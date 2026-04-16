import { Hono } from "hono";
import { sign } from "hono/jwt";

export const authRoute = new Hono();

authRoute.post("/auth/login", async (c) => {
  const { username, password } = await c.req.json<{
    username: string;
    password: string;
  }>();

  const validUsername = process.env.AUTH_USERNAME ?? "marketplace";
  const validPassword = process.env.AUTH_PASSWORD ?? "liferay";
  const secret = process.env.AUTH_SECRET ?? "change-me";

  if (username !== validUsername || password !== validPassword) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 8 * 60 * 60; // 8 hours

  const token = await sign({ sub: username, exp: expiresAt }, secret, "HS256");

  return c.json({ token });
});
