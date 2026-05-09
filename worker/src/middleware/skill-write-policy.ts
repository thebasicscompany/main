// CLOUD-AGENT-PLAN §9.3 — skill-write middleware. Sits between
// write_file/edit_file and the filesystem. Each rule returns either
// {ok:true} or {ok:false, code, message}; aggregator picks the FIRST
// failure so callers get one canonical reason per attempt.

export type WriteVerdict =
  | { ok: true }
  | { ok: false; code: WriteRejectCode; message: string };

export type WriteRejectCode =
  | "path_outside_policy"
  | "size_cap_exceeded"
  | "secret_detected"
  | "pixel_coord_detected"
  | "pii_detected"
  | "shell_exec_in_helper"
  | "missing_verification_stamp";

export interface PolicyOptions {
  /** Allow PII patterns (email/phone/SSN). Default false. */
  allowPII?: boolean;
  /** Single-file cap in bytes. Default 64 KiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

/** Allowed root prefixes per §9.3 path policy. */
const ALLOWED_ROOTS = ["skills/", "helpers/", "memory/", "tmp/"];

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/ },
  { name: "openai",    re: /\bsk-(?:proj-|live-)?[A-Za-z0-9_\-]{20,}\b/ },
  { name: "stripe_webhook", re: /\bwhsec_[A-Za-z0-9]{16,}\b/ },
  { name: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google_api_key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: "supabase_jwt",   re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
];

// "click 432, 198" / "x: 432, y: 198" / coordinates on a line by themselves
const PIXEL_COORD_PATTERNS: ReadonlyArray<RegExp> = [
  /\bclick(?:ing)?\s+(?:at\s+)?\(?\d{2,4}\s*,\s*\d{2,4}\)?/i,
  /\bx\s*[:=]\s*\d{2,4}\s*[,;]\s*y\s*[:=]\s*\d{2,4}\b/i,
  /^\s*\(?\d{2,4}\s*,\s*\d{2,4}\)?\s*$/m,
];

const PII_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // Real-looking email — exclude common placeholders.
  { name: "email", re: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/ },
  { name: "ssn",   re: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
  // us_phone — require at least one separator between groups so plain
  // 10-digit numbers (view counts, hashes, IDs) don't false-match.
  // No leading `\b` because parens form `(415)…` doesn't sit on a word
  // boundary; trailing `(?!\d)` prevents partial-match into longer ints.
  { name: "us_phone", re: /(?:\+?1[\s\-.])?(?:\(\d{3}\)\s?|\d{3}[\s\-.])\d{3}[\s\-.]\d{4}(?!\d)/ },
];

const HELPER_BANNED_IMPORTS: ReadonlyArray<RegExp> = [
  /\bimport\s+[^;]*\bfrom\s+['"]node:child_process['"]/,
  /\brequire\(\s*['"]node:child_process['"]\s*\)/,
  /\bimport\s+[^;]*\bfrom\s+['"]child_process['"]/,
  /\brequire\(\s*['"]child_process['"]\s*\)/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
];

/** Allowed placeholder emails — common docs / Anthropic / vendor examples. */
const PLACEHOLDER_EMAIL_DOMAINS = ["example.com", "test.com", "noreply.anthropic.com"];

function pathPolicy(path: string): WriteVerdict {
  if (!ALLOWED_ROOTS.some((root) => path === root.slice(0, -1) || path.startsWith(root))) {
    return {
      ok: false,
      code: "path_outside_policy",
      message: `path_outside_policy: skill-write requires path under one of [${ALLOWED_ROOTS.join(", ")}]; got '${path}'`,
    };
  }
  return { ok: true };
}

function sizeCap(content: string, maxBytes: number): WriteVerdict {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: "size_cap_exceeded",
      message: `size_cap_exceeded: ${bytes} bytes > ${maxBytes}`,
    };
  }
  return { ok: true };
}

function secretScan(content: string): WriteVerdict {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      return {
        ok: false,
        code: "secret_detected",
        message: `secret_detected: ${name} pattern matched — refusing to persist credentials in a skill`,
      };
    }
  }
  return { ok: true };
}

function pixelCoordScan(content: string): WriteVerdict {
  for (const re of PIXEL_COORD_PATTERNS) {
    if (re.test(content)) {
      return {
        ok: false,
        code: "pixel_coord_detected",
        message: "pixel_coord_detected: skills should record selectors, not pixel coordinates (layouts shift)",
      };
    }
  }
  return { ok: true };
}

function piiScan(content: string, allowPII: boolean): WriteVerdict {
  if (allowPII) return { ok: true };
  for (const { name, re } of PII_PATTERNS) {
    const m = re.exec(content);
    if (!m) continue;
    if (name === "email") {
      const domain = m[0].split("@")[1]?.toLowerCase() ?? "";
      if (PLACEHOLDER_EMAIL_DOMAINS.some((p) => domain === p || domain.endsWith("." + p))) continue;
    }
    return {
      ok: false,
      code: "pii_detected",
      message: `pii_detected: ${name} pattern matched — set workspace.agent_settings.allowPII=true to bypass`,
    };
  }
  return { ok: true };
}

function helperShellExecScan(path: string, content: string): WriteVerdict {
  if (!path.startsWith("helpers/") || !path.endsWith(".ts")) return { ok: true };
  for (const re of HELPER_BANNED_IMPORTS) {
    if (re.test(content)) {
      return {
        ok: false,
        code: "shell_exec_in_helper",
        message: "shell_exec_in_helper: helpers/*.ts cannot import child_process or use eval/new Function",
      };
    }
  }
  return { ok: true };
}

/** Files that must carry a `Last-verified: YYYY-MM-DD` line. */
const STAMP_REQUIRED = (path: string): boolean => {
  if (path.endsWith("/selectors.md") || path === "skills/selectors.md") return true;
  if (/^skills\/[^/]+\/flows\/[^/]+\.md$/.test(path)) return true;
  return false;
};

const STAMP_RE = /^\s*Last-verified:\s*\d{4}-\d{2}-\d{2}\s*$/m;

function verificationStamp(path: string, content: string): WriteVerdict {
  if (!STAMP_REQUIRED(path)) return { ok: true };
  if (!STAMP_RE.test(content)) {
    return {
      ok: false,
      code: "missing_verification_stamp",
      message: `missing_verification_stamp: ${path} requires a 'Last-verified: YYYY-MM-DD' line so the decay job can demote stale entries`,
    };
  }
  return { ok: true };
}

/** Run all rules and return the first failure (or {ok:true} if all pass). */
export function validateSkillWrite(
  path: string,
  content: string,
  opts: PolicyOptions = {},
): WriteVerdict {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const checks: WriteVerdict[] = [
    pathPolicy(path),
    sizeCap(content, maxBytes),
    secretScan(content),
    pixelCoordScan(content),
    piiScan(content, opts.allowPII ?? false),
    helperShellExecScan(path, content),
    verificationStamp(path, content),
  ];
  for (const v of checks) if (!v.ok) return v;
  return { ok: true };
}

/** Path falls under the skill-write policy's purview (caller decides whether to apply). */
export function pathRequiresSkillWritePolicy(path: string): boolean {
  return ALLOWED_ROOTS.some((root) => path === root.slice(0, -1) || path.startsWith(root));
}

export class SkillWriteBlockedError extends Error {
  constructor(public readonly verdict: Extract<WriteVerdict, { ok: false }>) {
    super(`skill_write_blocked: ${verdict.code}: ${verdict.message}`);
    this.name = "SkillWriteBlockedError";
  }
}
