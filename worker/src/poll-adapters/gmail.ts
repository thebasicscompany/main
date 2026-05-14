// F.4 / F.10 — PollAdapter for GMAIL_NEW_GMAIL_MESSAGE.
//
// Gmail's native history API (users.history.list) isn't exposed by
// Composio as a callable tool slug — verified live during F.10
// verification: GMAIL_LIST_HISTORY and GMAIL_FETCH_USER_PROFILE both
// 404. The closest workable Composio tool is GMAIL_FETCH_EMAILS,
// which accepts an `after:<unix_secs>` query and returns the message
// list.
//
// State strategy:
//   - `last_seen_unix`: epoch-seconds high-water. We always re-query
//     from `last_seen - SLACK_SECS` to guard against Gmail's
//     indexing delay (new messages don't always appear at `now()`).
//   - `last_seen_message_ids: string[]`: ring of recently-emitted
//     message IDs (cap 200). Used to dedupe the messages re-fetched
//     by the slack window.
//
// Each emitted payload matches Composio's native
// GMAIL_NEW_GMAIL_MESSAGE webhook shape so the cron-kicker's inline
// `buildInputs` mapper (worker/cron-kicker/handler.ts) and D.5's
// pickInputMapper produce the same RunInputs.email object.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_FETCH_EMAILS = "GMAIL_FETCH_EMAILS";
const SLACK_SECS = 300; // re-query the last 5 min on every poll to handle Gmail indexing lag
const ID_RING_CAP = 200;
const FETCH_PAGE_SIZE = 50;

interface GmailState extends Record<string, unknown> {
  last_seen_unix: number;
  last_seen_message_ids?: string[];
}

interface GmailConfig {
  /** Optional From-address filter; matched as a Gmail `from:` query
   *  fragment OR'd together. */
  from?: string[];
  /** Optional label filter; `label:` Gmail query operator. */
  label?: string;
  /** When true, set verbose=true on GMAIL_FETCH_EMAILS to include
   *  message body. */
  include_body?: boolean;
}

interface ToolExecuteResponse<T = unknown> {
  data?: { response_data?: T } | T;
  successful?: boolean;
  error?: string | null;
}

interface FetchEmailsData {
  messages?: Array<{
    messageId?: string;
    threadId?: string;
    subject?: string;
    sender?: string;
    to?: string;
    labelIds?: string[];
    messageTimestamp?: string;
    messageText?: string;
    preview?: { body?: string; subject?: string } | Record<string, unknown>;
    payload?: Record<string, unknown>;
  }>;
  nextPageToken?: string | null;
  resultSizeEstimate?: number;
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
      `gmail adapter: ${toolSlug} HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as ToolExecuteResponse<unknown>;
  if (parsed.successful === false) {
    throw new Error(
      `gmail adapter: ${toolSlug} returned successful=false${parsed.error ? `: ${parsed.error}` : ""}`,
    );
  }
  // Composio sometimes nests under `data.response_data` (the v3.1
  // execute envelope) and sometimes returns the underlying tool's
  // response object directly under `data`. Walk both shapes.
  const data = parsed.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    const inner = (data as { response_data?: unknown }).response_data;
    if (inner !== undefined) return inner as T;
    return data as unknown as T;
  }
  return {} as T;
}

function readConfig(raw: Record<string, unknown>): {
  fromList: string[] | null;
  labelFilter: string | null;
  verbose: boolean;
} {
  const cfg = raw as GmailConfig;
  const fromList = Array.isArray(cfg.from) && cfg.from.length > 0
    ? cfg.from.filter((s): s is string => typeof s === "string" && s.length > 0)
    : null;
  const labelFilter = typeof cfg.label === "string" && cfg.label.length > 0 ? cfg.label : null;
  return { fromList, labelFilter, verbose: cfg.include_body === true };
}

function buildGmailQuery(cfg: ReturnType<typeof readConfig>, afterUnixSecs: number): string {
  const clauses: string[] = [`after:${afterUnixSecs}`];
  if (cfg.fromList && cfg.fromList.length > 0) {
    const groups = cfg.fromList.map((s) => `from:${s}`).join(" OR ");
    clauses.push(`(${groups})`);
  }
  if (cfg.labelFilter) clauses.push(`label:${cfg.labelFilter}`);
  return clauses.join(" ");
}

function parseEpochSecs(stamp: string | undefined): number | null {
  if (!stamp) return null;
  // Composio normalizes messageTimestamp to ISO-like or epoch-secs
  // strings depending on the toolkit version. Handle both.
  const asNum = Number(stamp);
  if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
    // If ms (> year 2286 vs year 2001), prefer secs.
    return asNum > 9_999_999_999 ? Math.floor(asNum / 1000) : Math.floor(asNum);
  }
  const t = Date.parse(stamp);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export const gmailAdapter: PollAdapter = {
  toolkit: "gmail",
  events: ["GMAIL_NEW_GMAIL_MESSAGE"],

  async initialState(_args: PollAdapterArgs): Promise<GmailState> {
    return {
      last_seen_unix: Math.floor(Date.now() / 1000),
      last_seen_message_ids: [],
    };
  },

  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = readConfig(args.config);
    const nowUnix = Math.floor(Date.now() / 1000);
    const lastSeen =
      typeof lastState.last_seen_unix === "number" && lastState.last_seen_unix > 0
        ? lastState.last_seen_unix
        : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_message_ids)
        ? (lastState.last_seen_message_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    );

    if (!lastSeen) {
      return {
        newEvents: [],
        nextState: { last_seen_unix: nowUnix, last_seen_message_ids: [] },
      };
    }

    // Re-query the slack window so Gmail indexing delays don't
    // silently drop messages. Dedup happens via lastSeenIds.
    const afterSecs = Math.max(1, lastSeen - SLACK_SECS);
    const query = buildGmailQuery(cfg, afterSecs);

    const rd = await callTool<FetchEmailsData>(args, TOOL_FETCH_EMAILS, {
      query,
      max_results: FETCH_PAGE_SIZE,
      user_id: "me",
      verbose: cfg.verbose,
      ids_only: false,
    });
    const messages = Array.isArray(rd.messages) ? rd.messages : [];

    const newEvents: PollAdapterEvent[] = [];
    const seenIdsThisPoll: string[] = [];
    let highWaterUnix = lastSeen;

    for (const m of messages) {
      if (typeof m.messageId !== "string" || m.messageId.length === 0) continue;
      seenIdsThisPoll.push(m.messageId);
      if (lastSeenIds.has(m.messageId)) continue;

      const ts = parseEpochSecs(m.messageTimestamp);
      if (ts !== null && ts > highWaterUnix) highWaterUnix = ts;

      const payload: Record<string, unknown> = {
        messageId: m.messageId,
        threadId: m.threadId,
        from: m.sender,
        to: m.to,
        subject: m.subject,
        labelIds: m.labelIds ?? [],
      };
      const previewSnippet =
        (m.preview && typeof m.preview === "object" && "body" in m.preview
          ? (m.preview as { body?: string }).body
          : undefined) ?? undefined;
      if (previewSnippet) payload.snippet = previewSnippet;
      if (typeof m.messageTimestamp === "string") payload.messageTimestamp = m.messageTimestamp;
      if (cfg.verbose && typeof m.messageText === "string") payload.messageText = m.messageText;

      // Strip undefineds.
      for (const k of Object.keys(payload)) {
        if (payload[k] === undefined) delete payload[k];
      }
      newEvents.push({ payload });
    }

    // Advance high-water to at least nowUnix (the query was for
    // after:N, so we've definitely seen everything older). The
    // ring of message ids is built from this poll's batch (cap 200).
    const advancedUnix = Math.max(highWaterUnix, nowUnix);
    const ring = seenIdsThisPoll.slice(0, ID_RING_CAP);

    return {
      newEvents,
      nextState: {
        last_seen_unix: advancedUnix,
        last_seen_message_ids: ring,
      },
    };
  },
};

registerAdapter(gmailAdapter);
