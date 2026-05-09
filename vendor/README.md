# vendor/

Read-only local clones of upstream projects we copy code from.
Nothing here is shipped — only consulted while preparing copies under `api/src/`.
The contents are gitignored to keep the repo small.

## Upstream gateway clone

A local clone of the upstream we adopt for `api/src/gateway/`.
Tracking is intentionally minimal here; legal attribution lives where the
copied code lives (`api/src/gateway/LICENSE` and `api/src/gateway/NOTICE.md`).

- Origin: https://github.com/Portkey-AI/gateway
- License: MIT
- Pinned commit: `351692f` (2026-05-08)
- Plan: `docs/MANAGED-GATEWAY-PLAN.md`

To recreate the local clone:

```sh
mkdir -p vendor && cd vendor
git clone --depth 1 https://github.com/Portkey-AI/gateway.git portkey-gateway
( cd portkey-gateway && git -c advice.detachedHead=false checkout 351692f )
```
