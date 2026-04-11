import Docker from "dockerode";
import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { parseDeploymentLogs, sanitizeLogLine } from "./log-parser";
import { resolveLiferayDockerTag } from "./docker-hub";

export type RunDeploymentTestInput = {
  testRunId: string;
  dockerTag: string;
  uploadedFilePath: string;
  keepAlive: boolean;
  onEvent?: (event: RunnerProgressEvent) => void;
};

export type RunnerProgressEvent =
  | { type: "phase"; phase: string }
  | { type: "log"; line: string }
  | {
      type: "runtime";
      containerId?: string;
      mappedPort?: number;
      runtimeDeadlineAt?: string;
    };

export type RunDeploymentTestOutput = {
  success: boolean;
  summary: string;
  logs: string[];
  startedBundleCandidates?: string[];
  bundleIdentity?: {
    symbolicName?: string;
    version?: string;
  };
  deployEvidence?: {
    processingLine?: string;
    startedLine?: string;
    firstFailureLine?: string;
  };
};

export class LiferayTestRunner {
  private readonly docker = new Docker();
  private readonly maxRuntimeMs = Number(
    process.env.LIFERAY_MAX_RUNTIME_MS ?? 300_000,
  );
  private readonly stabilizationDelayMs = Number(
    process.env.LIFERAY_STABILIZATION_MS ?? 120_000,
  );
  private readonly deploymentMonitorTimeoutMs = Number(
    process.env.LIFERAY_DEPLOY_MONITOR_TIMEOUT_MS ?? 180_000,
  );
  private readonly activeRuns = new Map<string, { containerId: string }>();
  private readonly killedRuns = new Set<string>();

  async run(input: RunDeploymentTestInput): Promise<RunDeploymentTestOutput> {
    const emit = input.onEvent ?? (() => undefined);

    const dockerAvailable = await this.pingDocker();

    if (!dockerAvailable) {
      emit({ type: "phase", phase: "docker_unavailable" });
      emit({ type: "log", line: "Docker ping failed" });
      return {
        success: false,
        summary: "Docker daemon not reachable from API service.",
        logs: ["Docker ping failed"],
      };
    }

    let dockerTag = input.dockerTag;
    let imageName = `liferay/dxp:${dockerTag}`;
    const containerName = `lma-test-${input.testRunId}`;
    const deployHostDir = dirname(input.uploadedFilePath);
    const uploadedFileName = basename(input.uploadedFilePath);
    const summaryLogs: string[] = [];
    let containerId: string | null = null;
    const bundleIdentity = await this.tryExtractBundleIdentity(
      input.uploadedFilePath,
    );
    const runtimeDeadline = new Date(
      Date.now() + this.maxRuntimeMs,
    ).toISOString();

    try {
      emit({ type: "runtime", runtimeDeadlineAt: runtimeDeadline });
      emit({ type: "phase", phase: "pulling_image" });
      summaryLogs.push(`Pulling image ${imageName} (if needed)...`);
      emit({ type: "log", line: summaryLogs[summaryLogs.length - 1] });
      const resolvedTag = await this.pullImageWithFallback(
        dockerTag,
        (line) => {
          summaryLogs.push(line);
          emit({ type: "log", line });
        },
      );

      dockerTag = resolvedTag;
      imageName = `liferay/dxp:${dockerTag}`;

      emit({ type: "phase", phase: "creating_container" });
      const container = await this.docker.createContainer({
        Image: imageName,
        name: containerName,
        Tty: false,
        Env: [
          "LIFERAY_JVM_OPTS=-Xmx2g -Xms1g",
          "LIFERAY_CONTAINER_KILL_ON_FAILURE=0",
        ],
        ExposedPorts: {
          "8080/tcp": {},
        },
        HostConfig: {
          Binds: [`${deployHostDir}:/mnt/liferay/staging`],
          PortBindings: {
            "8080/tcp": [{ HostPort: "0" }],
          },
          AutoRemove: false,
        },
      });

      containerId = container.id;
      this.activeRuns.set(input.testRunId, { containerId });
      summaryLogs.push(`Container created: ${container.id.slice(0, 12)}`);
      emit({ type: "log", line: summaryLogs[summaryLogs.length - 1] });
      emit({ type: "runtime", containerId });

      emit({ type: "phase", phase: "starting_container" });
      await container.start();
      summaryLogs.push("Container started.");
      emit({ type: "log", line: summaryLogs[summaryLogs.length - 1] });

      emit({ type: "phase", phase: "waiting_port_mapping" });
      const mappedPort = await this.waitForMappedPort(container.id);
      summaryLogs.push(`Liferay host port mapped to ${mappedPort}.`);
      emit({ type: "log", line: summaryLogs[summaryLogs.length - 1] });
      emit({ type: "runtime", mappedPort });

      emit({ type: "phase", phase: "waiting_liferay_ready" });
      const remainingBeforeReady = this.getRemainingRuntimeMs(runtimeDeadline);
      const ready = await this.waitForLiferayReady(
        mappedPort,
        Math.min(180_000, remainingBeforeReady),
      );

      if (!ready) {
        const startupLines = await this.readContainerLogLines(container.id);

        return {
          success: false,
          summary: "Liferay did not become ready before timeout.",
          logs: [
            ...summaryLogs,
            `Artifact found in deploy mount: ${uploadedFileName}`,
            ...startupLines.slice(-200),
          ],
        };
      }

      emit({ type: "phase", phase: "deploying_artifact" });
      const deployStartSince = Math.floor(Date.now() / 1000) - 1;
      await this.deployArtifact(container.id, uploadedFileName);
      summaryLogs.push(
        `Artifact copied to /opt/liferay/deploy/${uploadedFileName}`,
      );
      emit({ type: "log", line: summaryLogs[summaryLogs.length - 1] });

      emit({ type: "phase", phase: "monitoring_deployment_logs" });
      summaryLogs.push("Liferay is ready. Monitoring deployment logs...");
      emit({ type: "log", line: summaryLogs[summaryLogs.length - 1] });
      const deploymentLines = await this.monitorDeployment(
        container.id,
        uploadedFileName,
        bundleIdentity.symbolicName,
        deployStartSince,
        Math.min(
          this.deploymentMonitorTimeoutMs,
          this.getRemainingRuntimeMs(runtimeDeadline),
        ),
        (line) => emit({ type: "log", line }),
      );
      const parsed = parseDeploymentLogs(
        deploymentLines,
        uploadedFileName,
        bundleIdentity.symbolicName,
      );

      if (parsed.failed) {
        const failureReason = parsed.firstFailureLine;
        return {
          success: false,
          summary: failureReason
            ? `Deployment failed: ${failureReason}`
            : "Deployment failed according to Liferay logs.",
          logs: [
            ...summaryLogs,
            ...parsed.matchedLines.slice(-120),
            ...deploymentLines.slice(-120),
          ],
          deployEvidence: {
            processingLine: parsed.processingLine,
            startedLine: parsed.successLine,
            firstFailureLine: parsed.firstFailureLine,
          },
          startedBundleCandidates: parsed.startedCandidates,
          bundleIdentity,
        };
      }

      if (parsed.success) {
        const successHint = parsed.successLine;
        const appName = parsed.deployedAppName;
        return {
          success: true,
          summary: appName
            ? `Deployment succeeded: ${appName}`
            : successHint
              ? `Deployment succeeded: ${successHint}`
              : "Deployment succeeded according to Liferay logs.",
          logs: [
            ...summaryLogs,
            ...parsed.matchedLines.slice(-120),
            ...deploymentLines.slice(-120),
          ],
          deployEvidence: {
            processingLine: parsed.processingLine,
            startedLine: parsed.successLine,
            firstFailureLine: parsed.firstFailureLine,
          },
          startedBundleCandidates: parsed.startedCandidates,
          bundleIdentity,
        };
      }

      return {
        success: false,
        summary:
          "No explicit success or failure deployment pattern found in logs.",
        logs: [...summaryLogs, ...deploymentLines.slice(-200)],
        deployEvidence: {
          processingLine: parsed.processingLine,
          startedLine: parsed.successLine,
          firstFailureLine: parsed.firstFailureLine,
        },
        startedBundleCandidates: parsed.startedCandidates,
        bundleIdentity,
      };
    } catch (error) {
      if (this.killedRuns.has(input.testRunId)) {
        return {
          success: false,
          summary: "Deployment interrupted: container killed by user.",
          logs: [...summaryLogs, "Container killed manually by user."],
        };
      }

      return {
        success: false,
        summary:
          error instanceof Error
            ? error.message
            : "Runner failed unexpectedly.",
        logs: summaryLogs,
      };
    } finally {
      emit({ type: "phase", phase: "cleaning_up" });
      if (containerId && !input.keepAlive) {
        const cleaned = await this.cleanupContainer(containerId);
        emit({
          type: "log",
          line: cleaned
            ? `Container ${containerId.slice(0, 12)} cleaned up.`
            : `Warning: failed to fully cleanup container ${containerId.slice(0, 12)}.`,
        });
      }

      if (input.keepAlive && containerId) {
        emit({
          type: "log",
          line: `Keep alive enabled: container ${containerId.slice(0, 12)} left running.`,
        });
      }

      this.activeRuns.delete(input.testRunId);
      this.killedRuns.delete(input.testRunId);
    }
  }

  async killRun(testRunId: string) {
    const active = this.activeRuns.get(testRunId);

    if (!active) {
      return false;
    }

    this.killedRuns.add(testRunId);
    await this.cleanupContainer(active.containerId);
    this.activeRuns.delete(testRunId);
    return true;
  }

  private getRemainingRuntimeMs(runtimeDeadlineIso: string) {
    const remaining = new Date(runtimeDeadlineIso).getTime() - Date.now();

    if (remaining <= 0) {
      throw new Error(
        "Deployment timed out after maximum runtime (5 minutes).",
      );
    }

    return remaining;
  }

  private async pullImage(imageName: string) {
    const stream = await this.docker.pull(imageName);

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private isMissingImageError(error: unknown) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);

    return (
      message.includes("not found") ||
      message.includes("failed to resolve reference") ||
      message.includes("manifest unknown")
    );
  }

  private async pullImageWithFallback(
    preferredTag: string,
    log: (line: string) => void,
  ) {
    const preferredImage = `liferay/dxp:${preferredTag}`;

    try {
      await this.pullImage(preferredImage);
      return preferredTag;
    } catch (error) {
      if (!this.isMissingImageError(error)) {
        throw error;
      }
    }

    const fallbackTag = await resolveLiferayDockerTag(preferredTag);

    if (!fallbackTag || fallbackTag === preferredTag) {
      throw new Error(
        `Docker image ${preferredImage} not found and no fallback tag was discovered on Docker Hub.`,
      );
    }

    log(
      `Selected image tag '${preferredTag}' was not found. Falling back to Docker Hub tag '${fallbackTag}'.`,
    );

    await this.pullImage(`liferay/dxp:${fallbackTag}`);
    return fallbackTag;
  }

  private async waitForMappedPort(containerId: string) {
    const timeoutMs = 30_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const inspection = await this.docker.getContainer(containerId).inspect();
      const bindings = inspection?.NetworkSettings?.Ports?.["8080/tcp"];
      const hostPort = bindings?.[0]?.HostPort;

      if (hostPort) {
        return Number(hostPort);
      }

      await Bun.sleep(500);
    }

    throw new Error(
      "Container port mapping for 8080 was not available in time.",
    );
  }

  private async waitForLiferayReady(hostPort: number, timeoutMs: number) {
    const start = Date.now();
    const probes = ["/", "/c/portal/robots"];

    while (Date.now() - start < timeoutMs) {
      for (const probe of probes) {
        try {
          const response = await fetch(`http://127.0.0.1:${hostPort}${probe}`, {
            method: "GET",
          });

          if (
            response.ok ||
            response.status === 401 ||
            response.status === 403
          ) {
            return true;
          }
        } catch {
          // Ignore probe errors while Liferay is still booting.
        }
      }

      await Bun.sleep(3000);
    }

    return false;
  }

  private async deployArtifact(containerId: string, uploadedFileName: string) {
    const shellEscapedFile = uploadedFileName.replace(/'/g, "'\\''");

    await this.runContainerCommand(
      containerId,
      `cp '/mnt/liferay/staging/${shellEscapedFile}' '/opt/liferay/deploy/${shellEscapedFile}'`,
    );
  }

  private async runContainerCommand(
    containerId: string,
    command: string,
    timeoutMs = 15_000,
  ) {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ["/bin/sh", "-lc", command],
      AttachStdout: false,
      AttachStderr: false,
    });

    await exec.start({});

    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const inspection = await exec.inspect();

      if (!inspection.Running) {
        if ((inspection.ExitCode ?? 1) !== 0) {
          throw new Error(
            `Failed command inside Liferay container: ${command}`,
          );
        }

        return;
      }

      await Bun.sleep(300);
    }

    throw new Error(
      `Command timeout inside Liferay container after ${timeoutMs}ms: ${command}`,
    );
  }

  private async monitorDeployment(
    containerId: string,
    uploadedFileName: string,
    symbolicName: string | undefined,
    since: number,
    timeoutMs: number,
    onNewLine?: (line: string) => void,
  ) {
    const start = Date.now();
    let lines: string[] = [];
    let alreadyEmitted = 0;

    while (Date.now() - start < timeoutMs) {
      lines = await this.readContainerLogLines(containerId, since);

      if (onNewLine && lines.length > alreadyEmitted) {
        const slice = lines.slice(alreadyEmitted);

        for (const line of slice) {
          onNewLine(line);
        }

        alreadyEmitted = lines.length;
      }

      const parsed = parseDeploymentLogs(lines, uploadedFileName, symbolicName);

      if (parsed.failed || parsed.success) {
        return lines;
      }

      await Bun.sleep(3000);
    }

    return lines;
  }

  private async readContainerLogLines(containerId: string, since?: number) {
    const container = this.docker.getContainer(containerId);
    const raw = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: false,
      since,
      tail: 500,
    });

    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);

    return text.split(/\r?\n/).map(sanitizeLogLine).filter(Boolean);
  }

  private async tryExtractBundleIdentity(uploadedFilePath: string) {
    const empty = {
      symbolicName: undefined,
      version: undefined,
    };

    if (
      !uploadedFilePath.toLowerCase().endsWith(".jar") ||
      !existsSync(uploadedFilePath)
    ) {
      return empty;
    }

    try {
      const proc = Bun.spawn(
        ["unzip", "-p", uploadedFilePath, "META-INF/MANIFEST.MF"],
        {
          stdout: "pipe",
          stderr: "ignore",
        },
      );

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      if (!output.trim()) {
        return empty;
      }

      const symbolicNameMatch = output.match(
        /^Bundle-SymbolicName:\s*([^;\r\n]+)/im,
      );
      const versionMatch = output.match(/^Bundle-Version:\s*([^\r\n]+)/im);

      return {
        symbolicName: symbolicNameMatch?.[1]?.trim(),
        version: versionMatch?.[1]?.trim(),
      };
    } catch {
      return empty;
    }
  }

  private async cleanupContainer(containerId: string) {
    const container = this.docker.getContainer(containerId);
    let cleaned = true;

    try {
      await container.stop({ t: 5 });
    } catch {
      cleaned = false;

      try {
        await container.kill();
      } catch {
        // Ignore if already stopped.
      }
    }

    try {
      await container.remove({ force: true });
    } catch {
      cleaned = false;

      try {
        await container.remove({ force: true });
      } catch {
        // Final fallback failed.
      }
    }

    return cleaned;
  }

  private async pingDocker() {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
