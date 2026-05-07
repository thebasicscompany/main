# Browser Extension — Build Handoff

> Hand this file to Cursor as the opening message of a new session.

## Context

Basics is shipping a cloud workflow runtime for B2B SaaS RevOps. Users record a workflow demo in their browser; a cloud Chrome (Browserbase) replays it on schedule with live-view, approval gating, take-over, audit log, and outcome verification.

**V1 surfaces:**
- **Web dashboard** (`runtime/web/`) — Next.js 15 on Vercel. Runs, history, schedules, live-view iframe, take-over, approvals.
- **Runtime API** (`runtime/api/`) — Hono on Fargate. Agent loop, Browserbase sessions, approval middleware, audit log.
- **Lens daemon** (separate repo: `basics-capture-v2/`) — native macOS daemon. Screen OCR, audio capture, Whisper. Stays desktop-only.
- **Browser extension** (your job) — replaces what was originally going to be a desktop pill overlay plus the Chrome-cookie-extractor portion of the Lens daemon.

We chose extension over desktop pill for V1 because: install friction collapses (Chrome Web Store one-click vs. signed `.app` + LaunchAgent + Accessibility TCC), cookie sync becomes trivial via `chrome.cookies` (vs. decrypting Chrome's `Cookies` SQLite via macOS Keychain), the work lives in the browser already, cross-platform is free.

## Repo placement

- The extension lives at `runtime/extension/` as a pnpm workspace, sharing types from `runtime/shared/`.
- Backend integration goes through the runtime API at `api.trybasics.ai/v1/runtime/*`.
- Confirm the workspace registration in `runtime/pnpm-workspace.yaml` before scaffolding.

## Read first, in order

1. `runtime/PROJECT.md` — overall scope, V1 in/out, surfaces, tech-stack constraints
2. `runtime/ARCHITECTURE.md` — block diagram, run lifecycle, **cookie sync flow** (extension-side), **recording flow** (extension-side)
3. `runtime/ROADMAP.md` — Phase 07 (cookie sync) is what the extension partly takes over from Lens
4. `../desktop/LENS-INTEGRATION.md` — what Lens still owns (screen OCR, audio). Helps you draw the boundary cleanly.
5. `../agent/CLAUDE.md` — workspace JWT (`X-Workspace-Token`) source-of-truth. Extension is a verifier/holder, never an issuer.

## Extension responsibilities

### 1. Cookie + localStorage sync to runtime
For each domain in the workspace's include-list (Salesforce, HubSpot, Looker, Notion, etc.):
- `chrome.cookies.getAll({ domain })`
- localStorage via content-script injection (cookies API doesn't cover it). Ship back to background via `chrome.runtime.sendMessage`.
- Encrypt with workspace key
- `POST api.trybasics.ai/v1/runtime/contexts/sync` with `X-Workspace-Token`

Triggers: post-auth, scheduled (every N hours), on-demand from dashboard, pre-run if context is stale.

The runtime endpoint and Browserbase Context creation already exist per the Phase 07 spec. You are not building the receiving side.

### 2. Demonstration recording (capture side)
Content script that overlays a recording UI on the user's SaaS tab and captures the workflow:
- Click coords + DOM selector + visible text + accessible name
- Typed input (passwords + masked fields redacted)
- Navigation, scroll, relevant network calls
- Recording start/stop control with a clear visual indicator

Stream the structured event log to runtime API (or buffer locally and POST on stop — preference: buffer-then-POST so we control the network footprint).

When Lens is running too: extension owns DOM events; Lens owns screen pixels + audio. They merge server-side keyed by timestamp — coordinate the timestamp source (use `performance.timeOrigin + performance.now()` and document it).

### 3. Approval surface during runs
Background service worker subscribes to runtime SSE for the active workspace. When an approval is pending and the user has the relevant SaaS domain open, show an inline prompt on that tab. Otherwise fall back to `chrome.notifications` → click opens the dashboard.

### 4. Auth
Extension opens the dashboard's existing OAuth flow → receives workspace JWT → stores in `chrome.storage.local`. Reuse `/v1/auth/token`. No new auth primitives.

## Recommended technical approach (research)

### Capture substrate: fork rrweb

[rrweb](https://github.com/rrweb-io/rrweb) is the right starting point. **MIT licensed, TypeScript-native, used in production by Sentry session replay and PostHog.** It captures:
- DOM mutations (`MutationObserver`)
- Mouse events (clicks, position)
- Scroll, viewport
- Input events (with built-in masking via `.rr-mask`, `.rr-ignore`, `.rr-block` CSS classes — `[type=password]` is masked by default)

A typical 5-min session compresses to 50–200 KB. Plasmo + rrweb + MV3 has prior art (e.g. [DEV blog post](https://dev.to/ch-usama/how-i-built-a-modern-chrome-extension-with-react-plasmo-and-rrweb-4bh8)) — don't blaze a new trail.

**What rrweb does NOT give us:** a high-level `navigate | click | type | wait | extract` playbook. rrweb is replay-fidelity-oriented; we need an agent-replayable step list. So:

```
rrweb raw events  ──[step-extraction pass]──►  distilled playbook steps
   (kept for replay,                              (the seed for the
    debug, future synthesis)                       agent's prompt)
```

The step-extraction pass is **our work**, not rrweb's. It collapses redundant mutations, picks the highest-signal click target, redacts masked input values, and produces an ordered list of typed steps. Keep both layers — raw events for the v2 demonstration→playbook synthesis pipeline, distilled steps for the v1 hand-tuning workflow.

### Build framework

Three credible options. Pick one in your scaffolding pass and write a two-sentence justification:

| Framework | Pitch | Trade |
|---|---|---|
| [Plasmo](https://www.plasmo.com/) | React + MV3 conventions, fastest scaffolding, big tutorial surface | Magic. You're inside their abstractions. |
| [WXT](https://wxt.dev/) | Pure Vite + MV3, less magic, growing community | Slightly more setup |
| [CRXJS](https://crxjs.dev/vite-plugin) + Vite | Lowest-magic, most-explicit | You write more glue |

Default recommendation: **WXT** unless you find a reason otherwise. Plasmo has the best Day-1 ergonomics but the cost shows up in Month-3 customizations.

### Alternatives considered

- **Chrome DevTools Recorder** — built into Chrome, exports JSON or `@puppeteer/replay` format. Good reference for the *step schema* (it has navigate / click / type / wait baked in). Not forkable as a substrate, but worth aligning the distilled-step format with so we get free `@puppeteer/replay` interop later. https://developer.chrome.com/docs/devtools/recorder
- **PostHog session replay / OpenReplay** — both wrap rrweb in a hosted/self-hosted product. Wrong altitude for us; we want the library, not the platform.
- **Browser Use / Stagehand recorder modes** — selector-driven philosophy, wrong fit for the SF/Looker pixel-click stack runtime targets (per `runtime/PROJECT.md`).

### Step schema (proposal — refine in Phase 0)

Align the distilled-step format roughly with Chrome DevTools Recorder so we can pipe to `@puppeteer/replay` later:

```ts
type Step =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; selector: string; text?: string; coords: { x: number; y: number } }
  | { kind: 'type'; selector: string; value: string; masked?: boolean }
  | { kind: 'keydown'; key: string }
  | { kind: 'wait'; ms: number; reason?: 'idle' | 'navigation' | 'manual' }
  | { kind: 'extract'; selector: string; as: string };
```

Live this in `runtime/shared/recording.ts`. The runtime API consumes it from there.

## Hard constraints

- **Manifest V3.** No exceptions.
- **TypeScript.**
- **Workspace JWT only** — don't introduce new tokens.
- **No telemetry SDK without asking** — privacy is a positioning point in `../basics-capture-v2/STRATEGY-MEMO.md`.
- **Default-redact `[type=password]` and any element with rrweb's `.rr-mask` / `.rr-ignore`.** Test this on day one — masked-input regression bugs are easy and disastrous.

## Out of scope — do not build

- Agent loop (lives in `runtime/api/`)
- Workflow editing (dashboard)
- Live-view of Browserbase session (dashboard iframe via `liveUrl`)
- Screen capture, audio, OCR (Lens daemon, native only)
- Take-over UX (dashboard, full-bleed iframe)
- Trust-grant editing (dashboard)
- Demonstration → playbook synthesis pipeline (v2)

## Decision points — surface to user before scaffolding

1. **Build framework** — Plasmo vs. WXT vs. CRXJS+Vite. Default recommendation: WXT.
2. **Workspace encryption key** — generated on first auth and stored in `chrome.storage.local`? Derived from JWT? Server-issued and rotated? Confirm with user.
3. **Browser scope V1** — Chrome only, or Chrome + Edge + Brave (Chromium siblings essentially free)? Firefox is a real port — assume out of scope unless told otherwise.
4. **Recording transport** — buffer-then-POST on stop (simpler) or stream events via SSE/WebSocket during recording (smoother UX, more infra)? Default: buffer-then-POST for V1.
5. **Step-extraction location** — extension-side (less server load, harder to iterate) or runtime-side (server reprocesses raw rrweb events)? Default: do the cheap pass extension-side, do v2-synthesis server-side.

Surface these *before* scaffolding, not after.

## Style

- Default to no comments. Annotate only non-obvious WHY (a Chrome API quirk, an MV3 gotcha, a CDP-side timestamp invariant).
- Prefer editing existing files over creating new ones once scaffolded.
- No abstractions beyond what V1 needs. Three similar lines beat a premature abstraction.
- Match `tsconfig.base.json` settings from runtime root.
