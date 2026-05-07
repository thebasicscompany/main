/**
 * CRM Hygiene — Phase 11 launch template #4.
 *
 * Wedge: weekly pass over the CRM looking for missing or stale required
 * fields (next-step, close date, amount, primary contact) on opportunities
 * that the sales team is supposed to keep current. Replaces the "Sunday
 * pre-forecast cleanup nag" that ops teams send manually.
 *
 * Outcome verification:
 *  - `record_count_changed` (Phase 09 stub today) — asserts that a
 *    measurable count of stale records were touched (either auto-fixed
 *    where safe, or flagged for the owner).
 *  - `slack_message_posted` — the per-rep nag DM went out.
 *
 * Schedule: Friday 18:00 UTC (≈ 2pm ET / 11am PT). End-of-week so reps
 * can clean up before EOD; gives ops a clean snapshot for Monday's
 * pipeline review.
 *
 * Partner customization:
 *  - Which fields are "required" varies by partner. v1 prompt assumes
 *    the canonical four (next step, close date, amount, primary contact)
 *    — tune the list per partner.
 *  - Stale threshold (e.g. "no update in 14 days") is partner-tunable.
 *  - Some partners want auto-fix for safe cases (e.g. set next step to
 *    "Schedule next call" when blank); others want flag-only.
 */

import type { WorkflowTemplate } from './types.js'

export const crmHygiene: WorkflowTemplate = {
  name: 'CRM Hygiene Sweep',
  schedule: 'cron(0 18 ? * FRI *)',
  enabled: true,
  requiredCredentials: {
    providers: [
      {
        provider: 'salesforce',
        scope: 'read_write',
        reason:
          'Read open opportunities + flag stale ones via a hygiene tag / chatter post on the record.',
      },
      {
        provider: 'slack',
        scope: 'write',
        reason: 'DM each rep their personal cleanup checklist.',
      },
    ],
    notes:
      'Cookie sync covers Salesforce. Slack DMs require the bot to have im:write — confirm during onboarding.',
  },
  checkModules: [
    {
      name: 'record_count_changed',
      params: {
        // TODO: tune with design partner data — Salesforce report URL
        // for "Open Opportunities — All Reps" filtered to violators.
        url: 'https://TODO_REPORT_URL',
        selector: '.report-record-count',
        expectChange: 'any',
      },
    },
    {
      name: 'slack_message_posted',
      params: {
        // TODO: tune with design partner data — partner's #revops or
        // hygiene channel id.
        channel: 'C_REVOPS_TODO',
        contains: 'CRM hygiene',
      },
    },
  ],
  prompt: [
    'You are running the weekly CRM hygiene sweep. Goal: every open opportunity has the required fields filled in and was updated in the last 14 days; flag the ones that don\'t and DM their owner.',
    '',
    'Step 1. Open the Salesforce report listing all open opportunities (Stage != Closed Won/Lost).',
    '  URL: https://login.salesforce.com  (then go to Reports → "Open Opportunities — All Reps")',
    '  // TODO: tune with design partner data — replace with the partner\'s actual report URL.',
    '',
    'Step 2. For each opportunity (cap at 100 to keep the run bounded), check that the following required fields are non-empty AND the record was updated in the last 14 days:',
    '  - Next Step',
    '  - Close Date',
    '  - Amount',
    '  - Primary Contact',
    '  // TODO: tune with design partner data — required-fields list and 14-day staleness threshold are partner-tunable.',
    '',
    'Step 3. For each violating opportunity, open the record and post a Chatter note tagging the owner with what\'s missing. Save and verify the post landed by re-loading the record.',
    '',
    'Step 4. Group the violations by opportunity owner. For each owner with 1+ violations, compose a private Slack DM of the form:',
    '  Hi <@owner> — your weekly hygiene check has N opps that need attention before Monday:',
    '  • <Opp Name> — missing: <fields>, last update: <date>',
    '  • …',
    '  Direct link: <Salesforce report URL filtered to that owner>',
    '',
    'Step 5. Send the DM to each owner.',
    '  // TODO: tune with design partner data — partner may want one channel post (e.g. #revops-hygiene) instead of per-rep DMs.',
    '',
    'Step 6. After all DMs are sent, post a summary into the ops channel:',
    '  *CRM hygiene — week of <date>*',
    '  • Opps flagged: N',
    '  • Reps notified: M',
    '  • Top offender (rep with most flags): <name> with K opps.',
    '  Channel: #revops',
    '  // TODO: tune with design partner data — replace channel.',
    '',
    'When done, summarize how many opps you flagged and to how many reps you DM\'d.',
  ].join('\n'),
}

export default crmHygiene
