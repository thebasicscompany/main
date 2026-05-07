export type WorkspaceRole = "owner" | "admin" | "member";

export type UserProfile = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
};

export type BillingSummary = {
  planName: string;
  seatsIncluded: number;
  seatsUsed: number;
  renewsAt: string;
  paymentMethodSummary: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  billing: BillingSummary;
};

export type WorkspaceMember = {
  id: string;
  displayName: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
};

export type IntegrationStatus = "connected" | "disconnected" | "expiring_soon" | "error";

export type Integration = {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  detail?: string;
};

export type TrustGrantScope = "workspace" | "workflow";

export type TrustGrant = {
  id: string;
  actionPattern: string;
  paramsConstraint: string;
  scope: TrustGrantScope;
  workflowId?: string;
  workflowName?: string;
  grantedByName: string;
  grantedAt: string;
  expiresAt?: string;
};

export type ApiToken = {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type WebhookEndpoint = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
};
