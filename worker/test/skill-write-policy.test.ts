// CLOUD-AGENT-PLAN §9.3 — skill-write middleware unit tests.

import { describe, expect, it } from "vitest";
import {
  validateSkillWrite,
  pathRequiresSkillWritePolicy,
} from "../src/middleware/skill-write-policy.js";

describe("validateSkillWrite — path policy", () => {
  it("allows skills/, helpers/, memory/, tmp/", () => {
    expect(validateSkillWrite("skills/example.com/INDEX.md", "x").ok).toBe(true);
    expect(validateSkillWrite("helpers/example.ts", "export {}").ok).toBe(true);
    expect(validateSkillWrite("memory/workspace.md", "tz: PT").ok).toBe(true);
    expect(validateSkillWrite("tmp/run-123/scratch", "x").ok).toBe(true);
  });

  it("rejects paths outside allowed roots", () => {
    const v = validateSkillWrite("sessions/x.json", "{}");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("path_outside_policy");
  });

  it("pathRequiresSkillWritePolicy mirrors", () => {
    expect(pathRequiresSkillWritePolicy("skills/x.md")).toBe(true);
    expect(pathRequiresSkillWritePolicy("notes/x.md")).toBe(false);
  });
});

describe("validateSkillWrite — size cap", () => {
  it("64 KiB allowed, 64 KiB + 1 rejected", () => {
    const just = "a".repeat(64 * 1024);
    const over = "a".repeat(64 * 1024 + 1);
    expect(validateSkillWrite("skills/x.md", just).ok).toBe(true);
    const v = validateSkillWrite("skills/x.md", over);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("size_cap_exceeded");
  });

  it("custom maxBytes is honored", () => {
    const v = validateSkillWrite("skills/x.md", "12345", { maxBytes: 4 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("size_cap_exceeded");
  });
});

describe("validateSkillWrite — secret detection (BUILD-LOOP D.1 verify)", () => {
  it("rejects content containing sk-ant-…", () => {
    const v = validateSkillWrite(
      "skills/example.com/notes.md",
      "previously the agent saw sk-ant-api03-RkodwpEntz3krpXiYLmjwQw6kmH00ORu9ha4PEpBqWJDnTiA5XawIw and wrote it down",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("secret_detected");
      expect(v.message).toMatch(/anthropic/);
    }
  });

  it("rejects AWS access key", () => {
    const v = validateSkillWrite("skills/x.md", "AKIAIOSFODNN7EXAMPLE in some text");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/aws_access_key/);
  });

  it("rejects Google API key", () => {
    const v = validateSkillWrite(
      "skills/x.md",
      "key: AIzaSyCTodcqYJtP8rYYC9vnghoBCoowuSq8W00",
    );
    expect(v.ok).toBe(false);
  });

  it("rejects Supabase service-role JWT", () => {
    const v = validateSkillWrite(
      "skills/x.md",
      "service role: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ4In0.HFQU8xCUYxzoosyfgWCKeR5C-TJZqr30M3K8z2D5Wnk",
    );
    expect(v.ok).toBe(false);
  });

  it("rejects Stripe webhook secret", () => {
    const v = validateSkillWrite("skills/x.md", "whsec_abcdef0123456789abcdef0123456789");
    expect(v.ok).toBe(false);
  });
});

describe("validateSkillWrite — pixel coords", () => {
  it("rejects 'click 432, 198'", () => {
    const v = validateSkillWrite("skills/example.com/flows/checkout.md", "Last-verified: 2026-05-09\n\nStep 1: click 432, 198");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("pixel_coord_detected");
  });

  it("rejects 'x: 432, y: 198' style", () => {
    const v = validateSkillWrite("skills/x.md", "Use x: 432, y: 198 for the submit button");
    expect(v.ok).toBe(false);
  });

  it("allows selector strings (no coords)", () => {
    const v = validateSkillWrite(
      "skills/example.com/selectors.md",
      "Last-verified: 2026-05-09\n\n| label | selector |\n| submit | button[type=submit] |",
    );
    expect(v.ok).toBe(true);
  });

  it("allows arbitrary numbers if not in click/x:y context", () => {
    const v = validateSkillWrite(
      "skills/x.md",
      "the API has 350 endpoints and a 5000 ms timeout",
    );
    expect(v.ok).toBe(true);
  });
});

describe("validateSkillWrite — PII heuristic", () => {
  it("rejects real-looking email by default", () => {
    const v = validateSkillWrite("skills/x.md", "owner is alice@acme.com per ticket");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("pii_detected");
  });

  it("allows example.com and noreply.anthropic.com placeholders", () => {
    expect(validateSkillWrite("skills/x.md", "test@example.com is fine").ok).toBe(true);
    expect(validateSkillWrite("skills/x.md", "robot@noreply.anthropic.com is fine").ok).toBe(true);
  });

  it("allowPII=true bypasses", () => {
    const v = validateSkillWrite(
      "skills/x.md",
      "user is alice@acme.com",
      { allowPII: true },
    );
    expect(v.ok).toBe(true);
  });

  it("rejects SSN-shaped patterns", () => {
    const v = validateSkillWrite("skills/x.md", "SSN sample 123-45-6789 in the docs");
    expect(v.ok).toBe(false);
  });

  it("rejects US phone-number-shaped patterns", () => {
    const v = validateSkillWrite("skills/x.md", "call (415) 555-0123 if locked out");
    expect(v.ok).toBe(false);
  });

  it("does NOT false-match bare 10-digit numbers (view counts, IDs)", () => {
    // YouTube view count "1700000000" used to false-match the phone regex.
    const body = "Last-verified: 2026-05-09\n\nView count selector returns 1700000000 for popular videos.";
    const v = validateSkillWrite("skills/x.md", body);
    expect(v.ok).toBe(true);
  });
});

describe("validateSkillWrite — helpers/*.ts shell-exec ban", () => {
  it("rejects child_process import", () => {
    const v = validateSkillWrite("helpers/example.ts", `import { exec } from "node:child_process";`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("shell_exec_in_helper");
  });

  it("rejects bare 'child_process' import", () => {
    const v = validateSkillWrite("helpers/x.ts", `const cp = require('child_process');`);
    expect(v.ok).toBe(false);
  });

  it("rejects eval()", () => {
    const v = validateSkillWrite("helpers/x.ts", `export const f = (s) => eval(s);`);
    expect(v.ok).toBe(false);
  });

  it("rejects new Function()", () => {
    const v = validateSkillWrite("helpers/x.ts", `export const make = () => new Function('a', 'return a');`);
    expect(v.ok).toBe(false);
  });

  it("allows clean helper", () => {
    const v = validateSkillWrite(
      "helpers/example.ts",
      `export function parsePrice(s: string): number { return Number(s.replace(/\\$/, '')); }`,
    );
    expect(v.ok).toBe(true);
  });

  it("does NOT trigger shell-exec rule on non-helper paths", () => {
    const v = validateSkillWrite("memory/notes.md", "we use child_process internally");
    expect(v.ok).toBe(true);
  });
});

describe("validateSkillWrite — verification stamp", () => {
  it("requires Last-verified on selectors.md", () => {
    const v = validateSkillWrite(
      "skills/example.com/selectors.md",
      "| label | selector |\n| h1 | h1 |",
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("missing_verification_stamp");
  });

  it("requires Last-verified on flows/<flow>.md", () => {
    const v = validateSkillWrite("skills/example.com/flows/checkout.md", "step 1: hit /checkout");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("missing_verification_stamp");
  });

  it("accepts Last-verified line on selectors.md", () => {
    const v = validateSkillWrite(
      "skills/example.com/selectors.md",
      "Last-verified: 2026-05-09\n\n| label | selector |\n| h1 | h1 |",
    );
    expect(v.ok).toBe(true);
  });

  it("does not require stamp on INDEX.md or non-selector docs", () => {
    expect(validateSkillWrite("skills/example.com/INDEX.md", "what we know").ok).toBe(true);
    expect(validateSkillWrite("memory/workspace.md", "tz: PT").ok).toBe(true);
  });
});
