import type { LiferayVersionOption } from "@lma/shared";

type DockerHubTag = {
  name: string;
  last_updated?: string;
};

export type DockerHubTagOption = {
  name: string;
  lastUpdated?: string;
};

type DockerHubTagsResponse = {
  next?: string | null;
  results?: DockerHubTag[];
};

const DOCKER_HUB_BASE_TAGS_URL =
  "https://hub.docker.com/v2/repositories/liferay/dxp/tags?page_size=100";
const CACHE_TTL_MS = 5 * 60_000;
const MAX_TAG_PAGES = 10;

let cache: {
  fetchedAt: number;
  tags: DockerHubTag[];
} | null = null;

function toMillis(value: string | undefined) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByUpdateDesc(a: DockerHubTag, b: DockerHubTag) {
  return toMillis(b.last_updated) - toMillis(a.last_updated);
}

function matchesPreferredPrefix(tagName: string, preferredTag: string) {
  return (
    tagName === preferredTag ||
    tagName.startsWith(`${preferredTag}.`) ||
    tagName.startsWith(`${preferredTag}-`)
  );
}

// Matches only clean quarterly patch tags: YYYY.qN.NUMBER with nothing after.
// e.g. "2025.q3.12" ✓   "2025.q3.12-d10.0.3-20260212101814" ✗
const CLEAN_QUARTERLY_TAG_RE = /^\d{4}\.q\d+\.(\d+)$/i;

function pickBestQuarterlyTag(
  preferredTag: string,
  tags: DockerHubTag[],
): string | undefined {
  const cleanMatches = tags.filter(
    (tag) =>
      tag.name.startsWith(`${preferredTag}.`) &&
      CLEAN_QUARTERLY_TAG_RE.test(tag.name),
  );

  if (cleanMatches.length === 0) {
    return undefined;
  }

  // Sort by patch number descending (numeric, not lexicographic).
  cleanMatches.sort((a, b) => {
    const patchA = Number(CLEAN_QUARTERLY_TAG_RE.exec(a.name)?.[1] ?? 0);
    const patchB = Number(CLEAN_QUARTERLY_TAG_RE.exec(b.name)?.[1] ?? 0);
    return patchB - patchA;
  });

  return cleanMatches[0]?.name;
}

function pickFallbackTag(preferredTag: string, tags: DockerHubTag[]) {
  const direct = tags.find((tag) => tag.name === preferredTag);

  if (direct) {
    return direct.name;
  }

  // For quarterly tags, pick the highest clean patch version (no suffix).
  // Fall back to YYYY.qN.0 if nothing is found.
  if (preferredTag.includes(".q")) {
    const best = pickBestQuarterlyTag(preferredTag, tags);
    if (best) {
      return best;
    }

    const dotZeroTag = `${preferredTag}.0`;
    return tags.find((tag) => tag.name === dotZeroTag)?.name ?? dotZeroTag;
  }

  const prefixMatches = tags.filter((tag) =>
    matchesPreferredPrefix(tag.name, preferredTag),
  );

  if (prefixMatches.length > 0) {
    return prefixMatches.sort(sortByUpdateDesc)[0]?.name;
  }

  const ltsTag = tags.find((tag) => tag.name.includes("-lts"));

  if (ltsTag) {
    return ltsTag.name;
  }

  return tags[0]?.name;
}

export async function listLiferayDxpDockerHubTags() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.tags;
  }

  let nextUrl: string | null | undefined = DOCKER_HUB_BASE_TAGS_URL;
  let page = 0;
  const collected: DockerHubTag[] = [];

  while (nextUrl && page < MAX_TAG_PAGES) {
    page += 1;
    const response = await fetch(nextUrl);

    if (!response.ok) {
      throw new Error(`Docker Hub tags request failed with ${response.status}`);
    }

    const payload = (await response.json()) as DockerHubTagsResponse;

    if (Array.isArray(payload.results)) {
      collected.push(
        ...payload.results.filter(
          (tag): tag is DockerHubTag =>
            typeof tag?.name === "string" && tag.name.length > 0,
        ),
      );
    }

    nextUrl = payload.next;
  }

  const uniqueTags = new Map<string, DockerHubTag>();

  for (const tag of collected) {
    uniqueTags.set(tag.name, tag);
  }

  const tags = [...uniqueTags.values()].sort(sortByUpdateDesc);
  cache = {
    fetchedAt: Date.now(),
    tags,
  };

  return tags;
}

export async function listLiferayDockerTagOptions(limit = 120) {
  const tags = await listLiferayDxpDockerHubTags();

  return tags.slice(0, Math.max(1, limit)).map(
    (tag) =>
      ({
        name: tag.name,
        lastUpdated: tag.last_updated,
      }) satisfies DockerHubTagOption,
  );
}

export async function resolveLiferayVersionOptions(
  options: LiferayVersionOption[],
) {
  const tags = await listLiferayDxpDockerHubTags();

  return options.map((option) => {
    const resolvedTag = pickFallbackTag(option.dockerTag, tags);

    if (!resolvedTag) {
      return option;
    }

    return {
      ...option,
      dockerTag: resolvedTag,
    };
  });
}

export async function resolveLiferayDockerTag(preferredTag: string) {
  const tags = await listLiferayDxpDockerHubTags();
  return pickFallbackTag(preferredTag, tags);
}
