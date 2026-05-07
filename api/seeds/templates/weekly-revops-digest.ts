/**
 * Weekly RevOps Digest — Phase 11 launch template #1.
 *
 * Wedge: every Monday morning, surface last week's CRM activity into a
 * digest the RevOps lead can paste into their team channel. Replaces the
 * "open Salesforce, open Looker, screenshot, paste, repeat" Monday ritual.
 *
 * Outcome verification (when checks ship for real):
 *  - `slack_message_posted` confirms the digest landed in the target
 *    channel for this run window.
 *  - `url_contains` is a fallback "did the public Salesforce report load"
 *    sanity check that works without partner credentials.
 *
 * Partner customization:
 *  - Slack channel id (e.g. `#revops`) replaces the placeholder in the
 *    prompt + the `slack_message_posted` params (added in Phase 10.5+).
 *  - The Salesforce report URL replaces the placeholder. Per-partner
 *    reports differ; tune during onboarding.
 *  - Company-specific KPIs (pipeline thresholds, risk flags) get baked
 *    into the prompt section labelled `// TODO: tune ...`.
 *
 * Schedule: every Monday at 13:00 UTC (≈ 9am ET / 6am PT). EventBridge
 * cron syntax is `cron(min hour day-of-month month day-of-week year)`,
 * with `?` mandatory in either day-of-month or day-of-week.
 */

import type { WorkflowTemplate } from './types.js'

export const weeklyRevopsDigest: WorkflowTemplate = {
  name: 'Weekly RevOps Digest',
  schedule: 'cron(0 13 ? * MON *)',
  enabled: true,
  requiredCredentials: {
    providers: [
      {
        provider: 'salesforce',
        scope: 'read',
        reason:
          'Read pipeline reports + opportunity activity for the digest window.',
      },
      {
        provider: 'slack',
        scope: 'write',
        reason: 'Post the digest into the configured RevOps channel.',
      },
    ],
    notes:
      'Cookie sync from Lens covers Salesforce; Slack is OAuthed separately during onboarding.',
  },
  checkModules: [
    {
      name: 'url_contains',
      params: {
        url: 'https://salesforce.com',
        contains: 'Salesforce',
      },
    },
    {
      name: 'slack_message_posted',
      params: {
        // TODO: tune with design partner data — replace with the partner's
        // actual RevOps channel id (e.g. C01ABCDE23).
        channel: 'C_REVOPS_TODO',
        contains: 'Weekly RevOps Digest',
      },
    },
  ],
  prompt: [
    'You are generating the weekly RevOps digest. Today is the start of a new week and the team needs a short status post in Slack covering pipeline movement over the last 7 days.',
    '',
    'Step 1. Navigate to the Salesforce pipeline report.',
    '  URL: https://login.salesforce.com  (then go to Reports → "Weekly Pipeline Movement")',
    '  // TODO: tune with design partner data — replace this with the partner-specific report URL once known.',
    '',
    'Step 2. Extract the following from the report view:',
    '  - Total open pipeline ($ amount + opportunity count).',
    '  - New opportunities created in the last 7 days (count + total $).',
    '  - Opportunities that moved stage in the last 7 days (count, with stage transitions).',
    '  - Opportunities marked Closed Won and Closed Lost in the last 7 days.',
    '  - The three largest open opportunities by $ amount (name, amount, owner, stage).',
    '  // TODO: tune with design partner data — partner may want different KPIs (e.g. logo retention, lead velocity).',
    '',
    'Step 3. Compose a Slack message of the form:',
    '  *Weekly RevOps Digest — <date range>*',
    '  • Open pipeline: $X across Y opps',
    '  • New this week: Z opps ($A)',
    '  • Closed Won: …',
    '  • Closed Lost: …',
    '  • Top 3 open opps: …',
    '',
    'Step 4. Post that message to the configured RevOps Slack channel.',
    '  Channel: #revops',
    '  // TODO: tune with design partner data — replace with the partner\'s actual channel id (e.g. C01ABCDE23).',
    '',
    'Step 5. Confirm the message was posted by re-loading the channel and verifying the most recent message author and timestamp match what you just posted.',
    '',
    'When done, write a one-line summary of the digest you posted (the same first line as the Slack message is fine).',
  ].join('\n'),
}

export default weeklyRevopsDigest
