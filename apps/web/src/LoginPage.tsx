import { useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

type Props = {
  onLogin: (token: string) => void;
};

export function LoginPage({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        setError("Invalid username or password.");
        return;
      }

      const data = (await response.json()) as { token: string };
      onLogin(data.token);
    } catch {
      setError("Could not connect to the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f4f5f7",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          background: "#fff",
          borderRadius: 8,
          padding: "2.5rem 2rem",
          width: 340,
          boxShadow: "0 2px 16px rgba(0,0,0,0.10)",
          display: "flex",
          flexDirection: "column",
          gap: "1.25rem",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "1.25rem",
            fontWeight: 700,
            textAlign: "center",
            color: "#1a1a2e",
          }}
        >
          Marketplace App Analyzer
        </h1>

        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}
        >
          <label
            htmlFor="username"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            Username
          </label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.95rem",
            }}
          />
        </div>

        <div
          style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}
        >
          <label
            htmlFor="password"
            style={{ fontSize: "0.875rem", fontWeight: 600 }}
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              fontSize: "0.95rem",
            }}
          />
        </div>

        {error && (
          <p
            style={{
              margin: 0,
              color: "#dc2626",
              fontSize: "0.875rem",
              textAlign: "center",
            }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "0.6rem 0",
            background: "#1a1a2e",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontWeight: 600,
            fontSize: "0.95rem",
            cursor: loading ? "not-allowed" : "pointer",
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
