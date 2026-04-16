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
const MAX_PREFIX_PAGES = 2;

let cache: {
  fetchedAt: number;
  tags: DockerHubTag[];
} | null = null;

const prefixCache = new Map<
  string,
  { fetchedAt: number; tags: DockerHubTag[] }
>();

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

// Matches LTS quarterly patch tags: YYYY.qN.NUMBER-lts
// e.g. "2025.q3.12-lts" ✓
const LTS_QUARTERLY_TAG_RE = /^\d{4}\.q\d+\.(\d+)-lts$/i;

function pickBestQuarterlyTag(
  preferredTag: string,
  tags: DockerHubTag[],
): string | undefined {
  const ltsMatches = tags.filter(
    (tag) =>
      tag.name.startsWith(`${preferredTag}.`) &&
      LTS_QUARTERLY_TAG_RE.test(tag.name),
  );

  if (ltsMatches.length > 0) {
    ltsMatches.sort((a, b) => {
      const patchA = Number(LTS_QUARTERLY_TAG_RE.exec(a.name)?.[1] ?? 0);
      const patchB = Number(LTS_QUARTERLY_TAG_RE.exec(b.name)?.[1] ?? 0);
      return patchB - patchA;
    });

    return ltsMatches[0]?.name;
  }

  const plainMatches = tags.filter(
    (tag) =>
      tag.name.startsWith(`${preferredTag}.`) &&
      CLEAN_QUARTERLY_TAG_RE.test(tag.name),
  );

  if (plainMatches.length === 0) {
    return undefined;
  }

  plainMatches.sort((a, b) => {
    const patchA = Number(CLEAN_QUARTERLY_TAG_RE.exec(a.name)?.[1] ?? 0);
    const patchB = Number(CLEAN_QUARTERLY_TAG_RE.exec(b.name)?.[1] ?? 0);
    return patchB - patchA;
  });

  return plainMatches[0]?.name;
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

async function fetchTagsForPrefix(prefix: string): Promise<DockerHubTag[]> {
  const cached = prefixCache.get(prefix);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tags;
  }

  const baseUrl = `https://hub.docker.com/v2/repositories/liferay/dxp/tags?page_size=100&name=${encodeURIComponent(prefix)}`;
  let nextUrl: string | null | undefined = baseUrl;
  let page = 0;
  const collected: DockerHubTag[] = [];

  while (nextUrl && page < MAX_PREFIX_PAGES) {
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

  const tags = [...uniqueTags.values()];
  prefixCache.set(prefix, { fetchedAt: Date.now(), tags });

  return tags;
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
  return Promise.all(
    options.map(async (option) => {
      // For quarterly tags use a targeted prefix search so older quarters
      // (e.g. 2024.q2) are not lost to the global 1000-tag page limit.
      const tags = option.dockerTag.includes(".q")
        ? await fetchTagsForPrefix(option.dockerTag)
        : await listLiferayDxpDockerHubTags();

      const resolvedTag = pickFallbackTag(option.dockerTag, tags);

      if (!resolvedTag) {
        return option;
      }

      return {
        ...option,
        dockerTag: resolvedTag,
      };
    }),
  );
}

export async function resolveLiferayDockerTag(preferredTag: string) {
  const tags = preferredTag.includes(".q")
    ? await fetchTagsForPrefix(preferredTag)
    : await listLiferayDxpDockerHubTags();
  return pickFallbackTag(preferredTag, tags);
}
