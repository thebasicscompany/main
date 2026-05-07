import type { Run, RunStatus } from "@/types/runs";

import { mockWorkflows } from "./workflows";

const WORKSPACE_ID = "ws_mock";

const USERS = [
  { id: "usr_001", name: "Arav Bhardwaj" },
  { id: "usr_002", name: "Maya Patel" },
  { id: "usr_003", name: "Jordan Reyes" },
];

/**
 * Anchor demo timestamps to real wall-clock at module init, so live cards
 * always show sensible elapsed times no matter when the page is loaded.
 * Declared before `mockRuns` so the top-level `relMin` calls below don't
 * hit a TDZ on module init.
 */
const NOW = Date.now();

function relMin(deltaMin: number): string {
  return new Date(NOW + deltaMin * 60_000).toISOString();
}

/**
 * Deterministic run fixtures. Statuses are spread to exercise every pill,
 * timestamps are anchored relative to the demo date so screenshots stay
 * stable. The first three are the "live" set (running / paused / verifying)
 * that should pin to the top of the table.
 */
export const mockRuns: Run[] = [
  {
    id: "run_2026_05_07_a1",
    workflowId: "wf_invoice_chase",
    workflowName: "Chase outstanding invoices",
    workspaceId: WORKSPACE_ID,
    status: "running",
    trigger: "scheduled",
    browserbaseSessionId: "bb_sess_a1",
    liveUrl: "https://browserbase.example/sess/a1",
    takeoverActive: false,
    startedAt: relMin(-4),
    stepCount: 17,
  },
  {
    id: "run_2026_05_07_b2",
    workflowId: "wf_lead_enrich",
    workflowName: "Enrich new HubSpot leads",
    workspaceId: WORKSPACE_ID,
    status: "paused",
    trigger: "scheduled",
    browserbaseSessionId: "bb_sess_b2",
    liveUrl: "https://browserbase.example/sess/b2",
    takeoverActive: false,
    startedAt: relMin(-12),
    stepCount: 9,
  },
  {
    id: "run_2026_05_07_c3",
    workflowId: "wf_slack_digest",
    workflowName: "Daily revenue digest to #leadership",
    workspaceId: WORKSPACE_ID,
    status: "verifying",
    trigger: "scheduled",
    browserbaseSessionId: "bb_sess_c3",
    liveUrl: "https://browserbase.example/sess/c3",
    takeoverActive: false,
    startedAt: relMin(-2),
    stepCount: 23,
  },
  {
    id: "run_2026_05_07_d4",
    workflowId: "wf_zendesk_triage",
    workflowName: "Triage urgent Zendesk tickets",
    workspaceId: WORKSPACE_ID,
    status: "verified",
    trigger: "scheduled",
    triggeredBy: USERS[0],
    takeoverActive: false,
    startedAt: relMin(-22),
    completedAt: relMin(-19),
    verifiedAt: relMin(-18),
    costCents: 12,
    stepCount: 14,
  },
  {
    id: "run_2026_05_07_e5",
    workflowId: "wf_invoice_chase",
    workflowName: "Chase outstanding invoices",
    workspaceId: WORKSPACE_ID,
    status: "verified",
    trigger: "scheduled",
    takeoverActive: false,
    startedAt: relMin(-65),
    completedAt: relMin(-58),
    verifiedAt: relMin(-58),
    costCents: 47,
    stepCount: 31,
  },
  {
    id: "run_2026_05_07_f6",
    workflowId: "wf_lead_enrich",
    workflowName: "Enrich new HubSpot leads",
    workspaceId: WORKSPACE_ID,
    status: "unverified",
    trigger: "manual",
    triggeredBy: USERS[1],
    takeoverActive: false,
    startedAt: relMin(-95),
    completedAt: relMin(-90),
    verifiedAt: relMin(-89),
    costCents: 33,
    stepCount: 18,
    errorSummary: "Check 'fields-populated' failed — 3 leads missing industry.",
  },
  {
    id: "run_2026_05_07_g7",
    workflowId: "wf_slack_digest",
    workflowName: "Daily revenue digest to #leadership",
    workspaceId: WORKSPACE_ID,
    status: "verified",
    trigger: "scheduled",
    takeoverActive: false,
    startedAt: relMin(-510),
    completedAt: relMin(-507),
    verifiedAt: relMin(-507),
    costCents: 8,
    stepCount: 6,
  },
  {
    id: "run_2026_05_06_h8",
    workflowId: "wf_zendesk_triage",
    workflowName: "Triage urgent Zendesk tickets",
    workspaceId: WORKSPACE_ID,
    status: "failed",
    trigger: "scheduled",
    takeoverActive: false,
    startedAt: relMin(-1450),
    completedAt: relMin(-1448),
    stepCount: 3,
    errorSummary: "Browserbase session ended unexpectedly (TimeoutError after 120s).",
  },
  {
    id: "run_2026_05_06_i9",
    workflowId: "wf_invoice_chase",
    workflowName: "Chase outstanding invoices",
    workspaceId: WORKSPACE_ID,
    status: "verified",
    trigger: "scheduled",
    takeoverActive: false,
    startedAt: relMin(-1500),
    completedAt: relMin(-1493),
    verifiedAt: relMin(-1493),
    costCents: 52,
    stepCount: 28,
  },
  {
    id: "run_2026_05_06_j0",
    workflowId: "wf_inventory_sync",
    workflowName: "Reconcile Shopify inventory",
    workspaceId: WORKSPACE_ID,
    status: "completed",
    trigger: "manual",
    triggeredBy: USERS[2],
    takeoverActive: true,
    startedAt: relMin(-1620),
    completedAt: relMin(-1605),
    costCents: 71,
    stepCount: 42,
  },
  {
    id: "run_2026_05_06_k1",
    workflowId: "wf_lead_enrich",
    workflowName: "Enrich new HubSpot leads",
    workspaceId: WORKSPACE_ID,
    status: "verified",
    trigger: "scheduled",
    takeoverActive: false,
    startedAt: relMin(-1800),
    completedAt: relMin(-1797),
    verifiedAt: relMin(-1797),
    costCents: 19,
    stepCount: 11,
  },
  {
    id: "run_2026_05_06_l2",
    workflowId: "wf_zendesk_triage",
    workflowName: "Triage urgent Zendesk tickets",
    workspaceId: WORKSPACE_ID,
    status: "verified",
    trigger: "scheduled",
    takeoverActive: false,
    startedAt: relMin(-1815),
    completedAt: relMin(-1814),
    verifiedAt: relMin(-1814),
    costCents: 4,
    stepCount: 5,
  },
  ...syntheticHistory(),
];

function syntheticHistory(): Run[] {
  const out: Run[] = [];
  const statuses: RunStatus[] = ["verified", "verified", "verified", "verified", "unverified", "failed", "completed"];
  let counter = 0;
  for (let day = 2; day <= 7; day++) {
    for (const wf of mockWorkflows) {
      const status = statuses[counter % statuses.length] as RunStatus;
      counter++;
      const startMin = -1 * (day * 1440 + (counter % 600));
      const completedMin = startMin + (3 + (counter % 12));
      out.push({
        id: `run_2026_05_${String(8 - day).padStart(2, "0")}_${counter.toString(36)}`,
        workflowId: wf.id,
        workflowName: wf.name,
        workspaceId: WORKSPACE_ID,
        status,
        trigger: counter % 5 === 0 ? "manual" : "scheduled",
        triggeredBy: counter % 5 === 0 ? USERS[counter % USERS.length] : undefined,
        takeoverActive: false,
        startedAt: relMin(startMin),
        completedAt: relMin(completedMin),
        verifiedAt: status === "verified" ? relMin(completedMin) : undefined,
        costCents: 5 + (counter % 60),
        stepCount: 4 + (counter % 30),
        errorSummary:
          status === "failed"
            ? "Approval timed out (waited 5m for Slack response)."
            : status === "unverified"
              ? "Check 'numbers-match-stripe' returned 0 of 3 expected lines."
              : undefined,
      });
    }
  }
  return out;
}

export function findRun(id: string): Run | undefined {
  return mockRuns.find((r) => r.id === id);
}
