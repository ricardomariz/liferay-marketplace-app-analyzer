import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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
  };

  return (
    <main className="page">
      <section className="card">
        <h1>Liferay App Analyzer</h1>
        <p>
          Upload .jar/.war files, select a DXP version, and run tests in queue.
        </p>

        <div className="field">
          <label htmlFor="version">Liferay Version</label>
          <select
            id="version"
            value={selectedVersion}
            onChange={(event) => {
              setSelectedVersion(event.target.value);
              setSelectedDockerTag("");
            }}
          >
            <option value="">Select a version</option>
            {versionsQuery.data?.map((version) => (
              <option key={version.key} value={version.key}>
                {version.label} ({version.dockerTag})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="docker-tag">Docker Tag (optional)</label>
          <select
            id="docker-tag"
            value={selectedDockerTag}
            onChange={(event) => setSelectedDockerTag(event.target.value)}
            disabled={!selectedVersion || dockerTagsQuery.isLoading}
          >
            <option value="">
              Automatic ({selectedVersionOption?.dockerTag ?? "version tag"})
            </option>
            {filteredDockerTagOptions.map((tag) => (
              <option key={tag.name} value={tag.name}>
                {tag.name}
              </option>
            ))}
          </select>
          {dockerTagsQuery.isError ? (
            <small>Could not load Docker Hub tags right now.</small>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="file">File</label>
          <input
            id="file"
            type="file"
            accept=".jar,.war"
            onChange={(event) =>
              setSelectedFile(event.target.files?.[0] ?? null)
            }
          />
        </div>

        <button type="button" disabled={!canSubmit} onClick={handleSubmit}>
          {createTestRunMutation.isPending ? "Queueing..." : "Start test"}
        </button>

        <label className="checkbox-inline" htmlFor="keep-alive">
          <input
            id="keep-alive"
            type="checkbox"
            checked={keepAlive}
            onChange={(event) => setKeepAlive(event.target.checked)}
          />
          Keep alive (do not stop container at the end of the test)
        </label>

        {selectedFile ? <p>Selected file: {selectedFile.name}</p> : null}

        {versionsQuery.isLoading ? <p>Loading versions...</p> : null}
        {versionsQuery.isError ? (
          <p>Failed to fetch versions from API.</p>
        ) : null}
        {createTestRunMutation.isError ? <p>Failed to queue test.</p> : null}

        {testRunQuery.data ? (
          <section className="result-box">
            <h2>Current test result</h2>
            <p>
              <strong>ID:</strong> {testRunQuery.data.id}
            </p>
            <p>
              <strong>Status:</strong> {testRunQuery.data.status}
            </p>
            <p>
              <strong>Phase:</strong> {testRunQuery.data.phase}
            </p>
            <p>
              <strong>Summary:</strong>{" "}
              {testRunQuery.data.resultSummary ?? "Processing..."}
            </p>
            {testRunQuery.data.mappedPort ? (
              <p>
                <strong>Portal:</strong>{" "}
                <a
                  className="details-link"
                  href={`http://localhost:${testRunQuery.data.mappedPort}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Liferay at localhost:{testRunQuery.data.mappedPort}
                </a>
              </p>
            ) : null}
            <Link
              className="details-link"
              to={`/test-runs/${testRunQuery.data.id}`}
            >
              View test details
            </Link>
          </section>
        ) : null}

        <section className="result-box">
          <h2>Active containers (keep alive)</h2>
          {activeContainersQuery.isLoading ? (
            <p>Loading active containers...</p>
          ) : null}
          {activeContainersQuery.isError ? (
            <p>Failed to list active containers.</p>
          ) : null}
          {!activeContainersQuery.isLoading &&
          !activeContainersQuery.isError ? (
            activeContainersQuery.data?.items.length ? (
              <div className="history-list">
                {activeContainersQuery.data.items.map((item) => (
                  <article key={item.id} className="history-item">
                    <p>
                      <strong>Test run:</strong> {item.id}
                    </p>
                    <p>
                      <strong>File:</strong> {item.fileName}
                    </p>
                    <p>
                      <strong>Container:</strong> {item.containerId ?? "N/A"}
                    </p>
                    <p>
                      <strong>Portal:</strong>{" "}
                      {item.mappedPort ? (
                        <a
                          className="details-link"
                          href={`http://localhost:${item.mappedPort}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          localhost:{item.mappedPort}
                        </a>
                      ) : (
                        "N/A"
                      )}
                    </p>
                    <Link className="details-link" to={`/test-runs/${item.id}`}>
                      Manage test
                    </Link>
                  </article>
                ))}
              </div>
            ) : (
              <p>No active containers at the moment.</p>
            )
          ) : null}
        </section>

        <section className="result-box">
          <div className="section-title-row">
            <h2>Test history</h2>
            <button
              type="button"
              className="button-secondary"
              onClick={clearHistoryFilters}
              disabled={!hasActiveHistoryFilters}
            >
              Clear filters
            </button>
          </div>

          {activeFilterChips.length ? (
            <div className="chip-row">
              {activeFilterChips.map((chip) => (
                <span key={chip} className="chip">
                  {chip}
                </span>
              ))}
            </div>
          ) : null}

          <div className="history-filters">
            <div className="field">
              <label htmlFor="history-file-name">File name</label>
              <input
                id="history-file-name"
                type="text"
                placeholder="e.g. my-app"
                value={historyFileName}
                onChange={(event) => setHistoryFileName(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="history-status">Status</label>
              <select
                id="history-status"
                value={historyStatus}
                onChange={(event) =>
                  setHistoryStatus(
                    event.target.value as
                      | ""
                      | "queued"
                      | "running"
                      | "success"
                      | "failed"
                      | "error",
                  )
                }
              >
                <option value="">All</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="history-created-from">Start date</label>
              <input
                id="history-created-from"
                type="date"
                value={historyCreatedFrom}
                onChange={(event) => setHistoryCreatedFrom(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="history-created-to">End date</label>
              <input
                id="history-created-to"
                type="date"
                value={historyCreatedTo}
                onChange={(event) => setHistoryCreatedTo(event.target.value)}
              />
            </div>
          </div>

          {historyQuery.isLoading ? <p>Loading history...</p> : null}
          {historyQuery.isError ? <p>Failed to load history.</p> : null}

          {!historyQuery.isLoading && !historyQuery.isError ? (
            <div className="history-list">
              {historyQuery.data?.items.length ? (
                historyQuery.data.items.map((item) => (
                  <article key={item.id} className="history-item">
                    <p>
                      <strong>File:</strong> {item.fileName}
                    </p>
                    <p>
                      <strong>Status:</strong> {item.status}
                    </p>
                    <p>
                      <strong>Date:</strong>{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                    <p>
                      <strong>Version:</strong> {item.versionKey} (
                      {item.dockerTag})
                    </p>
                    <Link className="details-link" to={`/test-runs/${item.id}`}>
                      View details
                    </Link>
                  </article>
                ))
              ) : (
                <p>No tests found for the selected filters.</p>
              )}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

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
      await queryClient.invalidateQueries({ queryKey: ["active-containers"] });
      await queryClient.invalidateQueries({ queryKey: ["test-runs-history"] });
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

  return (
    <main className="page">
      <section className="card">
        <div className="section-title-row">
          <h1>Test details</h1>
          <button
            type="button"
            className="button-secondary"
            onClick={() => navigate("/")}
          >
            Back
          </button>
        </div>

        {testRunQuery.isLoading ? <p>Loading details...</p> : null}
        {testRunQuery.isError ? <p>Could not load this test run.</p> : null}

        {testRunQuery.data ? (
          <section className="result-box details-panel">
            <p>
              <strong>ID:</strong> {testRunQuery.data.id}
            </p>
            <p>
              <strong>File:</strong> {testRunQuery.data.fileName}
            </p>
            <p>
              <strong>Status:</strong> {testRunQuery.data.status}
            </p>
            <p>
              <strong>Phase:</strong> {testRunQuery.data.phase}
            </p>
            <p>
              <strong>Version:</strong> {testRunQuery.data.versionKey} (
              {testRunQuery.data.dockerTag})
            </p>
            <p>
              <strong>Created at:</strong>{" "}
              {new Date(testRunQuery.data.createdAt).toLocaleString()}
            </p>
            <p>
              <strong>Summary:</strong>{" "}
              {testRunQuery.data.resultSummary ?? "Processing..."}
            </p>
            <p>
              <strong>Detected bundle:</strong>{" "}
              {testRunQuery.data.bundleIdentity?.symbolicName ?? "Not detected"}
              {testRunQuery.data.bundleIdentity?.version
                ? ` (${testRunQuery.data.bundleIdentity.version})`
                : ""}
            </p>
            {testRunQuery.data.runtimeDeadlineAt ? (
              <p>
                <strong>Deadline:</strong>{" "}
                {new Date(testRunQuery.data.runtimeDeadlineAt).toLocaleString()}
              </p>
            ) : null}
            {testRunQuery.data.mappedPort ? (
              <p>
                <strong>Portal:</strong>{" "}
                <a
                  className="details-link"
                  href={`http://localhost:${testRunQuery.data.mappedPort}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Liferay at localhost:{testRunQuery.data.mappedPort}
                </a>
              </p>
            ) : null}

            <div className="action-row">
              <button
                type="button"
                className="button-secondary"
                onClick={() => killMutation.mutate(testRunId)}
                disabled={
                  killMutation.isPending ||
                  !testRunQuery.data.containerId ||
                  isTerminalStatus(testRunQuery.data.status)
                }
              >
                {killMutation.isPending
                  ? "Killing container..."
                  : "Kill container"}
              </button>
            </div>

            <h2>Deployment evidence</h2>
            <div className="evidence-box">
              <p>
                <strong>Detected Processing:</strong>{" "}
                {testRunQuery.data.deployEvidence?.processingLine ??
                  "Not detected"}
              </p>
              <p>
                <strong>Detected STARTED:</strong>{" "}
                {testRunQuery.data.deployEvidence?.startedLine ??
                  "Not detected"}
              </p>
              <p>
                <strong>First detected failure:</strong>{" "}
                {testRunQuery.data.deployEvidence?.firstFailureLine ??
                  "Not detected"}
              </p>
              <p>
                <strong>STARTED candidates:</strong>{" "}
                {testRunQuery.data.startedBundleCandidates.length
                  ? testRunQuery.data.startedBundleCandidates.join(" | ")
                  : "Not detected"}
              </p>
            </div>

            {failureReason ? (
              <div className="failure-box">
                <div className="failure-header-row">
                  <strong>Likely failure reason:</strong>
                  {failureAnalysis ? (
                    <span
                      className={`severity-badge severity-${failureAnalysis.severity}`}
                    >
                      {failureAnalysis.severity}
                    </span>
                  ) : null}
                </div>
                {failureAnalysis ? (
                  <p>
                    <strong>Category:</strong> {failureAnalysis.category}
                  </p>
                ) : null}
                <p>{failureReason}</p>
                {failureAnalysis?.suggestions?.length ? (
                  <ul className="suggestions-list">
                    {failureAnalysis.suggestions.map((suggestion) => (
                      <li key={suggestion}>{suggestion}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <h2>Logs</h2>
            <div className="console-toolbar">
              <span>
                {autoScrollEnabled
                  ? "Auto-scroll enabled"
                  : "Auto-scroll paused (scroll down to resume)"}
              </span>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  const element = consoleRef.current;

                  if (!element) {
                    return;
                  }

                  element.scrollTop = element.scrollHeight;
                  setAutoScrollEnabled(true);
                }}
              >
                Jump to end
              </button>
            </div>
            <pre
              ref={consoleRef}
              onScroll={handleConsoleScroll}
              className="live-console"
            >
              {testRunQuery.data.logs.join("\n") || "No relevant logs yet."}
            </pre>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/test-runs/:id" element={<TestRunDetailsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
