import { LiferayTestRunner } from "./test-runner.js";
import { testRunStore } from "./test-run-store.js";

const runner = new LiferayTestRunner();

export async function recoverStaleRuns(): Promise<void> {
  const staleRuns = testRunStore.listStaleRuns();

  if (staleRuns.length === 0) {
    return;
  }

  console.log(
    `[startup-recovery] Found ${staleRuns.length} stale run(s) to recover.`,
  );

  for (const run of staleRuns) {
    let containerStillRunning = false;

    if (run.containerId) {
      containerStillRunning = await runner.isContainerRunning(run.containerId);
    }

    if (!containerStillRunning) {
      testRunStore.update(run.id, {
        status: "unknown",
        phase: "recovered_after_restart",
        resultSummary:
          "Server restarted during execution. Outcome unknown.",
        containerId: null,
        mappedPort: null,
        finishedAt: new Date().toISOString(),
      });

      console.log(
        `[startup-recovery] Run ${run.id} marked as unknown (no active container).`,
      );
    } else {
      console.log(
        `[startup-recovery] Run ${run.id} has a live container — leaving it running.`,
      );
    }
  }
}
