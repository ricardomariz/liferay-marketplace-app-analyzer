# Liferay Marketplace App Analyzer

Tool to validate `.jar` and `.war` artifact deployment on Liferay DXP via Docker, with a web UI for upload, real-time monitoring, and test history.

## Quick Setup

### 1. Prerequisites

- Bun 1.3+
- Docker installed and running

### 2. Install dependencies

```bash
cd /home/me/dev/projects/liferay-marketplace-app-analyzer
bun install
```

### 3. Configure frontend

```bash
cp apps/web/.env.example apps/web/.env
```

Expected default value in `apps/web/.env`:

```env
VITE_API_URL=http://localhost:3001
```

### 4. Start API and Web (2 terminals)

Terminal A (API):

```bash
cd /home/me/dev/projects/liferay-marketplace-app-analyzer
bun run dev:api
```

Terminal B (Web):

```bash
cd /home/me/dev/projects/liferay-marketplace-app-analyzer
bun run dev:web
```

### 5. Access

- Frontend: http://localhost:5173
- API health: http://localhost:3001/api/health

---

## Detailed Setup

### Project structure

```text
apps/
  api/   # Bun + Hono backend (upload, queue, SSE, Docker execution)
  web/   # Frontend React + Vite
packages/
  shared/ # Shared types
```

### Available scripts

No root:

```bash
bun run dev:api
bun run dev:web
bun run build:api
bun run build:web
```

No backend (`apps/api`):

```bash
bun run dev
bun run build
bun run start
```

No frontend (`apps/web`):

```bash
bun run dev
bun run build
bun run preview
```

### How to use the application

1. Abra o frontend em `http://localhost:5173`.
2. Select the Liferay version.
3. Upload a `.jar` or `.war` file.
4. Start the test.
5. Monitor status/phase in real time.
6. Open test details to see:

- summary
- logs
- likely failure reason
- suggested fixes

### History filters

In the history page, you can filter by:

- file name
- status (`queued`, `running`, `success`, `failed`, `error`)
- start date
- end date

### Main endpoints (API)

- `GET /api/health`
- `GET /api/versions`
- `GET /api/test-runs`
- `POST /api/test-runs`
- `GET /api/test-runs/:id`
- `GET /api/test-runs/:id/events` (SSE)

---

## Troubleshooting

### Docker unavailable

Symptom: tests fail with a Docker daemon unavailable message.

Checklist:

- confirm Docker is running
- confirm your user has permission to use Docker
- on Linux, validate with:

```bash
docker ps
```

### Port already in use

If `3001` or `5173` is already in use:

- API: set `PORT` before starting the API
- Web: change the Vite port (`apps/web/vite.config.ts`)

### Frontend cannot reach API

- validate `apps/web/.env`
- confirm API is running at `http://localhost:3001/api/health`

---

## Notes

- The system runs 1 test at a time (in-memory queue).
- History is currently associated with a fixed user `dev-user`.
- For persistence across restarts, the recommended next step is saving `test_runs` in SQLite.
