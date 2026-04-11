const FAILURE_PATTERNS = [
  /resolution error/i,
  /unable to resolve/i,
  /classnotfoundexception/i,
  /bundleexception/i,
  /failed to deploy/i,
  /unsatisfied import/i,
  /unable to start bundle/i,
  /could not resolve module/i,
  /error \[fileinstall-directory-watcher\]/i,
];

export type ParsedLogResult = {
  success: boolean;
  failed: boolean;
  matchedLines: string[];
  processingLine?: string;
  firstFailureLine?: string;
  successLine?: string;
  deployedAppName?: string;
  startedCandidates: string[];
};

export function sanitizeLogLine(line: string) {
  return line
    .replace(/^[\x00-\x1f\x7f-\x9f]+/, "")
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    .trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseDeploymentLogs(
  lines: string[],
  artifactFileName: string,
  bundleSymbolicName?: string,
): ParsedLogResult {
  const artifactBaseName = artifactFileName.replace(/\.(jar|war)$/i, "");
  const escapedFileName = escapeRegex(artifactFileName);
  const expectedBundlePrefix =
    bundleSymbolicName ?? artifactBaseName.replace(/-\d+$/, "");
  const escapedBundlePrefix = escapeRegex(expectedBundlePrefix);

  const processingPattern = new RegExp(`processing\\s+${escapedFileName}`, "i");
  const startedBundlePattern = new RegExp(
    `\\bSTARTED\\s+(${escapedBundlePrefix}[^\s\[]*)`,
    "i",
  );
  const watcherLinePattern = /\[fileinstall-directory-watcher\]/i;
  const unableToStartBundlePattern = /unable to start bundle:/i;

  const matchedLines: string[] = [];
  let sawProcessing = false;
  let processingLine: string | undefined;
  let firstFailureLine: string | undefined;
  let successLine: string | undefined;
  let deployedAppName: string | undefined;
  let success = false;
  let failed = false;
  const startedCandidates: string[] = [];

  for (const rawLine of lines) {
    const line = sanitizeLogLine(rawLine);

    if (!line) {
      continue;
    }

    if (processingPattern.test(line)) {
      sawProcessing = true;
      processingLine ??= line;
      matchedLines.push(line);
    }

    if (!sawProcessing) {
      continue;
    }

    if (!watcherLinePattern.test(line)) {
      // We only evaluate watcher lines after Processing the uploaded artifact.
      continue;
    }

    if (/\bSTARTED\b/i.test(line)) {
      startedCandidates.push(line);
    }

    const startedMatch = line.match(startedBundlePattern);

    if (startedMatch) {
      success = true;
      successLine ??= line;
      deployedAppName ??= startedMatch[1];
      matchedLines.push(line);
      continue;
    }

    if (unableToStartBundlePattern.test(line)) {
      failed = true;
      firstFailureLine ??= line;
      matchedLines.push(line);
      continue;
    }

    if (FAILURE_PATTERNS.some((pattern) => pattern.test(line))) {
      failed = true;
      firstFailureLine ??= line;
      matchedLines.push(line);
      continue;
    }
  }

  return {
    success,
    failed,
    matchedLines,
    processingLine,
    firstFailureLine,
    successLine,
    deployedAppName,
    startedCandidates,
  };
}
