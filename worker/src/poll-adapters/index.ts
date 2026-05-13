// F.2 — Adapter framework for self-hosted polling of managed-auth
// Composio triggers.
//
// Composio's managed-auth polling worker enforces a 15-minute minimum
// interval (March 11, 2026 changelog). For UX-sensitive trigger types
// (sheet rows added, new gmail messages, calendar event created) we
// replace just their polling worker with our own running on the
// existing worker/cron-kicker. Push-type triggers (Slack, Linear,
// Asana, GitHub-webhook, Notion real-time) continue going through
// Composio's webhook delivery — unaffected.
//
// An adapter is the per-toolkit logic that:
//   - knows the equivalent read API (composio_call slug + args) for its
//     trigger
//   - knows how to extract "what's new since last poll" from the read
//     response, comparing against the per-trigger `state` JSONB
//   - emits zero-or-more synthetic webhook payloads shaped EXACTLY like
//     Composio's native payload for that trigger, so the existing D.5
//     composio-trigger-router input mappers work unchanged
//   - returns the new state to persist back to composio_poll_state
//
// Adapters do NOT need to know about the kicker, the database, SQS, or
// the router — those are the kicker's concern. An adapter is a pure
// `(config, lastState, composioApiKey, fetch) → { newEvents, nextState }`
// function.

/** Per-poll-invocation arguments passed to every adapter. */
export interface PollAdapterArgs {
  /** Trigger config (Composio's trigger_config shape). e.g. for
   *  googlesheets: { spreadsheet_id, sheet_name, start_row, ... }. */
  config: Record<string, unknown>;
  /** Composio "user_id" the connection lives under. */
  composioUserId: string;
  /** The actual connected_account_id (e.g. ca_qLxNMgr653Vc). */
  connectedAccountId: string;
  /** Composio API key (from process.env or test seam). */
  composioApiKey: string;
  /** fetch impl. Test seam — defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** One synthetic event produced by an adapter. */
export interface PollAdapterEvent {
  /** Payload shaped like Composio's native trigger.message `data.payload`
   *  for this trigger slug. The kicker wraps it in the standard
   *  composio.trigger.message envelope before calling the router. */
  payload: Record<string, unknown>;
}

export interface PollAdapterResult {
  newEvents: PollAdapterEvent[];
  /** Opaque per-adapter state to persist back to composio_poll_state.state. */
  nextState: Record<string, unknown>;
}

export interface PollAdapter {
  /** The Composio toolkit slug this adapter handles (e.g. 'googlesheets'). */
  toolkit: string;
  /** Composio trigger slugs handled, e.g. ['GOOGLESHEETS_NEW_ROWS_TRIGGER']. */
  events: string[];
  /** Called once at registration time (when the operator creates an
   *  automation with this trigger). Establishes a baseline so the
   *  FIRST poll doesn't emit one event per pre-existing row. */
  initialState(args: PollAdapterArgs): Promise<Record<string, unknown>>;
  /** Called every poll cycle (cron-kicker fires every 1 min; per-row
   *  next_poll_at scheduling chooses which rows are due). */
  poll(
    args: PollAdapterArgs,
    lastState: Record<string, unknown>,
  ): Promise<PollAdapterResult>;
}

// ─── Registry ────────────────────────────────────────────────────────────

// Lazily populated to keep the index file dependency-free. Adapter
// modules call `registerAdapter` from their own entry points; the
// cron-kicker imports the adapters it cares about, which triggers
// registration as a side effect.
const adaptersByEvent = new Map<string, PollAdapter>();

export function registerAdapter(adapter: PollAdapter): void {
  for (const slug of adapter.events) {
    if (adaptersByEvent.has(slug)) {
      throw new Error(`poll-adapter: duplicate registration for ${slug}`);
    }
    adaptersByEvent.set(slug, adapter);
  }
}

export function getAdapter(toolkit: string, event: string): PollAdapter | null {
  const a = adaptersByEvent.get(event);
  if (!a) return null;
  if (a.toolkit.toLowerCase() !== toolkit.toLowerCase()) return null;
  return a;
}

/** Test-only: clear the registry between tests. */
export function _clearAdapterRegistryForTests(): void {
  adaptersByEvent.clear();
}
