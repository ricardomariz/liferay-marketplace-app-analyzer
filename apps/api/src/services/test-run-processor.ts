import { LiferayTestRunner, type RunnerProgressEvent } from "./test-runner.js";
import { InMemoryQueue } from "./queue";
import { testRunStore } from "./test-run-store";
import { rm } from "node:fs/promises";

const queue = new InMemoryQueue();
const runner = new LiferayTestRunner();

export function enqueueTestRun(testRunId: string) {
  queue.enqueue(async () => {
    const record = testRunStore.getById(testRunId);

    if (!record) {
      return;
    }

    testRunStore.update(testRunId, {
      status: "running",
      phase: "queued_for_execution",
    });

    try {
      const result = await runner.run({
        testRunId: record.id,
        dockerTag: record.dockerTag,
        uploadedFilePath: record.filePath,
        keepAlive: record.keepAlive,
        onEvent: (event: RunnerProgressEvent) => {
          const current = testRunStore.getById(testRunId);

          if (!current) {
            return;
          }

          if (event.type === "phase") {
            testRunStore.update(testRunId, {
              phase: event.phase,
            });
            return;
          }

          if (event.type === "runtime") {
            testRunStore.update(testRunId, {
              containerId: event.containerId ?? current.containerId,
              mappedPort: event.mappedPort ?? current.mappedPort,
              runtimeDeadlineAt:
                event.runtimeDeadlineAt ?? current.runtimeDeadlineAt,
            });
            return;
          }

          const nextLogs = [...current.logs, event.line].slice(-500);
          testRunStore.update(testRunId, {
            logs: nextLogs,
          });
        },
      });

      const latest = testRunStore.getById(testRunId) ?? record;

      testRunStore.update(testRunId, {
        status: result.success ? "success" : "failed",
        phase: result.success ? "completed_success" : "completed_failed",
        resultSummary: result.summary,
        deployEvidence: result.deployEvidence ?? null,
        startedBundleCandidates: result.startedBundleCandidates ?? [],
        containerId: latest.keepAlive ? latest.containerId : null,
        mappedPort: latest.keepAlive ? latest.mappedPort : null,
        logs: result.logs,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      testRunStore.update(testRunId, {
        status: "error",
        phase: "completed_error",
        resultSummary:
          error instanceof Error
            ? error.message
            : "Unexpected processing error",
        startedBundleCandidates: [],
        finishedAt: new Date().toISOString(),
      });
    } finally {
      await rm(record.filePath, { force: true }).catch(() => undefined);
    }
  });
}

export function getQueueSize() {
  return queue.size;
}

export async function requestKillTestRun(testRunId: string) {
  const killed = await runner.killRun(testRunId);

  if (killed) {
    testRunStore.update(testRunId, {
      containerId: null,
      mappedPort: null,
      killRequestedAt: new Date().toISOString(),
      killedAt: new Date().toISOString(),
    });
  }

  return killed;
}
