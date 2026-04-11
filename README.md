# Liferay Marketplace App Analyzer

Ferramenta para validar deploy de artifacts `.jar` e `.war` em Liferay DXP via Docker, com interface web para upload, acompanhamento em tempo real e histórico de testes.

## Quick Setup

### 1. Pré-requisitos

- Bun 1.3+
- Docker instalado e em execução

### 2. Instalar dependências

```bash
cd /home/me/dev/projects/liferay-marketplace-app-analyzer
bun install
```

### 3. Configurar frontend

```bash
cp apps/web/.env.example apps/web/.env
```

Valor padrão esperado em `apps/web/.env`:

```env
VITE_API_URL=http://localhost:3001
```

### 4. Subir API e Web (2 terminais)

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

### 5. Acessar

- Frontend: http://localhost:5173
- API health: http://localhost:3001/api/health

---

## Setup Detalhado

### Estrutura do projeto

```text
apps/
  api/   # Backend Bun + Hono (upload, fila, SSE, execução Docker)
  web/   # Frontend React + Vite
packages/
  shared/ # Tipos compartilhados
```

### Scripts disponíveis

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

### Como usar a aplicação

1. Abra o frontend em `http://localhost:5173`.
2. Selecione a versão do Liferay.
3. Faça upload do arquivo `.jar` ou `.war`.
4. Inicie o teste.
5. Acompanhe status/fase em tempo real.
6. Abra os detalhes do teste para ver:
   - resumo
   - logs
   - motivo provável de falha
   - sugestões de correção

### Filtros do histórico

No histórico você pode filtrar por:

- nome do arquivo
- status (`queued`, `running`, `success`, `failed`, `error`)
- data inicial
- data final

### Endpoints principais (API)

- `GET /api/health`
- `GET /api/versions`
- `GET /api/test-runs`
- `POST /api/test-runs`
- `GET /api/test-runs/:id`
- `GET /api/test-runs/:id/events` (SSE)

---

## Troubleshooting

### Docker indisponível

Sintoma: testes falham com mensagem de daemon Docker indisponível.

Checklist:

- confirme que o Docker está rodando
- confirme permissão do usuário para usar Docker
- em Linux, valide com:

```bash
docker ps
```

### Porta em uso

Se `3001` ou `5173` estiverem ocupadas:

- API: defina `PORT` antes de subir a API
- Web: ajuste porta no Vite (`apps/web/vite.config.ts`)

### Frontend sem conectar na API

- valide `apps/web/.env`
- confirme API ativa em `http://localhost:3001/api/health`

---

## Observações

- O sistema roda 1 teste por vez (fila em memória).
- O histórico atualmente é associado ao usuário fixo `dev-user`.
- Para persistência entre reinícios, o próximo passo recomendado é salvar `test_runs` em SQLite.
