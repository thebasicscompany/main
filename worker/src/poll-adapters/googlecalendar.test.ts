import { describe, expect, it, vi } from "vitest";
import { googleCalendarAdapter } from "./googlecalendar.js";

interface ExecuteResponse {
  data: { response_data: unknown };
  successful?: boolean;
  error?: string | null;
}

interface CalendarEventFixture {
  id: string;
  status?: string;
  created: string;
  updated: string;
  summary?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
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

function listResp(items: CalendarEventFixture[], nextPageToken?: string): ExecuteResponse {
  return {
    data: { response_data: { items, nextPageToken } },
    successful: true,
    error: null,
  };
}

const baseArgs = {
  composioUserId: "op@example.com",
  connectedAccountId: "ca_cal_fixture",
  composioApiKey: "test_key",
};

describe("googlecalendar PollAdapter", () => {
  it("registers under 'googlecalendar' for both created + updated trigger slugs", () => {
    expect(googleCalendarAdapter.toolkit).toBe("googlecalendar");
    expect(googleCalendarAdapter.events).toEqual([
      "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER",
      "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER",
    ]);
  });

  it("initialState anchors last_seen_updated at the current time", async () => {
    const before = Date.now();
    const state = await googleCalendarAdapter.initialState({
      ...baseArgs,
      config: {},
    });
    const after = Date.now();
    expect(typeof state.last_seen_updated).toBe("string");
    const ts = Date.parse(state.last_seen_updated as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("poll: no changes → zero events, preserves last_seen_updated", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [listResp([])],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_updated: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T10:00:00.000Z");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolSlug).toBe("GOOGLECALENDAR_EVENTS_LIST");
    expect(calls[0]!.args).toMatchObject({
      calendar_id: "primary",
      updated_min: "2026-05-13T10:00:00.000Z",
      single_events: true,
      order_by: "updated",
    });
  });

  it("poll: single newly-created event emits one event with change_kind='created'", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp([
          {
            id: "evt_A",
            status: "confirmed",
            created: "2026-05-13T11:00:00.000Z",
            updated: "2026-05-13T11:00:00.000Z",
            summary: "Stakeholder sync",
            start: { dateTime: "2026-05-14T09:00:00.000Z" },
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: { calendar_id: "ops@example.com" }, fetch: fetchImpl },
      { last_seen_updated: "2026-05-13T10:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload).toMatchObject({
      calendar_id: "ops@example.com",
      change_kind: "created",
    });
    const evt = result.newEvents[0]!.payload.event as Record<string, unknown>;
    expect(evt.id).toBe("evt_A");
    expect(evt.summary).toBe("Stakeholder sync");
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T11:00:00.000Z");
  });

  it("poll: single updated event emits change_kind='updated' (created < updated)", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp([
          {
            id: "evt_B",
            status: "confirmed",
            created: "2026-05-12T08:00:00.000Z",
            updated: "2026-05-13T11:30:00.000Z",
            summary: "Reschedule",
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_updated: "2026-05-13T11:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect(result.newEvents[0]!.payload.change_kind).toBe("updated");
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T11:30:00.000Z");
  });

  it("poll: mixed batch emits one event per item with correct change_kind each", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp([
          {
            id: "new1",
            status: "confirmed",
            created: "2026-05-13T12:00:00.000Z",
            updated: "2026-05-13T12:00:00.000Z",
          },
          {
            id: "upd1",
            status: "confirmed",
            created: "2026-05-01T09:00:00.000Z",
            updated: "2026-05-13T12:10:00.000Z",
          },
          {
            id: "new2",
            status: "confirmed",
            created: "2026-05-13T12:20:00.000Z",
            updated: "2026-05-13T12:20:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_updated: "2026-05-13T11:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(3);
    expect(result.newEvents.map((e) => e.payload.change_kind)).toEqual([
      "created",
      "updated",
      "created",
    ]);
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T12:20:00.000Z");
  });

  it("poll: paginates via nextPageToken across multiple GOOGLECALENDAR_EVENTS_LIST calls", async () => {
    const { fetchImpl, calls } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp(
          [
            {
              id: "p1evt1",
              status: "confirmed",
              created: "2026-05-13T13:00:00.000Z",
              updated: "2026-05-13T13:00:00.000Z",
            },
          ],
          "tok_page2",
        ),
        listResp([
          {
            id: "p2evt1",
            status: "confirmed",
            created: "2026-05-12T09:00:00.000Z",
            updated: "2026-05-13T13:05:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_updated: "2026-05-13T12:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.args).page_token).toBe("tok_page2");
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T13:05:00.000Z");
  });

  it("poll: skips cancelled events but still advances high-water past their updated time", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp([
          {
            id: "cancelled1",
            status: "cancelled",
            created: "2026-05-12T09:00:00.000Z",
            updated: "2026-05-13T14:30:00.000Z",
          },
          {
            id: "newAfter",
            status: "confirmed",
            created: "2026-05-13T14:35:00.000Z",
            updated: "2026-05-13T14:35:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      { last_seen_updated: "2026-05-13T14:00:00.000Z" },
    );
    expect(result.newEvents).toHaveLength(1);
    expect((result.newEvents[0]!.payload.event as { id: string }).id).toBe("newAfter");
    // High-water moved past the cancelled row's timestamp so we
    // don't keep re-fetching it.
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T14:35:00.000Z");
  });

  it("poll: drops boundary-equal row when its id was previously emitted at that timestamp", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp([
          {
            id: "boundary",
            status: "confirmed",
            created: "2026-05-12T09:00:00.000Z",
            updated: "2026-05-13T15:00:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {
        last_seen_updated: "2026-05-13T15:00:00.000Z",
        last_seen_event_ids: ["boundary"],
      },
    );
    expect(result.newEvents).toEqual([]);
    expect(result.nextState.last_seen_updated).toBe("2026-05-13T15:00:00.000Z");
    expect(result.nextState.last_seen_event_ids).toEqual(["boundary"]);
  });

  it("poll: a NEW event sharing the boundary millisecond is still emitted (does not get dropped)", async () => {
    const { fetchImpl } = makeFetch({
      GOOGLECALENDAR_EVENTS_LIST: [
        listResp([
          {
            // Already emitted at this timestamp in the prior poll.
            id: "seen_at_boundary",
            status: "confirmed",
            created: "2026-05-12T09:00:00.000Z",
            updated: "2026-05-13T15:00:00.000Z",
          },
          {
            // NEW event stamped at the same exact millisecond — must
            // NOT be dropped by the boundary check.
            id: "new_at_boundary",
            status: "confirmed",
            created: "2026-05-13T15:00:00.000Z",
            updated: "2026-05-13T15:00:00.000Z",
          },
        ]),
      ],
    });
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {
        last_seen_updated: "2026-05-13T15:00:00.000Z",
        last_seen_event_ids: ["seen_at_boundary"],
      },
    );
    expect(result.newEvents).toHaveLength(1);
    expect((result.newEvents[0]!.payload.event as { id: string }).id).toBe("new_at_boundary");
    // The boundary id set now contains both rows that have been
    // emitted at that timestamp — the prior one (still extant) and
    // the new one we just emitted.
    expect(new Set(result.nextState.last_seen_event_ids as string[])).toEqual(
      new Set(["seen_at_boundary", "new_at_boundary"]),
    );
  });

  it("poll: missing last_seen_updated → silent re-baseline at now, zero events", async () => {
    // No GOOGLECALENDAR_EVENTS_LIST call should be made because we
    // never have a sensible updated_min to use.
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch should not be called on missing-state recovery");
    }) as unknown as typeof fetch;
    const before = Date.now();
    const result = await googleCalendarAdapter.poll(
      { ...baseArgs, config: {}, fetch: fetchImpl },
      {}, // no last_seen_updated
    );
    const after = Date.now();
    expect(result.newEvents).toEqual([]);
    const ts = Date.parse(result.nextState.last_seen_updated as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(result.nextState.last_seen_event_ids).toEqual([]);
  });

  it("poll: HTTP error propagates as a normal throw", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream down", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      googleCalendarAdapter.poll(
        { ...baseArgs, config: {}, fetch: fetchImpl },
        { last_seen_updated: "2026-05-13T15:00:00.000Z" },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });
});
