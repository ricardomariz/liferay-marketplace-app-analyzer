import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { testRunsRoute } from "./routes/test-runs";
import { versionsRoute } from "./routes/versions";
import { recoverStaleRuns } from "./services/startup-recovery";

const app = new Hono();

app.use("*", cors());

app.get("/", (c) =>
  c.json({
    name: "liferay-marketplace-app-analyzer-api",
    status: "running",
  }),
);

app.route("/api", healthRoute);
app.route("/api", versionsRoute);
app.route("/api", testRunsRoute);

const port = Number(process.env.PORT ?? 3001);

recoverStaleRuns().catch((err) => {
  console.error("[startup-recovery] Recovery failed:", err);
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`API server running on http://localhost:${info.port}`);
  },
);
