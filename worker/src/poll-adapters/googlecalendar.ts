// F.5 — PollAdapter for Google Calendar event-created /
// event-updated triggers. Both Composio trigger slugs map to the
// same underlying read (`GOOGLECALENDAR_EVENTS_LIST` with
// `updated_min`), so a single adapter handles them and emits events
// tagged with `change_kind: 'created' | 'updated'`.
//
// State: `{ last_seen_updated: ISO }`. We bump it on every poll to
// the max(event.updated) we saw, so subsequent polls only fetch
// events newer than the high-water mark.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_EVENTS_LIST = "GOOGLECALENDAR_EVENTS_LIST";
const EVENTS_PAGE_CAP = 50;

interface CalendarState extends Record<string, unknown> {
  last_seen_updated: string;
  /** Event IDs whose `updated` timestamp equals `last_seen_updated`
   *  and that we've already emitted. Google's `updated_min` is
   *  INCLUSIVE, so re-querying will return them again — we use this
   *  set to drop only those exact rows, not every event sharing
   *  that millisecond. Critical when bulk imports / recurring-
   *  expansion stamp many events the same ms. */
  last_seen_event_ids?: string[];
}

interface CalendarConfig {
  /** Composio's trigger_config supports calendar_id. Defaults to
   *  'primary' which Google maps to the user's main calendar. */
  calendar_id?: string;
}

interface ToolExecuteResponse<T = unknown> {
  data?: { response_data?: T };
  successful?: boolean;
  error?: string | null;
}

interface CalendarEvent {
  id?: string;
  status?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  organizer?: { email?: string; displayName?: string };
  htmlLink?: string;
  [key: string]: unknown;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  /** Some Composio variants normalize keys to snake_case. */
  next_page_token?: string;
}

async function callTool<T = unknown>(
  args: PollAdapterArgs,
  toolSlug: string,
  toolArgs: Record<string, unknown>,
): Promise<T> {
  const fetchImpl = args.fetch ?? fetch;
  const url = `${COMPOSIO_BASE_URL.replace(/\/+$/, "")}/tools/execute/${encodeURIComponent(toolSlug)}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "x-api-key": args.composioApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      user_id: args.composioUserId,
      connected_account_id: args.connectedAccountId,
      arguments: toolArgs,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `googlecalendar adapter: ${toolSlug} HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as ToolExecuteResponse<T>;
  if (parsed.successful === false) {
    throw new Error(
      `googlecalendar adapter: ${toolSlug} returned successful=false${parsed.error ? `: ${parsed.error}` : ""}`,
    );
  }
  // Composio's envelope is inconsistent across tools: some return
  // `data.response_data.<x>`, others return `data.<x>` directly.
  // F.10 caught this — handle both.
  const data = parsed.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    const inner = (data as { response_data?: unknown }).response_data;
    if (inner !== undefined) return inner as T;
    return data as unknown as T;
  }
  return {} as T;
}

function readConfig(raw: Record<string, unknown>): { calendarId: string } {
  const cfg = raw as CalendarConfig;
  const calendarId =
    typeof cfg.calendar_id === "string" && cfg.calendar_id.length > 0 ? cfg.calendar_id : "primary";
  return { calendarId };
}

async function fetchEventsPaginated(
  args: PollAdapterArgs,
  cfg: { calendarId: string },
  updatedMin: string | null,
): Promise<{ events: CalendarEvent[] }> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined = undefined;
  for (let i = 0; i < EVENTS_PAGE_CAP; i++) {
    const toolArgs: Record<string, unknown> = {
      calendar_id: cfg.calendarId,
      single_events: true, // expand recurring events; each instance carries its own updated
      show_deleted: true, // we filter on status='confirmed' below; show_deleted lets us advance high-water past deletions
      order_by: "updated",
    };
    if (updatedMin) toolArgs.updated_min = updatedMin;
    if (pageToken) toolArgs.page_token = pageToken;
    const rd = await callTool<EventsListResponse>(args, TOOL_EVENTS_LIST, toolArgs);
    const items = Array.isArray(rd.items) ? rd.items : [];
    events.push(...items);
    const nextToken = rd.nextPageToken ?? rd.next_page_token;
    pageToken = typeof nextToken === "string" && nextToken.length > 0 ? nextToken : undefined;
    if (!pageToken) break;
  }
  return { events };
}

function detectChangeKind(event: CalendarEvent): "created" | "updated" {
  // Per spec: created when event.created === event.updated. Google
  // sets `updated` strictly >= `created`; when they match exactly
  // we know the row has never been edited post-creation.
  if (
    typeof event.created === "string" &&
    typeof event.updated === "string" &&
    event.created === event.updated
  ) {
    return "created";
  }
  return "updated";
}

function maxIso(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return a >= b ? a : b;
}

export const googleCalendarAdapter: PollAdapter = {
  toolkit: "googlecalendar",
  events: [
    "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER",
    "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER",
  ],

  async initialState(args: PollAdapterArgs): Promise<CalendarState> {
    // Anchor at now so the first poll only emits events updated after
    // this point. Avoids emitting one event per row in a calendar's
    // back-catalog on registration.
    return {
      last_seen_updated: new Date().toISOString(),
      last_seen_event_ids: [],
    };
  },

  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = readConfig(args.config);
    const lastSeen =
      typeof lastState.last_seen_updated === "string" ? lastState.last_seen_updated : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_event_ids)
        ? (lastState.last_seen_event_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    );

    // Defensive: if state is missing the high-water (corrupted row),
    // re-baseline at now() and emit zero events. Avoids accidentally
    // dumping the entire calendar back-catalog as cloud_runs.
    if (!lastSeen) {
      return {
        newEvents: [],
        nextState: {
          last_seen_updated: new Date().toISOString(),
          last_seen_event_ids: [],
        },
      };
    }

    const { events } = await fetchEventsPaginated(args, cfg, lastSeen);

    if (events.length === 0) {
      return {
        newEvents: [],
        nextState: {
          last_seen_updated: lastSeen,
          last_seen_event_ids: Array.from(lastSeenIds),
        },
      };
    }

    let highWater: string | null = lastSeen;
    const newEvents: PollAdapterEvent[] = [];

    for (const event of events) {
      // Bump the high-water mark even for events we filter out, so
      // we don't loop on them forever.
      highWater = maxIso(highWater, event.updated);

      // Skip cancelled events — operator never asked for "calendar
      // event cancelled" semantics; let the deletion advance the
      // high-water mark and move on.
      if (event.status === "cancelled") continue;

      // updated_min is INCLUSIVE in Google's API, so events whose
      // `updated` exactly matches the prior high-water will reappear.
      // Drop only the specific IDs we already emitted at that
      // boundary timestamp; a NEW event that happens to share that
      // exact millisecond is still surfaced.
      if (
        typeof event.updated === "string" &&
        event.updated === lastSeen &&
        typeof event.id === "string" &&
        lastSeenIds.has(event.id)
      ) {
        continue;
      }

      newEvents.push({
        payload: {
          event,
          calendar_id: cfg.calendarId,
          change_kind: detectChangeKind(event),
        },
      });
    }

    // Capture event IDs at the new high-water timestamp so the next
    // poll's boundary drop targets only the rows we just emitted.
    const newHighWater = highWater ?? lastSeen;
    const boundaryIds = newEvents
      .map((e) => (e.payload.event as CalendarEvent | undefined))
      .filter((evt): evt is CalendarEvent => !!evt && typeof evt.id === "string" && evt.updated === newHighWater)
      .map((evt) => evt.id as string);

    // If the new high-water equals the prior one (only cancelled or
    // dropped boundary rows showed up), preserve the prior id set so
    // we don't forget previously-emitted boundary ids.
    const mergedBoundaryIds =
      newHighWater === lastSeen
        ? Array.from(new Set<string>([...lastSeenIds, ...boundaryIds]))
        : boundaryIds;

    return {
      newEvents,
      nextState: {
        last_seen_updated: newHighWater,
        last_seen_event_ids: mergedBoundaryIds,
      },
    };
  },
};

registerAdapter(googleCalendarAdapter);
