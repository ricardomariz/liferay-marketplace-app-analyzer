import { Hono } from "hono";
import { LIFERAY_VERSION_OPTIONS } from "../config/liferay-versions";
import {
  fetchTagsForPrefix,
  listLiferayDockerTagOptions,
  resolveLiferayVersionOptions,
} from "../services/docker-hub";

export const versionsRoute = new Hono();

versionsRoute.get("/versions/available", async (c) => {
  try {
    const versions = await resolveLiferayVersionOptions(
      LIFERAY_VERSION_OPTIONS,
    );

    return c.json({
      versions,
    });
  } catch {
    return c.json({
      versions: LIFERAY_VERSION_OPTIONS,
    });
  }
});

versionsRoute.get("/versions", async (c) => {
  try {
    const versions = await resolveLiferayVersionOptions(
      LIFERAY_VERSION_OPTIONS,
    );

    return c.json({
      versions,
    });
  } catch {
    return c.json({
      versions: LIFERAY_VERSION_OPTIONS,
    });
  }
});

versionsRoute.get("/versions/tags", async (c) => {
  const prefix = c.req.query("prefix")?.trim() ?? "";

  try {
    if (prefix) {
      const raw = await fetchTagsForPrefix(prefix);
      const tags = raw.map((tag) => ({
        name: tag.name,
        lastUpdated: tag.last_updated,
      }));
      return c.json({ tags });
    }

    const tags = await listLiferayDockerTagOptions();
    return c.json({ tags });
  } catch {
    return c.json({ tags: [] });
  }
});
