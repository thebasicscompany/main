# infra/

Infrastructure-as-code notes for `basics-runtime`. The actual SST v3 stack
lives at the repo root in `sst.config.ts` (SST convention — root-level
config so `sst dev`/`sst deploy` find it without flags). This directory is
the home for any future supplementary IaC (raw Pulumi modules, Terraform
sidecars, ops runbooks, etc.); for now it's a docs landing pad.

## What's deployed

Single stack, region `us-east-1`:

- **VPC** (`RuntimeVpc`) — 2 public + 2 private subnets, managed NAT.
- **ECS Cluster + Fargate Service** (`RuntimeCluster`, `RuntimeApi`) —
  Hono service from `api/`, Node 22 / arm64, 1 vCPU / 2 GB. Behind an ALB
  on `api.trybasics.ai` (443/https → 3001/http). Healthcheck hits
  `/health` (unauthenticated) — `/v1/runtime/health` is JWT-gated and
  would 401 the load balancer.
- **S3 bucket** (`RuntimeScreenshotsBucket`, name `basics-runtime-screenshots`)
  — for Phase 05 audit-log screenshots. 90-day expiry. Linked to the
  Fargate task for IAM access.
- **EventBridge rule** (`RuntimeWorkflowSchedulerRule`) — placeholder for
  Phase 10 cron-fired workflow runs. Currently `DISABLED` with a
  one-fire-per-year cron; Phase 10 will wire real targets.
- **SST Secrets** — see list below.

DNS for `api.trybasics.ai` is managed at Vercel; the ACM cert validates
via DNS and we don't create the record from SST. The first deploy will
print the validation CNAME — copy it into Vercel and re-run.

## Secrets

Set per-stage with `sst secret set`:

```bash
# core auth + DB
pnpm sst secret set SupabaseUrl "https://xxx.supabase.co" --stage production
pnpm sst secret set SupabaseServiceRoleKey "..." --stage production
pnpm sst secret set SupabaseAnonKey "..." --stage production
pnpm sst secret set SupabaseJwtSecret "..." --stage production
pnpm sst secret set WorkspaceJwtSecret "$(openssl rand -hex 32)" --stage production
pnpm sst secret set DatabaseUrl "postgres://..." --stage production

# LLM + voice providers
pnpm sst secret set AnthropicApiKey "sk-ant-..." --stage production
pnpm sst secret set GoogleGenerativeAiApiKey "..." --stage production
pnpm sst secret set DeepgramApiKey "..." --stage production

# Browserbase (Phase 01 — set now to avoid re-deploying then)
pnpm sst secret set BrowserbaseApiKey "..." --stage production
pnpm sst secret set BrowserbaseProjectId "..." --stage production
```

To list set secrets: `pnpm sst secret list --stage production`.

## Common workflows

```bash
# Local dev (SST live mode — wires local handlers to deployed AWS bits)
pnpm dev:sst

# Build the IaC (validate without deploying)
pnpm build:sst

# Deploy production stack
pnpm deploy
# == sst deploy --stage production
```

The first `pnpm deploy` will hang waiting for ACM cert validation. Watch
for the `_<random>.api.trybasics.ai` CNAME in the deploy logs, add it as a
DNS record at Vercel, and the deploy will resume on the next reconcile.

## What's intentionally NOT here

- No `app.trybasics.ai` — there is no web dashboard in the runtime
  service. The desktop app talks to `api.trybasics.ai` directly.
- No Lambda-based API — runtime runs as a long-lived Fargate task
  (Browserbase sessions and persistent connections don't fit Lambda).
- No SES, no Stripe, no Composio, no Sendblue, no brain-archive bucket,
  no scheduler IAM roles. Those belonged to the sibling `agent/` repo and
  are explicitly out of scope here.
