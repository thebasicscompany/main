import { afterEach, describe, expect, it } from "vitest";
import {
  _clearAdapterRegistryForTests,
  getAdapter,
  registerAdapter,
  type PollAdapter,
} from "./index.js";

afterEach(() => {
  _clearAdapterRegistryForTests();
});

const fakeAdapter: PollAdapter = {
  toolkit: "fakekit",
  events: ["FAKEKIT_SOMETHING_HAPPENED"],
  initialState: async () => ({ seen: 0 }),
  poll: async (_args, lastState) => ({
    newEvents: [{ payload: { thing: "new" } }],
    nextState: { seen: ((lastState.seen as number) ?? 0) + 1 },
  }),
};

describe("PollAdapter registry", () => {
  it("returns a registered adapter by (toolkit, event)", () => {
    registerAdapter(fakeAdapter);
    const a = getAdapter("fakekit", "FAKEKIT_SOMETHING_HAPPENED");
    expect(a).toBe(fakeAdapter);
  });

  it("is toolkit-case-insensitive on lookup", () => {
    registerAdapter(fakeAdapter);
    const a = getAdapter("FAKEKIT", "FAKEKIT_SOMETHING_HAPPENED");
    expect(a).toBe(fakeAdapter);
  });

  it("returns null when the event isn't registered", () => {
    expect(getAdapter("fakekit", "UNKNOWN_EVENT")).toBeNull();
  });

  it("returns null when event maps to a different toolkit", () => {
    registerAdapter(fakeAdapter);
    expect(getAdapter("wrongkit", "FAKEKIT_SOMETHING_HAPPENED")).toBeNull();
  });

  it("rejects duplicate registration of the same event slug", () => {
    registerAdapter(fakeAdapter);
    const dup = { ...fakeAdapter, toolkit: "other" };
    expect(() => registerAdapter(dup)).toThrow(/duplicate registration/);
  });
});
