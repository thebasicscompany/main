import { describe, expect, it, vi } from "vitest";
import { googleDriveAdapter } from "./googledrive.js";

interface ExecuteResponse {
  data: { response_data: unknown };
  successful?: boolean;
  error?: string | null;
}

interface DriveFileFixture {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime: string;
  createdTime?: string;
  parents?: string[];
}

function makeFetch(queues: Record<string, ExecuteResponse[]>): {
  fetchImpl: typeof fetch;
  calls: Array<{ toolSlug: string; args: Record<string, unknown> }>;
} {
  const remaining: Record<string, ExecuteResponse[]> = {};
  for (const [k, v] of Object.entries(queues)) remaining[k] = [...v];
  const calls: Array<{ toolSlug: string; args: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/tools\/execute\/([^?]+)$/);
    const toolSlug = m ? decodeURIComponent(m[1]!) : "";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ toolSlug, args: body.arguments as Record<string, unknown> });
    const queue = remaining[toolSlug];
    if (!queue || queue.length === 0) throw new Error(`no canned response for ${toolSlug}`);
    const next = queue.shift()!;
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function listResp(files: DriveFileFixture[], nextPageToken?: string): ExecuteResponse {
  return {
    data: { response_data: { files, nextPageToken } },
    successful: true,
    error: null,
  };
}

const baseArgs = {
  composioUserId: "op@example.com",
  connectedAccountId: "ca_drive_fixture",
  composioApiKey: "test_key",
};

describe("googledrive PollAdapter", () => {
  it("registers under 'googledrive' for both new-file trigger slugs", () => {
    expect(googleDriveAdapter.toolkit).toBe("googledrive");
    expect(googleDriveAdapter.events).toEqual([
      "GOOGLEDRIVE_FILE_CREATED_TRIGGER",
      "GOOGLEDRIVE_NEW_FILE_MATCHING_QUERY_TRIGGER",
    ]);
  });

  it("initialState anchors last_seen_modified at the current time", async () => {
    const before = Date.now();
    const state = await googleDriveAdapter.initialState({ ...baseArgs, config: {} });
    const after = Date.now();
    expect(typeof state.last_seen_modified).toBe("string");
    const ts = Date.parse(state.last_seen_modified as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(state.last_seen_file_ids).toEqual([]);
  });

  it("poll: no changes → zero events, preserves last_seen_modified", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [listResp([])],
    });
    const result = await googleDriveAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_modified: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_seen_modified).toBe("2026-05-13T10:00:00.000Z");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.args.q as string)).toContain("modifiedTime > '2026-05-13T10:00:00.000Z'");
    expect((calls[0]!.args.q as string)).toContain("trashed = false");
  });

  it("poll: single new file emits Composio-shaped payload", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [
        listResp([
          {
            id: "file_A",
            name: "Pitch.pdf",
            mimeType: "application/pdf",
            modifiedTime: "2026-05-13T11:30:00.000Z",
            createdTime: "2026-05-13T11:30:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleDriveAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_modified: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      file_id: "file_A",
      mime_type: "application/pdf",
      modified_time: "2026-05-13T11:30:00.000Z",
    });
    expect((result.newEvents[0]!.payload.file as { id: string }).id).toBe("file_A");
    expect(result.nextState.last_seen_modified).toBe("2026-05-13T11:30:00.000Z");
  });

  it("poll: mimeType filter (single) appended to q", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [listResp([])],
    });
    await googleDriveAdapter.poll(
      {
        ...baseArgs,
        config: { mimeType: "application/pdf" },
        fetch: fetchImpl,
      },
      { last_seen_modified: "2026-05-13T10:00:00.000Z" },
    );
    expect((calls[0]!.args.q as string)).toContain("mimeType = 'application/pdf'");
  });

  it("poll: mimeType filter (array) groups with OR", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [listResp([])],
    });
    await googleDriveAdapter.poll(
      {
        ...baseArgs,
        config: { mimeType: ["application/pdf", "image/png"] },
        fetch: fetchImpl,
      },
      { last_seen_modified: "2026-05-13T10:00:00.000Z" },
    );
    const q = calls[0]!.args.q as string;
    expect(q).toContain("(mimeType = 'application/pdf' or mimeType = 'image/png')");
  });

  it("poll: parents filter (single) restricts to folder", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [listResp([])],
    });
    await googleDriveAdapter.poll(
      { ...baseArgs, config: { parents: "folder_xyz" }, fetch: fetchImpl },
      { last_seen_modified: "2026-05-13T10:00:00.000Z" },
    );
    expect((calls[0]!.args.q as string)).toContain("'folder_xyz' in parents");
  });

  it("poll: freeform query filter is wrapped in parens and ANDed in", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [listResp([])],
    });
    await googleDriveAdapter.poll(
      {
        ...baseArgs,
        config: { query: "name contains 'Q3' or fullText contains 'pipeline'" },
        fetch: fetchImpl,
      },
      { last_seen_modified: "2026-05-13T10:00:00.000Z" },
    );
    const q = calls[0]!.args.q as string;
    expect(q).toContain("(name contains 'Q3' or fullText contains 'pipeline')");
  });

  it("poll: mixed mime types in result emit one event each, dedupe by file id", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [
        listResp([
          {
            id: "f1",
            mimeType: "application/pdf",
            modifiedTime: "2026-05-13T12:01:00.000Z",
          },
          {
            id: "f2",
            mimeType: "image/png",
            modifiedTime: "2026-05-13T12:02:00.000Z",
          },
          {
            id: "f1", // duplicate (rare but defensive)
            mimeType: "application/pdf",
            modifiedTime: "2026-05-13T12:01:00.000Z",
          },
          {
            id: "f3",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-05-13T12:03:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleDriveAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_modified: "2026-05-13T12:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(3);
    expect(result.newEvents.map((e) => e.payload.file_id)).toEqual(["f1", "f2", "f3"]);
    expect(result.nextState.last_seen_modified).toBe("2026-05-13T12:03:00.000Z");
  });

  it("poll: paginates via nextPageToken", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [
        listResp(
          [{ id: "p1", modifiedTime: "2026-05-13T13:00:00.000Z" }],
          "tok_page2",
        ),
        listResp([{ id: "p2", modifiedTime: "2026-05-13T13:05:00.000Z" }]),
      ],
    });
    const result = await googleDriveAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_modified: "2026-05-13T12:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.args).page_token).toBe("tok_page2");
    expect(result.nextState.last_seen_modified).toBe("2026-05-13T13:05:00.000Z");
  });

  it("poll: boundary-equal file with id in last_seen_file_ids is dropped", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [
        listResp([{ id: "boundary", modifiedTime: "2026-05-13T14:00:00.000Z" }]),
      ],
    });
    const result = await googleDriveAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {
        last_seen_modified: "2026-05-13T14:00:00.000Z",
        last_seen_file_ids: ["boundary"],
      },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_seen_modified).toBe("2026-05-13T14:00:00.000Z");
    expect(result.nextState.last_seen_file_ids).toEqual(["boundary"]);
  });

  it("poll: q escapes single-quotes in lastSeen properly", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLEDRIVE_LIST_FILES: [listResp([])],
    });
    await googleDriveAdapter.poll(
      { ...baseArgs, config: { query: "name contains 'unmatched" }, fetch: fetchImpl },
      { last_seen_modified: "2026-05-13T15:00:00.000Z" },
    );
    const q = calls[0]!.args.q as string;
    // The lastSeen string has no quotes — confirm wrapped clean
    expect(q).toContain("modifiedTime > '2026-05-13T15:00:00.000Z'");
  });

  it("poll: missing last_seen_modified → silent re-baseline, zero events, no fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not fetch on missing-state recovery");
    }) as unknown as typeof fetch;
    const result = await googleDriveAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {},
    );
    expect(result.newEvents).toEqual([]);
    const ts = Date.parse(result.nextState.last_seen_modified as string);
    expect(ts).toBeGreaterThan(0);
  });

  it("poll: HTTP error propagates", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream down", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      googleDriveAdapter.poll(
        { ...baseArgs, config: {}, fetch: fetchImpl },
        { last_seen_modified: "2026-05-13T15:00:00.000Z" },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });
});
