// K.5 — sandbox runtime for agent-authored helpers (cloud_agent_helpers).
//
// Helpers are TypeScript modules with the shape:
//   export async function run(args, ctx) { ... }
// The agent (via helper_write) writes them after a successful pipeline.
// On subsequent runs, the worker registers a single `helper_call` tool
// (K.4) that the LLM invokes with `{helperName, args}`; this module
// compiles + executes the matching helper body inside a Node `vm.Script`
// with a deliberately narrow context.
//
// Why vm.Script (not isolated-vm or vm2)? isolated-vm is a native dep
// that's painful to ship on Alpine + arm64 Fargate. vm2 is deprecated.
// Node's built-in `vm` does NOT provide a true security boundary
// (the V8 contexts share the heap, and helpers can still mount
// prototype-chain escapes), so we DO NOT treat this as a hostile-code
// boundary. We treat it as a *separation-of-concerns* boundary: helpers
// can only call ctx-injected APIs because that's all the names that are
// in scope. The hostile-code threat model is "the agent we trust is the
// one writing the helper" — same trust level as the agent's other tools.
//
// What we DO enforce:
//   - AST validation at helper_write time (K.2) rejects `process`, `eval`,
//     `Function`, `require`, `child_process`, `fs`, etc.
//   - Sandbox provides only: ctx.composio(slug, params), ctx.browser,
//     ctx.fetch (with origin allowlist), ctx.sql_read, ctx.log.
//   - 5-minute hard timeout per helper invocation. Throws
//     HelperTimeoutError so the dispatcher fast-path / LLM can fall back.
//   - Body is compiled ONCE per helper version per worker boot (cached
//     by helper id). Subsequent invocations re-use the compiled Script.

import * as vm from "node:vm";

const HELPER_TIMEOUT_MS = Number(process.env.HELPER_TIMEOUT_MS ?? 5 * 60_000);
const HELPER_FETCH_ALLOWLIST = (process.env.HELPER_FETCH_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export class HelperTimeoutError extends Error {
  readonly code = "helper_timeout" as const;
  constructor(message: string) {
    super(message);
    this.name = "HelperTimeoutError";
  }
}

export class HelperRuntimeError extends Error {
  readonly code = "helper_runtime_error" as const;
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HelperRuntimeError";
  }
}

export interface HelperCtx {
  composio: (slug: string, params: Record<string, unknown>) => Promise<unknown>;
  browser: Record<string, (...args: unknown[]) => Promise<unknown>>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sql_read: (
    query: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ) => Promise<Array<Record<string, unknown>>>;
  log: (...args: unknown[]) => void;
}

interface CompiledHelper {
  id: string;
  helperVersion: number;
  script: vm.Script;
}

const compileCache = new Map<string, CompiledHelper>();

/**
 * Compile a helper body to a `vm.Script`. The body is wrapped so that
 * its exported `run` function is captured into a known slot we can
 * invoke. We strip `export` because `vm.runInContext` doesn't natively
 * support ESM exports — the wrapper exposes `run` directly.
 */
function compileHelperBody(body: string): vm.Script {
  // Strip `export ` from `export async function run` so vm sees a normal
  // declaration in the script scope. We then capture it via the trailing
  // assignment to `__run`.
  const stripped = body.replace(
    /export\s+async\s+function\s+run\b/,
    "async function run",
  );
  const wrapped = `${stripped}\n;__run = run;`;
  return new vm.Script(wrapped, {
    filename: "helper.ts",
    lineOffset: 0,
  });
}

function getOrCompile(helperId: string, helperVersion: number, body: string): vm.Script {
  const cached = compileCache.get(helperId);
  if (cached && cached.helperVersion === helperVersion) {
    return cached.script;
  }
  const script = compileHelperBody(body);
  compileCache.set(helperId, { id: helperId, helperVersion, script });
  return script;
}

/**
 * Build a fetch wrapper that only allows requests to origins in
 * HELPER_FETCH_ALLOWLIST. Empty allowlist denies all (helpers should
 * use ctx.composio / ctx.browser for outbound work by default).
 */
function makeRestrictedFetch(): HelperCtx["fetch"] {
  return async function helperFetch(url: string, init?: RequestInit): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HelperRuntimeError(`helper fetch: invalid URL: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new HelperRuntimeError(`helper fetch: protocol not allowed: ${parsed.protocol}`);
    }
    const origin = parsed.origin;
    const allowed = HELPER_FETCH_ALLOWLIST.some((entry) =>
      entry === origin || entry === parsed.hostname || origin.endsWith(entry),
    );
    if (!allowed) {
      throw new HelperRuntimeError(
        `helper fetch: origin not in HELPER_FETCH_ALLOWLIST: ${origin}`,
      );
    }
    return fetch(url, init);
  };
}

export interface RunHelperInput {
  helperId: string;
  helperVersion: number;
  body: string;
  args: unknown;
  ctx: HelperCtx;
}

/**
 * Invoke a helper. Returns whatever the helper's `run()` returns.
 * Throws HelperTimeoutError on >HELPER_TIMEOUT_MS wall clock.
 * Throws HelperRuntimeError wrapping any other helper-thrown error.
 */
export async function runHelper(input: RunHelperInput): Promise<unknown> {
  const script = getOrCompile(input.helperId, input.helperVersion, input.body);

  // Build the sandbox context. Helpers see exactly these names plus
  // a `__run` slot where their exported function lands after script
  // execution. Everything else is hidden — accessing `process`, `fs`,
  // etc. throws ReferenceError inside the sandbox.
  const sandbox: Record<string, unknown> = {
    __run: undefined,
    console: {
      log: input.ctx.log,
      error: input.ctx.log,
      warn: input.ctx.log,
      info: input.ctx.log,
      debug: input.ctx.log,
    },
    // Helpers may need timers for retry/throttle logic.
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Promise,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  };
  const context = vm.createContext(sandbox, { name: `helper:${input.helperId}` });

  // Run the script to define `run` in the context and capture it into __run.
  try {
    script.runInContext(context, { timeout: 1000 });
  } catch (e) {
    throw new HelperRuntimeError(
      `helper compile-time error: ${(e as Error).message}`,
      e,
    );
  }

  const runFn = (sandbox as { __run?: (...args: unknown[]) => Promise<unknown> }).__run;
  if (typeof runFn !== "function") {
    throw new HelperRuntimeError(
      "helper body did not assign __run — body must `export async function run(args, ctx) { ... }`",
    );
  }

  // Build the helper-facing ctx with the fetch restriction applied.
  const helperCtx: HelperCtx = {
    composio: input.ctx.composio,
    browser: input.ctx.browser,
    fetch: makeRestrictedFetch(),
    sql_read: input.ctx.sql_read,
    log: input.ctx.log,
  };

  // Race helper execution against the hard timeout.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new HelperTimeoutError(
          `helper ${input.helperId} timed out after ${HELPER_TIMEOUT_MS}ms`,
        ),
      );
    }, HELPER_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      runFn(input.args, helperCtx),
      timeoutPromise,
    ]);
    return result;
  } catch (e) {
    if (e instanceof HelperTimeoutError || e instanceof HelperRuntimeError) {
      throw e;
    }
    throw new HelperRuntimeError(
      `helper threw: ${(e as Error).message}`,
      e,
    );
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Invalidate the compile cache for a helper (call after helper_write
 * supersedes a prior version, so the next helper_call picks up the new
 * body). The dispatcher already loads body+version fresh from DB on
 * each call, so this is just a memory cleanup hint.
 */
export function invalidateHelper(helperId: string): void {
  compileCache.delete(helperId);
}
