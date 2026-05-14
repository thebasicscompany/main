// K.2 — `helper_write` — the agent emits a TS pipeline module the worker
// will register as a callable opencode tool on future runs (and the
// dispatcher fast-path can invoke directly to skip the LLM hot path).
//
// Body validation:
//   1. Parse as TypeScript via the TS compiler API. Must compile and
//      must export `async function run(args, ctx)`.
//   2. AST-walk for forbidden identifiers: `process`, `eval`, `Function`,
//      `require`, `import` from disallowed modules, `child_process`,
//      `fs`, `net`, `http`, `https`, `vm`, raw `globalThis` writes.
//   3. ≤ 64 KB.
//   4. Re-use the skill-write content scanner (PII/secrets).
//
// On success, INSERT into public.cloud_agent_helpers with helper_version =
// COALESCE(prior.helper_version, 0) + 1 and active=true; deactivate the
// prior version of the same (workspace, name).

import { defineTool } from "@basics/shared";
import { z } from "zod";
import * as ts from "typescript";
import { validateSkillWrite, SkillWriteBlockedError } from "../middleware/skill-write-policy.js";
import type { WorkerToolContext } from "./context.js";

const FORBIDDEN_GLOBAL_IDENTIFIERS = new Set([
  "process",
  "eval",
  "Function",
  "require",
  "globalThis",
  "global",
  "Buffer",
  "__dirname",
  "__filename",
]);

const FORBIDDEN_IMPORT_PREFIXES = [
  "child_process",
  "node:child_process",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "vm",
  "node:vm",
  "worker_threads",
  "node:worker_threads",
  "cluster",
  "node:cluster",
];

interface HelperBodyVerdict {
  ok: boolean;
  code?: string;
  message?: string;
}

function validateHelperBody(body: string): HelperBodyVerdict {
  if (body.length > 64 * 1024) {
    return { ok: false, code: "too_large", message: `body exceeds 64KB (${body.length} bytes)` };
  }
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile("helper.ts", body, ts.ScriptTarget.ES2022, true);
  } catch (e) {
    return {
      ok: false,
      code: "parse_failed",
      message: `TypeScript parse error: ${(e as Error).message}`,
    };
  }
  // Parse diagnostics live on the SourceFile but the public typings only
  // expose them in newer ts versions. Read via index to be tolerant.
  const synthetic = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (synthetic.length > 0) {
    const first = synthetic[0]!;
    return {
      ok: false,
      code: "syntax_error",
      message: `syntax error: ${ts.flattenDiagnosticMessageText(first.messageText, "\n")}`,
    };
  }

  // Must export `run` as an async function.
  let hasRunExport = false;
  let runIsAsync = false;
  let runParamCount = 0;
  for (const stmt of sf.statements) {
    if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.name?.text === "run" &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      hasRunExport = true;
      runIsAsync = stmt.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      runParamCount = stmt.parameters.length;
    }
  }
  if (!hasRunExport) {
    return {
      ok: false,
      code: "missing_run_export",
      message: "helper must `export async function run(args, ctx) { ... }`",
    };
  }
  if (!runIsAsync) {
    return {
      ok: false,
      code: "run_not_async",
      message: "exported `run` must be declared async",
    };
  }
  if (runParamCount < 2) {
    return {
      ok: false,
      code: "run_wrong_arity",
      message: "exported `run` must accept (args, ctx)",
    };
  }

  // AST walk for forbidden identifiers / imports.
  let forbiddenFinding: HelperBodyVerdict | null = null;
  const visit = (node: ts.Node): void => {
    if (forbiddenFinding) return;
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec)) {
        const mod = spec.text;
        for (const bad of FORBIDDEN_IMPORT_PREFIXES) {
          if (mod === bad || mod.startsWith(`${bad}/`)) {
            forbiddenFinding = {
              ok: false,
              code: "forbidden_import",
              message: `import of ${mod} not allowed in helpers (must only call ctx-injected APIs)`,
            };
            return;
          }
        }
      }
    } else if (ts.isCallExpression(node)) {
      // require('...') call
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        forbiddenFinding = {
          ok: false,
          code: "forbidden_require",
          message: "require() not allowed in helpers",
        };
        return;
      }
      // eval('...') or Function('...')
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "eval" || node.expression.text === "Function")
      ) {
        forbiddenFinding = {
          ok: false,
          code: "forbidden_eval",
          message: `${node.expression.text}() not allowed in helpers`,
        };
        return;
      }
    } else if (ts.isIdentifier(node)) {
      // Top-level identifier reference to a forbidden global. Skip if
      // it's the name slot of a declaration/parameter (those are OK).
      const parent = node.parent;
      const isDeclName =
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node);
      if (!isDeclName && FORBIDDEN_GLOBAL_IDENTIFIERS.has(node.text)) {
        forbiddenFinding = {
          ok: false,
          code: "forbidden_global",
          message: `helper references forbidden global \`${node.text}\` — only ctx-injected APIs are allowed`,
        };
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  if (forbiddenFinding) return forbiddenFinding;

  return { ok: true };
}

export const helper_write = defineTool({
  name: "helper_write",
  description:
    "K.2 — persist an agent-authored TypeScript pipeline module. The body MUST `export async function run(args, ctx)`. Sandbox-executed: no fs/net/process/child_process/eval; only ctx.composio(), ctx.browser, ctx.fetch (allowlisted), ctx.sql_read, ctx.log are available. On success the helper is registered as an opencode tool on future worker boots (K.4) and may be invoked directly by the dispatcher fast-path (K.7) — skipping the LLM hot path entirely. Use this when a pipeline you just executed was deterministic enough to compile.",
  params: z.object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/, "name must be snake_case starting with a letter"),
    description: z.string().min(1).max(500),
    body: z.string().min(1).max(64 * 1024),
    args_schema: z.record(z.string(), z.unknown()).optional(),
    automation_id: z.string().uuid().optional(),
    supersedes_helper_id: z.string().uuid().optional(),
  }),
  mutating: true,
  requiresApproval: false,
  cost: "low",
  execute: async (
    { name, description, body, args_schema, automation_id, supersedes_helper_id },
    ctx: WorkerToolContext,
  ) => {
    // Run the same content scanner skill_write uses for PII/secrets etc.
    const syntheticPath = `helpers/${name}.ts`;
    const policyVerdict = validateSkillWrite(syntheticPath, body);
    if (!policyVerdict.ok) {
      await ctx.publish({
        type: "helper_write_blocked",
        payload: {
          name,
          code: policyVerdict.code,
          message: policyVerdict.message,
          byteLength: Buffer.byteLength(body, "utf8"),
        },
      });
      throw new SkillWriteBlockedError(policyVerdict);
    }

    // K.2-specific structural validation.
    const bodyVerdict = validateHelperBody(body);
    if (!bodyVerdict.ok) {
      await ctx.publish({
        type: "helper_write_blocked",
        payload: {
          name,
          code: bodyVerdict.code,
          message: bodyVerdict.message,
          byteLength: Buffer.byteLength(body, "utf8"),
        },
      });
      throw new Error(`helper_write rejected (${bodyVerdict.code}): ${bodyVerdict.message}`);
    }

    const sql = ctx.sql;
    if (!sql) {
      throw new Error("helper_write_unavailable: ctx.sql is not configured for this run");
    }

    // Determine next version + deactivate prior active row of the same name.
    const prior = await sql<Array<{ id: string; helper_version: number }>>`
      SELECT id::text AS id, helper_version
        FROM public.cloud_agent_helpers
       WHERE workspace_id = ${ctx.workspaceId}::uuid AND name = ${name} AND active = true
       ORDER BY helper_version DESC
       LIMIT 1
    `;
    const nextVersion = (prior[0]?.helper_version ?? 0) + 1;
    if (prior[0]) {
      await sql`
        UPDATE public.cloud_agent_helpers
           SET active = false, updated_at = now()
         WHERE id = ${prior[0].id}::uuid
      `;
    }

    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO public.cloud_agent_helpers
        (workspace_id, automation_id, name, description, args_schema, body,
         helper_version, active, superseded_by, source_run_id)
      VALUES
        (${ctx.workspaceId}::uuid,
         ${automation_id ?? null}::uuid,
         ${name},
         ${description},
         ${sql.json((args_schema ?? {}) as unknown as Parameters<typeof sql.json>[0])},
         ${body},
         ${nextVersion},
         true,
         ${supersedes_helper_id ?? prior[0]?.id ?? null}::uuid,
         ${ctx.runId ?? null}::uuid)
      RETURNING id::text AS id
    `;
    const newId = inserted[0]!.id;

    await ctx.publish({
      type: "helper_written",
      payload: {
        helperId: newId,
        name,
        helperVersion: nextVersion,
        supersedesId: prior[0]?.id ?? null,
        byteLength: Buffer.byteLength(body, "utf8"),
        automationId: automation_id ?? null,
      },
    });

    return {
      kind: "json" as const,
      json: {
        ok: true,
        helperId: newId,
        name,
        helperVersion: nextVersion,
        supersedesId: prior[0]?.id ?? null,
      },
    };
  },
});
