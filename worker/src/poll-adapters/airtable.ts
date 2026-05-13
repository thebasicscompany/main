// F.8 — PollAdapter for Airtable new-record-in-view trigger.
//
// Composio exposes airtable triggers somewhat indirectly; the
// practically-usable one is "new record in a view," which we
// re-implement directly via AIRTABLE_LIST_RECORDS with createdTime-
// descending sort. Each poll fetches the first page; we walk
// records from newest to oldest, emitting until we hit the prior
// last_seen_record_id. The state is the newest record's id.
//
// Why id-based high-water (per spec literal `{ last_seen_record_id
// }`) instead of timestamp-based:
//   - Airtable's `createdTime` is reliably populated; records
//     created in the same second commonly tie.
//   - Using the record_id of the newest-seen row gives an exact
//     boundary check (the next poll stops when it hits the same
//     id), so we never re-emit the same record and never miss new
//     records that share createdTime with the previously-emitted
//     boundary row.
//   - When the prior boundary record is deleted before the next
//     poll, we'd otherwise emit everything fetched. Defensive
//     fallback: also track a small ring of last_seen_record_ids
//     so a deleted boundary still has a backup match.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_LIST_RECORDS = "AIRTABLE_LIST_RECORDS";

const FETCH_PAGE_SIZE = 100;
const BOUNDARY_RING_SIZE = 20; // recent record ids kept for fallback dedup

interface AirtableState extends Record<string, unknown> {
  last_seen_record_id: string | null;
  last_seen_record_ids?: string[];
}

interface AirtableConfig {
  baseId?: string;
  base_id?: string;
  tableId?: string;
  table_id?: string;
  viewId?: string;
  view_id?: string;
  filterByFormula?: string;
  filter_by_formula?: string;
}

interface ToolExecuteResponse<T = unknown> {
  data?: { response_data?: T };
  successful?: boolean;
  error?: string | null;
}

interface AirtableRecord {
  id?: string;
  createdTime?: string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RecordsListResponse {
  records?: AirtableRecord[];
  offset?: string;
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
      `airtable adapter: ${toolSlug} HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as ToolExecuteResponse<T>;
  if (parsed.successful === false) {
    throw new Error(
      `airtable adapter: ${toolSlug} returned successful=false${parsed.error ? `: ${parsed.error}` : ""}`,
    );
  }
  return (parsed.data?.response_data ?? {}) as T;
}

function readConfig(raw: Record<string, unknown>): {
  baseId: string;
  tableId: string;
  viewId?: string;
  filterByFormula?: string;
} {
  const cfg = raw as AirtableConfig;
  const baseId = cfg.baseId ?? cfg.base_id;
  const tableId = cfg.tableId ?? cfg.table_id;
  if (typeof baseId !== "string" || baseId.length === 0) {
    throw new Error("airtable adapter: trigger config missing baseId");
  }
  if (typeof tableId !== "string" || tableId.length === 0) {
    throw new Error("airtable adapter: trigger config missing tableId");
  }
  const viewId =
    typeof cfg.viewId === "string" && cfg.viewId.length > 0
      ? cfg.viewId
      : typeof cfg.view_id === "string" && cfg.view_id.length > 0
        ? cfg.view_id
        : undefined;
  const filterByFormula =
    typeof cfg.filterByFormula === "string" && cfg.filterByFormula.length > 0
      ? cfg.filterByFormula
      : typeof cfg.filter_by_formula === "string" && cfg.filter_by_formula.length > 0
        ? cfg.filter_by_formula
        : undefined;
  return { baseId, tableId, viewId, filterByFormula };
}

async function fetchFirstPageDesc(
  args: PollAdapterArgs,
  cfg: ReturnType<typeof readConfig>,
): Promise<AirtableRecord[]> {
  const toolArgs: Record<string, unknown> = {
    baseId: cfg.baseId,
    tableId: cfg.tableId,
    sort: [{ field: "createdTime", direction: "desc" }],
    maxRecords: FETCH_PAGE_SIZE,
    pageSize: FETCH_PAGE_SIZE,
  };
  if (cfg.viewId) toolArgs.view = cfg.viewId;
  if (cfg.filterByFormula) toolArgs.filterByFormula = cfg.filterByFormula;
  const rd = await callTool<RecordsListResponse>(args, TOOL_LIST_RECORDS, toolArgs);
  return Array.isArray(rd.records) ? rd.records : [];
}

export const airtableAdapter: PollAdapter = {
  toolkit: "airtable",
  events: ["AIRTABLE_NEW_RECORD_TRIGGER"],

  async initialState(args: PollAdapterArgs): Promise<AirtableState> {
    const cfg = readConfig(args.config);
    const records = await fetchFirstPageDesc(args, cfg);
    const newestId = records[0]?.id ?? null;
    const ring = records.slice(0, BOUNDARY_RING_SIZE)
      .map((r) => r.id)
      .filter((s): s is string => typeof s === "string");
    return {
      last_seen_record_id: newestId,
      last_seen_record_ids: ring,
    };
  },

  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = readConfig(args.config);
    const lastSeenId =
      typeof lastState.last_seen_record_id === "string" ? lastState.last_seen_record_id : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_record_ids)
        ? (lastState.last_seen_record_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : lastSeenId
          ? [lastSeenId]
          : [],
    );

    const records = await fetchFirstPageDesc(args, cfg);

    if (records.length === 0) {
      return {
        newEvents: [],
        nextState: {
          last_seen_record_id: lastSeenId,
          last_seen_record_ids: Array.from(lastSeenIds).slice(0, BOUNDARY_RING_SIZE),
        },
      };
    }

    // If we never had a baseline (lastSeenId null), avoid dumping the
    // whole table — re-baseline silently on the newest record and
    // emit nothing. Mirrors the calendar/drive defensive recovery.
    if (!lastSeenId) {
      const ring = records.slice(0, BOUNDARY_RING_SIZE)
        .map((r) => r.id)
        .filter((s): s is string => typeof s === "string");
      return {
        newEvents: [],
        nextState: {
          last_seen_record_id: records[0]?.id ?? null,
          last_seen_record_ids: ring,
        },
      };
    }

    // Walk newest→oldest; stop when we hit any previously-seen id.
    const newEvents: PollAdapterEvent[] = [];
    for (const record of records) {
      if (typeof record.id !== "string") continue;
      if (lastSeenIds.has(record.id)) break;
      newEvents.push({
        payload: {
          record,
          base_id: cfg.baseId,
          table_id: cfg.tableId,
          view_id: cfg.viewId,
          record_id: record.id,
        },
      });
    }

    // New high-water = first record's id (the newest). Ring keeps
    // the last BOUNDARY_RING_SIZE record ids so a deleted boundary
    // row still has a fallback dedup target.
    const newestRecordId = records[0]?.id ?? lastSeenId;
    const ring = records.slice(0, BOUNDARY_RING_SIZE)
      .map((r) => r.id)
      .filter((s): s is string => typeof s === "string");

    // If we ran past the prior boundary without finding it (deleted),
    // we emitted everything — that's intentional defensive behavior.
    // Worst case: operator sees a backfill of up to FETCH_PAGE_SIZE
    // records, which is bounded.

    return {
      newEvents,
      nextState: {
        last_seen_record_id: newestRecordId,
        last_seen_record_ids: ring,
      },
    };
  },
};

registerAdapter(airtableAdapter);
