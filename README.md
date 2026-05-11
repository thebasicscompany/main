# basics-main

Cloud workflow runtime + voice infra. Single Hono service on AWS Fargate, Next.js dashboard on Vercel, shared Supabase Postgres.

See `PROJECT.md`, `ROADMAP.md`, `ARCHITECTURE.md` for the why and the plan.

## Workspaces

- `api/` — Hono service. Voice credentials, LLM proxy, workspace JWT issuer/verifier, runtime workflow orchestration.
- `web/` — Next.js 15 dashboard. Run library, history, live-view, approvals, audit log.
- `harness/` — TS port of browser-harness's CDP helper surface (Phase 02).
- `shared/` — Shared types: tool schemas, run states, approval shapes.
- `infra/` — SST config (Fargate + ALB + EventBridge + S3).

## Develop

Runtime targets Node (>= 22) with pnpm (>= 10) and Doppler for secret injection.

```bash
pnpm install
# Secrets come from Doppler (project=backend, config=dev). No .env needed locally.
pnpm dev              # → doppler run --project backend --config dev -- pnpm -r --parallel dev
```

`pnpm dev` proxies through Doppler so every workspace sees the same env vars
without committing a `.env`.

## Chat Paths

- Normal desktop client chat uses `POST /v1/assistants/:assistantId/messages/`.
  The API runs the managed LLM gateway loop, advertises connected host bridge
  tools (`host_bash`, `host_file_read`) when a macOS client is present, and
  advertises API-side Composio proxy tools (`composio_list_tools`,
  `composio_execute_tool`) when Composio is configured.
- Cloud runs use `POST /v1/runs` and the worker/opencode/browser automation
  path. Opencode is not the normal desktop client-chat LLM loop, and this path
  does not receive Composio tool wiring.

## Deploy

```bash
pnpm deploy           # sst deploy --stage production
```
