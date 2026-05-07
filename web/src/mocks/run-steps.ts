import type { CheckResult, RunStep, RunStepKind } from "@/types/runs";

/**
 * Detailed timeline for the verified "Chase outstanding invoices" demo run
 * (`run_2026_05_07_e5`). Other runs render a synthesized lightweight
 * timeline based on stepCount. Anchor to wall-clock at module init so the
 * "Xm ago" labels stay sensible whenever the page is loaded.
 */
const NOW = Date.now();

function relMin(deltaMin: number): string {
  return new Date(NOW + deltaMin * 60_000).toISOString();
}

function step(
  runId: string,
  index: number,
  kind: RunStepKind,
  payload: RunStep["payload"],
  minutesAgo: number,
): RunStep {
  return {
    id: `step_${runId}_${index}`,
    runId,
    stepIndex: index,
    kind,
    payload,
    createdAt: relMin(-minutesAgo),
  };
}

const E5 = "run_2026_05_07_e5";

export const detailedRunSteps: Record<string, RunStep[]> = {
  [E5]: [
    step(E5, 0, "model_thinking", { kind: "model_thinking", text: "Authenticating into QuickBooks via stored Browserbase context." }, 65),
    step(E5, 1, "model_tool_use", { kind: "model_tool_use", toolName: "navigate", reasoning: "Open the Aged Receivables report." }, 65),
    step(E5, 2, "tool_call", { kind: "tool_call", toolName: "navigate", params: { url: "https://app.qbo.intuit.com/app/reports" }, durationMs: 980 }, 65),
    step(E5, 3, "tool_call", { kind: "tool_call", toolName: "click_at", params: { selector: "a[href*='ar-aging']" }, durationMs: 410 }, 64),
    step(E5, 4, "model_thinking", { kind: "model_thinking", text: "I see 8 invoices over 30 days. Filtering out 2 marked 'pending review'. 6 to chase." }, 64),
    step(E5, 5, "tool_call", { kind: "tool_call", toolName: "extract_table", params: { selector: "#aging-report" }, durationMs: 1120, result: { rows: 6 } }, 64),
    step(E5, 6, "model_tool_use", { kind: "model_tool_use", toolName: "navigate", reasoning: "Switch to Gmail to draft the first reminder." }, 63),
    step(E5, 7, "tool_call", { kind: "tool_call", toolName: "navigate", params: { url: "https://mail.google.com" }, durationMs: 730 }, 63),
    step(E5, 8, "tool_call", { kind: "tool_call", toolName: "compose_email", params: { to: "ap@acmecorp.com", subject: "Reminder: Invoice #INV-1042 — $4,800" }, durationMs: 540 }, 62),
    step(E5, 9, "approval", { kind: "approval", approvalId: "appr_001", action: "send_email", status: "approved" }, 61),
    step(E5, 10, "tool_call", { kind: "tool_call", toolName: "send_email", params: { to: "ap@acmecorp.com" }, durationMs: 320 }, 60),
    step(E5, 11, "tool_call", { kind: "tool_call", toolName: "compose_email", params: { to: "billing@nimbusinc.com", subject: "Reminder: Invoice #INV-1051 — $2,200" }, durationMs: 480 }, 60),
    step(E5, 12, "tool_call", { kind: "tool_call", toolName: "send_email", params: { to: "billing@nimbusinc.com" }, durationMs: 280 }, 60),
    step(E5, 13, "tool_call", { kind: "tool_call", toolName: "compose_email", params: { to: "finance@vortexlabs.io", subject: "Reminder: Invoice #INV-1063 — $9,400" }, durationMs: 510 }, 59),
    step(E5, 14, "tool_call", { kind: "tool_call", toolName: "send_email", params: { to: "finance@vortexlabs.io" }, durationMs: 260 }, 59),
    step(E5, 15, "tool_call", { kind: "tool_call", toolName: "compose_email", params: { to: "ap@brightside.co", subject: "Reminder: Invoice #INV-1078 — $1,150" }, durationMs: 470 }, 59),
    step(E5, 16, "tool_call", { kind: "tool_call", toolName: "send_email", params: { to: "ap@brightside.co" }, durationMs: 250 }, 58),
    step(E5, 17, "tool_call", { kind: "tool_call", toolName: "compose_email", params: { to: "ap@kelpkitchen.com", subject: "Reminder: Invoice #INV-1082 — $3,600" }, durationMs: 510 }, 58),
    step(E5, 18, "tool_call", { kind: "tool_call", toolName: "send_email", params: { to: "ap@kelpkitchen.com" }, durationMs: 270 }, 58),
    step(E5, 19, "tool_call", { kind: "tool_call", toolName: "compose_email", params: { to: "ar@palomashop.com", subject: "Reminder: Invoice #INV-1090 — $700" }, durationMs: 460 }, 58),
    step(E5, 20, "tool_call", { kind: "tool_call", toolName: "send_email", params: { to: "ar@palomashop.com" }, durationMs: 240 }, 58),
    step(E5, 21, "model_thinking", { kind: "model_thinking", text: "All 6 reminders sent. Verifying outbox count and that no 'pending review' invoice was touched." }, 58),
    step(E5, 22, "check", { kind: "check", checkName: "emails-sent", passed: true, evidence: { sent: 6, expected: 6 } }, 58),
    step(E5, 23, "check", { kind: "check", checkName: "no-pending-review-touched", passed: true, evidence: { skippedInvoices: ["INV-1018", "INV-1029"] } }, 58),
    step(E5, 24, "tool_call", { kind: "tool_call", toolName: "session_close", params: {}, durationMs: 120 }, 58),
  ],
};

export const detailedRunChecks: Record<string, CheckResult[]> = {
  [E5]: [
    { name: "emails-sent", passed: true, message: "Sent 6 of 6 expected reminders.", evidence: { recipients: 6 } },
    { name: "no-pending-review-touched", passed: true, message: "Both 'pending review' invoices skipped.", evidence: { skipped: ["INV-1018", "INV-1029"] } },
  ],
  run_2026_05_07_f6: [
    { name: "fields-populated", passed: false, message: "3 of 12 leads still missing industry.", evidence: { missing: ["lead_a3", "lead_b1", "lead_d4"] } },
    { name: "audit-tag-applied", passed: true, message: "All 12 leads tagged 'enriched-by-runtime'.", evidence: { tagged: 12 } },
  ],
  run_2026_05_07_d4: [
    { name: "urgency-flagged", passed: true, message: "1 of 1 outage tickets flagged urgent.", evidence: { flagged: ["zd_4912"] } },
    { name: "product-area-tagged", passed: true, message: "All 5 non-outage tickets tagged.", evidence: { tagged: 5 } },
  ],
};

/**
 * Synthesize a lightweight 5-7 step timeline for runs without a hand-tuned
 * fixture, so every run detail page renders something reasonable.
 */
export function synthesizeSteps(runId: string, count: number, status: string): RunStep[] {
  const out: RunStep[] = [];
  const n = Math.min(count, 7);
  for (let i = 0; i < n; i++) {
    const minutesAgo = 30 - i * 2;
    if (i === 0) {
      out.push(step(runId, i, "model_thinking", { kind: "model_thinking", text: "Authenticating and loading the workflow context." }, minutesAgo));
    } else if (i === n - 1 && (status === "verified" || status === "unverified")) {
      out.push(
        step(runId, i, "check", {
          kind: "check",
          checkName: status === "verified" ? "all-checks-passed" : "outcome-check",
          passed: status === "verified",
          evidence: {},
        }, minutesAgo),
      );
    } else {
      out.push(
        step(runId, i, "tool_call", {
          kind: "tool_call",
          toolName: ["navigate", "click_at", "type_text", "extract_table"][i % 4]!,
          params: {},
          durationMs: 400 + (i % 5) * 90,
        }, minutesAgo),
      );
    }
  }
  return out;
}
