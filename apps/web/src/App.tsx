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

  return matchedLogLine ?? record.resultSummary ?? "Falha sem detalhe de log.";
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

  const reason = findFailureReason(record) ?? "Falha sem detalhe de log.";
  const reasonLower = reason.toLowerCase();

  if (
    /unable to resolve|resolution error|unsatisfied import|bundleexception/.test(
      reasonLower,
    )
  ) {
    return {
      severity: "high",
      category: "Dependências OSGi não resolvidas",
      reason,
      suggestions: [
        "Verifique se o módulo exporta/importa os pacotes corretos no MANIFEST.MF.",
        "Confirme se as dependências exigidas existem na versão DXP escolhida.",
        "Revise a versão de compilação do app e as versões dos bundles dependentes.",
      ],
    };
  }

  if (/classnotfoundexception/.test(reasonLower)) {
    return {
      severity: "high",
      category: "Classe ausente em runtime",
      reason,
      suggestions: [
        "Inclua a dependência faltante no empacotamento correto do módulo.",
        "Evite dependência de classe de pacote não disponível no target DXP.",
        "Valide se houve mudança de API entre versões do Liferay.",
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
      category: "Infraestrutura/ambiente",
      reason,
      suggestions: [
        "Confirme se o Docker está ativo e acessível pelo backend.",
        "Aumente timeout de startup para versões mais pesadas do DXP.",
        "Verifique recursos da máquina (RAM/CPU/disco) durante a execução.",
      ],
    };
  }

  if (/failed to deploy/.test(reasonLower)) {
    return {
      severity: "medium",
      category: "Erro genérico de deploy",
      reason,
      suggestions: [
        "Revise logs completos para identificar classe/pacote que iniciou a falha.",
        "Teste o mesmo artifact em outra versão DXP para comparar compatibilidade.",
        "Valide se o arquivo enviado (.jar/.war) é o build final correto.",
      ],
    };
  }

  return {
    severity: "low",
    category: "Falha não categorizada",
    reason,
    suggestions: [
      "Analise as últimas linhas dos logs para identificar o primeiro erro real.",
      "Repita o teste com logs debug habilitados no app para mais contexto.",
      "Valide versão do Java e compatibilidade do artifact com o DXP escolhido.",
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
    historyFileName ? `Arquivo: ${historyFileName}` : null,
    historyStatus ? `Status: ${historyStatus}` : null,
    historyCreatedFrom ? `De: ${historyCreatedFrom}` : null,
    historyCreatedTo ? `Até: ${historyCreatedTo}` : null,
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
        <p>Upload de .jar/.war com seleção de versão DXP e execução em fila.</p>

        <div className="field">
          <label htmlFor="version">Versão Liferay</label>
          <select
            id="version"
            value={selectedVersion}
            onChange={(event) => {
              setSelectedVersion(event.target.value);
              setSelectedDockerTag("");
            }}
          >
            <option value="">Selecione uma versão</option>
            {versionsQuery.data?.map((version) => (
              <option key={version.key} value={version.key}>
                {version.label} ({version.dockerTag})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="docker-tag">Tag Docker (opcional)</label>
          <select
            id="docker-tag"
            value={selectedDockerTag}
            onChange={(event) => setSelectedDockerTag(event.target.value)}
            disabled={!selectedVersion || dockerTagsQuery.isLoading}
          >
            <option value="">
              Automático ({selectedVersionOption?.dockerTag ?? "tag da versão"})
            </option>
            {filteredDockerTagOptions.map((tag) => (
              <option key={tag.name} value={tag.name}>
                {tag.name}
              </option>
            ))}
          </select>
          {dockerTagsQuery.isError ? (
            <small>Não foi possível carregar tags do Docker Hub agora.</small>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="file">Arquivo</label>
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
          {createTestRunMutation.isPending
            ? "Enfileirando..."
            : "Iniciar teste"}
        </button>

        <label className="checkbox-inline" htmlFor="keep-alive">
          <input
            id="keep-alive"
            type="checkbox"
            checked={keepAlive}
            onChange={(event) => setKeepAlive(event.target.checked)}
          />
          Keep alive (não matar container ao fim do teste)
        </label>

        {selectedFile ? <p>Arquivo selecionado: {selectedFile.name}</p> : null}

        {versionsQuery.isLoading ? <p>Carregando versões...</p> : null}
        {versionsQuery.isError ? <p>Erro ao buscar versões da API.</p> : null}
        {createTestRunMutation.isError ? (
          <p>Erro ao enfileirar teste.</p>
        ) : null}

        {testRunQuery.data ? (
          <section className="result-box">
            <h2>Resultado do teste atual</h2>
            <p>
              <strong>ID:</strong> {testRunQuery.data.id}
            </p>
            <p>
              <strong>Status:</strong> {testRunQuery.data.status}
            </p>
            <p>
              <strong>Fase:</strong> {testRunQuery.data.phase}
            </p>
            <p>
              <strong>Resumo:</strong>{" "}
              {testRunQuery.data.resultSummary ?? "Processando..."}
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
                  Abrir Liferay em localhost:{testRunQuery.data.mappedPort}
                </a>
              </p>
            ) : null}
            <Link
              className="details-link"
              to={`/test-runs/${testRunQuery.data.id}`}
            >
              Ver detalhes do teste
            </Link>
          </section>
        ) : null}

        <section className="result-box">
          <h2>Containers ativos (keep alive)</h2>
          {activeContainersQuery.isLoading ? (
            <p>Carregando containers ativos...</p>
          ) : null}
          {activeContainersQuery.isError ? (
            <p>Erro ao listar containers ativos.</p>
          ) : null}
          {!activeContainersQuery.isLoading &&
          !activeContainersQuery.isError ? (
            activeContainersQuery.data?.items.length ? (
              <div className="history-list">
                {activeContainersQuery.data.items.map((item) => (
                  <article key={item.id} className="history-item">
                    <p>
                      <strong>Teste:</strong> {item.id}
                    </p>
                    <p>
                      <strong>Arquivo:</strong> {item.fileName}
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
                      Gerenciar teste
                    </Link>
                  </article>
                ))}
              </div>
            ) : (
              <p>Nenhum container ativo no momento.</p>
            )
          ) : null}
        </section>

        <section className="result-box">
          <div className="section-title-row">
            <h2>Historico de testes</h2>
            <button
              type="button"
              className="button-secondary"
              onClick={clearHistoryFilters}
              disabled={!hasActiveHistoryFilters}
            >
              Limpar filtros
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
              <label htmlFor="history-file-name">Nome do arquivo</label>
              <input
                id="history-file-name"
                type="text"
                placeholder="ex: meu-app"
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
                <option value="">Todos</option>
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="history-created-from">Data inicial</label>
              <input
                id="history-created-from"
                type="date"
                value={historyCreatedFrom}
                onChange={(event) => setHistoryCreatedFrom(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="history-created-to">Data final</label>
              <input
                id="history-created-to"
                type="date"
                value={historyCreatedTo}
                onChange={(event) => setHistoryCreatedTo(event.target.value)}
              />
            </div>
          </div>

          {historyQuery.isLoading ? <p>Carregando historico...</p> : null}
          {historyQuery.isError ? <p>Erro ao carregar historico.</p> : null}

          {!historyQuery.isLoading && !historyQuery.isError ? (
            <div className="history-list">
              {historyQuery.data?.items.length ? (
                historyQuery.data.items.map((item) => (
                  <article key={item.id} className="history-item">
                    <p>
                      <strong>Arquivo:</strong> {item.fileName}
                    </p>
                    <p>
                      <strong>Status:</strong> {item.status}
                    </p>
                    <p>
                      <strong>Data:</strong>{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </p>
                    <p>
                      <strong>Versao:</strong> {item.versionKey} (
                      {item.dockerTag})
                    </p>
                    <Link className="details-link" to={`/test-runs/${item.id}`}>
                      Ver detalhes
                    </Link>
                  </article>
                ))
              ) : (
                <p>Nenhum teste encontrado para os filtros informados.</p>
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
          <h1>Detalhes do teste</h1>
          <button
            type="button"
            className="button-secondary"
            onClick={() => navigate("/")}
          >
            Voltar
          </button>
        </div>

        {testRunQuery.isLoading ? <p>Carregando detalhes...</p> : null}
        {testRunQuery.isError ? (
          <p>Não foi possível carregar este teste.</p>
        ) : null}

        {testRunQuery.data ? (
          <section className="result-box details-panel">
            <p>
              <strong>ID:</strong> {testRunQuery.data.id}
            </p>
            <p>
              <strong>Arquivo:</strong> {testRunQuery.data.fileName}
            </p>
            <p>
              <strong>Status:</strong> {testRunQuery.data.status}
            </p>
            <p>
              <strong>Fase:</strong> {testRunQuery.data.phase}
            </p>
            <p>
              <strong>Versão:</strong> {testRunQuery.data.versionKey} (
              {testRunQuery.data.dockerTag})
            </p>
            <p>
              <strong>Criado em:</strong>{" "}
              {new Date(testRunQuery.data.createdAt).toLocaleString()}
            </p>
            <p>
              <strong>Resumo:</strong>{" "}
              {testRunQuery.data.resultSummary ?? "Processando..."}
            </p>
            <p>
              <strong>Bundle detectado:</strong>{" "}
              {testRunQuery.data.bundleIdentity?.symbolicName ??
                "Não detectado"}
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
                  Abrir Liferay em localhost:{testRunQuery.data.mappedPort}
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
                  ? "Matando container..."
                  : "Matar container"}
              </button>
            </div>

            <h2>Evidências de deploy</h2>
            <div className="evidence-box">
              <p>
                <strong>Processing detectado:</strong>{" "}
                {testRunQuery.data.deployEvidence?.processingLine ??
                  "Não detectado"}
              </p>
              <p>
                <strong>STARTED detectado:</strong>{" "}
                {testRunQuery.data.deployEvidence?.startedLine ??
                  "Não detectado"}
              </p>
              <p>
                <strong>Primeira falha detectada:</strong>{" "}
                {testRunQuery.data.deployEvidence?.firstFailureLine ??
                  "Não detectado"}
              </p>
              <p>
                <strong>STARTED candidatos:</strong>{" "}
                {testRunQuery.data.startedBundleCandidates.length
                  ? testRunQuery.data.startedBundleCandidates.join(" | ")
                  : "Não detectado"}
              </p>
            </div>

            {failureReason ? (
              <div className="failure-box">
                <div className="failure-header-row">
                  <strong>Motivo provável da falha:</strong>
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
                    <strong>Categoria:</strong> {failureAnalysis.category}
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
                  ? "Auto-scroll ligado"
                  : "Auto-scroll pausado (role para baixo para retomar)"}
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
                Ir para o fim
              </button>
            </div>
            <pre
              ref={consoleRef}
              onScroll={handleConsoleScroll}
              className="live-console"
            >
              {testRunQuery.data.logs.join("\n") ||
                "Sem logs relevantes ainda."}
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
