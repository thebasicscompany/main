// B.7 — composio_call: invoke a Composio tool by slug.
//
// Behaviour (plan §B.7 verbatim):
//   (a) Resolve `connectedAccountId` for the toolkit from the B.3 resolver;
//       missing → emit `connection_expired`, return { ok:false, code:'no_connection' }.
//   (b) Call ComposioClient.executeTool(toolSlug, { connectedAccountId, params }).
//   (c) On 401/403 / CONNECTION_EXPIRED:
//       emit `connection_expired`, invalidate the in-context account,
//       return structured error.
//   (d) On 429:
//       emit `external_rate_limit`, return structured retry hint.
//   (e) On schema-mismatch error:
//       invalidateCache, refreshCache, retry once with fresh schema.
//   (f) Always emit `external_action` audit (B.5), return { ok:true, result }.
//
// Per-toolkit semaphore (default 3 concurrent) keyed on the toolkit slug
// (the chunk before the first underscore, lowercased).

import { defineTool } from "@basics/shared";
import {
  ComposioClient,
  ComposioUnavailableError,
  markComposioConnectedAccountExpired,
} from "@basics/shared";
import { z } from "zod";
import { emitExternalAction } from "../composio/audit.js";
import { isDeniedByPolicy } from "../composio/denylist.js";
import { composioCallApproval } from "../approvals/policy.js";
import type { WorkerToolContext } from "./context.js";

export const SEMAPHORE_DEFAULT = 3;

const ParamsSchema = z.object({
  toolSlug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Z0-9_]+$/, "toolSlug must be UPPER_SNAKE_CASE"),
  params: z.record(z.string(), z.unknown()).default({}),
});

type Sem = { active: number; queue: Array<() => void> };
const semaphores = new Map<string, Sem>();

async function withSemaphore<T>(
  key: string,
  max: number,
  fn: () => Promise<T>,
): Promise<T> {
  let sem = semaphores.get(key);
  if (!sem) {
    sem = { active: 0, queue: [] };
    semaphores.set(key, sem);
  }
  while (sem.active >= max) {
    await new Promise<void>((resolve) => sem!.queue.push(resolve));
  }
  sem.active += 1;
  try {
    return await fn();
  } finally {
    sem.active -= 1;
    const next = sem.queue.shift();
    if (next) next();
  }
}

/** Test-only — reset shared semaphore state between tests. */
export function _resetComposioCallSemaphoresForTests(): void {
  semaphores.clear();
}

export interface ComposioCallDeps {
  client?: Pick<ComposioClient, "executeTool">;
  semaphoreMax?: number;
}

let injectedDeps: ComposioCallDeps | null = null;
export function setComposioCallDeps(d: ComposioCallDeps | null): void {
  injectedDeps = d;
}

function toolkitSlugOf(toolSlug: string): string {
  return toolSlug.split("_")[0]!.toLowerCase();
}

function isConnExpiredError(status: number | undefined, message: string): boolean {
  if (status === 401 || status === 403) return true;
  return /CONNECTION_EXPIRED|UNAUTHORIZED|FORBIDDEN|TOKEN_EXPIRED/i.test(message);
}

function isRateLimitError(status: number | undefined): boolean {
  return status === 429;
}

function isSchemaMismatchError(status: number | undefined, message: string): boolean {
  if (status === 400 || status === 422) {
    return /schema|argument|parameter|invalid_field|missing.*field/i.test(message);
  }
  return false;
}

export const composio_call = defineTool({
  name: "composio_call",
  description:
    "Invoke a Composio tool by slug. `toolSlug` is the UPPER_SNAKE Composio identifier (e.g. GMAIL_LIST_THREADS); `params` is the per-tool argument object. The worker resolves the right connected account from the workspace's Composio bindings, applies a per-toolkit concurrency semaphore, retries once on schema-mismatch (after refreshing the cached schema), and writes both an external_action activity event (PII-redacted preview) and an external_action_audit row.",
  params: ParamsSchema,
  mutating: true,
  approval: (args) => composioCallApproval({ toolSlug: args.toolSlug }),
  cost: "medium",
  execute: async (input, ctx: WorkerToolContext) => {
    const { toolSlug, params } = ParamsSchema.parse(input);
    if (!ctx.composio) {
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: { code: "composio_unavailable", message: "ctx.composio missing" },
        },
      };
    }
    const { accountsByToolkit, cache, auditSql, policy } = ctx.composio;

    const toolkitSlug = toolkitSlugOf(toolSlug);

    // B.8 denylist gate. Runs BEFORE the connection resolution so a
    // policy denial never reveals whether the toolkit happens to be
    // connected. Audit row still written so denied attempts are
    // visible to operators.
    const policyDecision = isDeniedByPolicy(toolSlug, policy ?? {});
    if (policyDecision.denied) {
      await ctx.publish({
        type: "denied_by_policy",
        payload: {
          kind: "denied_by_policy",
          toolSlug,
          toolkitSlug,
          pattern: policyDecision.pattern,
          source: policyDecision.source,
        },
      });
      if (auditSql) {
        await emitExternalAction(
          ctx,
          toolSlug,
          params,
          {
            error: {
              code: "denied_by_policy",
              pattern: policyDecision.pattern,
              source: policyDecision.source,
            },
          },
          { sql: auditSql },
        );
      }
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: {
            code: "denied_by_policy",
            toolSlug,
            toolkitSlug,
            pattern: policyDecision.pattern,
            source: policyDecision.source,
          },
        },
      };
    }

    const connectedAccount = accountsByToolkit.get(toolkitSlug);

    // (a) no connection
    if (!connectedAccount) {
      await ctx.publish({
        type: "connection_expired",
        payload: {
          kind: "connection_expired",
          toolSlug,
          toolkitSlug,
          reason: "no_active_account",
        },
      });
      return {
        kind: "json" as const,
        json: { ok: false, error: { code: "no_connection", toolkitSlug } },
      };
    }

    const semaphoreMax = injectedDeps?.semaphoreMax ?? SEMAPHORE_DEFAULT;

    return withSemaphore(toolkitSlug, semaphoreMax, async () => {
      let client: Pick<ComposioClient, "executeTool">;
      try {
        client = injectedDeps?.client ?? new ComposioClient();
      } catch (err) {
        if (err instanceof ComposioUnavailableError) {
          return {
            kind: "json" as const,
            json: {
              ok: false,
              error: { code: "composio_unavailable", message: "no API key" },
            },
          };
        }
        throw err;
      }

      const callOnce = (): Promise<unknown> =>
        client.executeTool(toolSlug, {
          userId: ctx.accountId,
          connectedAccountId: connectedAccount.id,
          arguments: params,
        });

      const runAudit = async (result: unknown): Promise<void> => {
        if (!auditSql) return;
        await emitExternalAction(ctx, toolSlug, params, result, { sql: auditSql });
      };

      try {
        const result = await callOnce();
        // (f) success
        await runAudit(result);
        return { kind: "json" as const, json: { ok: true, result } };
      } catch (err) {
        const e = err as { status?: number; message?: string };
        const status = e.status;
        const message = String(e.message ?? "");

        // (c) auth / expired
        if (isConnExpiredError(status, message)) {
          markComposioConnectedAccountExpired(connectedAccount.id);
          accountsByToolkit.delete(toolkitSlug);
          await ctx.publish({
            type: "connection_expired",
            payload: {
              kind: "connection_expired",
              toolSlug,
              toolkitSlug,
              connectedAccountId: connectedAccount.id,
              status,
            },
          });
          await runAudit({ error: { code: "connection_expired", status } });
          return {
            kind: "json" as const,
            json: {
              ok: false,
              error: { code: "connection_expired", toolkitSlug, status },
            },
          };
        }

        // (d) rate limit
        if (isRateLimitError(status)) {
          await ctx.publish({
            type: "external_rate_limit",
            payload: {
              kind: "external_rate_limit",
              toolSlug,
              toolkitSlug,
              status,
            },
          });
          await runAudit({ error: { code: "rate_limited", status } });
          return {
            kind: "json" as const,
            json: {
              ok: false,
              error: { code: "rate_limited", toolkitSlug, status },
            },
          };
        }

        // (e) schema mismatch — retry once after cache invalidate+refresh
        if (isSchemaMismatchError(status, message) && cache) {
          try {
            await cache.invalidateCache(ctx.workspaceId, toolkitSlug);
            await cache.refreshCache(ctx.workspaceId, toolkitSlug);
            const retryResult = await callOnce();
            await runAudit(retryResult);
            return {
              kind: "json" as const,
              json: { ok: true, result: retryResult, recoveredFromSchemaMismatch: true },
            };
          } catch (retryErr) {
            const r = retryErr as { status?: number; message?: string };
            await runAudit({
              error: {
                code: "schema_mismatch",
                status: r.status,
                message: r.message,
              },
            });
            return {
              kind: "json" as const,
              json: {
                ok: false,
                error: {
                  code: "schema_mismatch",
                  toolkitSlug,
                  status: r.status,
                  message: r.message ?? "schema mismatch retry failed",
                },
              },
            };
          }
        }

        // generic / unknown error
        await runAudit({ error: { message, status } });
        return {
          kind: "json" as const,
          json: {
            ok: false,
            error: {
              code: "composio_error",
              toolkitSlug,
              status,
              message,
            },
          },
        };
      }
    });
  },
});
