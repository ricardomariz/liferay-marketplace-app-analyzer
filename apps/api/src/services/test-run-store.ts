import type { TestRunStatus } from "@lma/shared";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const dbPath = fileURLToPath(
  new URL("../../data/test-runs.sqlite", import.meta.url),
);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath, { create: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS test_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    version_key TEXT NOT NULL,
    docker_tag TEXT NOT NULL,
    keep_alive INTEGER NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    result_summary TEXT,
    deploy_evidence TEXT,
    started_bundle_candidates TEXT NOT NULL,
    container_id TEXT,
    mapped_port INTEGER,
    runtime_deadline_at TEXT,
    kill_requested_at TEXT,
    killed_at TEXT,
    logs TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_test_runs_user_created
    ON test_runs(user_id, created_at DESC);
`);

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRowToRecord(row: Record<string, unknown>): TestRunRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    fileName: String(row.file_name),
    fileSize: Number(row.file_size),
    filePath: String(row.file_path),
    versionKey: String(row.version_key),
    dockerTag: String(row.docker_tag),
    keepAlive: Number(row.keep_alive) === 1,
    status: String(row.status) as TestRunStatus,
    phase: String(row.phase),
    resultSummary:
      row.result_summary === null ? null : String(row.result_summary),
    deployEvidence: parseJson<TestRunRecord["deployEvidence"]>(
      row.deploy_evidence === null ? null : String(row.deploy_evidence),
      null,
    ),
    startedBundleCandidates: parseJson<string[]>(
      String(row.started_bundle_candidates ?? "[]"),
      [],
    ),
    containerId: row.container_id === null ? null : String(row.container_id),
    mappedPort:
      row.mapped_port === null || row.mapped_port === undefined
        ? null
        : Number(row.mapped_port),
    runtimeDeadlineAt:
      row.runtime_deadline_at === null ? null : String(row.runtime_deadline_at),
    killRequestedAt:
      row.kill_requested_at === null ? null : String(row.kill_requested_at),
    killedAt: row.killed_at === null ? null : String(row.killed_at),
    logs: parseJson<string[]>(String(row.logs ?? "[]"), []),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

export class SqliteTestRunStore {
  private readonly listeners = new Map<string, Set<TestRunListener>>();

  create(record: TestRunRecord) {
    db.query(
      `
          INSERT INTO test_runs (
            id, user_id, file_name, file_size, file_path, version_key, docker_tag,
            keep_alive, status, phase, result_summary, deploy_evidence,
            started_bundle_candidates, container_id, mapped_port,
            runtime_deadline_at, kill_requested_at, killed_at, logs,
            created_at, finished_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?
          )
        `,
    ).run(
      record.id,
      record.userId,
      record.fileName,
      record.fileSize,
      record.filePath,
      record.versionKey,
      record.dockerTag,
      record.keepAlive ? 1 : 0,
      record.status,
      record.phase,
      record.resultSummary,
      JSON.stringify(record.deployEvidence),
      JSON.stringify(record.startedBundleCandidates),
      record.containerId,
      record.mappedPort,
      record.runtimeDeadlineAt,
      record.killRequestedAt,
      record.killedAt,
      JSON.stringify(record.logs),
      record.createdAt,
      record.finishedAt,
    );

    this.emit(record.id, record);
    return record;
  }

  getById(id: string) {
    const row = db
      .query(`SELECT * FROM test_runs WHERE id = ?`)
      .get(id) as Record<string, unknown> | null;

    if (!row) {
      return null;
    }

    return mapRowToRecord(row);
  }

  listByUser(userId: string) {
    const rows = db
      .query(
        `SELECT * FROM test_runs WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[];

    return rows.map(mapRowToRecord);
  }

  listActiveContainers(userId: string) {
    const rows = db
      .query(
        `
          SELECT *
          FROM test_runs
          WHERE user_id = ?
            AND container_id IS NOT NULL
            AND killed_at IS NULL
            AND (keep_alive = 1 OR status = 'running')
          ORDER BY created_at DESC
        `,
      )
      .all(userId) as Record<string, unknown>[];

    return rows.map(mapRowToRecord);
  }

  update(id: string, patch: Partial<TestRunRecord>) {
    const existing = this.getById(id);

    if (!existing) {
      return null;
    }

    const updated = {
      ...existing,
      ...patch,
    };

    db.query(
      `
          UPDATE test_runs
          SET
            file_name = ?,
            file_size = ?,
            file_path = ?,
            version_key = ?,
            docker_tag = ?,
            keep_alive = ?,
            status = ?,
            phase = ?,
            result_summary = ?,
            deploy_evidence = ?,
            started_bundle_candidates = ?,
            container_id = ?,
            mapped_port = ?,
            runtime_deadline_at = ?,
            kill_requested_at = ?,
            killed_at = ?,
            logs = ?,
            created_at = ?,
            finished_at = ?
          WHERE id = ?
        `,
    ).run(
      updated.fileName,
      updated.fileSize,
      updated.filePath,
      updated.versionKey,
      updated.dockerTag,
      updated.keepAlive ? 1 : 0,
      updated.status,
      updated.phase,
      updated.resultSummary,
      JSON.stringify(updated.deployEvidence),
      JSON.stringify(updated.startedBundleCandidates),
      updated.containerId,
      updated.mappedPort,
      updated.runtimeDeadlineAt,
      updated.killRequestedAt,
      updated.killedAt,
      JSON.stringify(updated.logs),
      updated.createdAt,
      updated.finishedAt,
      id,
    );

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

export const testRunStore = new SqliteTestRunStore();
