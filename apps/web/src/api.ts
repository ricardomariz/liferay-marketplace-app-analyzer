import type { LiferayVersionOption, VersionsResponse } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

const TOKEN_KEY = "auth_token";

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = getAuthToken();
  return token
    ? { Authorization: `Bearer ${token}`, ...(extra as object) }
    : { ...(extra as object) };
}

async function authFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    headers: { ...authHeaders(init.headers as HeadersInit) },
  });

  if (response.status === 401) {
    clearAuthToken();
    window.location.reload();
  }

  return response;
}

export type TestRunRecord = {
  id: string;
  userId: string;
  fileName: string;
  fileSize: number;
  filePath: string;
  versionKey: string;
  dockerTag: string;
  keepAlive: boolean;
  status: "queued" | "running" | "success" | "failed" | "error" | "unknown";
  phase: string;
  resultSummary: string | null;
  deployEvidence: {
    processingLine?: string;
    startedLine?: string;
    firstFailureLine?: string;
  } | null;
  bundleIdentity?: {
    symbolicName?: string;
    version?: string;
  };
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

export type TestRunHistoryFilters = {
  fileName?: string;
  createdFrom?: string;
  createdTo?: string;
  status?: TestRunRecord["status"];
};

export type DockerTagOption = {
  name: string;
  lastUpdated?: string;
};

export async function fetchVersions(): Promise<LiferayVersionOption[]> {
  const response = await authFetch(`${API_BASE_URL}/api/versions`);

  if (!response.ok) {
    throw new Error("Failed to fetch versions");
  }

  const data = (await response.json()) as VersionsResponse;
  return data.versions;
}

export async function createTestRun(input: {
  file: File;
  versionKey: string;
  keepAlive: boolean;
  dockerTag?: string;
}) {
  const formData = new FormData();
  formData.append("file", input.file);
  formData.append("versionKey", input.versionKey);
  formData.append("keepAlive", input.keepAlive ? "true" : "false");

  if (input.dockerTag) {
    formData.append("dockerTag", input.dockerTag);
  }

  const response = await authFetch(`${API_BASE_URL}/api/test-runs`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };

    if (
      response.status === 409 &&
      errorPayload.error === "container_already_active"
    ) {
      const err = new Error("container_already_active");
      err.name = "ContainerAlreadyActiveError";
      throw err;
    }

    throw new Error(
      `Failed to create test run: ${JSON.stringify(errorPayload)}`,
    );
  }

  return response.json() as Promise<{
    testRunId: string;
    status: TestRunRecord["status"];
  }>;
}

export async function fetchDockerTags(
  prefix?: string,
): Promise<DockerTagOption[]> {
  const url = new URL(`${API_BASE_URL}/api/versions/tags`);
  if (prefix) url.searchParams.set("prefix", prefix);
  const response = await authFetch(url.toString());

  if (!response.ok) {
    throw new Error("Failed to fetch Docker tags");
  }

  const data = (await response.json()) as {
    tags?: DockerTagOption[];
  };

  return Array.isArray(data.tags) ? data.tags : [];
}

export async function getTestRun(id: string): Promise<TestRunRecord> {
  const response = await authFetch(`${API_BASE_URL}/api/test-runs/${id}`);

  if (!response.ok) {
    throw new Error("Failed to load test run");
  }

  return response.json() as Promise<TestRunRecord>;
}

export async function listTestRuns(filters: TestRunHistoryFilters = {}) {
  const params = new URLSearchParams();

  if (filters.fileName) {
    params.set("fileName", filters.fileName);
  }

  if (filters.createdFrom) {
    params.set("createdFrom", filters.createdFrom);
  }

  if (filters.createdTo) {
    params.set("createdTo", filters.createdTo);
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  const response = await authFetch(`${API_BASE_URL}/api/test-runs${suffix}`);

  if (!response.ok) {
    throw new Error("Failed to list test runs");
  }

  return response.json() as Promise<{
    items: TestRunRecord[];
    queueSize: number;
  }>;
}

export function subscribeToTestRunEvents(
  id: string,
  handlers: {
    onUpdate: (record: TestRunRecord) => void;
    onError?: () => void;
  },
) {
  const token = getAuthToken();
  const url = new URL(`${API_BASE_URL}/api/test-runs/${id}/events`);
  if (token) url.searchParams.set("token", token);

  const eventSource = new EventSource(url.toString());

  const processMessage = (event: MessageEvent) => {
    try {
      const record = JSON.parse(event.data) as TestRunRecord;
      handlers.onUpdate(record);
    } catch {
      // Ignore malformed events.
    }
  };

  eventSource.addEventListener("snapshot", processMessage);
  eventSource.addEventListener("test-run-update", processMessage);

  eventSource.onerror = () => {
    handlers.onError?.();
  };

  return () => {
    eventSource.close();
  };
}

export async function killTestRun(id: string) {
  const response = await authFetch(`${API_BASE_URL}/api/test-runs/${id}/kill`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error("Failed to kill test run container");
  }

  return response.json() as Promise<{
    killed: boolean;
    item: TestRunRecord;
  }>;
}

export async function listActiveContainers() {
  const response = await authFetch(
    `${API_BASE_URL}/api/test-runs-active-containers`,
  );

  if (!response.ok) {
    throw new Error("Failed to list active containers");
  }

  return response.json() as Promise<{
    items: Array<{
      id: string;
      fileName: string;
      status: TestRunRecord["status"];
      phase: string;
      containerId: string | null;
      mappedPort: number | null;
      keepAlive: boolean;
      createdAt: string;
      finishedAt: string | null;
    }>;
  }>;
}
