// F.7 — PollAdapters for Notion: page-added (workspace-wide),
// page-added-to-database (per-database), comments-added (per-page).
//
// Three Composio trigger slugs are involved, each with subtly
// different read semantics, so we register three separate
// PollAdapter objects (all under toolkit='notion') rather than
// threading a slug discriminator through one giant poll function.
// The framework's (toolkit, event)→adapter map (poll-adapters/
// index.ts) keeps them straight.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_NOTION_SEARCH = "NOTION_SEARCH";
const TOOL_NOTION_QUERY_DATABASE = "NOTION_QUERY_DATABASE";
const TOOL_NOTION_LIST_COMMENTS = "NOTION_LIST_COMMENTS";

const PAGE_CAP = 50;

interface ToolExecuteResponse<T = unknown> {
  data?: { response_data?: T };
  successful?: boolean;
  error?: string | null;
}

interface NotionPage {
  id?: string;
  object?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  parent?: { type?: string; database_id?: string; page_id?: string };
  properties?: Record<string, unknown>;
  url?: string;
  [key: string]: unknown;
}

interface NotionComment {
  id?: string;
  parent?: { type?: string; page_id?: string; block_id?: string };
  discussion_id?: string;
  created_time?: string;
  last_edited_time?: string;
  created_by?: { id?: string };
  rich_text?: unknown;
  [key: string]: unknown;
}

interface SearchOrQueryResponse {
  results?: Array<NotionPage>;
  next_cursor?: string | null;
  has_more?: boolean;
}

interface CommentsResponse {
  results?: Array<NotionComment>;
  next_cursor?: string | null;
  has_more?: boolean;
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
      `notion adapter: ${toolSlug} HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as ToolExecuteResponse<T>;
  if (parsed.successful === false) {
    throw new Error(
      `notion adapter: ${toolSlug} returned successful=false${parsed.error ? `: ${parsed.error}` : ""}`,
    );
  }
  // F.10 — Composio envelope shape varies per tool (data vs
  // data.response_data). Handle both.
  const data = parsed.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    const inner = (data as { response_data?: unknown }).response_data;
    if (inner !== undefined) return inner as T;
    return data as unknown as T;
  }
  return {} as T;
}

function maxIso(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return a >= b ? a : b;
}

// ─── Adapter 1: NOTION_PAGE_ADDED_TRIGGER ────────────────────────────────
//
// Workspace-wide "any page created" via NOTION_SEARCH sorted by
// last_edited_time desc. State: { last_seen_edited }.

interface PageAddedState extends Record<string, unknown> {
  last_seen_edited: string;
  last_seen_page_ids?: string[];
}

async function notionSearchPages(
  args: PollAdapterArgs,
  pageSize: number,
): Promise<NotionPage[]> {
  const collected: NotionPage[] = [];
  let nextCursor: string | undefined = undefined;
  for (let i = 0; i < PAGE_CAP; i++) {
    const toolArgs: Record<string, unknown> = {
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: pageSize,
    };
    if (nextCursor) toolArgs.start_cursor = nextCursor;
    const rd = await callTool<SearchOrQueryResponse>(args, TOOL_NOTION_SEARCH, toolArgs);
    const results = Array.isArray(rd.results) ? rd.results : [];
    collected.push(...results);
    if (!rd.has_more || !rd.next_cursor) break;
    nextCursor = rd.next_cursor;
  }
  return collected;
}

export const notionPageAddedAdapter: PollAdapter = {
  toolkit: "notion",
  events: ["NOTION_PAGE_ADDED_TRIGGER"],
  async initialState(args: PollAdapterArgs): Promise<PageAddedState> {
    return {
      last_seen_edited: new Date().toISOString(),
      last_seen_page_ids: [],
    };
  },
  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const lastSeen =
      typeof lastState.last_seen_edited === "string" ? lastState.last_seen_edited : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_page_ids)
        ? (lastState.last_seen_page_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    );

    if (!lastSeen) {
      return {
        newEvents: [],
        nextState: {
          last_seen_edited: new Date().toISOString(),
          last_seen_page_ids: [],
        },
      };
    }

    const pages = await notionSearchPages(args, 50);
    if (pages.length === 0) {
      return {
        newEvents: [],
        nextState: { last_seen_edited: lastSeen, last_seen_page_ids: Array.from(lastSeenIds) },
      };
    }

    let highWater: string | null = lastSeen;
    const newEvents: PollAdapterEvent[] = [];
    for (const page of pages) {
      highWater = maxIso(highWater, page.last_edited_time);
      // SEARCH returns ALL pages sorted desc — only emit ones whose
      // edit time is strictly later than the prior high-water OR at
      // the boundary but not in last_seen_page_ids.
      if (typeof page.last_edited_time !== "string") continue;
      if (page.last_edited_time < lastSeen) continue;
      if (
        page.last_edited_time === lastSeen &&
        typeof page.id === "string" &&
        lastSeenIds.has(page.id)
      ) {
        continue;
      }
      newEvents.push({
        payload: {
          page,
          page_id: page.id,
          last_edited_time: page.last_edited_time,
        },
      });
    }

    const newHighWater = highWater ?? lastSeen;
    const boundaryIds = newEvents
      .map((e) => e.payload.page as NotionPage | undefined)
      .filter((p): p is NotionPage => !!p && typeof p.id === "string" && p.last_edited_time === newHighWater)
      .map((p) => p.id as string);
    const mergedBoundaryIds =
      newHighWater === lastSeen
        ? Array.from(new Set<string>([...lastSeenIds, ...boundaryIds]))
        : boundaryIds;

    return {
      newEvents,
      nextState: { last_seen_edited: newHighWater, last_seen_page_ids: mergedBoundaryIds },
    };
  },
};

// ─── Adapter 2: NOTION_PAGE_ADDED_TO_DATABASE ────────────────────────────
//
// Per-database new-page detection via NOTION_QUERY_DATABASE.
// State: { last_seen_created, last_seen_page_ids? }.

interface DatabasePageState extends Record<string, unknown> {
  last_seen_created: string;
  last_seen_page_ids?: string[];
}

interface DatabaseConfig {
  database_id?: string;
}

async function notionQueryDatabaseDesc(
  args: PollAdapterArgs,
  databaseId: string,
): Promise<NotionPage[]> {
  const collected: NotionPage[] = [];
  let nextCursor: string | undefined = undefined;
  for (let i = 0; i < PAGE_CAP; i++) {
    const toolArgs: Record<string, unknown> = {
      database_id: databaseId,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 100,
    };
    if (nextCursor) toolArgs.start_cursor = nextCursor;
    const rd = await callTool<SearchOrQueryResponse>(args, TOOL_NOTION_QUERY_DATABASE, toolArgs);
    const results = Array.isArray(rd.results) ? rd.results : [];
    collected.push(...results);
    if (!rd.has_more || !rd.next_cursor) break;
    nextCursor = rd.next_cursor;
  }
  return collected;
}

export const notionPageAddedToDatabaseAdapter: PollAdapter = {
  toolkit: "notion",
  events: ["NOTION_PAGE_ADDED_TO_DATABASE"],
  async initialState(args: PollAdapterArgs): Promise<DatabasePageState> {
    return {
      last_seen_created: new Date().toISOString(),
      last_seen_page_ids: [],
    };
  },
  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = args.config as DatabaseConfig;
    if (typeof cfg.database_id !== "string" || cfg.database_id.length === 0) {
      throw new Error("notion adapter: NOTION_PAGE_ADDED_TO_DATABASE config missing database_id");
    }
    const lastSeen =
      typeof lastState.last_seen_created === "string" ? lastState.last_seen_created : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_page_ids)
        ? (lastState.last_seen_page_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    );

    if (!lastSeen) {
      return {
        newEvents: [],
        nextState: {
          last_seen_created: new Date().toISOString(),
          last_seen_page_ids: [],
        },
      };
    }

    const pages = await notionQueryDatabaseDesc(args, cfg.database_id);
    if (pages.length === 0) {
      return {
        newEvents: [],
        nextState: { last_seen_created: lastSeen, last_seen_page_ids: Array.from(lastSeenIds) },
      };
    }

    let highWater: string | null = lastSeen;
    const newEvents: PollAdapterEvent[] = [];
    for (const page of pages) {
      highWater = maxIso(highWater, page.created_time);
      if (typeof page.created_time !== "string") continue;
      if (page.created_time < lastSeen) continue;
      if (
        page.created_time === lastSeen &&
        typeof page.id === "string" &&
        lastSeenIds.has(page.id)
      ) {
        continue;
      }
      newEvents.push({
        payload: {
          page,
          page_id: page.id,
          database_id: cfg.database_id,
          created_time: page.created_time,
        },
      });
    }

    const newHighWater = highWater ?? lastSeen;
    const boundaryIds = newEvents
      .map((e) => e.payload.page as NotionPage | undefined)
      .filter((p): p is NotionPage => !!p && typeof p.id === "string" && p.created_time === newHighWater)
      .map((p) => p.id as string);
    const mergedBoundaryIds =
      newHighWater === lastSeen
        ? Array.from(new Set<string>([...lastSeenIds, ...boundaryIds]))
        : boundaryIds;

    return {
      newEvents,
      nextState: { last_seen_created: newHighWater, last_seen_page_ids: mergedBoundaryIds },
    };
  },
};

// ─── Adapter 3: NOTION_COMMENTS_ADDED_TRIGGER ────────────────────────────
//
// Per-page comments listing via NOTION_LIST_COMMENTS. Comment IDs
// are UUIDs (not ordered), so we use created_time as the high-water
// AND keep a boundary ID set to dedupe same-ms ties.

interface CommentsState extends Record<string, unknown> {
  last_seen_created: string;
  last_seen_comment_ids?: string[];
}

interface CommentsConfig {
  /** Composio's NOTION_COMMENTS_ADDED_TRIGGER config uses block_id
   *  (which is the page id you're watching for new comments on). */
  block_id?: string;
}

async function notionListCommentsAll(
  args: PollAdapterArgs,
  blockId: string,
): Promise<NotionComment[]> {
  const collected: NotionComment[] = [];
  let nextCursor: string | undefined = undefined;
  for (let i = 0; i < PAGE_CAP; i++) {
    const toolArgs: Record<string, unknown> = { block_id: blockId, page_size: 100 };
    if (nextCursor) toolArgs.start_cursor = nextCursor;
    const rd = await callTool<CommentsResponse>(args, TOOL_NOTION_LIST_COMMENTS, toolArgs);
    const results = Array.isArray(rd.results) ? rd.results : [];
    collected.push(...results);
    if (!rd.has_more || !rd.next_cursor) break;
    nextCursor = rd.next_cursor;
  }
  return collected;
}

export const notionCommentsAddedAdapter: PollAdapter = {
  toolkit: "notion",
  events: ["NOTION_COMMENTS_ADDED_TRIGGER"],
  async initialState(args: PollAdapterArgs): Promise<CommentsState> {
    return {
      last_seen_created: new Date().toISOString(),
      last_seen_comment_ids: [],
    };
  },
  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = args.config as CommentsConfig;
    if (typeof cfg.block_id !== "string" || cfg.block_id.length === 0) {
      throw new Error("notion adapter: NOTION_COMMENTS_ADDED_TRIGGER config missing block_id");
    }
    const lastSeen =
      typeof lastState.last_seen_created === "string" ? lastState.last_seen_created : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_comment_ids)
        ? (lastState.last_seen_comment_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    );

    if (!lastSeen) {
      return {
        newEvents: [],
        nextState: {
          last_seen_created: new Date().toISOString(),
          last_seen_comment_ids: [],
        },
      };
    }

    const comments = await notionListCommentsAll(args, cfg.block_id);
    if (comments.length === 0) {
      return {
        newEvents: [],
        nextState: { last_seen_created: lastSeen, last_seen_comment_ids: Array.from(lastSeenIds) },
      };
    }

    let highWater: string | null = lastSeen;
    const newEvents: PollAdapterEvent[] = [];
    for (const comment of comments) {
      highWater = maxIso(highWater, comment.created_time);
      if (typeof comment.created_time !== "string") continue;
      if (comment.created_time < lastSeen) continue;
      if (
        comment.created_time === lastSeen &&
        typeof comment.id === "string" &&
        lastSeenIds.has(comment.id)
      ) {
        continue;
      }
      newEvents.push({
        payload: {
          comment,
          comment_id: comment.id,
          page_id: cfg.block_id,
          created_time: comment.created_time,
        },
      });
    }

    const newHighWater = highWater ?? lastSeen;
    const boundaryIds = newEvents
      .map((e) => e.payload.comment as NotionComment | undefined)
      .filter((c): c is NotionComment => !!c && typeof c.id === "string" && c.created_time === newHighWater)
      .map((c) => c.id as string);
    const mergedBoundaryIds =
      newHighWater === lastSeen
        ? Array.from(new Set<string>([...lastSeenIds, ...boundaryIds]))
        : boundaryIds;

    return {
      newEvents,
      nextState: { last_seen_created: newHighWater, last_seen_comment_ids: mergedBoundaryIds },
    };
  },
};

registerAdapter(notionPageAddedAdapter);
registerAdapter(notionPageAddedToDatabaseAdapter);
registerAdapter(notionCommentsAddedAdapter);
