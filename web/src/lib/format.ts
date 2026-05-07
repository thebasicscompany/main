/**
 * Formats a cron expression into a human-readable schedule. Handles only
 * the patterns we use in mock workflows; throws fall-through to "Custom"
 * for anything else (good enough for V1 read-only UI).
 */
export function formatCron(cron: string | undefined): string {
  if (!cron) return "Manual only";
  const trimmed = cron.trim();
  if (trimmed === "0 9 * * 1-5") return "Weekdays at 9:00 AM";
  if (trimmed === "0 8 * * *") return "Daily at 8:00 AM";
  if (trimmed === "0 */4 * * *") return "Every 4 hours";
  if (trimmed === "*/15 * * * *") return "Every 15 minutes";
  if (trimmed === "*/5 * * * *") return "Every 5 minutes";
  return `Custom · ${trimmed}`;
}

/**
 * Relative time label: "just now", "12m ago", "3h ago", "2d ago".
 */
export function formatRelative(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

const CREDENTIAL_LABELS: Record<string, string> = {
  quickbooks: "QuickBooks",
  gmail: "Gmail",
  hubspot: "HubSpot",
  linkedin: "LinkedIn",
  stripe: "Stripe",
  slack: "Slack",
  zendesk: "Zendesk",
  shopify: "Shopify",
  googlesheets: "Google Sheets",
};

export function credentialLabel(key: string): string {
  return CREDENTIAL_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}
