import type {
  ApiToken,
  Integration,
  TrustGrant,
  WebhookEndpoint,
  WorkspaceMember,
  WorkspaceSummary,
} from "@/types/settings";

export const mockWorkspaceSummary: WorkspaceSummary = {
  id: "ws_mock",
  name: "Acme RevOps",
  slug: "acme-revops",
  billing: {
    planName: "Design partner",
    seatsIncluded: 10,
    seatsUsed: 4,
    renewsAt: "2026-06-01T00:00:00Z",
    paymentMethodSummary: "Visa •••• 4242",
  },
};

export const mockWorkspaceMembers: WorkspaceMember[] = [
  {
    id: "mbr_1",
    displayName: "Jordan Lee",
    email: "jordan@acme-revops.example",
    role: "owner",
    joinedAt: "2025-08-12T14:22:00Z",
  },
  {
    id: "mbr_2",
    displayName: "Sam Rivera",
    email: "sam.r@acme-revops.example",
    role: "admin",
    joinedAt: "2025-09-03T09:15:00Z",
  },
  {
    id: "mbr_3",
    displayName: "Priya Shah",
    email: "priya@acme-revops.example",
    role: "member",
    joinedAt: "2026-01-20T16:40:00Z",
  },
  {
    id: "mbr_4",
    displayName: "Alex Chen",
    email: "alex.chen@acme-revops.example",
    role: "member",
    joinedAt: "2026-03-02T11:05:00Z",
  },
];

export const mockIntegrations: Integration[] = [
  {
    id: "slack",
    name: "Slack",
    description: "Approval DMs, digest posts, and on-call pings.",
    status: "connected",
    detail: "Workspace RevOps Runtime · #leadership",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    description: "CRM checks and field verification after runs.",
    status: "connected",
    detail: "OAuth · api.salesforce.com",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Lead enrichment workflows.",
    status: "expiring_soon",
    detail: "Token expires in 6 days",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Read-only revenue metrics for digest playbooks.",
    status: "disconnected",
  },
];

export const mockTrustGrants: TrustGrant[] = [
  {
    id: "tg_1",
    actionPattern: "tool:navigate",
    paramsConstraint: 'host ends with ".salesforce.com"',
    scope: "workspace",
    grantedByName: "Jordan Lee",
    grantedAt: "2026-04-28T18:12:00Z",
    expiresAt: "2026-07-28T18:12:00Z",
  },
  {
    id: "tg_2",
    actionPattern: "tool:click_at_xy",
    paramsConstraint: "region=data-table · Salesforce · Accounts tab",
    scope: "workflow",
    workflowId: "wf_lead_enrich",
    workflowName: "Enrich new HubSpot leads",
    grantedByName: "Sam Rivera",
    grantedAt: "2026-04-30T09:45:00Z",
  },
  {
    id: "tg_3",
    actionPattern: "tool:js",
    paramsConstraint: "snippet hash sha256:9f3c… · read-only DOM scrape",
    scope: "workflow",
    workflowId: "wf_slack_digest",
    workflowName: "Daily revenue digest to #leadership",
    grantedByName: "Jordan Lee",
    grantedAt: "2026-05-02T13:00:00Z",
    expiresAt: "2026-08-02T13:00:00Z",
  },
];

export const mockApiTokens: ApiToken[] = [
  {
    id: "tok_1",
    label: "CI — nightly checks",
    prefix: "brt_live_8Qx",
    createdAt: "2026-03-01T10:00:00Z",
    lastUsedAt: "2026-05-06T02:15:00Z",
  },
  {
    id: "tok_2",
    label: "Local Lens dev",
    prefix: "brt_test_k9m",
    createdAt: "2026-04-10T15:30:00Z",
    lastUsedAt: "2026-05-05T19:40:00Z",
  },
];

export const mockWebhooks: WebhookEndpoint[] = [
  {
    id: "wh_1",
    url: "https://hooks.slack.com/services/T000/B000/XXXXXXXX",
    events: ["run.completed", "run.failed"],
    enabled: true,
    createdAt: "2026-02-14T12:00:00Z",
  },
];
