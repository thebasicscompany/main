/**
 * Quarterly Board Metrics — Phase 11 launch template #5.
 *
 * Wedge: at the end of every quarter, pull pipeline + ARR + retention
 * metrics into a board-ready summary doc. Replaces the founder's "spend
 * the weekend before the board meeting in Looker" ritual.
 *
 * Outcome verification:
 *  - `url_contains` — fetch the published Looker / Notion summary URL
 *    and assert the quarter label appears in the rendered doc.
 *  - `slack_message_posted` — the link to the summary went out to the
 *    #board channel for the founder to review before the meeting.
 *
 * Schedule: 9 AM UTC on the 1st of Jan / Apr / Jul / Oct (one day after
 * quarter-end so the data has settled). EventBridge cron does support
 * comma lists in the month field.
 *
 * Partner customization:
 *  - The destination is partner-specific: some founders want a Notion
 *    page, some want a Google Doc, some want a Looker board. v1 prompt
 *    targets Looker by default; tune per partner.
 *  - Which metrics matter (ARR, NRR, GRR, payback, magic number, burn
 *    multiple) varies by stage. v1 covers the standard SaaS set; tune.
 */

import type { WorkflowTemplate } from './types.js'

export const quarterlyBoardMetrics: WorkflowTemplate = {
  name: 'Quarterly Board Metrics',
  schedule: 'cron(0 9 1 1,4,7,10 ? *)',
  enabled: true,
  requiredCredentials: {
    providers: [
      {
        provider: 'salesforce',
        scope: 'read',
        reason: 'Pull pipeline + ARR data for the quarter.',
      },
      {
        provider: 'looker',
        scope: 'read_write',
        reason:
          'Read the metrics dashboards + write a "Q<n> <year>" summary board.',
      },
      {
        provider: 'slack',
        scope: 'write',
        reason: 'Post the summary link to the #board channel.',
      },
    ],
    notes:
      'Some partners use Notion or Google Docs instead of Looker for the destination doc — confirm during onboarding.',
  },
  checkModules: [
    {
      name: 'url_contains',
      params: {
        // TODO: tune with design partner data — published Looker / Notion /
        // Google Doc URL where the quarter summary lives. The check
        // asserts the quarter label appears on the rendered doc.
        url: 'https://TODO_BOARD_DOC_URL',
        contains: 'Q',
      },
    },
    {
      name: 'slack_message_posted',
      params: {
        // TODO: tune with design partner data — partner's #board channel id.
        channel: 'C_BOARD_TODO',
        contains: 'board metrics',
      },
    },
  ],
  prompt: [
    'You are compiling end-of-quarter metrics into a board-ready summary. Today is the first day of a new quarter; the previous quarter\'s data is what you\'re reporting on.',
    '',
    'Step 1. Determine the quarter label you\'re reporting on (e.g. "Q3 2025"). Use the previous calendar quarter — if today is 2025-10-01 the quarter you report on is Q3 2025.',
    '',
    'Step 2. Open the Salesforce ARR snapshot report.',
    '  URL: https://login.salesforce.com  (then go to Reports → "ARR Snapshot — End of Quarter")',
    '  // TODO: tune with design partner data — partner-specific report URL.',
    '',
    'Step 3. Capture the following from the ARR snapshot:',
    '  - Ending ARR.',
    '  - New ARR added during the quarter.',
    '  - Churned ARR during the quarter.',
    '  - Expansion ARR during the quarter.',
    '  - Net Revenue Retention (NRR) — quarter-over-quarter.',
    '  - Gross Revenue Retention (GRR) — quarter-over-quarter.',
    '  // TODO: tune with design partner data — some partners track CAC payback / magic number / burn multiple.',
    '',
    'Step 4. Open the pipeline coverage dashboard in Looker.',
    '  URL: https://looker.<partner-domain>/dashboards/pipeline-coverage',
    '  // TODO: tune with design partner data — partner-specific Looker URL.',
    '  Capture: pipeline coverage ratio (open pipeline ÷ next-quarter target).',
    '',
    'Step 5. Compose a summary in a new Looker board / Notion page / Google Doc (use the partner-specified destination):',
    '  *Board Metrics — Q<n> <year>*',
    '  Highlights:',
    '  • Ending ARR: $X (vs $Y last quarter, +Z%)',
    '  • Net New ARR: $A (new $B + expansion $C – churn $D)',
    '  • NRR: N% / GRR: G%',
    '  • Pipeline coverage entering Q<n+1>: R×',
    '  Risks / watch-items:',
    '  • <pull from your reading>',
    '  Wins:',
    '  • <largest closed-won deals + notable expansions>',
    '',
    'Step 6. Save and publish the doc. Capture the public-share URL.',
    '',
    'Step 7. Post the URL into the board Slack channel:',
    '  *Q<n> <year> board metrics — <link>*',
    '  Founder review requested before <board-meeting date>.',
    '  Channel: #board',
    '  // TODO: tune with design partner data — replace with the partner\'s actual board channel id.',
    '',
    'When done, summarize what doc you created and where you posted the link.',
  ].join('\n'),
}

export default quarterlyBoardMetrics
