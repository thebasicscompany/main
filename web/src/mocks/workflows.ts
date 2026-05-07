import type { Workflow } from "@/types/runs";

const WORKSPACE_ID = "ws_mock";

export const mockWorkflows: Workflow[] = [
  {
    id: "wf_invoice_chase",
    workspaceId: WORKSPACE_ID,
    name: "Chase outstanding invoices",
    prompt:
      "Review QuickBooks invoices aged 30+ days. For each, draft a reminder email referencing the invoice number, amount, and due date. Send through Gmail under sales@ alias. Skip invoices with notes containing 'pending review'.",
    schedule: "0 9 * * 1-5",
    enabled: true,
    requiredCredentials: ["quickbooks", "gmail"],
    checkModules: ["emails-sent", "no-pending-review-touched"],
    createdAt: "2026-04-01T15:30:00Z",
    updatedAt: "2026-05-01T11:12:00Z",
  },
  {
    id: "wf_lead_enrich",
    workspaceId: WORKSPACE_ID,
    name: "Enrich new HubSpot leads",
    prompt:
      "For every HubSpot lead created in the last 24h with empty 'company_size' or 'industry', look the company up on LinkedIn, fill those two fields, and add a tag 'enriched-by-runtime'. Don't touch leads that already have a 'do-not-modify' tag.",
    schedule: "0 */4 * * *",
    enabled: true,
    requiredCredentials: ["hubspot", "linkedin"],
    checkModules: ["fields-populated", "audit-tag-applied"],
    createdAt: "2026-03-20T18:00:00Z",
    updatedAt: "2026-04-25T08:45:00Z",
  },
  {
    id: "wf_slack_digest",
    workspaceId: WORKSPACE_ID,
    name: "Daily revenue digest to #leadership",
    prompt:
      "Pull yesterday's MRR, new signups, and churn from Stripe. Format as a Slack post with the standard 'Daily Revenue' template and post to #leadership. Mention @cfo if churn > 2%.",
    schedule: "0 8 * * *",
    enabled: true,
    requiredCredentials: ["stripe", "slack"],
    checkModules: ["post-published", "numbers-match-stripe"],
    createdAt: "2026-02-14T13:00:00Z",
    updatedAt: "2026-04-02T09:00:00Z",
  },
  {
    id: "wf_zendesk_triage",
    workspaceId: WORKSPACE_ID,
    name: "Triage urgent Zendesk tickets",
    prompt:
      "Every 15 minutes, scan new Zendesk tickets. If subject contains 'down', 'broken', or 'outage', escalate to priority=urgent and ping #support-oncall. Otherwise tag with the matching product area.",
    schedule: "*/15 * * * *",
    enabled: true,
    requiredCredentials: ["zendesk", "slack"],
    checkModules: ["urgency-flagged", "product-area-tagged"],
    createdAt: "2026-01-09T20:30:00Z",
    updatedAt: "2026-04-30T17:15:00Z",
  },
  {
    id: "wf_inventory_sync",
    workspaceId: WORKSPACE_ID,
    name: "Reconcile Shopify inventory",
    prompt:
      "Compare Shopify variant inventory against the warehouse CSV at s3://ops-mirror/inventory/latest.csv. Flag any SKU drifting more than 5 units, post discrepancies to a Google Sheet, and DM @ops-lead if more than 20 SKUs drift.",
    enabled: false,
    requiredCredentials: ["shopify", "googlesheets", "slack"],
    checkModules: ["sheet-updated", "drift-counted"],
    createdAt: "2026-03-05T10:00:00Z",
    updatedAt: "2026-04-18T14:25:00Z",
  },
];

export function findWorkflow(id: string): Workflow | undefined {
  return mockWorkflows.find((w) => w.id === id);
}
