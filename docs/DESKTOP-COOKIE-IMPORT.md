# Desktop cookie-import integration

This doc tells the **desktop app team** what to ship so a user can connect non-OAuth sites (LinkedIn, Twitter, internal dashboards) without iframing into a Browserbase live-view to log in again.

The desktop app reads cookies from the user's existing logged-in Chrome / Brave / Edge profile, POSTs them to our backend, and we provision a Browserbase Context the cloud agent reuses on every run.

> **TL;DR for the desktop team:** copy the chrome-import pattern from [`browser-use/desktop` `app/src/main/chrome-import/`](https://github.com/browser-use/desktop/tree/main/app/src/main/chrome-import) and repoint the upload destination at `POST https://api.trybasics.ai/v1/runtime/contexts/sync`. The endpoint is already live and accepts the exact payload shape that the `browser-use/desktop` extractor emits.

---

## What the backend already provides

| Surface | Status |
|---|---|
| `POST /v1/runtime/contexts/sync` | ✅ live in production (`api/src/routes/contexts.ts`) |
| `GET /v1/runtime/contexts/me` | ✅ live (returns sync status: `{context_id, last_synced_at, has_sync}`) |
| Domain filtering server-side | ✅ accepts `domains: string[]` in payload, drops cookies outside list |
| Hard cap | ✅ 50,000 cookies / 50,000 localStorage items per upload |
| Privacy | ✅ cookie values never persist in Postgres, never logged (only domain summary) |
| Browserbase Context provisioning | ✅ creates on first sync, reuses on subsequent (`workspaces.browserbase_profile_id`) |
| Runtime consumption | ✅ `worker/src/opencode-plugin/index.ts` attaches the Context to each Browserbase session, so any goto_url() on a synced domain arrives already-logged-in |

**Desktop team does NOT need to:**
- Build any backend endpoints — they exist.
- Talk to Browserbase directly — we proxy it.
- Persist cookies anywhere — send + forget.
- Implement diff / "what's new" logic — the api response returns `{cookie_count, domains}` so the UI can render a confirmation.

---

## Payload shape

`POST /v1/runtime/contexts/sync`

**Auth:** `Authorization: Bearer <workspace_jwt>` (the user's signed-in workspace JWT — minted via the existing dashboard auth flow + handed off to the desktop the same way the desktop currently gets its workspace token for any other api call).

**Body:**

```json
{
  "cookies": [
    {
      "name": "li_at",
      "value": "AQEDA...",
      "domain": ".linkedin.com",
      "path": "/",
      "expires": 1763580000,
      "size": 200,
      "httpOnly": true,
      "secure": true,
      "session": false,
      "sameSite": "None"
    }
  ],
  "profile_label": "Chrome — Personal",
  "profile_directory": "Default",
  "domains": ["linkedin.com", "twitter.com"],
  "local_storage": [
    { "securityOrigin": "https://www.linkedin.com", "key": "lang", "value": "en_US" }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `cookies[]` | yes | Match Chrome CDP `Storage.getCookies` shape verbatim. `sameSite` ∈ `'Strict' | 'Lax' | 'None'` (CDP form). |
| `profile_label` | yes | Free-text user-visible label, e.g. `"Chrome — Personal"`. Stored on the workspace row for the UI. |
| `profile_directory` | no | Source profile folder name (e.g. `"Default"`, `"Profile 1"`). Audit-trail only. |
| `domains` | **strongly recommended** | Allowed-domain filter. **Anything outside this list is dropped server-side.** Lets the user pick which sites to sync (don't ship everything). |
| `local_storage[]` | no | `{securityOrigin, key, value}` per Chrome's CDP shape. Optional; sites whose auth depends on it (Notion, Linear, etc.) need it. |

**Response (200):**

```json
{
  "context_id": "browserbase-context-abc123",
  "synced_at": "2026-05-14T03:50:00.000Z",
  "cookie_count": 47,
  "local_storage_count": 12,
  "domains": ["linkedin.com", "twitter.com"],
  "profileId": "browserbase-context-abc123",
  "cookieCount": 47
}
```

(`profileId` + `cookieCount` are alias fields kept for backward-compatibility with the existing `browser-use/desktop` parsers — pick whichever name your client already reads.)

**Errors:**
- `400 invalid cookie payload` — schema mismatch (zod validation failure; check `details`).
- `503 browserbase_unavailable` — upstream Browserbase outage; retry.
- `502 internal_error` — CDP attach failure or DB write failure; details in `message`.

---

## What the desktop needs to do

Three pieces. Two are already 90% present in `browser-use/desktop`'s codebase — port verbatim.

### 1. Profile discovery — port `app/src/main/chrome-import/profiles.ts`

Scans well-known paths on darwin / win32 / linux for installed Chromium-family browsers (Google Chrome, Chrome Canary, Brave, Edge, Vivaldi, Opera, Chromium, Arc, etc.) and the profiles inside their User Data dirs. Returns:

```ts
interface ChromeProfile {
  id: string;          // e.g. "brave:Profile%201" — stable across launches
  directory: string;   // e.g. "Default" or "Profile 1"
  browserKey: string;  // e.g. "google-chrome", "brave"
  browserName: string; // e.g. "Google Chrome"
  name: string;        // profile display name from Local State
  email: string;       // signed-in Google email if available
  avatarIcon: string;  // profile avatar
}
```

The desktop UI surfaces this list so the user picks WHICH profile to import from (they may have a "work" and "personal" Chrome profile; we only want one).

**No changes needed when porting** — copy the file as-is from browser-use/desktop. It's pure profile-discovery, no `browser-use`-specific dependencies. The `mainLogger` import can be swapped for the desktop's own logger.

### 2. Cookie extraction — port `app/src/main/chrome-import/cookies.ts`

Crucial pattern that solves Chrome's cookie encryption:

1. **Copy the chosen profile dir to a temp dir.** Skip `Extensions`, `IndexedDB`, `Local Storage`, `Service Worker`, `GPUCache`, `Shared Dictionary`, `SharedCache` subdirs + lock files (`SingletonLock`, `lockfile`, `RunningChromeVersion`, `History`). We only need the `Cookies` SQLite file + `Local State`.
2. **Launch that browser headless against the temp dir** with `--remote-debugging-port=<freeport>`. The headless instance runs as the same OS user → has macOS Keychain access / Windows DPAPI access → can decrypt cookies that the user normally has access to.
3. **Connect via CDP WebSocket** (the `/json/version` endpoint returns the WS URL).
4. **Call `Storage.getCookies`** — returns already-decrypted cookies in the shape our api expects.
5. **Kill the headless instance + delete the temp dir.**

Result: an array of `CdpCookie` objects ready to POST. **Do not skip the copy-to-temp step** — running headless against the user's live profile dir can corrupt their session.

**One change when porting:** the source file writes cookies into Electron's local `session.defaultSession.cookies.set(...)` jar. Strip that — we POST to our api instead (see step 3 below). Keep the CDP cookie-pull, drop the local jar write.

### 3. Domain-pick UI + upload — NEW

This is the only part the desktop team writes from scratch. Flow:

1. After extraction, group the cookies by domain. Show the user a list:
   ```
   ☐ linkedin.com    (47 cookies)
   ☐ twitter.com     (12 cookies)
   ☑ amazon.com      (212 cookies)  ← already selected (default = unchecked)
   ☑ github.com      (89 cookies)
   ```
2. Default everything **unchecked**. Force the user to opt-in per-domain.
3. After they confirm, POST to `https://api.trybasics.ai/v1/runtime/contexts/sync` with:
   - `cookies`: ALL cookies extracted (api will filter server-side too)
   - `domains`: the checked domains
   - `profile_label`: from the profile they picked in step 1
4. Show the response: "Synced 59 cookies for 2 domains. Ready to use."

**Security caveats — please honor these:**
- Never log cookie values, even at debug level.
- Don't persist the cookie array anywhere on disk after upload. Send + drop.
- Sandbox the headless browser launch (no extensions, no GPU, no first-run prompts — already true with the `--no-first-run --no-default-browser-check` flags in browser-use/desktop's launcher).
- Do not allow the user to enter a freeform "send everything" override. The domain-pick UI is the user's consent surface.

---

## Trust + audit

- **The `domains` field is the trust boundary.** The desktop sends it; the api enforces it (cookies outside the list are dropped server-side before they reach Browserbase). If the desktop is compromised, the worst it can do is ask the user to sync sites they didn't intend — same as a regular phishing-via-UI threat.
- **Cookie values cross only one hop:** desktop → api over TLS → Browserbase Context API over TLS. They are never persisted in our Postgres or logged.
- **The Browserbase Context** is the system of record for the cookies. The user can revoke a site by deleting the `workspace_browser_sites` row (or by hitting a future `DELETE /v1/runtime/contexts/sync?domain=X` endpoint — not built yet, file an issue if you need it).

---

## Renewal

Session cookies rotate (LinkedIn rotates `JSESSIONID` daily, Twitter rotates ct0). The desktop should re-sync on a schedule:

- **Manual:** popup button "Sync now" per site.
- **Periodic:** every 6 hours via background timer / cron.
- **On demand:** after any agent run that hits `browser_session_expired` activity event (our worker emits this when the saved cookies are stale).

Re-sync is idempotent on the api side — calling `/v1/runtime/contexts/sync` again overwrites the existing Context's cookie jar.

---

## Open question (for desktop team to decide)

Where does the workspace JWT live in the desktop app? Two options:

1. **Embedded auth flow.** Desktop pops a dashboard URL (e.g. `https://app.trybasics.ai/desktop/auth?return=<deeplink>`), user signs in via Supabase if needed, dashboard postMessages a long-lived workspace JWT back to the desktop, desktop stores in OS keychain. This is the same pattern proposed for the (now-deleted) extension.
2. **Reuse existing desktop auth.** If the desktop already has its own auth (and a workspace JWT already in OS keychain for other api calls), just reuse it — no new flow needed.

Pick option 2 if it applies — it's strictly less work. We'd recommend a **long-lived (30-day) workspace JWT** for the desktop's cookie-sync use case so the user doesn't have to re-auth daily. If you need a `POST /v1/auth/desktop-token` mint endpoint that takes a Supabase session and issues a long-lived workspace JWT, ping us; it's ~30 lines of new code.

---

## What's NOT in this doc (intentionally)

- Workflow recording (rrweb). browser-use/desktop and our deleted `extension/ROADMAP.md` both had recording-substrate phases. Out of scope here — we're solving cookie onboarding, not playbook synthesis.
- Per-domain approval-surface injection. The desktop / extension Roadmap Phase 08 had an idea of injecting approval prompts into matching tabs. Out of scope — approvals stream over SSE today (G.1) and the desktop UI consumes that directly.
- localStorage capture from non-Chromium browsers (Firefox, Safari). Chrome / Chromium-family only for v1.
