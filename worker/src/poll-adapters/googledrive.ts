// F.6 — PollAdapter for Google Drive new-file / new-file-matching-
// query triggers. Both Composio slugs map to the same underlying
// read (`GOOGLEDRIVE_LIST_FILES`) with a `q` constructed from the
// operator-supplied filters plus a `modifiedTime > <last_seen>`
// term to scope to newly-changed files since the previous sweep.
//
// Drive's `modifiedTime` is generally what users mean by "new"
// (covers create-by-upload, copy-into-folder, move-into-folder).
// `createdTime` is also available but misses copy/move semantics
// that an operator-facing automation usually cares about.

import {
  registerAdapter,
  type PollAdapter,
  type PollAdapterArgs,
  type PollAdapterEvent,
  type PollAdapterResult,
} from "./index.js";

const COMPOSIO_BASE_URL =
  process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev/api/v3.1";

const TOOL_LIST_FILES = "GOOGLEDRIVE_LIST_FILES";
const FILES_PAGE_CAP = 50;

interface DriveState extends Record<string, unknown> {
  last_seen_modified: string;
  /** File IDs at the exact boundary millisecond, to avoid duplicate
   *  emit when modifiedTime ties with the prior high-water (Drive's
   *  Q-language treats `modifiedTime > X` as strict-greater, but
   *  string-equal boundaries can still slip through when Drive
   *  rounds to seconds — defensive). */
  last_seen_file_ids?: string[];
}

interface DriveConfig {
  /** Filter shape from Composio trigger_config:
   *   - mimeType: 'application/pdf' or array of mime types
   *   - parents: 'folderId' or array of parent folder ids
   *   - query: freeform Drive q-string (operator escape hatch) */
  mimeType?: string | string[];
  parents?: string | string[];
  query?: string;
}

interface ToolExecuteResponse<T = unknown> {
  data?: { response_data?: T };
  successful?: boolean;
  error?: string | null;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  parents?: string[];
  size?: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  [key: string]: unknown;
}

interface FilesListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
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
      `googledrive adapter: ${toolSlug} HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as ToolExecuteResponse<T>;
  if (parsed.successful === false) {
    throw new Error(
      `googledrive adapter: ${toolSlug} returned successful=false${parsed.error ? `: ${parsed.error}` : ""}`,
    );
  }
  // F.10 — Composio envelope shape is inconsistent per tool. Some
  // tools nest under `data.response_data`, others put the payload
  // directly under `data`. Handle both.
  const data = parsed.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    const inner = (data as { response_data?: unknown }).response_data;
    if (inner !== undefined) return inner as T;
    return data as unknown as T;
  }
  return {} as T;
}

function asArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.length > 0) : [v];
}

/** Build a Drive `q` query string per
 *  https://developers.google.com/drive/api/guides/search-files.
 *  Escape strategy for embedded quotes: backslash-escape `'` and
 *  `\\`. This matches Drive's documented escaping rules. */
function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildDriveQuery(cfg: DriveConfig, lastSeenModified: string): string {
  const clauses: string[] = [`modifiedTime > '${escapeQ(lastSeenModified)}'`];
  // Drive treats trashed files as visible by default; exclude them.
  clauses.push("trashed = false");

  const mimeTypes = asArray(cfg.mimeType);
  if (mimeTypes.length === 1) {
    clauses.push(`mimeType = '${escapeQ(mimeTypes[0]!)}'`);
  } else if (mimeTypes.length > 1) {
    const grouped = mimeTypes.map((m) => `mimeType = '${escapeQ(m)}'`).join(" or ");
    clauses.push(`(${grouped})`);
  }

  const parents = asArray(cfg.parents);
  if (parents.length === 1) {
    clauses.push(`'${escapeQ(parents[0]!)}' in parents`);
  } else if (parents.length > 1) {
    const grouped = parents.map((p) => `'${escapeQ(p)}' in parents`).join(" or ");
    clauses.push(`(${grouped})`);
  }

  if (typeof cfg.query === "string" && cfg.query.trim().length > 0) {
    // Wrap operator-supplied freeform query in parens so it doesn't
    // bind incorrectly with our `and` joins.
    clauses.push(`(${cfg.query.trim()})`);
  }

  return clauses.join(" and ");
}

function readConfig(raw: Record<string, unknown>): DriveConfig {
  return raw as DriveConfig;
}

async function fetchFilesPaginated(
  args: PollAdapterArgs,
  q: string,
): Promise<{ files: DriveFile[] }> {
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined = undefined;
  for (let i = 0; i < FILES_PAGE_CAP; i++) {
    const toolArgs: Record<string, unknown> = {
      q,
      page_size: 100,
      fields:
        "files(id,name,mimeType,modifiedTime,createdTime,webViewLink,webContentLink,parents,size,owners(emailAddress,displayName)),nextPageToken",
      order_by: "modifiedTime",
    };
    if (pageToken) toolArgs.page_token = pageToken;
    const rd = await callTool<FilesListResponse>(args, TOOL_LIST_FILES, toolArgs);
    const batch = Array.isArray(rd.files) ? rd.files : [];
    for (const f of batch) {
      if (typeof f.id === "string" && !seen.has(f.id)) {
        seen.add(f.id);
        files.push(f);
      }
    }
    const next = rd.nextPageToken ?? rd.next_page_token;
    pageToken = typeof next === "string" && next.length > 0 ? next : undefined;
    if (!pageToken) break;
  }
  return { files };
}

function maxIso(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return a >= b ? a : b;
}

export const googleDriveAdapter: PollAdapter = {
  toolkit: "googledrive",
  events: [
    "GOOGLEDRIVE_FILE_CREATED_TRIGGER",
    "GOOGLEDRIVE_NEW_FILE_MATCHING_QUERY_TRIGGER",
  ],

  async initialState(args: PollAdapterArgs): Promise<DriveState> {
    // Anchor at now() so the first poll doesn't dump the operator's
    // entire Drive as cloud_runs.
    return {
      last_seen_modified: new Date().toISOString(),
      last_seen_file_ids: [],
    };
  },

  async poll(args: PollAdapterArgs, lastState: Record<string, unknown>): Promise<PollAdapterResult> {
    const cfg = readConfig(args.config);
    const lastSeen =
      typeof lastState.last_seen_modified === "string" ? lastState.last_seen_modified : null;
    const lastSeenIds = new Set<string>(
      Array.isArray(lastState.last_seen_file_ids)
        ? (lastState.last_seen_file_ids as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
    );

    if (!lastSeen) {
      return {
        newEvents: [],
        nextState: {
          last_seen_modified: new Date().toISOString(),
          last_seen_file_ids: [],
        },
      };
    }

    const q = buildDriveQuery(cfg, lastSeen);
    const { files } = await fetchFilesPaginated(args, q);

    if (files.length === 0) {
      return {
        newEvents: [],
        nextState: {
          last_seen_modified: lastSeen,
          last_seen_file_ids: Array.from(lastSeenIds),
        },
      };
    }

    let highWater: string | null = lastSeen;
    const newEvents: PollAdapterEvent[] = [];

    for (const file of files) {
      highWater = maxIso(highWater, file.modifiedTime);
      // Drive's q-language uses strict `>` for modifiedTime, but be
      // defensive — same-millisecond ties can occur if Drive's
      // backend rounds before we serialize, and a boundary file the
      // prior poll emitted would slip through equality-via-rounding.
      if (
        typeof file.modifiedTime === "string" &&
        file.modifiedTime === lastSeen &&
        typeof file.id === "string" &&
        lastSeenIds.has(file.id)
      ) {
        continue;
      }
      newEvents.push({
        payload: {
          file,
          file_id: file.id,
          mime_type: file.mimeType,
          modified_time: file.modifiedTime,
        },
      });
    }

    const newHighWater = highWater ?? lastSeen;
    const boundaryIds = newEvents
      .map((e) => e.payload.file as DriveFile | undefined)
      .filter((f): f is DriveFile => !!f && typeof f.id === "string" && f.modifiedTime === newHighWater)
      .map((f) => f.id as string);
    const mergedBoundaryIds =
      newHighWater === lastSeen
        ? Array.from(new Set<string>([...lastSeenIds, ...boundaryIds]))
        : boundaryIds;

    return {
      newEvents,
      nextState: {
        last_seen_modified: newHighWater,
        last_seen_file_ids: mergedBoundaryIds,
      },
    };
  },
};

registerAdapter(googleDriveAdapter);
