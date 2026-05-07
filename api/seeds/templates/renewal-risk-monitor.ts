/**
 * Renewal Risk Monitor — Phase 11 launch template #3.
 *
 * Wedge: weekly sweep over accounts entering their renewal window (next
 * 90 days) and surface ones showing risk signals — declining usage,
 * support escalations, no-touch in 30 days, etc. Gives CSMs a prioritized
 * worklist instead of a sortable spreadsheet.
 *
 * Outcome verification:
 *  - `record_count_changed` (Phase 09 stub today) — asserts at least one
 *    "at-risk" tag was written across the surveyed accounts.
 *  - `slack_message_posted` — the digest of at-risk accounts went to the
 *    configured CS channel.
 *
 * Schedule: Tuesday 14:00 UTC (≈ 10am ET / 7am PT). Tuesday on purpose so
 * CSMs see it after Monday standup but with the rest of the week to act.
 *
 * Partner customization:
 *  - The Salesforce / Looker view id for "renewals next 90 days" is
 *    partner-specific.
 *  - Risk signals (usage drop %, support ticket count, etc.) are
 *    partner-specific. v1 hardcodes a sane default; tune in onboarding.
 *  - Some partners flag risk in HubSpot (not Salesforce) — swap accordingly.
 */

import type { WorkflowTemplate } from './types.js'

export const renewalRiskMonitor: WorkflowTemplate = {
  name: 'Renewal Risk Monitor',
  schedule: 'cron(0 14 ? * TUE *)',
  enabled: true,
  requiredCredentials: {
    providers: [
      {
        provider: 'salesforce',
        scope: 'read_write',
        reason:
          'Read renewal-window accounts + write an "At Risk" tag onto flagged ones.',
      },
      {
        provider: 'slack',
        scope: 'write',
        reason: 'Post the at-risk digest into the customer success channel.',
      },
      {
        provider: 'looker',
        scope: 'read',
        optional: true,
        reason:
          'Optional usage data dashboard — partner may use Mixpanel / Amplitude instead.',
      },
    ],
    notes:
      'Cookie sync covers Salesforce + Looker; Slack is OAuthed during onboarding.',
  },
  checkModules: [
    {
      name: 'record_count_changed',
      params: {
        // TODO: tune with design partner data — Salesforce report URL
        // for "Upcoming Renewals — 90d" filtered to At Risk.
        url: 'https://TODO_REPORT_URL',
        selector: '.report-record-count',
        expectChange: 'increase',
      },
    },
    {
      name: 'slack_message_posted',
      params: {
        // TODO: tune with design partner data — partner's actual CS channel id.
        channel: 'C_CS_TODO',
        contains: 'renewal',
      },
    },
  ],
  prompt: [
    'You are running the weekly renewal risk sweep. Identify accounts whose contract renews in the next 90 days and surface ones showing risk signals so CSMs can intervene.',
    '',
    'Step 1. Open the Salesforce report listing accounts with a renewal date in the next 90 days.',
    '  URL: https://login.salesforce.com  (then go to Reports → "Upcoming Renewals — 90d")',
    '  // TODO: tune with design partner data — replace with the partner\'s actual report URL once known.',
    '',
    'Step 2. For each account in the report (cap at 25 to keep the run bounded), gather:',
    '  - Account name, ARR, renewal date, owner (CSM).',
    '  - Last activity date on the account record (note + email + meeting).',
    '  - Open support tickets count and their priority breakdown if visible.',
    '',
    'Step 3. Visit the usage dashboard (Looker if configured, otherwise skip this step).',
    '  URL: https://looker.<partner-domain>',
    '  // TODO: tune with design partner data — replace with the partner\'s actual usage dashboard. Some partners use Mixpanel or Amplitude here; consult onboarding notes.',
    '',
    'Step 4. Mark an account "at risk" if ANY of the following are true:',
    '  - No-touch (no logged activity) in 30+ days.',
    '  - 30%+ drop in monthly active users vs the trailing 90-day average.',
    '  - Two or more open high-priority support tickets.',
    '  // TODO: tune with design partner data — partner may have a more or less aggressive risk definition.',
    '',
    'Step 5. For each at-risk account, open the Salesforce account record and set the "Health" picklist field to "At Risk". Save and confirm the save persisted by re-loading the record.',
    '',
    'Step 6. Compose a Slack digest of the form:',
    '  *Renewal Risk — week of <date>*',
    '  N accounts flagged at-risk this week.',
    '  • <Account A> — $ARR, renews <date>, signal: <reason>',
    '  • <Account B> — …',
    '  Owners: <@CSM-handle>',
    '',
    'Step 7. Post the digest to the configured CS channel.',
    '  Channel: #customer-success',
    '  // TODO: tune with design partner data — replace with the partner\'s actual channel id.',
    '',
    'When done, summarize how many accounts you flagged and to which channel you posted.',
  ].join('\n'),
}

export default renewalRiskMonitor
