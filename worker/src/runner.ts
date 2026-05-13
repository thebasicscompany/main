// One-run orchestrator for the worker. CLOUD-AGENT-PLAN §16.2 / §11.1.
// G.1a — opencode subprocess driver. The runner spawns
//   `opencode run "<goal>" --format json` and forwards every ndjson event
// into agent_activity via the Publisher. The runner still emits
// run_started + run_completed at the boundaries so the §11.1 timeline
// stays correct from the SSE consumer's perspective.
//
// G.1b lands the opencode plugin that registers our 32 Browserbase tools
// and binds them to a Browserbase session created up front. Today this
// only proves the opencode-stdout → agent_activity pipe with whatever
// built-in tools opencode ships (bash/read/edit/etc.).

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import postgres from "postgres";
import { Publisher } from "./publisher.js";
import { dispatchOutputs, type Automation, normalizeRunStatus } from "./outputs.js";
import { PgQuotaStore } from "./quota-store.js";
import type { WorkerToolContext } from "./tools/context.js";

interface RunEnv {
  workspaceId: string;
  runId: string;
  accountId: string;
  browserbaseApiKey: string;
  browserbaseProjectId: string;
  databaseUrl: string;
  /** G.1 — natural-language goal for opencode. */
  goal: string;
  /** Optional model override; default Claude Sonnet via opencode's `provider/model`. */
  model?: string;
  /** Optional Anthropic API key; opencode reads ANTHROPIC_API_KEY env. */
  anthropicApiKey?: string;
  /**
   * A.8 — optional automation context. When set, the runner calls
   * dispatchOutputs() after the run terminates and routes each declared
   * output (email/SMS) through the corresponding tool. Without an
   * automation, the run-completion path is unchanged.
   */
  automation?: Automation;
}

export interface RunnerOptions {
  /** opencode binary location; defaults to `opencode` on PATH. */
  opencodeBin?: string;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

export async function runOnce(env: RunEnv, options: RunnerOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const publisher = new Publisher({
    databaseUrl: env.databaseUrl,
    runId: env.runId,
    workspaceId: env.workspaceId,
    accountId: env.accountId,
  });

  let status: "success" | "error" = "success";
  let errorMessage: string | undefined;
  let stopReason = "unknown";
  let finalText: string | null = null;

  try {
    await publisher.emit({
      type: "run_started",
      payload: {
        trigger: "user",
        startedAt: new Date(startedAt).toISOString(),
        worker: "basics-worker",
        loop: "opencode",
        goal: env.goal,
      },
    });

    const apiKey = env.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("missing ANTHROPIC_API_KEY: opencode needs it for anthropic/* models");
    }

    // G.1b — point opencode at our plugin bundle so it picks up the
    // 32 Browserbase tools. The plugin reads RUN_ID/WORKSPACE_ID/etc.
    // from the env (passed through below) to wire up its own Publisher
    // + Browserbase session on first tool call.
    const pluginPath = process.env.OPENCODE_PLUGIN_PATH ?? "/app/opencode-plugin.js";
    const opencodeConfig = JSON.stringify({ plugin: [pluginPath] });

    const result = await runOpencode({
      bin: options.opencodeBin ?? "opencode",
      goal: env.goal,
      model: env.model ?? DEFAULT_MODEL,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: apiKey,
        OPENCODE_CONFIG_CONTENT: opencodeConfig,
        // Propagate run identity so the plugin can build its ctx.
        RUN_ID: env.runId,
        WORKSPACE_ID: env.workspaceId,
        ACCOUNT_ID: env.accountId,
        BROWSERBASE_API_KEY: env.browserbaseApiKey,
        BROWSERBASE_PROJECT_ID: env.browserbaseProjectId,
        DATABASE_URL_POOLER: env.databaseUrl,
      },
      onEvent: async (event) => {
        await publisher.emit({
          type: prefixOpencodeType(event.type),
          payload: event as unknown as Record<string, unknown>,
        });
      },
    });

    stopReason = result.stopReason;
    finalText = result.finalText;
    if (result.stopReason === "error") {
      status = "error";
      errorMessage = result.errorMessage;
    }
  } catch (err) {
    status = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error("worker: run failed", err);
  } finally {
    const durationMs = Date.now() - startedAt;
    const summaryText =
      status === "success"
        ? finalText ?? "(no final text; opencode terminated normally)"
        : `error: ${errorMessage ?? "unknown"}`;
    await publisher
      .emit({
        type: "run_completed",
        payload: {
          status,
          summary: summaryText,
          stopReason,
          durationMs,
          cost: 0,
        },
      })
      .catch((e) => console.error("worker: failed to emit run_completed", e));

    // A.8 — if this run is bound to an automation, route its outputs
    // (email / SMS) through the dispatcher. Errors are confined to the
    // dispatcher's per-channel results; they never break the run.
    if (env.automation && env.automation.outputs.length > 0) {
      let outputSql: ReturnType<typeof postgres> | null = null;
      try {
        outputSql = postgres(env.databaseUrl);
        const outputCtx: WorkerToolContext = {
          session: {} as never,
          runId: env.runId,
          workspaceId: env.workspaceId,
          accountId: env.accountId,
          workspaceRoot: "/workspace",
          publish: (e) => publisher.emit(e),
          quotaStore: new PgQuotaStore(outputSql),
        };
        await dispatchOutputs(outputCtx, env.automation, {
          status: normalizeRunStatus(status),
          summary: summaryText,
        });
      } catch (e) {
        console.error("worker: dispatchOutputs failed", e);
      } finally {
        if (outputSql) await outputSql.end({ timeout: 5 }).catch(() => {});
      }
    }

    await publisher.close().catch(() => {});
  }
  void randomUUID;
}

interface OpencodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  [k: string]: unknown;
}

interface RunOpencodeArgs {
  bin: string;
  goal: string;
  model: string;
  env: NodeJS.ProcessEnv;
  onEvent: (event: OpencodeEvent) => Promise<void>;
}

interface RunOpencodeResult {
  stopReason: "completed" | "error" | "killed";
  finalText: string | null;
  errorMessage?: string;
}

async function runOpencode(args: RunOpencodeArgs): Promise<RunOpencodeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      args.bin,
      [
        "run",
        args.goal,
        "--format", "json",
        "--model", args.model,
        "--dangerously-skip-permissions",
      ],
      {
        env: args.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let buffer = "";
    let lastErrorMessage: string | undefined;
    let finalText: string | null = null;

    const flushLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: OpencodeEvent;
      try {
        event = JSON.parse(trimmed) as OpencodeEvent;
      } catch {
        // Non-JSON line on stdout — surface as a raw_stdout event so
        // operators can debug.
        event = { type: "raw_stdout", line: trimmed };
      }
      // Pluck final assistant text + error messages so the runner can
      // populate run_completed accurately.
      if (event.type === "error") {
        const inner = (event as { error?: { data?: { message?: string } } }).error;
        if (inner?.data?.message) lastErrorMessage = inner.data.message;
      }
      if (event.type === "message.part.updated" || event.type === "message.updated") {
        const part = (event as { part?: { type?: string; text?: string } }).part;
        if (part?.type === "text" && typeof part.text === "string") {
          finalText = part.text;
        }
      }
      try {
        await args.onEvent(event);
      } catch (e) {
        console.error("worker: onEvent failed", e);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", async (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        await flushLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Don't fail the run on stderr — opencode logs progress here.
      console.error("[opencode stderr]", chunk.trimEnd());
    });

    child.on("error", (err) => {
      resolve({
        stopReason: "error",
        finalText,
        errorMessage: `opencode spawn failed: ${err.message}`,
      });
    });

    child.on("close", async (code, signal) => {
      if (buffer.trim()) await flushLine(buffer);
      if (signal) {
        resolve({ stopReason: "killed", finalText, errorMessage: `signal=${signal}` });
        return;
      }
      if (code === 0) {
        resolve({ stopReason: "completed", finalText });
        return;
      }
      resolve({
        stopReason: "error",
        finalText,
        errorMessage: lastErrorMessage ?? `opencode exit ${code}`,
      });
    });
  });
}

function prefixOpencodeType(t: string): string {
  // Keep our canonical run_started/run_completed/screenshot etc. when
  // G.1b lands real tool calls. For now pass opencode's events through
  // with an `oc.` prefix so consumers can tell the difference.
  return `oc.${t}`;
}
