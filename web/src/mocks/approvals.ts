import type { Approval } from "@/types/runs";

const WORKSPACE_ID = "ws_mock";
const NOW = Date.now();

function relMin(deltaMin: number): string {
  return new Date(NOW + deltaMin * 60_000).toISOString();
}

const USERS = [
  { id: "usr_001", name: "Arav Bhardwaj" },
  { id: "usr_002", name: "Maya Patel" },
  { id: "usr_003", name: "Jordan Reyes" },
];

export const mockApprovals: Approval[] = [
  // Pending
  {
    id: "appr_pending_001",
    runId: "run_2026_05_07_a1",
    workspaceId: WORKSPACE_ID,
    action: "send_email",
    reason: "First-time recipient — outside the auto-approved domain list.",
    params: {
      to: "ap@northlightco.com",
      subject: "Reminder: Invoice #INV-1108 — $5,200",
      body_preview: "Hi team, our records show invoice INV-1108 is 32 days past due...",
    },
    status: "pending",
    requestedAt: relMin(-3),
  },
  {
    id: "appr_pending_002",
    runId: "run_2026_05_07_b2",
    workspaceId: WORKSPACE_ID,
    action: "modify_lead",
    reason: "Lead has 'do-not-modify' tag — surfacing for confirmation.",
    params: {
      leadId: "lead_44219",
      changes: { industry: "Healthtech", company_size: "51-200" },
    },
    status: "pending",
    requestedAt: relMin(-11),
  },
  {
    id: "appr_pending_003",
    runId: "run_2026_05_07_c3",
    workspaceId: WORKSPACE_ID,
    action: "post_slack",
    reason: "Churn 3.1% > 2% threshold — flagged for human eyes before mentioning @cfo.",
    params: {
      channel: "#leadership",
      mentions: ["@cfo"],
      message: "Daily Revenue · MRR $482,300 · Signups 14 · Churn 3.1% (above target).",
    },
    status: "pending",
    requestedAt: relMin(-1),
  },
  // Resolved (synthesized history across last few days)
  ...synthesized(),
];

function synthesized(): Approval[] {
  const out: Approval[] = [];
  const actions: Array<{ action: string; reason: string; params: Record<string, unknown> }> = [
    { action: "send_email", reason: "Outside auto-approved sender list.", params: { to: "ap@acmecorp.com" } },
    { action: "send_email", reason: "First-time recipient.", params: { to: "billing@nimbusinc.com" } },
    { action: "modify_lead", reason: "Tag conflict.", params: { leadId: "lead_52" } },
    { action: "post_slack", reason: "Mention @cfo.", params: { channel: "#leadership" } },
    { action: "escalate_ticket", reason: "Priority change requires sign-off.", params: { ticketId: "zd_4912" } },
    { action: "update_inventory", reason: "Drift > 5 units on a tracked SKU.", params: { sku: "VR-CHARGE-44" } },
  ];
  const outcomes: Array<"approved" | "rejected" | "timeout"> = [
    "approved",
    "approved",
    "approved",
    "rejected",
    "approved",
    "approved",
    "timeout",
    "approved",
  ];

  for (let i = 0; i < 22; i++) {
    const a = actions[i % actions.length]!;
    const status = outcomes[i % outcomes.length]!;
    const requestedMinAgo = -(20 + i * 23);
    const resolvedDelay = status === "timeout" ? 5 : 1 + (i % 4);
    out.push({
      id: `appr_resolved_${i.toString().padStart(3, "0")}`,
      runId: `run_history_${i}`,
      workspaceId: WORKSPACE_ID,
      action: a.action,
      reason: a.reason,
      params: a.params,
      status,
      requestedAt: relMin(requestedMinAgo),
      resolvedAt: relMin(requestedMinAgo + resolvedDelay),
      resolvedBy: status === "timeout" ? undefined : USERS[i % USERS.length],
    });
  }
  return out;
}

export function findApproval(id: string): Approval | undefined {
  return mockApprovals.find((a) => a.id === id);
}
