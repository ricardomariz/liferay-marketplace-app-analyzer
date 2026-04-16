import { randomUUID } from "crypto";
import { Hono } from "hono";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import type { TestRunStatus } from "@lma/shared";
import { getLiferayVersionByKey } from "../config/liferay-versions";
import {
  enqueueTestRun,
  getQueueSize,
  requestKillTestRun,
} from "../services/test-run-processor";
import { resolveLiferayDockerTag } from "../services/docker-hub";
import { testRunStore } from "../services/test-run-store";
import { LiferayTestRunner } from "../services/test-runner";

const runner = new LiferayTestRunner();

export const testRunsRoute = new Hono();

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const ALLOWED_EXTENSIONS = [".jar", ".war"];
const ALLOWED_STATUS_FILTERS: TestRunStatus[] = [
  "queued",
  "running",
  "success",
  "failed",
  "error",
];
const encoder = new TextEncoder();

function toSseMessage(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

testRunsRoute.get("/test-runs", (c) => {
  // Temporary fixed user until auth is implemented.
  const userId = "dev-user";
  const fileName = c.req.query("fileName")?.trim().toLowerCase() ?? "";
  const createdFrom = c.req.query("createdFrom") ?? "";
  const createdTo = c.req.query("createdTo") ?? "";
  const status = c.req.query("status")?.trim().toLowerCase() ?? "";

  const fromDate = createdFrom ? new Date(createdFrom) : null;
  const toDate = createdTo ? new Date(createdTo) : null;

  const hasInvalidFromDate = !!fromDate && Number.isNaN(fromDate.getTime());
  const hasInvalidToDate = !!toDate && Number.isNaN(toDate.getTime());

  if (hasInvalidFromDate || hasInvalidToDate) {
    return c.json({ error: "invalid_date_filter" }, 400);
  }

  if (status && !ALLOWED_STATUS_FILTERS.includes(status as TestRunStatus)) {
    return c.json({ error: "invalid_status_filter" }, 400);
  }

  const items = testRunStore.listByUser(userId).filter((record) => {
    if (fileName && !record.fileName.toLowerCase().includes(fileName)) {
      return false;
    }

    const createdAt = new Date(record.createdAt).getTime();

    if (fromDate && createdAt < fromDate.getTime()) {
      return false;
    }

    if (toDate && createdAt > toDate.getTime()) {
      return false;
    }

    if (status && record.status !== status) {
      return false;
    }

    return true;
  });

  return c.json({
    items,
    queueSize: getQueueSize(),
  });
});

testRunsRoute.get("/test-runs-active-containers", (c) => {
  const userId = "dev-user";

  return c.json({
    items: testRunStore.listActiveContainers(userId).map((record) => ({
      id: record.id,
      fileName: record.fileName,
      status: record.status,
      phase: record.phase,
      containerId: record.containerId,
      mappedPort: record.mappedPort,
      keepAlive: record.keepAlive,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
    })),
  });
});

testRunsRoute.get("/test-runs/:id", (c) => {
  const record = testRunStore.getById(c.req.param("id"));

  if (!record) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json(record);
});

testRunsRoute.post("/test-runs/:id/kill", async (c) => {
  const id = c.req.param("id");
  const record = testRunStore.getById(id);

  if (!record) {
    return c.json({ error: "not_found" }, 404);
  }

  const killed = await requestKillTestRun(id);

  if (!killed) {
    return c.json({ error: "container_not_active" }, 409);
  }

  return c.json({
    killed,
    item: testRunStore.getById(id),
  });
});

testRunsRoute.get("/test-runs/:id/events", (c) => {
  const id = c.req.param("id");
  const record = testRunStore.getById(id);

  if (!record) {
    return c.json({ error: "not_found" }, 404);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(toSseMessage("snapshot", record)));

      const unsubscribe = testRunStore.subscribe(id, (updatedRecord) => {
        controller.enqueue(
          encoder.encode(toSseMessage("test-run-update", updatedRecord)),
        );
      });

      const pingInterval = setInterval(() => {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 15000);

      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(pingInterval);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

testRunsRoute.post("/test-runs", async (c) => {
  const body = await c.req.parseBody();
  const versionKey = typeof body.versionKey === "string" ? body.versionKey : "";
  const dockerTagOverrideRaw =
    typeof body.dockerTag === "string" ? body.dockerTag.trim() : "";
  const keepAliveRaw =
    typeof body.keepAlive === "string" ? body.keepAlive : "false";
  const keepAlive = keepAliveRaw === "true";
  const file = body.file;

  const version = getLiferayVersionByKey(versionKey);

  if (!version) {
    return c.json({ error: "invalid_version" }, 400);
  }

  const hasActiveContainer = await runner.hasActiveLmaContainer();

  if (hasActiveContainer) {
    return c.json({ error: "container_already_active" }, 409);
  }

  if (dockerTagOverrideRaw && !/^[a-zA-Z0-9._-]+$/.test(dockerTagOverrideRaw)) {
    return c.json({ error: "invalid_docker_tag" }, 400);
  }

  if (!(file instanceof File)) {
    return c.json({ error: "file_required" }, 400);
  }

  const fileName = basename(file.name || "artifact.jar");
  const fileNameLower = fileName.toLowerCase();
  const hasAllowedExtension = ALLOWED_EXTENSIONS.some((extension) =>
    fileNameLower.endsWith(extension),
  );

  if (!hasAllowedExtension) {
    return c.json(
      { error: "invalid_file_extension", allowed: ALLOWED_EXTENSIONS },
      400,
    );
  }

  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: "invalid_file_size", maxBytes: MAX_UPLOAD_BYTES },
      400,
    );
  }

  const testRunId = randomUUID();
  const userId = "dev-user";
  const uploadDir = `/tmp/lma-uploads/${testRunId}`;
  const storedFilePath = `${uploadDir}/${fileName}`;

  await mkdir(uploadDir, { recursive: true });
  await Bun.write(storedFilePath, file);

  const created = testRunStore.create({
    id: testRunId,
    userId,
    fileName,
    fileSize: file.size,
    filePath: storedFilePath,
    versionKey: version.key,
    dockerTag:
      dockerTagOverrideRaw ||
      (await resolveLiferayDockerTag(version.dockerTag)) ||
      version.dockerTag,
    keepAlive,
    status: "queued",
    phase: "queued",
    resultSummary: null,
    deployEvidence: null,
    startedBundleCandidates: [],
    containerId: null,
    mappedPort: null,
    runtimeDeadlineAt: null,
    killRequestedAt: null,
    killedAt: null,
    logs: [],
    createdAt: new Date().toISOString(),
    finishedAt: null,
  });

  enqueueTestRun(testRunId);

  return c.json(
    {
      testRunId: created.id,
      status: created.status,
      selectedVersion: {
        ...version,
        dockerTag: created.dockerTag,
      },
      queueSize: getQueueSize(),
    },
    202,
  );
});
