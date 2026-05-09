// BUILD-LOOP D.3 — skill loader middleware tests.

import { describe, expect, it } from "vitest";
import {
  composeSkillContext,
  InMemorySkillLoader,
  normalizeHost,
} from "../src/skill-loader.js";

const ws = "ws-d03";

describe("normalizeHost", () => {
  it("downcases + strips port + trailing dot", () => {
    expect(normalizeHost("Example.COM:443.")).toBe("example.com");
  });

  it("extracts hostname from full URL", () => {
    expect(normalizeHost("https://example.com/path?q=1")).toBe("example.com");
    expect(normalizeHost("http://Sub.Example.com:8080/")).toBe("sub.example.com");
  });

  it("returns empty for empty input", () => {
    expect(normalizeHost("")).toBe("");
  });
});

describe("InMemorySkillLoader — filter + sort", () => {
  it("returns only active + non-pending + non-superseded rows for the host/workspace", async () => {
    const loader = new InMemorySkillLoader();
    loader.add({ id: "1", workspaceId: ws, host: "example.com", name: "selectors", description: "x", body: "h1", confidence: 0.9 });
    loader.add({ id: "2", workspaceId: ws, host: "example.com", name: "pending",   description: "x", body: "y",  pendingReview: true });
    loader.add({ id: "3", workspaceId: ws, host: "example.com", name: "inactive",  description: "x", body: "z",  active: false });
    loader.add({ id: "4", workspaceId: ws, host: "example.com", name: "superseded", description: "x", body: "w", supersededBy: "1" });
    loader.add({ id: "5", workspaceId: ws, host: "other.com",   name: "wrong-host", description: "x", body: "v" });
    loader.add({ id: "6", workspaceId: "ws-other", host: "example.com", name: "wrong-ws", description: "x", body: "u" });

    const out = await loader.loadForHost({ workspaceId: ws, host: "example.com" });
    expect(out.map((s) => s.name)).toEqual(["selectors"]);
  });

  it("sorts by confidence DESC, applies limit", async () => {
    const loader = new InMemorySkillLoader();
    loader.add({ id: "1", workspaceId: ws, host: "h", name: "a", description: "", body: "a", confidence: 0.3 });
    loader.add({ id: "2", workspaceId: ws, host: "h", name: "b", description: "", body: "b", confidence: 0.9 });
    loader.add({ id: "3", workspaceId: ws, host: "h", name: "c", description: "", body: "c", confidence: 0.6 });
    loader.add({ id: "4", workspaceId: ws, host: "h", name: "d", description: "", body: "d", confidence: 0.95 });

    const top2 = await loader.loadForHost({ workspaceId: ws, host: "h", limit: 2 });
    expect(top2.map((s) => s.name)).toEqual(["d", "b"]);
  });

  it("normalizes host on lookup (URL form, port, case)", async () => {
    const loader = new InMemorySkillLoader();
    loader.add({ id: "1", workspaceId: ws, host: "example.com", name: "x", description: "", body: "ok" });
    expect((await loader.loadForHost({ workspaceId: ws, host: "https://Example.COM:443" })).length).toBe(1);
  });
});

describe("composeSkillContext — system-prompt fragment shape", () => {
  it("empty skill list emits a count=0 stub", () => {
    const out = composeSkillContext("example.com", []);
    expect(out).toContain('<skills host="example.com" count="0">');
    expect(out).toContain("no skills indexed for example.com");
  });

  it("non-empty list emits catalog + bodies in §8.3 layers", () => {
    const out = composeSkillContext("example.com", [
      { id: "1", name: "selectors", description: "stable selectors", body: "h1: page heading", confidence: 0.9 },
      { id: "2", name: "checkout",  description: "the checkout flow", body: "step 1: submit", confidence: 0.7 },
    ]);
    expect(out).toContain('<skills host="example.com" count="2">');
    expect(out).toContain("## Catalog");
    expect(out).toContain("- selectors (confidence 0.90): stable selectors");
    expect(out).toContain("- checkout (confidence 0.70): the checkout flow");
    expect(out).toContain("## Bodies");
    expect(out).toContain('<skill name="selectors">\nh1: page heading\n</skill>');
    expect(out).toContain('<skill name="checkout">\nstep 1: submit\n</skill>');
    expect(out).toContain("</skills>");
  });
});

describe("D.3 verify (BUILD-LOOP) — fake skill, capture compose", () => {
  it("loads the example.com fake skill and composeSkillContext contains its body", async () => {
    const loader = new InMemorySkillLoader();
    loader.add({
      id: "fake-1",
      workspaceId: ws,
      host: "example.com",
      name: "INDEX",
      description: "what this folder knows about example.com",
      body: "the page is the IETF example domain. Use h1 selector for the heading.",
      confidence: 0.8,
    });

    const skills = await loader.loadForHost({ workspaceId: ws, host: "example.com" });
    expect(skills.length).toBe(1);
    const promptFragment = composeSkillContext("example.com", skills);
    expect(promptFragment).toContain("the page is the IETF example domain");
    expect(promptFragment).toContain("Use h1 selector for the heading");
  });
});
