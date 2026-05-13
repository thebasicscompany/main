# Composio support ticket — GOOGLESHEETS_NEW_ROWS_TRIGGER polling stalls after baseline

**TL;DR** — GOOGLESHEETS_NEW_ROWS_TRIGGER instances baseline correctly on first poll but never poll again. Webhook is never delivered. Confirmed identical configuration worked end-to-end on 2026-05-12; today (2026-05-13) three separate trigger upserts all reproduce.

## Account / project context

- Project: `basics`
- Project ID: `376bb0bc-2dcb-4855-ad45-2f10cf0c678a`
- Connected account: `ca_qLxNMgr653Vc` (toolkit `googlesheets`, status `ACTIVE`)
- User ID: `aa9dd140-def8-4e8e-9955-4acc04e11fea`
- Webhook subscription: `ws_jVANhPM-Idwb`
- Webhook URL: `https://api.trybasics.ai/webhooks/composio`

## Reproduction

1. Created a fresh sheet via `GOOGLESHEETS_CREATE_GOOGLE_SHEET1` →
   `spreadsheet_id: 1iPw-NPmu2MJP6x6yh8yYkO_RtiZPJgksPDAV0Klnng0`.
2. Seeded the sheet: header row + 3 data rows in rows 3–5
   (Sundar Pichai, Mark Zuckerberg, Tim Cook).
3. Upserted a NEW_ROWS trigger:
   ```
   POST /api/v3/trigger_instances/GOOGLESHEETS_NEW_ROWS_TRIGGER/upsert
   {
     "user_id":"aa9dd140-def8-4e8e-9955-4acc04e11fea",
     "connected_account_id":"ca_qLxNMgr653Vc",
     "trigger_config":{
       "spreadsheet_id":"1iPw-NPmu2MJP6x6yh8yYkO_RtiZPJgksPDAV0Klnng0",
       "sheet_name":"Sheet1",
       "interval":60,
       "start_row":3
     }
   }
   ```
   Response: `{"trigger_id":"ti_xOkHb5DL8H3A"}`.
4. Added a 4th row (Bill Gates) at row 6.
5. Polled `GET /api/v3/trigger_instances/active?triggers_ids=ti_xOkHb5DL8H3A`
   every 30s.

## Observed behavior

- The trigger baselines exactly once (~20s after upsert).
  - `updated_at: 2026-05-13T20:06:25.912Z`
  - `state: { last_row_count: 3 }`
- After that, `updated_at` never changes. No subsequent poll.
  Sampled every 30s for 6+ minutes; the trigger row in `/trigger_instances/active`
  is frozen at the baseline timestamp.
- Adding the new row (Bill Gates → 4 rows ≥ row 3) does NOT cause
  `state.last_row_count` to advance, and no webhook is delivered to
  `https://api.trybasics.ai/webhooks/composio`. Our edge has TLS termination
  + verbose request logging; zero hits with `webhook-id` header from
  Composio in the window.
- `disabled_at: null`. The trigger is not marked disabled on your side.

## Other triggers tried in the same window (same config, same symptom)

- `ti_Xi25yPp3SnoR` (upserted with `interval: 30`) — baselined never,
  `state.last_row_count: 0`, `updated_at` frozen at registration.
- `ti_rO5WmZflEa4R` (upserted with `interval: 60`) — baselined once,
  `state.last_row_count: 2`, `updated_at` frozen.
- `ti_xOkHb5DL8H3A` (upserted with `interval: 60`, current) — same.

All three were eventually deleted via `DELETE /api/v3/trigger_instances/manage/<id>`
(succeeded).

## Confirmation that our side is correct

- Yesterday (2026-05-12) the identical flow — same sheet creation,
  same trigger slug, same `interval: 60`, same webhook subscription —
  delivered to `/webhooks/composio` reliably (~60s after row add).
  Logs show that history.
- Today we manually synthesized a Composio webhook payload, signed it
  HMAC-SHA256 over `${webhook_id}.${timestamp}.${body}` with the project's
  shared secret (`<redacted>`, retrieved via
  `GET /api/v3/webhook_subscriptions/ws_jVANhPM-Idwb`), and POSTed
  to `https://api.trybasics.ai/webhooks/composio`. It was accepted
  (`200 OK`, routed into a live agent run, real SMS dispatched).
  The post-Composio half of the chain is healthy.

## Hypothesis

The Composio polling worker for GOOGLESHEETS_NEW_ROWS_TRIGGER appears to
have stopped polling our connected account, OR the worker is backlogged
and just hasn't gotten to it. The behavior is consistent across three
fresh trigger registrations within a 30-minute window.

## What we'd like

1. Confirmation of whether `ca_qLxNMgr653Vc` / our project is on a
   degraded polling tier, or whether the worker is genuinely backlogged.
2. If a manual re-arm of the polling state is possible on your side for
   `ti_xOkHb5DL8H3A`, please do.
3. ETA for normal poll cadence to resume.

Happy to share full request/response traces, our webhook handler code,
and the timestamps above. Reach me at dmrknife@gmail.com (workspace
owner) or this thread.
