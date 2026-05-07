# @basics/harness

TypeScript port of [`browser-harness`](https://github.com/...) — Chrome DevTools Protocol helpers for browser automation.

## Status

This is a literal, line-by-line port of the Python `browser-harness` reference into TypeScript. Every public helper in `helpers.py` has a TS counterpart, with `@source` JSDoc tags pointing back to the source line range so the port can be audited.

The Python reference is preserved verbatim under `reference/python-original/`. Do not modify it — it is the audit artifact for the port.

## Design

Pure functions over a CDP `session` handle. No globals, no daemon, no IPC.

The Python upstream uses a daemon pattern (one process owns the CDP WebSocket and helpers IPC into it). We do not — see `runtime/ARCHITECTURE.md`. The caller opens a session, threads it through every helper, and detaches when done.

```
     attach(opts)  -->  CdpSession  -->  helpers(session, ...)  -->  detach(session)
```

## Usage

```ts
import { attach, detach, goto_url, click_at_xy, page_info } from '@basics/harness'

const session = await attach({ wsUrl: 'wss://browserbase.example/cdp/...' })
try {
  await goto_url(session, 'https://example.com')
  const info = await page_info(session)
  console.log(info)
  await click_at_xy(session, 100, 200)
} finally {
  await detach(session)
}
```

## Layout

- `src/session.ts` — CDP connection lifecycle. `attach` / `detach`, default-domain enables, event tap, dialog tracking.
- `src/helpers.ts` — public helpers. Direct port of `helpers.py`.
- `src/internal.ts` — private helpers from `helpers.py` (CDP send wrapper, `Runtime.evaluate` decoding, `_has_return_statement`, etc).
- `src/types.ts` — shared types (`CdpSession`, `PageInfo`, `MouseButton`, …).
- `src/index.ts` — barrel export.
- `reference/python-original/` — the Python source we ported from. Treat as read-only.

## What is NOT ported

- `daemon.py` / `_ipc.py` — daemon and IPC concerns. We don't use them.
- `admin.py` / `run.py` — daemon admin and CLI entry point.
- The Pillow-based `BH_DEBUG_CLICKS` overlay in `click_at_xy`.
- The Pillow `max_dim` thumbnail step in `capture_screenshot`.
- The `BROWSER_USE_API_KEY` proxy fallback in `http_get`.
- The `BH_DOMAIN_SKILLS` workspace-glob in `goto_url`.
- `_load_agent_helpers` (workspace-loaded helper plugins).

These are runtime / host-side concerns; if needed they can be layered on at the call site.

## Testing

```sh
pnpm -F @basics/harness test       # unit + shape tests with vitest
pnpm -F @basics/harness typecheck  # tsc --noEmit
```

The included tests are all unit + shape tests against a mock CDP client. Real Chrome integration tests against a Browserbase session are Phase 02 of `runtime/`.
