// G.1b / H.2 — opencode plugin that registers our 32 Browserbase tools.
//
// This module is loaded by opencode at session boot via OPENCODE_CONFIG_CONTENT
// pointing at a bundled file. The plugin owns:
//   - Browserbase session lifecycle (create on first tool call, stop on close)
//   - CDP attach via @basics/harness
//   - Publisher writes to agent_activity (tool_call_start / _end / screenshot)
//   - Per-opencode-session ctx keyed off ToolContext.sessionID (H.2)
//
// Resolution order for {workspaceId, runId, accountId}:
//   1. opencode_session_bindings table by sessionID (H.3 pool flow)
//   2. process.env RUN_ID/WORKSPACE_ID/ACCOUNT_ID (G.1b 1:1 fallback)
//
// Other env always read from process.env (platform-wide):
//   BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, DATABASE_URL_POOLER

import { type Plugin, tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import postgres from "postgres";
import { attach as cdpAttach, detach as cdpDetach, type CdpSession } from "@basics/harness";
import {
  buildWorkerToolRegistry,
  type WorkerToolContext,
} from "../tools/index.js";
import { Publisher } from "../publisher.js";
import {
  createBrowserbaseSession,
  stopBrowserbaseSession,
  type BrowserbaseSession,
} from "../browserbase.js";
import { PgSkillLoader, composeSkillContext, type LoadedSkill } from "../skill-loader.js";
import { PgSkillStore } from "../skill-store.js";
import { PgQuotaStore } from "../quota-store.js";
import { resolveConnectedAccounts } from "../composio/connection-resolver.js";
import { PgComposioToolCache } from "../composio/cache.js";
import { loadComposioPolicy } from "../composio/denylist.js";
import { executeWithApproval } from "../approvals/with-approval.js";
import type { ToolResult } from "@basics/shared";

interface PluginRuntime {
  ctx: WorkerToolContext;
  publisher: Publisher;
  bb: BrowserbaseSession;
  session: CdpSession;
  bbApiKey: string;
  bbProjectId: string;
  skills: ReadonlyArray<LoadedSkill>;
  sessionID: string;
  workspaceId: string;
  runId: string;
  /** C.4 — tx-mode pg (port :6543) used for INSERT/SELECT + approval_rules lookup. */
  quotaSql: ReturnType<typeof postgres>;
  /** C.4 — session-mode pg (port :5432) used for LISTEN on approval channels. */
  listenSql: ReturnType<typeof postgres>;
}

// H.2 — per-opencode-session runtime cache. Keyed by ToolContext.sessionID
// so multiple sessions in the same opencode-serve process get isolated
// Browserbase sessions, publishers, and skill contexts.
const runtimeBySession = new Map<string, Promise<PluginRuntime>>();

function readEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`opencode-plugin: missing env ${key}`);
  return v;
}

interface SessionBinding {
  workspaceId: string;
  runId: string;
  accountId: string;
  /** Set when the run originated from an automation (D.3/D.5/D.6). Used
   * by the C.3 approval-rule lookup so per-automation remember rules
   * match correctly. */
  automationId?: string;
}

/** Resolve sessionID → {workspaceId, runId, accountId}. Tries the bindings
 * table first (H.3 pool flow); falls back to process.env (G.1b 1:1). */
async function resolveBinding(
  databaseUrl: string,
  sessionID: string,
): Promise<SessionBinding> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    const rows = await sql<
      Array<{ workspace_id: string; run_id: string; account_id: string; automation_id: string | null }>
    >`
      SELECT b.workspace_id, b.run_id, b.account_id, r.automation_id
        FROM public.cloud_session_bindings b
        LEFT JOIN public.cloud_runs r ON r.id = b.run_id
       WHERE b.session_id = ${sessionID}
       LIMIT 1
    `;
    if (rows[0]) {
      const binding: SessionBinding = {
        workspaceId: rows[0].workspace_id,
        runId: rows[0].run_id,
        accountId: rows[0].account_id,
      };
      if (rows[0].automation_id) binding.automationId = rows[0].automation_id;
      return binding;
    }
  } catch (e) {
    console.error(
      "plugin: opencode_session_bindings lookup failed; falling back to env",
      e,
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
  return {
    workspaceId: readEnv("WORKSPACE_ID"),
    runId: readEnv("RUN_ID"),
    accountId: readEnv("ACCOUNT_ID"),
  };
}

async function buildRuntime(sessionID: string): Promise<PluginRuntime> {
  const databaseUrl = readEnv("DATABASE_URL_POOLER");
  const { workspaceId, runId, accountId, automationId } = await resolveBinding(databaseUrl, sessionID);
  const bbApiKey = readEnv("BROWSERBASE_API_KEY");
  const bbProjectId = readEnv("BROWSERBASE_PROJECT_ID");

  const publisher = new Publisher({ databaseUrl, runId, workspaceId, accountId });

  // G.2 — pull the workspace's Browserbase Context (cookies + storage) so
  // the agent boots into the user's logged-in state.
  const sql = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  let contextId: string | undefined;
  try {
    const rows = await sql<Array<{ browserbase_profile_id: string | null }>>`
      SELECT browserbase_profile_id FROM public.workspaces WHERE id = ${workspaceId} LIMIT 1
    `;
    contextId = rows[0]?.browserbase_profile_id ?? undefined;
  } catch (e) {
    console.error("plugin: failed to read browserbase_profile_id; continuing context-less", e);
  }

  await publisher.emit({
    type: "browserbase_session_creating",
    payload: { workspaceId, runId, contextId: contextId ?? null },
  });
  const bb = await createBrowserbaseSession({
    apiKey: bbApiKey,
    projectId: bbProjectId,
    workspaceId,
    runId,
    ...(contextId ? { contextId } : {}),
  });
  const session = await cdpAttach({ wsUrl: bb.cdpWsUrl });
  await publisher.emit({
    type: "browserbase_session_attached",
    payload: { sessionId: bb.sessionId, liveViewUrl: bb.liveViewUrl ?? null },
  });

  // G.2 — persist liveUrl + sessionId on the run row so any consumer can iframe it.
  try {
    await sql`
      UPDATE public.cloud_runs
         SET browserbase_session_id = ${bb.sessionId},
             live_view_url = ${bb.liveViewUrl ?? null}
       WHERE id = ${runId}
    `;
  } catch (e) {
    console.error("plugin: failed to persist liveUrl; continuing", e);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }

  // G.3 — per-workspace EFS sandbox. The container mounts the shared
  // EFS access point at /workspace; we scope this run to a workspace
  // subdir (mkdir -p on first call) and pass that as workspaceRoot
  // so all fs-policy-protected tools can only write here.
  const efsBase = process.env.WORKSPACE_ROOT_BASE ?? "/workspace";
  const workspaceRoot = path.join(efsBase, workspaceId);
  try {
    await fs.mkdir(workspaceRoot, { recursive: true });
  } catch (e) {
    console.error("plugin: failed to mkdir workspaceRoot; continuing", e);
  }

  // G.4 — load active skills + wire skill_write through PgSkillStore.
  const skillLoader = new PgSkillLoader({ databaseUrl });
  let skills: LoadedSkill[] = [];
  try {
    skills = await skillLoader.loadAll({ workspaceId, limit: 20 });
    if (skills.length > 0) {
      await publisher.emit({
        type: "skills_loaded",
        payload: { count: skills.length, names: skills.map((s) => s.name) },
      });
    }
  } catch (e) {
    console.error("plugin: skill load failed; continuing skill-less", e);
  } finally {
    await skillLoader.close().catch(() => undefined);
  }

  const skillStore = new PgSkillStore({ databaseUrl });
  // A.6/A.7 output tools (send_email, send_sms) and A.8's run-completion
  // dispatcher all enforce per-workspace daily caps via the
  // increment_output_quota SECURITY DEFINER function. Use a DEDICATED
  // pg connection — the shared `sql` above is `max:1, idle_timeout:5`
  // and gets closed between calls, causing `write CONNECTION_ENDED`
  // failures under tool-call concurrency (discovered live during A.9).
  const quotaSql = postgres(databaseUrl, {
    max: 2,
    prepare: false,
    idle_timeout: 60,
    connect_timeout: 10,
  });
  const quotaStore = new PgQuotaStore(quotaSql);

  // C.4 — LISTEN/NOTIFY for approval pause/resume requires Supavisor
  // session mode (:5432). The tx-mode pooler at :6543 drops LISTEN
  // registrations on each query (see feedback_supavisor_listen_session_mode).
  const listenUrl = databaseUrl.replace(/:6543\b/, ":5432");
  const listenSql = postgres(listenUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 0,
    connect_timeout: 10,
    connection: { application_name: "basics-worker-approvals-listen" },
  });

  // B.3 — Resolve ACTIVE Composio connected accounts for this run. The
  // resolver is fail-soft: an empty Map on Composio downtime / missing API
  // key, so the tools downstream return `no_connection` errors rather than
  // crashing the run. The `composio_resolved` event surfaces the toolkit
  // slugs (no auth tokens) into cloud_activity so live e2e can verify.
  const accountsByToolkit = await resolveConnectedAccounts(accountId);
  await publisher
    .emit({
      type: "composio_resolved",
      payload: {
        toolkitSlugs: Array.from(accountsByToolkit.keys()).sort(),
        accountCount: accountsByToolkit.size,
      },
    })
    .catch((e) => console.error("composio_resolved emit failed", e));

  const ctx: WorkerToolContext = {
    session,
    runId,
    workspaceId,
    accountId,
    ...(automationId ? { automationId } : {}),
    workspaceRoot,
    skillStore,
    quotaStore,
    // E.2 — saved browser-session loader uses the same tx-mode pg
    // connection as the quota gate. Read-only from this layer; writes
    // happen via the API service (E.4 connect endpoint).
    browserSites: { sql: quotaSql, workspaceId },
    composio: {
      accountsByToolkit,
      // B.4 cache: lazily uses ComposioClient at refresh time;
      // shares the quotaSql connection (max:2, idle_timeout:60).
      cache: new PgComposioToolCache({ sql: quotaSql }),
      // B.5 audit writes (B.7 composio_call): share the same connection.
      auditSql: quotaSql,
      // B.8 denylist policy: load once at session boot. Empty policy on
      // any read error — the default patterns still apply.
      policy: await loadComposioPolicy(quotaSql, workspaceId).catch((err) => {
        console.error("composio policy load failed", (err as Error).message);
        return {};
      }),
    },
    publish: async (event) => {
      await publisher.emit(event);
    },
  };

  return {
    ctx,
    publisher,
    bb,
    session,
    bbApiKey,
    bbProjectId,
    skills,
    sessionID,
    workspaceId,
    runId,
    quotaSql,
    listenSql,
  };
}

function ensureRuntime(sessionID: string): Promise<PluginRuntime> {
  let p = runtimeBySession.get(sessionID);
  if (!p) {
    p = buildRuntime(sessionID);
    runtimeBySession.set(sessionID, p);
    // If buildRuntime rejects, drop the cache entry so the next call retries.
    p.catch(() => runtimeBySession.delete(sessionID));
  }
  return p;
}

async function teardownRuntime(sessionID: string): Promise<void> {
  const p = runtimeBySession.get(sessionID);
  if (!p) return;
  runtimeBySession.delete(sessionID);
  try {
    const rt = await p;
    await rt.publisher.emit({ type: "session_teardown", payload: { sessionID } }).catch(() => undefined);
    await cdpDetach(rt.session).catch(() => undefined);
    await stopBrowserbaseSession(rt.bbApiKey, rt.bbProjectId, rt.bb.sessionId).catch(() => undefined);
    await rt.publisher.close().catch(() => undefined);
    await rt.listenSql.end({ timeout: 2 }).catch(() => undefined);
    await rt.quotaSql.end({ timeout: 2 }).catch(() => undefined);
  } catch {
    // best-effort teardown
  }
}

function formatForOpencode(
  r: ToolResult,
): string | { output: string; metadata?: Record<string, unknown> } {
  if (r.kind === "text") return r.text;
  if (r.kind === "json") {
    return {
      output: typeof r.json === "string" ? r.json : JSON.stringify(r.json),
      metadata: { kind: "json", json: r.json as Record<string, unknown> | undefined },
    };
  }
  if (r.kind === "image") {
    // The image bytes themselves are never echoed back into the model
    // context (they'd blow context budget and the model can't act on raw
    // base64 anyway). When the screenshot tool persisted to S3, we surface
    // the s3Key + signedUrl in the output so the agent can pass them
    // directly to send_email.attachments or final_answer.
    const byteLength =
      r.byteLength ?? Math.floor((r.b64.length * 3) / 4);
    if (r.s3Key) {
      return {
        output: JSON.stringify({
          s3Key: r.s3Key,
          signedUrl: r.signedUrl ?? null,
          byteLength,
          mimeType: r.mimeType ?? "image/png",
        }),
        metadata: { kind: "image", s3Key: r.s3Key, byteLength },
      };
    }
    return {
      output: "[screenshot captured; bytes elided — see screenshot event in agent_activity]",
      metadata: { kind: "image", byteLength },
    };
  }
  if (r.kind === "error") {
    throw new Error(r.message);
  }
  return JSON.stringify(r);
}

export const BasicsBrowserPlugin: Plugin = async (_input) => {
  // Don't eagerly create the BB session — wait for the first tool call.
  // (Saves the BB cost when opencode opens a session that never uses tools.)
  const registry = buildWorkerToolRegistry();
  const tools: Record<string, ReturnType<typeof tool>> = {};

  for (const [name, def] of registry.entries()) {
    // Our tools' params are typically ZodObject; opencode wants a
    // ZodRawShape (the `.shape`). For non-object schemas, fall back to
    // a wrapper that keys the original under `_arg`.
    let argsShape: z.ZodRawShape;
    if (def.params instanceof z.ZodObject) {
      argsShape = def.params.shape as z.ZodRawShape;
    } else {
      argsShape = { _arg: def.params as z.ZodTypeAny };
    }

    tools[name] = tool({
      description: def.description,
      args: argsShape,
      execute: async (args, ocCtx) => {
        const rt = await ensureRuntime(ocCtx.sessionID);
        const toolCallId = randomUUID();
        await rt.publisher.emit({
          type: "tool_call_start",
          payload: { toolCallId, tool: name, params: args },
        });
        const t0 = Date.now();
        try {
          // If our schema was a ZodObject, args is the object directly;
          // if we wrapped under _arg, unwrap.
          const innerInput = "_arg" in (args as Record<string, unknown>)
            ? (args as { _arg: unknown })._arg
            : args;
          const parsed = def.params.parse(innerInput);
          // C.4 — Approval gate. Fast-paths to def.execute when the tool
          // has no `approval` inspector or its decision says not-required;
          // otherwise inserts a pending approval, LISTENs on the per-id
          // channel until NOTIFY (approved/denied) or TTL (expired throws
          // RunPausedError to end the run cleanly).
          const result = await executeWithApproval(
            def,
            toolCallId,
            parsed,
            rt.ctx,
            {
              sqlTx: rt.quotaSql,
              sqlListen: rt.listenSql,
              sqlRules: rt.quotaSql,
            },
          );
          const latencyMs = Date.now() - t0;
          if (result.kind === "image" && typeof (result as { b64?: unknown }).b64 === "string") {
            await rt.publisher.emit({
              type: "screenshot",
              payload: {
                toolCallId,
                s3Key: `pending://${rt.ctx.runId}/${toolCallId}.png`,
                thumbS3Key: `pending://${rt.ctx.runId}/${toolCallId}.thumb.png`,
                byteLength: Math.floor(
                  ((result as { b64: string }).b64.length * 3) / 4,
                ),
              },
            });
          }
          const endResult: Record<string, unknown> =
            result.kind === "image"
              ? { kind: "image" }
              : result.kind === "json"
                ? { kind: "json", json: (result as { json: unknown }).json }
                : result.kind === "text"
                  ? { kind: "text", text: (result as { text: string }).text }
                  : { kind: "error", message: (result as { message: string }).message };
          await rt.publisher.emit({
            type: "tool_call_end",
            payload: { toolCallId, result: endResult, latencyMs },
          });
          return formatForOpencode(result);
        } catch (err) {
          const latencyMs = Date.now() - t0;
          const msg = err instanceof Error ? err.message : String(err);
          // H.4 — tenant-isolation audit. fs-policy throws
          // PathOutsideSandboxError when a tool tries to write/read
          // outside its session's workspaceRoot (absolute path or `..`
          // traversal). Surface that as a dedicated audit event so it
          // shows up in cross-tenant alerts.
          const errName = err instanceof Error ? err.name : "Error";
          if (errName === "PathOutsideSandboxError") {
            await rt.publisher.emit({
              type: "cross_tenant_attempt",
              payload: {
                toolCallId,
                tool: name,
                params: args,
                workspaceId: rt.workspaceId,
                runId: rt.runId,
                sessionID: rt.sessionID,
                message: msg,
              },
            }).catch(() => undefined);
          }
          await rt.publisher.emit({
            type: "tool_call_end",
            payload: { toolCallId, result: { error: msg, code: errName }, latencyMs },
          });
          throw err instanceof Error ? err : new Error(msg);
        }
      },
    });
  }

  return {
    tool: tools,
    // G.4 — inject the workspace's loaded skills as a system-prompt
    // fragment on every model turn. opencode calls this hook just
    // before each LLM call; we trigger ensureRuntime() (which loads
    // skills if not yet loaded for this run), then prepend the §8.3
    // <skills> block.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input.sessionID) return; // No session yet — nothing to bind to.
        const rt = await ensureRuntime(input.sessionID);
        if (rt.skills.length === 0) return;
        const fragment = composeSkillContext("any", rt.skills);
        output.system.unshift(fragment);
      } catch (e) {
        console.error("plugin: skill system-transform failed", e);
      }
    },
  };
};

// Cleanup hook — opencode SIGTERMs us at server shutdown. Tear down all
// active per-session runtimes (BB sessions, publisher connections).
process.on("SIGTERM", async () => {
  const ids = [...runtimeBySession.keys()];
  await Promise.allSettled(ids.map((id) => teardownRuntime(id)));
});
