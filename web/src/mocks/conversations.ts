import type { ThreadMessageLike } from "@assistant-ui/react";

export type ConversationThreadMeta = {
  id: string;
  title: string;
  subtitle: string;
};

export const conversationThreads: ConversationThreadMeta[] = [
  {
    id: "c-001",
    title: "Weekly RevOps digest debug",
    subtitle: "Stripe vs HubSpot variance",
  },
  {
    id: "c-002",
    title: "New deal account research playbook",
    subtitle: "Enrichment run checklist",
  },
  {
    id: "c-003",
    title: "CRM hygiene review",
    subtitle: "Duplicates & stage drift",
  },
  {
    id: "c-004",
    title: "Quarterly board metrics draft",
    subtitle: "Runs & verification narrative",
  },
  {
    id: "c-005",
    title: "Renewal risk monitor — ACME",
    subtitle: "Approvals & trust ledger",
  },
];

const initialById: Record<string, readonly ThreadMessageLike[]> = {
  "c-001": [
    {
      role: "user",
      content:
        "Why did yesterday's revenue digest run show Stripe MRR **$482.3k** but HubSpot closed-won only shows **$478.9k**?",
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Likely causes are **timing** (Stripe invoices finalized after HubSpot deal-close timestamps) or **partial refunds** still pending sync.\n\n" +
            "Next checks:\n\n" +
            "1. Open run `run_2026_05_07_g7` — verification pill **numbers-match-stripe** should confirm webhook totals.\n" +
            "2. If HubSpot is lower, look for deals stuck in *Proposal* with invoices already paid.\n\n" +
            "Want me to draft a one-line Slack reply for `#finance-ops`?",
        },
      ],
    },
  ],
  "c-002": [
    {
      role: "user",
      content: "What's the safest sequence to enrich a net-new enterprise lead without touching GDPR-marked records?",
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Use workflow **Enrich new HubSpot leads** with these guards:\n\n" +
            "- Skip leads tagged `do-not-modify` (same gate as production).\n" +
            "- Run enrichment **before** outbound sequencing only.\n" +
            "- After each batch, confirm check **`fields-populated`** passes.\n\n" +
            "If you want, I can link to the last **unverified** run where checks failed as a regression example.",
        },
      ],
    },
  ],
  "c-003": [
    {
      role: "user",
      content: "Give me a quick CRM hygiene checklist I can run weekly.",
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "**Weekly CRM hygiene**\n\n" +
            "| Step | Owner |\n|------|-------|\n| Duplicate pairs by domain | RevOps |\n| Stage drift vs last activity | RevOps |\n| Closed-lost still syncing to Stripe | Finance |\n\n" +
            "Cross-check against `/audit` for automated mutations — anything touching stage should leave an audit row.",
        },
      ],
    },
  ],
  "c-004": [
    {
      role: "user",
      content: "Summarize verification posture for board slides — 3 bullets, no jargon.",
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "- **Every revenue-critical workflow** runs module checks after completion (`verified` vs `unverified`).\n" +
            "- **Failures surface** in `/runs` with explicit error summaries — no silent passes.\n" +
            "- **Exceptions** route through `/approvals` before irreversible customer-facing sends.",
        },
      ],
    },
  ],
  "c-005": [
    {
      role: "user",
      content: "If renewal risk spikes on ACME, what approvals should I expect?",
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Anything crossing **auto-approved domains** still flows freely — first-time vendor emails, Slack mentions above thresholds (`@cfo`), or Zendesk priority bumps surface as **`pending`** in `/approvals`.\n\n" +
            "Rejected stays terminal for that gate; timeouts bubble back as run **`failed`** with an audit trail.",
        },
      ],
    },
  ],
};

export function getConversationMeta(id: string): ConversationThreadMeta | undefined {
  return conversationThreads.find((t) => t.id === id);
}

export function getConversationInitialMessages(id: string): readonly ThreadMessageLike[] {
  return initialById[id] ?? [];
}

export function mockAssistantReply(threadId: string, userText: string): string {
  const lower = userText.toLowerCase();
  if (/run|verified|browserbase|session/.test(lower)) {
    return (
      "For runs, start at **`/runs`** — live cards bubble recent sessions to the top. Detail view splits **timeline** vs **live browser** with verification pills pinned under the viewport.\n\n" +
      "Tell me a run id (e.g. `run_2026_05_07_e5`) and I’ll narrate what the timeline is telling us."
    );
  }
  if (/workflow|schedule|cron|playbook/.test(lower)) {
    return (
      "Workflows are **read-only** in the dashboard for now — definitions ship from TS modules, but **`/workflows`** shows schedule text, credential requirements, check modules, and rolling success rate.\n\n" +
      `Thread context \`${threadId}\`: pick a workflow card and cross-reference recent runs at the bottom.`
    );
  }
  if (/approval|human|gate|trust/.test(lower)) {
    return (
      "**`/approvals`** is the human boundary — pending rows hold structured params until approve/reject (mock UI toggles locally).\n\n" +
      "Resolved rows become your institutional memory for who blessed risky sends."
    );
  }
  if (/audit|log|export/.test(lower)) {
    return (
      "**`/audit`** (next roadmap slice) will consolidate workspace mutations — for now, treat verification pills + run error summaries as the lightweight audit trail.\n\n" +
      "Ask about a specific workflow if you want a tighter narrative."
    );
  }
  return (
    "I'm running **offline fixtures** here — no model attached yet.\n\n" +
    `Try asking about **runs**, **workflows**, **approvals**, or **audit**. (Thread \`${threadId}\`)`
  );
}
