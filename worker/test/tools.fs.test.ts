// BUILD-LOOP B.2 — filesystem tools sandboxed to /workspace.
// Per-test temp dir as workspaceRoot; never touches the host's filesystem
// outside that. /etc/passwd / `..` escapes assert path_outside_sandbox.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildWorkerToolRegistry,
  type WorkerToolContext,
} from "../src/tools/index.js";
import { toOpencodeTools } from "../src/tools/oc-adapter.js";
import type { CdpSession } from "@basics/harness";

let workspace: string;

const fakeCtx = (root: string): WorkerToolContext => ({
  session: undefined as unknown as CdpSession,
  runId: "00000000-0000-0000-0000-000000000b02",
  workspaceId: "00000000-0000-0000-0000-000000000b02",
  accountId: "00000000-0000-0000-0000-000000000b02",
  workspaceRoot: root,
  publish: () => undefined,
});

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "basics-fs-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("filesystem tools — sandbox", () => {
  it("write_file rejects an absolute /etc/passwd target with path_outside_sandbox", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await expect(
      tools.find((t) => t.name === "write_file")!.execute({
        path: "/etc/passwd",
        content: "evil",
      }),
    ).rejects.toThrow(/path_outside_sandbox/);
  });

  it("write_file rejects `..` escapes", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await expect(
      tools.find((t) => t.name === "write_file")!.execute({
        path: "../escape.txt",
        content: "x",
      }),
    ).rejects.toThrow(/path_outside_sandbox/);
  });

  it("read_file rejects absolute paths", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await expect(
      tools.find((t) => t.name === "read_file")!.execute({ path: "/etc/passwd" }),
    ).rejects.toThrow(/path_outside_sandbox/);
  });
});

describe("filesystem tools — round-trip", () => {
  it("write_file then read_file returns identical content", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    // selectors.md requires the §9.3 verification stamp (D.1).
    const body = "Last-verified: 2026-05-09\n\n# selectors\n\n- h1: page heading\n";
    const w = await tools.find((t) => t.name === "write_file")!.execute({
      path: "skills/example.com/selectors.md",
      content: body,
    });
    expect(w).toMatchObject({ kind: "json" });

    const r = (await tools.find((t) => t.name === "read_file")!.execute({
      path: "skills/example.com/selectors.md",
    })) as { kind: "json"; json: { content: string } };
    expect(r.json.content).toBe(body);
  });

  it("write_file refuses to overwrite by default", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    const writeTool = tools.find((t) => t.name === "write_file")!;
    await writeTool.execute({ path: "f.txt", content: "v1" });
    await expect(writeTool.execute({ path: "f.txt", content: "v2" })).rejects.toThrow(/file_exists/);
    const r = (await tools.find((t) => t.name === "read_file")!.execute({ path: "f.txt" })) as {
      kind: "json";
      json: { content: string };
    };
    expect(r.json.content).toBe("v1");
  });

  it("write_file with overwrite: true replaces", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await tools.find((t) => t.name === "write_file")!.execute({ path: "f.txt", content: "v1" });
    await tools.find((t) => t.name === "write_file")!.execute({ path: "f.txt", content: "v2", overwrite: true });
    const r = (await tools.find((t) => t.name === "read_file")!.execute({ path: "f.txt" })) as {
      kind: "json";
      json: { content: string };
    };
    expect(r.json.content).toBe("v2");
  });
});

describe("edit_file", () => {
  it("replaces a unique substring", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await tools.find((t) => t.name === "write_file")!.execute({
      path: "doc.md",
      content: "before EDIT_ME after",
    });
    const r = (await tools.find((t) => t.name === "edit_file")!.execute({
      path: "doc.md",
      oldString: "EDIT_ME",
      newString: "EDITED",
    })) as { kind: "json"; json: { replacements: number } };
    expect(r.json.replacements).toBe(1);
    const after = (await tools.find((t) => t.name === "read_file")!.execute({ path: "doc.md" })) as {
      kind: "json";
      json: { content: string };
    };
    expect(after.json.content).toBe("before EDITED after");
  });

  it("rejects when oldString is ambiguous unless replaceAll: true", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await tools.find((t) => t.name === "write_file")!.execute({
      path: "doc.md",
      content: "x x x",
    });
    await expect(
      tools.find((t) => t.name === "edit_file")!.execute({
        path: "doc.md",
        oldString: "x",
        newString: "y",
      }),
    ).rejects.toThrow(/old_string_ambiguous/);
    const r = (await tools.find((t) => t.name === "edit_file")!.execute({
      path: "doc.md",
      oldString: "x",
      newString: "y",
      replaceAll: true,
    })) as { kind: "json"; json: { replacements: number } };
    expect(r.json.replacements).toBe(3);
  });

  it("errors when oldString is not present", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await tools.find((t) => t.name === "write_file")!.execute({ path: "doc.md", content: "abc" });
    await expect(
      tools.find((t) => t.name === "edit_file")!.execute({
        path: "doc.md",
        oldString: "ZZZ",
        newString: "y",
      }),
    ).rejects.toThrow(/old_string_not_found/);
  });
});

describe("glob + grep", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(workspace, "skills/example.com"), { recursive: true });
    await fs.mkdir(path.join(workspace, "skills/other.com"), { recursive: true });
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspace, "skills/example.com/selectors.md"), "# example sel\nh1: page heading\n");
    await fs.writeFile(path.join(workspace, "skills/other.com/selectors.md"), "# other sel\nh1: x\n");
    await fs.writeFile(path.join(workspace, "memory/workspace.md"), "tz: PT\n");
  });

  it("glob matches by pattern", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    const r = (await tools.find((t) => t.name === "glob")!.execute({
      pattern: "skills/**/selectors.md",
    })) as { kind: "json"; json: { matches: string[]; count: number } };
    expect(r.json.matches).toEqual(
      expect.arrayContaining(["skills/example.com/selectors.md", "skills/other.com/selectors.md"]),
    );
    expect(r.json.count).toBe(2);
  });

  it("grep finds literal occurrences", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    const r = (await tools.find((t) => t.name === "grep")!.execute({
      pattern: "page heading",
    })) as { kind: "json"; json: { hits: Array<{ path: string; line: number; text: string }> } };
    expect(r.json.hits.length).toBe(1);
    expect(r.json.hits[0]?.path).toBe("skills/example.com/selectors.md");
  });

  it("grep with regex + glob filter", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    const r = (await tools.find((t) => t.name === "grep")!.execute({
      pattern: "^h1:",
      regex: true,
      glob: "skills/**/*.md",
    })) as { kind: "json"; json: { hits: Array<{ path: string }> } };
    expect(r.json.hits.length).toBe(2);
  });
});

describe("write_file × skill-write middleware (D.1 verify)", () => {
  it("write_file({path: 'skills/...', content: 'sk-ant-...'}) rejects with skill_write_blocked + publishes event", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx: WorkerToolContext = {
      session: undefined as unknown as CdpSession,
      runId: "00000000-0000-0000-0000-000000000d01",
      workspaceId: "00000000-0000-0000-0000-000000000d01",
      accountId: "00000000-0000-0000-0000-000000000d01",
      workspaceRoot: workspace,
      publish: (e) => { captured.push(e); },
    };
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    const writeTool = tools.find((t) => t.name === "write_file")!;

    const POISONED =
      "found api key sk-ant-api03-RkodwpEntz3krpXiYLmjwQw6kmH00ORu9ha4PEpBqWJDnTiA5XawIw earlier";
    await expect(
      writeTool.execute({ path: "skills/example.com/notes.md", content: POISONED }),
    ).rejects.toThrow(/skill_write_blocked: secret_detected/);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("skill_write_blocked");
    expect(captured[0]?.payload.code).toBe("secret_detected");
    expect(captured[0]?.payload.path).toBe("skills/example.com/notes.md");

    // No file should have landed on disk.
    await expect(fs.access(path.join(workspace, "skills/example.com/notes.md"))).rejects.toThrow();
  });

  it("write_file under non-skill path skips the middleware (and writes normally)", async () => {
    const captured: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ctx: WorkerToolContext = {
      session: undefined as unknown as CdpSession,
      runId: "00000000-0000-0000-0000-000000000d01",
      workspaceId: "00000000-0000-0000-0000-000000000d01",
      accountId: "00000000-0000-0000-0000-000000000d01",
      workspaceRoot: workspace,
      publish: (e) => { captured.push(e); },
    };
    const tools = toOpencodeTools(buildWorkerToolRegistry(), { resolveContext: () => ctx });
    // 'sessions/' isn't an allowed skill root, so the policy is skipped.
    // (sessions/ also isn't a normal write target, but the FS sandbox lets it
    // land under workspaceRoot/sessions for this test.)
    await tools.find((t) => t.name === "write_file")!.execute({
      path: "sessions/run.json",
      content: "{ \"key\": \"sk-ant-suuuuper-secret-not-checked-here-because-not-a-skill-path\" }",
    });
    expect(captured).toHaveLength(0); // no skill_write_blocked event
  });
});

describe("delete_file", () => {
  it("removes a file and refuses directories", async () => {
    const tools = toOpencodeTools(buildWorkerToolRegistry(), {
      resolveContext: () => fakeCtx(workspace),
    });
    await tools.find((t) => t.name === "write_file")!.execute({ path: "trash.txt", content: "" });
    const r = (await tools.find((t) => t.name === "delete_file")!.execute({ path: "trash.txt" })) as {
      kind: "json";
      json: { deleted: boolean };
    };
    expect(r.json.deleted).toBe(true);

    await fs.mkdir(path.join(workspace, "subdir"));
    await expect(
      tools.find((t) => t.name === "delete_file")!.execute({ path: "subdir" }),
    ).rejects.toThrow(/is_directory/);
  });

  it("delete_file is approval-gated", () => {
    const reg = buildWorkerToolRegistry();
    const tool = reg.get("delete_file");
    expect(tool?.mutating).toBe(true);
    expect(tool?.requiresApproval).toBe(true);
  });
});
