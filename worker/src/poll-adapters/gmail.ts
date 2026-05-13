// F.4 — PollAdapter for GMAIL_NEW_GMAIL_MESSAGE.
//
// Gmail exposes a history API (`users.history.list`) that returns
// deltas since a given historyId — far more efficient than scanning
// the inbox each poll. The adapter:
//   1) initialState — call GMAIL_FETCH_USER_PROFILE to grab the
//      current historyId; persist `{ start_history_id }`.
//   2) poll — call GMAIL_LIST_HISTORY paginated, collect every
//      `messagesAdded[*].message`, optionally fetch each message's
//      headers + snippet via GMAIL_FETCH_MESSAGE_BY_THREAD_ID, then
//      emit one PollAdapterEvent per new message. Update state to
//      the latest historyId reported by the API.
//   3) On HTTP 404 / Composio "history-id-too-old": fall back to
//      GMAIL_LIST_THREADS with `q=after:<unix_ts>`, then re-baseline
//      historyId from FETCH_USER_PROFILE before returning. (A
//      best-effort recovery — Gmail's history retention is ~7 days.)
//
// The emitted payload shape mirrors Composio's native
// GMAIL_NEW_GMAIL_MESSAGE webhook event so the existing input mapper
// in api/src/lib/composio-trigger-router.ts (and the cron-kicker's
// inline gmail mapper at handler.ts:137-149) work unchanged.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_FETCH_PROFILE = "GMAIL_FETCH_USER_PROFILE";
const TOOL_LIST_HISTORY = "GMAIL_LIST_HISTORY";
const TOOL_FETCH_MESSAGE = "GMAIL_FETCH_MESSAGE_BY_THREAD_ID";
const TOOL_LIST_THREADS = "GMAIL_LIST_THREADS";

const HISTORY_PAGE_CAP = 50; // safety: never paginate forever

interface GmailState extends Record<string, unknown> {
  start_history_id: string;
}

interface GmailConfig {
  /** Composio's GMAIL trigger config exposes optional filters. */
  label_ids?: string[];
  /** Restrict to messages whose From: matches one of these
   *  addresses (exact match, case-insensitive). */
  from?: string[];
  /** When true, fetch full message via GMAIL_FETCH_MESSAGE_BY_THREAD_ID
   *  so the payload includes body text. Default false — saves one
   *  HTTP call per message and matches what Composio's own webhook
   *  delivers for the basic trigger. */
  include_body?: boolean;
}

interface ToolExecuteResponse<T = unknown> {
  data?: { response_data?: T };
  successful?: boolean;
  error?: string | null;
}

interface HistoryMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

interface HistoryListResponse {
  history?: Array<{
    id?: string;
    messages?: HistoryMessage[];
    messagesAdded?: Array<{ message?: HistoryMessage }>;
  }>;
  historyId?: string;
  nextPageToken?: string;
}

interface MessagePayload {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
    body?: { data?: string };
    parts?: Array<{ body?: { data?: string }; mimeType?: string; parts?: unknown[] }>;
  };
}

interface ThreadsListResponse {
  threads?: Array<{ id?: string; historyId?: string; snippet?: string }>;
  nextPageToken?: string;
}

interface UserProfile {
  emailAddress?: string;
  historyId?: string;
}

class HistoryTooOldError extends Error {
  readonly _historyTooOld = true;
  constructor(message: string) {
    super(message);
    this.name = "HistoryTooOldError";
  }
}

function isHistoryTooOld(status: number, body: string): boolean {
  // Gmail's historyId-expired surfaces as HTTP 404 with body containing
  // "Requested entity was not found" OR HTTP 400 with
  // "Invalid startHistoryId" / "Start history ID is too old". Composio
  // may pass either of these through. Be lenient on detection.
  if (status === 404) return true;
  if (status === 400 && /history\s*id|startHistoryId/i.test(body)) return true;
  if (/too\s*old|expired|gone/i.test(body) && /history/i.test(body)) return true;
  return false;
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
    if (isHistoryTooOld(res.status, detail)) {
      throw new HistoryTooOldError(`gmail adapter: ${toolSlug} HTTP ${res.status}: ${detail}`);
    }
    throw new Error(`gmail adapter: ${toolSlug} HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = (await res.json()) as ToolExecuteResponse<T>;
  if (parsed.successful === false) {
    const err = parsed.error ?? "(no error message)";
    if (isHistoryTooOld(200, err)) {
      throw new HistoryTooOldError(`gmail adapter: ${toolSlug} returned successful=false: ${err}`);
    }
    throw new Error(`gmail adapter: ${toolSlug} returned successful=false: ${err}`);
  }
  return (parsed.data?.response_data ?? {}) as T;
}

function readConfig(raw: Record<string, unknown>): {
  labelIds: string[] | null;
  fromList: string[] | null;
  includeBody: boolean;
} {
  const cfg = raw as GmailConfig;
  const labelIds = Array.isArray(cfg.label_ids) && cfg.label_ids.length > 0 ? cfg.label_ids : null;
  const fromList = Array.isArray(cfg.from) && cfg.from.length > 0
    ? cfg.from.map((s) => String(s).toLowerCase())
    : null;
  return { labelIds, fromList, includeBody: cfg.include_body === true };
}

function getHeader(msg: MessagePayload | null, name: string): string | undefined {
  const headers = msg?.payload?.headers;
  if (!Array.isArray(headers)) return undefined;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (typeof h?.name === "string" && h.name.toLowerCase() === target && typeof h.value === "string") {
      return h.value;
    }
  }
  return undefined;
}

function decodeBody(msg: MessagePayload | null): string | undefined {
  if (!msg) return undefined;
  const part = msg.payload?.body?.data
    ? msg.payload.body
    : findTextPart(msg.payload?.parts);
  const data = part?.data;
  if (typeof data !== "string" || data.length === 0) return undefined;
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  } catch {
    return undefined;
  }
}

function findTextPart(parts: unknown): { data?: string } | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const raw of parts) {
    const p = raw as { body?: { data?: string }; mimeType?: string; parts?: unknown };
    if (p.mimeType === "text/plain" && p.body?.data) return p.body;
    if (Array.isArray(p.parts)) {
      const nested = findTextPart(p.parts);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function fetchHistoryPaginated(
  args: PollAdapterArgs,
  startHistoryId: string,
  labelIds: string[] | null,
): Promise<{ messages: HistoryMessage[]; latestHistoryId: string }> {
  const seen = new Set<string>();
  const messages: HistoryMessage[] = [];
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined = undefined;

  for (let i = 0; i < HISTORY_PAGE_CAP; i++) {
    const toolArgs: Record<string, unknown> = {
      start_history_id: startHistoryId,
      history_types: ["messageAdded"],
    };
    if (pageToken) toolArgs.page_token = pageToken;
    if (labelIds && labelIds.length > 0) toolArgs.label_id = labelIds[0]; // Gmail API takes single labelId

    const rd = await callTool<HistoryListResponse>(args, TOOL_LIST_HISTORY, toolArgs);
    if (typeof rd.historyId === "string" && rd.historyId.length > 0) {
      latestHistoryId = rd.historyId;
    }
    const history = Array.isArray(rd.history) ? rd.history : [];
    for (const h of history) {
      const added = Array.isArray(h.messagesAdded) ? h.messagesAdded : [];
      for (const a of added) {
        const m = a.message;
        if (m && typeof m.id === "string" && !seen.has(m.id)) {
          seen.add(m.id);
          messages.push(m);
        }
      }
    }

    pageToken = typeof rd.nextPageToken === "string" ? rd.nextPageToken : undefined;
    if (!pageToken) break;
  }

  return { messages, latestHistoryId };
}

async function fetchMessageDetails(
  args: PollAdapterArgs,
  messageId: string,
): Promise<MessagePayload | null> {
  try {
    return await callTool<MessagePayload>(args, TOOL_FETCH_MESSAGE, {
      message_id: messageId,
      format: "full",
    });
  } catch (e) {
    // Per-message fetch failures shouldn't sink the whole sweep.
    console.warn("gmail adapter: per-message fetch failed", {
      messageId,
      error: (e as Error).message,
    });
    return null;
  }
}

function buildPayload(
  base: HistoryMessage,
  details: MessagePayload | null,
  includeBody: boolean,
): Record<string, unknown> {
  const from = getHeader(details, "from");
  const to = getHeader(details, "to");
  const subject = getHeader(details, "subject");
  const labelIds = details?.labelIds ?? base.labelIds ?? [];
  const payload: Record<string, unknown> = {
    messageId: base.id,
    threadId: details?.threadId ?? base.threadId,
    from: from ?? undefined,
    to: to ?? undefined,
    subject: subject ?? undefined,
    snippet: details?.snippet,
    labelIds,
  };
  if (typeof details?.internalDate === "string") {
    payload.messageTimestamp = details.internalDate;
  }
  if (includeBody) {
    const body = decodeBody(details);
    if (typeof body === "string") payload.messageText = body;
  }
  // Drop undefineds for a tidy JSON envelope.
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }
  return payload;
}

function senderMatchesFilter(fromHeader: string | undefined, fromList: string[] | null): boolean {
  if (!fromList) return true;
  if (!fromHeader) return false;
  const lower = fromHeader.toLowerCase();
  return fromList.some((f) => lower.includes(f));
}

async function recoverFromTooOld(args: PollAdapterArgs): Promise<GmailState> {
  // Re-baseline: fetch profile for the latest historyId. Best-effort
  // emit-zero on history loss — the alternative (replaying everything
  // since now-7d via LIST_THREADS) risks spamming the operator with
  // backfill events that the user already saw.
  const profile = await callTool<UserProfile>(args, TOOL_FETCH_PROFILE, {});
  const historyId = typeof profile.historyId === "string" ? profile.historyId : "";
  if (historyId.length === 0) {
    throw new Error("gmail adapter: profile lacked historyId during too-old recovery");
  }
  return { start_history_id: historyId };
}

async function fallbackListThreadsSince(
  args: PollAdapterArgs,
  cfg: { labelIds: string[] | null; fromList: string[] | null; includeBody: boolean },
): Promise<HistoryMessage[]> {
  // Gmail query `after:<unix_secs>` for the last hour. We cap at 1h
  // not 7d because the spec's fallback is "we lost track of state",
  // and replaying all of last week's mail is exactly the kind of
  // operator-spam this adapter is meant to avoid.
  const afterTs = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
  const q = `after:${afterTs}`;
  const toolArgs: Record<string, unknown> = { q };
  if (cfg.labelIds && cfg.labelIds.length > 0) toolArgs.label_ids = cfg.labelIds;
  const rd = await callTool<ThreadsListResponse>(args, TOOL_LIST_THREADS, toolArgs);
  const threads = Array.isArray(rd.threads) ? rd.threads : [];
  return threads
    .filter((t) => typeof t.id === "string")
    .map((t) => ({ id: t.id as string, threadId: t.id }));
}

export const gmailAdapter: PollAdapter = {
  toolkit: "gmail",
  events: ["GMAIL_NEW_GMAIL_MESSAGE"],

  async initialState(args: PollAdapterArgs): Promise<GmailState> {
    const profile = await callTool<UserProfile>(args, TOOL_FETCH_PROFILE, {});
    const historyId = typeof profile.historyId === "string" ? profile.historyId : "";
    if (historyId.length === 0) {
      throw new Error("gmail adapter: GMAIL_FETCH_USER_PROFILE response missing historyId");
    }
    return { start_history_id: historyId };
  },

  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = readConfig(args.config);
    const startHistoryId =
      typeof lastState.start_history_id === "string" ? lastState.start_history_id : "";
    if (startHistoryId.length === 0) {
      // No baseline yet — re-baseline silently. (Defensive; F.9 sets
      // initialState on registration, but a stale row missing the
      // field shouldn't crash the sweep.)
      const fresh = await recoverFromTooOld(args);
      return { newEvents: [], nextState: fresh };
    }

    let historyMessages: HistoryMessage[];
    let latestHistoryId: string;

    try {
      const result = await fetchHistoryPaginated(args, startHistoryId, cfg.labelIds);
      historyMessages = result.messages;
      latestHistoryId = result.latestHistoryId;
    } catch (e) {
      if (e instanceof HistoryTooOldError || (e as { _historyTooOld?: boolean })._historyTooOld) {
        console.warn("gmail adapter: historyId expired; recovering via LIST_THREADS + profile baseline", {
          startHistoryId,
        });
        historyMessages = await fallbackListThreadsSince(args, cfg);
        const fresh = await recoverFromTooOld(args);
        latestHistoryId = fresh.start_history_id;
      } else {
        throw e;
      }
    }

    if (historyMessages.length === 0) {
      return {
        newEvents: [],
        nextState: { start_history_id: latestHistoryId },
      };
    }

    const newEvents: PollAdapterEvent[] = [];
    for (const base of historyMessages) {
      if (!base.id) continue;
      // Fetch details when either include_body is set OR the
      // from-filter is configured (we need the From: header to
      // filter on). Otherwise the history-API minimal info is enough.
      const needsDetails = cfg.includeBody || cfg.fromList !== null;
      const details = needsDetails ? await fetchMessageDetails(args, base.id) : null;
      const payload = buildPayload(base, details, cfg.includeBody);

      if (cfg.fromList && !senderMatchesFilter(getHeader(details, "from"), cfg.fromList)) {
        continue;
      }

      newEvents.push({ payload });
    }

    return {
      newEvents,
      nextState: { start_history_id: latestHistoryId },
    };
  },
};

registerAdapter(gmailAdapter);
