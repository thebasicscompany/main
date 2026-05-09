# NOTICE

This directory contains code derived from an upstream open-source AI gateway,
distributed under the MIT License.

- Origin: https://github.com/Portkey-AI/gateway
- Copyright: Copyright (c) 2024 Portkey, Inc
- License: MIT (see `LICENSE` in this directory — verbatim copy of upstream)
- Pinned source: commit `351692f` (cloned 2026-05-09)

## Modifications

The list below is the full set of changes made when adopting the upstream code
into this repository. Per-file source-attribution headers are not added because
the entire tree is derived; this file is the central record.

1. **Pruned providers.** `providers/index.ts` was rewritten to register only
   `anthropic`, `openai`, `google`, `vertex-ai`, and `bedrock`. ~70 other
   provider directories were deleted; restore from upstream when needed.
2. **Dropped non-runtime files.** `start-server.ts`, `tests/`, `public/` were
   removed (we mount the Hono app inside our own server, not standalone).
3. **`index.ts` patched.** Removed the Cloudflare Workers / Wrangler runtime
   branches (compress, realtime WebSocket route, Redis cache bootstrap).
   Node-only.
4. **`apm/` logger swap.** Replaced upstream's logger with a thin shim around
   our pino logger (`api/src/middleware/logger.ts`).
5. **`conf.json` defaults.** `cache: false` (response cache is the wrong layer
   for billing-tagged managed-pooled traffic).
6. **String/identifier neutralization.** User-visible strings, route prefixes,
   and exported symbols use neutral names. The upstream brand appears only in
   `LICENSE` and this `NOTICE.md` — both are required for MIT attribution.

## Re-syncing from upstream

The local clone path is `runtime/vendor/portkey-gateway/` (gitignored). To
diff-merge a newer upstream:

```sh
cd runtime/vendor/portkey-gateway
git fetch && git checkout <new-sha>
diff -ru runtime/vendor/portkey-gateway/src runtime/api/src/gateway
```

Then re-apply each modification in this list.
