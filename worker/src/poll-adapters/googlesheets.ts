// F.3 — PollAdapter for GOOGLESHEETS_NEW_ROWS_TRIGGER.
//
// Replaces Composio's managed-auth polling worker for googlesheets
// "new row" triggers (15-min managed-auth polling floor per their
// 2026-03-11 changelog). We poll directly from the cron-kicker every
// 2 minutes (configurable in F.2) by re-reading the configured sheet
// via composio_call("GOOGLESHEETS_BATCH_GET") and emitting one
// synthetic event per row that appeared since the previous poll.
//
// The emitted payload shape EXACTLY matches Composio's native
// GOOGLESHEETS_NEW_ROWS_TRIGGER payload so the existing D.5 input
// mapper (api/src/lib/composio-trigger-router.ts:pickInputMapper
// for 'googlesheets') keeps working unchanged — both the
// composio-webhook path (when push triggers are used) and this
// self-hosted poll path produce the same RunInputs.row.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_SLUG = "GOOGLESHEETS_BATCH_GET";

interface ToolExecuteResponse {
  data?: {
    response_data?: {
      // Sheets API passes through one of these keys (camelCase
      // matches Google's native shape; some Composio toolkits
      // normalize to snake_case). Handle both.
      valueRanges?: ValueRange[];
      value_ranges?: ValueRange[];
    };
  };
  successful?: boolean;
  error?: string | null;
}

interface ValueRange {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
}

interface GoogleSheetsState extends Record<string, unknown> {
  last_row_count: number;
  header_row?: string[];
}

interface GoogleSheetsConfig {
  spreadsheet_id?: string;
  sheet_name?: string;
  /** 1-based row index that data starts at (header rows above are
   *  skipped). Composio's trigger_config exposes this. */
  start_row?: number;
  /** Operator may explicitly toggle off the header-row hint by
   *  setting `header_row: false` in trigger_config; otherwise we
   *  treat row 1 as headers when start_row > 1. */
  header_row?: boolean | string[];
}

function readConfig(raw: Record<string, unknown>): {
  spreadsheetId: string;
  sheetName: string;
  startRow: number;
  hasHeader: boolean;
} {
  const cfg = raw as GoogleSheetsConfig;
  const spreadsheetId = cfg.spreadsheet_id;
  if (typeof spreadsheetId !== "string" || spreadsheetId.length === 0) {
    throw new Error("googlesheets adapter: trigger config missing spreadsheet_id");
  }
  const sheetName = cfg.sheet_name && cfg.sheet_name.length > 0 ? cfg.sheet_name : "Sheet1";
  const startRow = typeof cfg.start_row === "number" && cfg.start_row > 0 ? cfg.start_row : 1;
  // If header_row is explicitly false → no header. Otherwise: when
  // start_row > 1 there's at least one row above the data, so treat
  // row 1 as headers; when start_row === 1 the trigger has no
  // designated header row.
  const hasHeader = cfg.header_row === false ? false : startRow > 1;
  return { spreadsheetId, sheetName, startRow, hasHeader };
}

async function callBatchGet(
  args: PollAdapterArgs,
  cfg: ReturnType<typeof readConfig>,
): Promise<unknown[][]> {
  const fetchImpl = args.fetch ?? fetch;
  const ranges = [`${cfg.sheetName}!A1:Z`];
  const url = `${COMPOSIO_BASE_URL.replace(/\/+$/, "")}/tools/execute/${encodeURIComponent(TOOL_SLUG)}`;
  const body = {
    user_id: args.composioUserId,
    connected_account_id: args.connectedAccountId,
    arguments: {
      spreadsheet_id: cfg.spreadsheetId,
      ranges,
    },
  };
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "x-api-key": args.composioApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `googlesheets adapter: ${TOOL_SLUG} HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as ToolExecuteResponse;
  if (parsed.successful === false) {
    throw new Error(
      `googlesheets adapter: ${TOOL_SLUG} returned successful=false${parsed.error ? `: ${parsed.error}` : ""}`,
    );
  }
  const rd = parsed.data?.response_data;
  const valueRanges = rd?.valueRanges ?? rd?.value_ranges ?? [];
  const first = valueRanges[0];
  if (!first || !Array.isArray(first.values)) return [];
  return first.values;
}

/** Trim trailing all-empty rows that Sheets sometimes pads onto the
 *  end of a range (e.g. when ranges='Sheet1!A1:Z' is queried over
 *  a partially-filled sheet). */
function countNonEmptyRows(rows: unknown[][]): number {
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (Array.isArray(row) && row.some((cell) => cell !== "" && cell !== null && cell !== undefined)) {
      last = i;
    }
  }
  return last + 1;
}

function rowAsStringArray(row: unknown): string[] {
  if (!Array.isArray(row)) return [];
  return row.map((cell) => (cell == null ? "" : String(cell)));
}

export const googleSheetsAdapter: PollAdapter = {
  toolkit: "googlesheets",
  events: ["GOOGLESHEETS_NEW_ROWS_TRIGGER"],

  async initialState(args: PollAdapterArgs): Promise<GoogleSheetsState> {
    const cfg = readConfig(args.config);
    const rows = await callBatchGet(args, cfg);
    const lastRowCount = countNonEmptyRows(rows);
    const state: GoogleSheetsState = { last_row_count: lastRowCount };
    if (cfg.hasHeader && rows.length > 0) {
      state.header_row = rowAsStringArray(rows[0]);
    }
    return state;
  },

  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = readConfig(args.config);
    const rows = await callBatchGet(args, cfg);
    const currentCount = countNonEmptyRows(rows);
    const prev = (typeof lastState.last_row_count === "number" ? lastState.last_row_count : 0);
    const prevHeader = Array.isArray(lastState.header_row)
      ? (lastState.header_row as unknown[]).map((h) => (typeof h === "string" ? h : String(h)))
      : undefined;

    // Re-derive header from row 0 if config says we have one; falls
    // back to the previously-stored header otherwise.
    const headerRow = cfg.hasHeader && rows.length > 0 ? rowAsStringArray(rows[0]) : prevHeader;

    if (currentCount < prev) {
      // Sheet shrank (row deletion). NEVER emit synthetic "delete"
      // events — just resync the baseline and keep going. We also
      // don't tear down or pause; this is a routine user action.
      console.warn("googlesheets adapter: sheet shrank; resyncing baseline", {
        prev,
        current: currentCount,
        spreadsheetId: cfg.spreadsheetId,
        sheetName: cfg.sheetName,
      });
      return {
        newEvents: [],
        nextState: {
          last_row_count: currentCount,
          ...(headerRow ? { header_row: headerRow } : {}),
        },
      };
    }

    if (currentCount === prev) {
      return {
        newEvents: [],
        nextState: {
          last_row_count: currentCount,
          ...(headerRow ? { header_row: headerRow } : {}),
        },
      };
    }

    // currentCount > prev. New rows are at indices [prev, currentCount).
    // row_number is 1-based (Composio's native shape). Spreadsheet
    // row N corresponds to rows[N-1] in the values array.
    const detectedAt = new Date().toISOString();
    const newEvents: PollAdapterEvent[] = [];
    for (let i = prev; i < currentCount; i++) {
      const row = rows[i] ?? [];
      const rowData = Array.isArray(row) ? row : [];
      const payload: Record<string, unknown> = {
        row_number: i + 1,
        row_data: rowData,
        sheet_name: cfg.sheetName,
        spreadsheet_id: cfg.spreadsheetId,
        detected_at: detectedAt,
      };
      // header_row is a hint the kicker uses to build a keyed `row`
      // object in buildInputs(toolkit, event, payload). Composio's
      // native payload does NOT include it; we tack it on as an
      // extra field so the mapper produces useful inputs.
      if (headerRow && headerRow.length > 0) {
        payload.header_row = headerRow;
      }
      newEvents.push({ payload });
    }

    return {
      newEvents,
      nextState: {
        last_row_count: currentCount,
        ...(headerRow ? { header_row: headerRow } : {}),
      },
    };
  },
};

registerAdapter(googleSheetsAdapter);
