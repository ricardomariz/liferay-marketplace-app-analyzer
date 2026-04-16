import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  createTestRun,
  fetchDockerTags,
  fetchVersions,
  getTestRun,
  killTestRun,
  listActiveContainers,
  listTestRuns,
  subscribeToTestRunEvents,
  type TestRunRecord,
} from "./api";

const STATUS_OPTIONS: Array<
  "queued" | "running" | "success" | "failed" | "error"
> = ["queued", "running", "success", "failed", "error"];

const HISTORY_PAGE_SIZE = 20;

type GroupedFileRun = {
  fileName: string;
  latest: TestRunRecord;
  rest: TestRunRecord[];
  totalCount: number;
};

function isTerminalStatus(status: TestRunRecord["status"]) {
  return status === "success" || status === "failed" || status === "error";
}

function findFailureReason(record: TestRunRecord | undefined) {
  if (!record) {
    return null;
  }

  if (record.status !== "failed" && record.status !== "error") {
    return null;
  }

  const failurePattern =
    /resolution error|unable to resolve|classnotfoundexception|bundleexception|failed to deploy|unsatisfied import/i;

  const matchedLogLine = record.logs.find((line) => failurePattern.test(line));

  return (
    matchedLogLine ?? record.resultSummary ?? "Failure without detailed logs."
  );
}

type FailureAnalysis = {
  severity: "high" | "medium" | "low";
  category: string;
  reason: string;
  suggestions: string[];
};

function analyzeFailure(
  record: TestRunRecord | undefined,
): FailureAnalysis | null {
  if (!record) {
    return null;
  }

  if (record.status !== "failed" && record.status !== "error") {
    return null;
  }

  const reason = findFailureReason(record) ?? "Failure without detailed logs.";
  const reasonLower = reason.toLowerCase();

  if (
    /unable to resolve|resolution error|unsatisfied import|bundleexception/.test(
      reasonLower,
    )
  ) {
    return {
      severity: "high",
      category: "Unresolved OSGi dependencies",
      reason,
      suggestions: [
        "Check whether the module exports/imports the correct packages in MANIFEST.MF.",
        "Confirm that required dependencies exist in the selected DXP version.",
        "Review the app build version and dependent bundle versions.",
      ],
    };
  }

  if (/classnotfoundexception/.test(reasonLower)) {
    return {
      severity: "high",
      category: "Missing class at runtime",
      reason,
      suggestions: [
        "Include the missing dependency in the correct module packaging.",
        "Avoid depending on package classes not available in the target DXP.",
        "Validate whether there was an API change between Liferay versions.",
      ],
    };
  }

  if (
    /did not become ready before timeout|docker daemon not reachable/.test(
      reasonLower,
    )
  ) {
    return {
      severity: "medium",
      category: "Infrastructure/environment",
      reason,
      suggestions: [
        "Confirm Docker is running and reachable by the backend.",
        "Increase startup timeout for heavier DXP versions.",
        "Check machine resources (RAM/CPU/disk) during execution.",
      ],
    };
  }

  if (/failed to deploy/.test(reasonLower)) {
    return {
      severity: "medium",
      category: "Generic deployment error",
      reason,
      suggestions: [
        "Review full logs to identify the class/package that triggered the failure.",
        "Test the same artifact on another DXP version to compare compatibility.",
        "Validate that the uploaded file (.jar/.war) is the correct final build.",
      ],
    };
  }

  return {
    severity: "low",
    category: "Uncategorized failure",
    reason,
    suggestions: [
      "Analyze the last log lines to identify the first real error.",
      "Repeat the test with debug logs enabled for more context.",
      "Validate Java version and artifact compatibility with the selected DXP.",
    ],
  };
}

// ─── Shared UI components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: TestRunRecord["status"] }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

function PhaseLabel({ phase }: { phase: string }) {
  return <span className="phase-label">{phase.replace(/_/g, " ")}</span>;
}

function LogConsole({
  logs,
  autoScrollEnabled,
  consoleRef,
  onScroll,
  onJumpToEnd,
}: {
  logs: string[];
  autoScrollEnabled: boolean;
  consoleRef: RefObject<HTMLPreElement | null>;
  onScroll: () => void;
  onJumpToEnd: () => void;
}) {
  return (
    <div className="console-wrapper">
      <div className="console-header">
        <div className="console-dots">
          <div className="console-dot" />
          <div className="console-dot" />
          <div className="console-dot" />
        </div>
        <span className="console-title">Live logs</span>
        <span className="console-scroll-status">
          {autoScrollEnabled ? "auto-scroll ↓" : "paused"}
        </span>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: "11px", padding: "3px 10px" }}
          onClick={onJumpToEnd}
        >
          Jump to end
        </button>
      </div>
      <pre ref={consoleRef} onScroll={onScroll} className="live-console">
        {logs.join("\n") || "No relevant logs yet."}
      </pre>
    </div>
  );
}

function EvidencePanel({ record }: { record: TestRunRecord }) {
  const items = [
    {
      label: "Processing detected",
      value: record.deployEvidence?.processingLine,
    },
    { label: "STARTED detected", value: record.deployEvidence?.startedLine },
    { label: "First failure", value: record.deployEvidence?.firstFailureLine },
    {
      label: "STARTED candidates",
      value: record.startedBundleCandidates.length
        ? record.startedBundleCandidates.join(" | ")
        : undefined,
    },
  ];
  return (
    <div className="evidence-grid">
      {items.map((item) => (
        <div key={item.label} className="evidence-item">
          <div className="evidence-item-label">{item.label}</div>
          <div
            className={`evidence-item-value${
              !item.value ? " evidence-item-empty" : ""
            }`}
          >
            {item.value ?? "Not detected"}
          </div>
        </div>
      ))}
    </div>
  );
}

function FailurePanel({
  reason,
  analysis,
}: {
  reason: string;
  analysis: FailureAnalysis | null;
}) {
  return (
    <div className="failure-panel">
      <div className="failure-panel-header">
        <span className="failure-panel-title">Failure analysis</span>
        {analysis ? (
          <span className={`severity-badge severity-${analysis.severity}`}>
            {analysis.severity}
          </span>
        ) : null}
      </div>
      {analysis ? (
        <p className="failure-category">{analysis.category}</p>
      ) : null}
      <div className="failure-panel-reason">{reason}</div>
      {analysis?.suggestions?.length ? (
        <ul className="suggestions-list">
          {analysis.suggestions.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AppTopbar({ breadcrumb }: { breadcrumb?: string }) {
  return (
    <header className="topbar">
      <Link to="/" className="topbar-logo">
        <div className="topbar-logo-icon">L</div>
        <span className="topbar-logo-text">App Analyzer</span>
      </Link>
      {breadcrumb ? (
        <>
          <div className="topbar-sep" />
          <span className="topbar-breadcrumb">{breadcrumb}</span>
        </>
      ) : null}
      <div className="topbar-spacer" />
      <span className="topbar-badge">Liferay DXP</span>
    </header>
  );
}

// ─── Home page ────────────────────────────────────────────────────────────────
function HomePage() {
  const queryClient = useQueryClient();
  const [selectedVersion, setSelectedVersion] = useState("");
  const [selectedDockerTag, setSelectedDockerTag] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [keepAlive, setKeepAlive] = useState(false);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [historyFileName, setHistoryFileName] = useState("");
  const [historyCreatedFrom, setHistoryCreatedFrom] = useState("");
  const [historyCreatedTo, setHistoryCreatedTo] = useState("");
  const [historyStatus, setHistoryStatus] = useState<
    "" | "queued" | "running" | "success" | "failed" | "error"
  >("");
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const versionsQuery = useQuery({
    queryKey: ["versions"],
    queryFn: fetchVersions,
  });

  const dockerTagsQuery = useQuery({
    queryKey: ["docker-tags"],
    queryFn: fetchDockerTags,
  });

  const createTestRunMutation = useMutation({
    mutationFn: createTestRun,
    onSuccess: (data) => {
      setTestRunId(data.testRunId);
    },
  });

  const testRunQuery = useQuery({
    queryKey: ["test-run", testRunId],
    queryFn: () => getTestRun(testRunId as string),
    enabled: !!testRunId,
  });

  const historyQuery = useQuery({
    queryKey: [
      "test-runs-history",
      historyFileName,
      historyCreatedFrom,
      historyCreatedTo,
      historyStatus,
    ],
    queryFn: () =>
      listTestRuns({
        fileName: historyFileName || undefined,
        createdFrom: historyCreatedFrom || undefined,
        createdTo: historyCreatedTo || undefined,
        status: historyStatus || undefined,
      }),
  });

  const activeContainersQuery = useQuery({
    queryKey: ["active-containers"],
    queryFn: listActiveContainers,
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!testRunId) {
      return;
    }

    let closed = false;

    const closeSse = subscribeToTestRunEvents(testRunId, {
      onUpdate: (record: TestRunRecord) => {
        queryClient.setQueryData(["test-run", testRunId], record);

        if (!closed && isTerminalStatus(record.status)) {
          closed = true;
          closeSse();
          queryClient.invalidateQueries({ queryKey: ["test-runs-history"] });
        }
      },
      onError: () => {
        queryClient.invalidateQueries({ queryKey: ["test-run", testRunId] });
      },
    });

    return () => {
      if (!closed) {
        closeSse();
      }
    };
  }, [queryClient, testRunId]);

  const canSubmit =
    !!selectedVersion && !!selectedFile && !createTestRunMutation.isPending;

  const selectedVersionOption = useMemo(
    () =>
      versionsQuery.data?.find((version) => version.key === selectedVersion),
    [selectedVersion, versionsQuery.data],
  );

  const selectedVersionPrefix = useMemo(() => {
    const source = selectedVersionOption?.dockerTag ?? "";
    const match = source.match(/^(\d{4}\.q\d+)/i);

    return match?.[1] ?? source;
  }, [selectedVersionOption]);

  const filteredDockerTagOptions = useMemo(() => {
    const tags = dockerTagsQuery.data ?? [];

    if (!selectedVersionPrefix) {
      return tags.slice(0, 80);
    }

    const stronglyRelated = tags.filter((tag) =>
      tag.name.startsWith(selectedVersionPrefix),
    );

    if (stronglyRelated.length > 0) {
      return stronglyRelated.slice(0, 80);
    }

    const yearlyRelated = tags.filter((tag) =>
      tag.name.startsWith(selectedVersionPrefix.slice(0, 4)),
    );

    if (yearlyRelated.length > 0) {
      return yearlyRelated.slice(0, 80);
    }

    return tags.slice(0, 80);
  }, [dockerTagsQuery.data, selectedVersionPrefix]);

  const hasActiveHistoryFilters =
    !!historyFileName ||
    !!historyCreatedFrom ||
    !!historyCreatedTo ||
    !!historyStatus;

  const groupedHistory = useMemo((): GroupedFileRun[] => {
    const items = historyQuery.data?.items ?? [];
    const map = new Map<string, TestRunRecord[]>();

    for (const item of items) {
      const existing = map.get(item.fileName);

      if (existing) {
        existing.push(item);
      } else {
        map.set(item.fileName, [item]);
      }
    }

    return [...map.entries()].map(([fileName, runs]) => ({
      fileName,
      latest: runs[0]!,
      rest: runs.slice(1),
      totalCount: runs.length,
    }));
  }, [historyQuery.data]);

  const totalHistoryPages = Math.max(
    1,
    Math.ceil(groupedHistory.length / HISTORY_PAGE_SIZE),
  );

  const paginatedGroups = useMemo(
    () =>
      groupedHistory.slice(
        (historyPage - 1) * HISTORY_PAGE_SIZE,
        historyPage * HISTORY_PAGE_SIZE,
      ),
    [groupedHistory, historyPage],
  );

  const toggleFileExpand = (fileName: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);

      if (next.has(fileName)) {
        next.delete(fileName);
      } else {
        next.add(fileName);
      }

      return next;
    });
  };

  const activeFilterChips = [
    historyFileName ? `File: ${historyFileName}` : null,
    historyStatus ? `Status: ${historyStatus}` : null,
    historyCreatedFrom ? `From: ${historyCreatedFrom}` : null,
    historyCreatedTo ? `To: ${historyCreatedTo}` : null,
  ].filter(Boolean) as string[];

  const handleSubmit = async () => {
    if (!selectedFile || !selectedVersion) {
      return;
    }

    await createTestRunMutation.mutateAsync({
      file: selectedFile,
      versionKey: selectedVersion,
      keepAlive,
      dockerTag: selectedDockerTag || undefined,
    });

    await queryClient.invalidateQueries({ queryKey: ["test-runs-history"] });
    await queryClient.invalidateQueries({ queryKey: ["active-containers"] });
  };

  const clearHistoryFilters = () => {
    setHistoryFileName("");
    setHistoryCreatedFrom("");
    setHistoryCreatedTo("");
    setHistoryStatus("");
    setHistoryPage(1);
    setExpandedFiles(new Set());
  };

  return (
    <div className="app-shell">
      <AppTopbar />
      <div className="page-content">
        <div className="page-grid">
          {/* ── Left: form ── */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">New test run</span>
            </div>
            <div className="card-body">
              <div className="field">
                <label htmlFor="version">Liferay version</label>
                <select
                  id="version"
                  value={selectedVersion}
                  disabled={versionsQuery.isLoading}
                  aria-busy={versionsQuery.isLoading}
                  onChange={(event) => {
                    setSelectedVersion(event.target.value);
                    setSelectedDockerTag("");
                  }}
                >
                  <option value="">
                    {versionsQuery.isLoading
                      ? "Loading versions..."
                      : "Select a version"}
                  </option>
                  {versionsQuery.data?.map((version) => (
                    <option key={version.key} value={version.key}>
                      {version.label} — {version.dockerTag}
                    </option>
                  ))}
                </select>
                {versionsQuery.isLoading ? (
                  <small>Loading versions…</small>
                ) : null}
                {versionsQuery.isError ? (
                  <small style={{ color: "var(--error)" }}>
                    Failed to fetch versions.
                  </small>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="docker-tag">Docker tag (optional)</label>
                <select
                  id="docker-tag"
                  value={selectedDockerTag}
                  onChange={(event) => setSelectedDockerTag(event.target.value)}
                  disabled={!selectedVersion || dockerTagsQuery.isLoading}
                >
                  <option value="">
                    Automatic —{" "}
                    {selectedVersionOption?.dockerTag ?? "version default"}
                  </option>
                  {filteredDockerTagOptions.map((tag) => (
                    <option key={tag.name} value={tag.name}>
                      {tag.name}
                    </option>
                  ))}
                </select>
                {dockerTagsQuery.isError ? (
                  <small>Could not load Docker Hub tags.</small>
                ) : null}
              </div>

              <div className="field">
                <label htmlFor="file">Artifact</label>
                <input
                  id="file"
                  type="file"
                  accept=".jar,.war"
                  onChange={(event) =>
                    setSelectedFile(event.target.files?.[0] ?? null)
                  }
                />
              </div>

              {selectedFile ? (
                <div className="selected-file">📦 {selectedFile.name}</div>
              ) : null}

              <label className="checkbox-row" htmlFor="keep-alive">
                <input
                  id="keep-alive"
                  type="checkbox"
                  checked={keepAlive}
                  onChange={(event) => setKeepAlive(event.target.checked)}
                />
                <span>Keep container alive after test</span>
              </label>

              <button
                type="button"
                className="btn-primary"
                style={{ width: "100%" }}
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {createTestRunMutation.isPending ? "Queueing…" : "Run test"}
              </button>

              {createTestRunMutation.isError ? (
                <div
                  className={`alert ${
                    createTestRunMutation.error?.message ===
                    "container_already_active"
                      ? "alert-info"
                      : "alert-error"
                  }`}
                >
                  {createTestRunMutation.error?.message ===
                  "container_already_active"
                    ? "A container is already running. Kill it or wait for it to finish before starting a new test."
                    : "Failed to queue test."}
                </div>
              ) : null}
            </div>
          </div>

          {/* ── Right: current run + active containers ── */}
          <div className="stack">
            <div className="card">
              <div className="card-header">
                <span className="card-title">Current run</span>
                {testRunQuery.data ? (
                  <StatusBadge status={testRunQuery.data.status} />
                ) : null}
              </div>
              <div className="card-body">
                {testRunQuery.data ? (
                  <>
                    <div className="data-table">
                      <div className="data-row">
                        <span className="data-label">ID</span>
                        <span className="data-value data-value-mono">
                          {testRunQuery.data.id.slice(0, 20)}…
                        </span>
                      </div>
                      <div className="data-row">
                        <span className="data-label">Phase</span>
                        <PhaseLabel phase={testRunQuery.data.phase} />
                      </div>
                      <div className="data-row">
                        <span className="data-label">Summary</span>
                        <span className="data-value">
                          {testRunQuery.data.resultSummary ?? "Processing…"}
                        </span>
                      </div>
                      {testRunQuery.data.mappedPort ? (
                        <div className="data-row">
                          <span className="data-label">Portal</span>
                          <a
                            className="link-external"
                            href={`http://localhost:${testRunQuery.data.mappedPort}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            localhost:{testRunQuery.data.mappedPort} ↗
                          </a>
                        </div>
                      ) : null}
                    </div>
                    <div style={{ marginTop: "14px" }}>
                      <Link
                        className="link"
                        to={`/test-runs/${testRunQuery.data.id}`}
                      >
                        View full details →
                      </Link>
                    </div>
                  </>
                ) : (
                  <p className="empty-state" style={{ padding: "16px 0" }}>
                    No test running. Configure a run on the left.
                  </p>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <span className="card-title">Active containers</span>
              </div>
              <div className="card-body">
                {activeContainersQuery.isLoading ? (
                  <p className="loading-text">Loading…</p>
                ) : activeContainersQuery.isError ? (
                  <div className="alert alert-error">
                    Failed to list active containers.
                  </div>
                ) : activeContainersQuery.data?.items.length ? (
                  <div className="container-list">
                    {activeContainersQuery.data.items.map((item) => (
                      <div key={item.id} className="container-item">
                        <div className="container-info">
                          <div className="container-name">{item.fileName}</div>
                          <div className="container-meta">
                            {item.containerId?.slice(0, 12) ?? "—"}
                            {item.mappedPort ? (
                              <>
                                {" · "}
                                <a
                                  className="link"
                                  href={`http://localhost:${item.mappedPort}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  :{item.mappedPort}
                                </a>
                              </>
                            ) : null}
                          </div>
                        </div>
                        <StatusBadge status={item.status} />
                        <Link className="link" to={`/test-runs/${item.id}`}>
                          Manage →
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state" style={{ padding: "12px 0" }}>
                    No active containers.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── History (full width) ── */}
        <div className="card" style={{ marginTop: "20px" }}>
          <div className="card-header">
            <span className="card-title">Test history</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={clearHistoryFilters}
              disabled={!hasActiveHistoryFilters}
            >
              Clear filters
            </button>
          </div>
          <div className="card-body">
            {activeFilterChips.length ? (
              <div className="chip-row">
                {activeFilterChips.map((chip) => (
                  <span key={chip} className="chip">
                    {chip}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="filters-bar">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="h-name">File name</label>
                <input
                  id="h-name"
                  type="text"
                  placeholder="e.g. my-app"
                  value={historyFileName}
                  onChange={(event) => {
                    setHistoryFileName(event.target.value);
                    setHistoryPage(1);
                  }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="h-status">Status</label>
                <select
                  id="h-status"
                  value={historyStatus}
                  onChange={(event) => {
                    setHistoryStatus(
                      event.target.value as
                        | ""
                        | "queued"
                        | "running"
                        | "success"
                        | "failed"
                        | "error",
                    );
                    setHistoryPage(1);
                  }}
                >
                  <option value="">All</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="h-from">Start date</label>
                <input
                  id="h-from"
                  type="date"
                  value={historyCreatedFrom}
                  onChange={(event) => {
                    setHistoryCreatedFrom(event.target.value);
                    setHistoryPage(1);
                  }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="h-to">End date</label>
                <input
                  id="h-to"
                  type="date"
                  value={historyCreatedTo}
                  onChange={(event) => {
                    setHistoryCreatedTo(event.target.value);
                    setHistoryPage(1);
                  }}
                />
              </div>
            </div>

            {historyQuery.isLoading ? (
              <p className="loading-text">Loading history…</p>
            ) : null}
            {historyQuery.isError ? (
              <div className="alert alert-error">Failed to load history.</div>
            ) : null}

            {!historyQuery.isLoading && !historyQuery.isError ? (
              paginatedGroups.length ? (
                <>
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Version</th>
                        <th>Status</th>
                        <th>Date</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedGroups.map((group) => (
                        <>
                          <tr
                            key={group.fileName}
                            className="history-row-group"
                          >
                            <td className="file-name">
                              <div className="file-name-cell">
                                {group.rest.length > 0 ? (
                                  <button
                                    type="button"
                                    className="expand-btn"
                                    onClick={() =>
                                      toggleFileExpand(group.fileName)
                                    }
                                    aria-label={
                                      expandedFiles.has(group.fileName)
                                        ? "Collapse"
                                        : "Expand"
                                    }
                                  >
                                    {expandedFiles.has(group.fileName)
                                      ? "▾"
                                      : "▸"}
                                  </button>
                                ) : (
                                  <span className="expand-btn-spacer" />
                                )}
                                <span title={group.fileName}>
                                  {group.fileName}
                                </span>
                                {group.totalCount > 1 ? (
                                  <span className="test-count-chip">
                                    {group.totalCount}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                            <td>
                              <span className="version-tag">
                                {group.latest.versionKey}
                              </span>
                              <span
                                className="version-tag"
                                style={{ marginLeft: 6, opacity: 0.5 }}
                              >
                                ({group.latest.dockerTag})
                              </span>
                            </td>
                            <td>
                              <StatusBadge status={group.latest.status} />
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              {new Date(
                                group.latest.createdAt,
                              ).toLocaleString()}
                            </td>
                            <td className="action-cell">
                              <Link
                                className="link"
                                to={`/test-runs/${group.latest.id}`}
                              >
                                Details →
                              </Link>
                            </td>
                          </tr>
                          {expandedFiles.has(group.fileName)
                            ? group.rest.map((item) => (
                                <tr key={item.id} className="history-row-sub">
                                  <td className="file-name">
                                    <div className="file-name-cell">
                                      <span className="expand-btn-spacer" />
                                      <span
                                        className="sub-row-label"
                                        title={item.createdAt}
                                      >
                                        Previous run
                                      </span>
                                    </div>
                                  </td>
                                  <td>
                                    <span className="version-tag">
                                      {item.versionKey}
                                    </span>
                                    <span
                                      className="version-tag"
                                      style={{ marginLeft: 6, opacity: 0.5 }}
                                    >
                                      ({item.dockerTag})
                                    </span>
                                  </td>
                                  <td>
                                    <StatusBadge status={item.status} />
                                  </td>
                                  <td style={{ whiteSpace: "nowrap" }}>
                                    {new Date(item.createdAt).toLocaleString()}
                                  </td>
                                  <td className="action-cell">
                                    <Link
                                      className="link"
                                      to={`/test-runs/${item.id}`}
                                    >
                                      Details →
                                    </Link>
                                  </td>
                                </tr>
                              ))
                            : null}
                        </>
                      ))}
                    </tbody>
                  </table>

                  {totalHistoryPages > 1 ? (
                    <div className="pagination-bar">
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={historyPage <= 1}
                        onClick={() => setHistoryPage((p) => p - 1)}
                      >
                        ← Prev
                      </button>
                      <span className="pagination-label">
                        Page {historyPage} of {totalHistoryPages}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost"
                        disabled={historyPage >= totalHistoryPages}
                        onClick={() => setHistoryPage((p) => p + 1)}
                      >
                        Next →
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="empty-state">
                  No tests found for the selected filters.
                </p>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Details page ─────────────────────────────────────────────────────────────
function TestRunDetailsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const testRunId = params.id ?? "";
  const consoleRef = useRef<HTMLPreElement | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  const testRunQuery = useQuery({
    queryKey: ["test-run", testRunId],
    queryFn: () => getTestRun(testRunId),
    enabled: !!testRunId,
  });

  const killMutation = useMutation({
    mutationFn: killTestRun,
    onSuccess: async (payload) => {
      queryClient.setQueryData(["test-run", testRunId], payload.item);
      await queryClient.refetchQueries({ queryKey: ["test-run", testRunId] });
      await queryClient.invalidateQueries({ queryKey: ["active-containers"] });
      await queryClient.invalidateQueries({ queryKey: ["test-runs-history"] });
    },
    onError: (error) => {
      console.error("Failed to kill container:", error);
    },
  });

  useEffect(() => {
    if (!testRunId) {
      return;
    }

    let closed = false;

    const closeSse = subscribeToTestRunEvents(testRunId, {
      onUpdate: (record: TestRunRecord) => {
        queryClient.setQueryData(["test-run", testRunId], record);

        if (!closed && isTerminalStatus(record.status)) {
          closed = true;
          closeSse();
          queryClient.invalidateQueries({ queryKey: ["test-runs-history"] });
        }
      },
      onError: () => {
        queryClient.invalidateQueries({ queryKey: ["test-run", testRunId] });
      },
    });

    return () => {
      if (!closed) {
        closeSse();
      }
    };
  }, [queryClient, testRunId]);

  const failureReason = useMemo(
    () => findFailureReason(testRunQuery.data),
    [testRunQuery.data],
  );
  const failureAnalysis = useMemo(
    () => analyzeFailure(testRunQuery.data),
    [testRunQuery.data],
  );

  useEffect(() => {
    const element = consoleRef.current;

    if (!element || !autoScrollEnabled) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [autoScrollEnabled, testRunQuery.data?.logs]);

  const handleConsoleScroll = () => {
    const element = consoleRef.current;

    if (!element) {
      return;
    }

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;

    setAutoScrollEnabled(distanceFromBottom < 20);
  };

  const handleJumpToEnd = () => {
    const element = consoleRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setAutoScrollEnabled(true);
  };

  return (
    <div className="app-shell">
      <AppTopbar breadcrumb="Test details" />
      <div className="page-content">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "20px",
          }}
        >
          <button
            type="button"
            className="btn-ghost"
            onClick={() => navigate("/")}
          >
            ← Back
          </button>
          {testRunQuery.data ? (
            <StatusBadge status={testRunQuery.data.status} />
          ) : null}
          {testRunQuery.data ? (
            <PhaseLabel phase={testRunQuery.data.phase} />
          ) : null}
        </div>

        {testRunQuery.isLoading ? (
          <p className="loading-text">Loading…</p>
        ) : null}
        {testRunQuery.isError ? (
          <div className="alert alert-error">Could not load this test run.</div>
        ) : null}

        {testRunQuery.data ? (
          <div className="stack">
            {/* Metadata + logs */}
            <div className="details-grid">
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Run details</span>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => killMutation.mutate(testRunId)}
                    disabled={
                      killMutation.isPending ||
                      !testRunQuery.data.containerId ||
                      (isTerminalStatus(testRunQuery.data.status) &&
                        !testRunQuery.data.keepAlive)
                    }
                  >
                    {killMutation.isPending ? "Killing…" : "Kill container"}
                  </button>
                </div>
                <div className="card-body">
                  <div className="data-table">
                    <div className="data-row">
                      <span className="data-label">ID</span>
                      <span className="data-value data-value-mono">
                        {testRunQuery.data.id.slice(0, 18)}…
                      </span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">File</span>
                      <span className="data-value data-value-mono">
                        {testRunQuery.data.fileName}
                      </span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Version</span>
                      <span className="data-value data-value-mono">
                        {testRunQuery.data.versionKey}
                      </span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Docker tag</span>
                      <span className="data-value data-value-mono">
                        {testRunQuery.data.dockerTag}
                      </span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Created</span>
                      <span className="data-value">
                        {new Date(testRunQuery.data.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {testRunQuery.data.finishedAt ? (
                      <div className="data-row">
                        <span className="data-label">Finished</span>
                        <span className="data-value">
                          {new Date(
                            testRunQuery.data.finishedAt,
                          ).toLocaleString()}
                        </span>
                      </div>
                    ) : null}
                    {testRunQuery.data.runtimeDeadlineAt ? (
                      <div className="data-row">
                        <span className="data-label">Deadline</span>
                        <span className="data-value">
                          {new Date(
                            testRunQuery.data.runtimeDeadlineAt,
                          ).toLocaleString()}
                        </span>
                      </div>
                    ) : null}
                    {testRunQuery.data.bundleIdentity?.symbolicName ? (
                      <div className="data-row">
                        <span className="data-label">Bundle</span>
                        <span className="data-value data-value-mono">
                          {testRunQuery.data.bundleIdentity.symbolicName}
                          {testRunQuery.data.bundleIdentity.version
                            ? ` (${testRunQuery.data.bundleIdentity.version})`
                            : ""}
                        </span>
                      </div>
                    ) : null}
                    {testRunQuery.data.mappedPort ? (
                      <div className="data-row">
                        <span className="data-label">Portal</span>
                        <a
                          className="link-external"
                          href={`http://localhost:${testRunQuery.data.mappedPort}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          localhost:{testRunQuery.data.mappedPort} ↗
                        </a>
                      </div>
                    ) : null}
                    <div className="data-row">
                      <span className="data-label">Summary</span>
                      <span className="data-value">
                        {testRunQuery.data.resultSummary ?? "Processing…"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <LogConsole
                logs={testRunQuery.data.logs}
                autoScrollEnabled={autoScrollEnabled}
                consoleRef={consoleRef}
                onScroll={handleConsoleScroll}
                onJumpToEnd={handleJumpToEnd}
              />
            </div>

            {/* Deployment evidence */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Deployment evidence</span>
              </div>
              <div className="card-body">
                <EvidencePanel record={testRunQuery.data} />
              </div>
            </div>

            {/* Failure analysis */}
            {failureReason ? (
              <FailurePanel reason={failureReason} analysis={failureAnalysis} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────
export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/test-runs/:id" element={<TestRunDetailsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
