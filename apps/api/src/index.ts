import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import { Hono } from "hono";
import { authRoute } from "./routes/auth";
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

// Public routes — no auth required
app.route("/api", authRoute);
app.route("/api", healthRoute);

// JWT guard for all other /api/* routes.
// Also accepts ?token= query param for EventSource (SSE) connections.
app.use("/api/*", async (c, next) => {
  const secret = process.env.AUTH_SECRET ?? "change-me";

  // Allow token via query param for SSE routes that can't set headers.
  const queryToken = c.req.query("token");
  if (queryToken) {
    c.req.raw.headers.set("Authorization", `Bearer ${queryToken}`);
  }

  return jwt({ secret, alg: "HS256" })(c, next);
});

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
