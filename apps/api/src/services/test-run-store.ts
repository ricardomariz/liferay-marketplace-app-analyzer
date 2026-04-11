import type { TestRunStatus } from "@lma/shared";

export type TestRunRecord = {
  id: string;
  userId: string;
  fileName: string;
  fileSize: number;
  filePath: string;
  versionKey: string;
  dockerTag: string;
  keepAlive: boolean;
  status: TestRunStatus;
  phase: string;
  resultSummary: string | null;
  deployEvidence: {
    processingLine?: string;
    startedLine?: string;
    firstFailureLine?: string;
  } | null;
  startedBundleCandidates: string[];
  containerId: string | null;
  mappedPort: number | null;
  runtimeDeadlineAt: string | null;
  killRequestedAt: string | null;
  killedAt: string | null;
  logs: string[];
  createdAt: string;
  finishedAt: string | null;
};

type TestRunListener = (record: TestRunRecord) => void;

export class InMemoryTestRunStore {
  private readonly records = new Map<string, TestRunRecord>();
  private readonly listeners = new Map<string, Set<TestRunListener>>();

  create(record: TestRunRecord) {
    this.records.set(record.id, record);
    this.emit(record.id, record);
    return record;
  }

  getById(id: string) {
    return this.records.get(id) ?? null;
  }

  listByUser(userId: string) {
    return [...this.records.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listActiveContainers(userId: string) {
    return this.listByUser(userId).filter(
      (record) =>
        !!record.containerId &&
        !record.killedAt &&
        (record.keepAlive || record.status === "running"),
    );
  }

  update(id: string, patch: Partial<TestRunRecord>) {
    const existing = this.records.get(id);

    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...patch,
    };

    this.records.set(id, updated);
    this.emit(id, updated);
    return updated;
  }

  subscribe(id: string, listener: TestRunListener) {
    const currentListeners =
      this.listeners.get(id) ?? new Set<TestRunListener>();
    currentListeners.add(listener);
    this.listeners.set(id, currentListeners);

    return () => {
      const listenersForId = this.listeners.get(id);

      if (!listenersForId) {
        return;
      }

      listenersForId.delete(listener);

      if (listenersForId.size === 0) {
        this.listeners.delete(id);
      }
    };
  }

  private emit(id: string, record: TestRunRecord) {
    const listenersForId = this.listeners.get(id);

    if (!listenersForId) {
      return;
    }

    for (const listener of listenersForId) {
      listener(record);
    }
  }
}

export const testRunStore = new InMemoryTestRunStore();
