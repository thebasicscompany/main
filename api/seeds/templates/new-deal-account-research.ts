/**
 * New-Deal Account Research — Phase 11 launch template #2.
 *
 * Wedge: when a new opportunity is created, gather public-facing context
 * about the prospect company so the AE walks into the first call already
 * knowing the lay of the land. Saves 30–45 minutes of pre-call research.
 *
 * Trigger: USER-TRIGGERED (no schedule). The desktop "Run agent now"
 * action passes the new opportunity id. v1 doesn't yet have CRM-event
 * triggers; Phase 12+ will add them. Until then, the AE clicks Run after
 * an opp lands.
 *
 * Outcome verification:
 *  - `crm_field_equals` (Phase 09 stub today) — confirms the research
 *    summary was written back onto the opportunity record's notes field.
 *  - `url_contains` — sanity-check the company's public homepage is
 *    reachable, i.e. the prospect domain is real.
 *
 * Partner customization:
 *  - The opportunity record id is passed in at run-time, but the prompt
 *    references a placeholder URL pattern that needs the partner's
 *    Salesforce instance subdomain.
 *  - Some partners want LinkedIn People searches; others want Crunchbase
 *    funding history. Mark which sources to query per partner.
 */

import type { WorkflowTemplate } from './types.js'

export const newDealAccountResearch: WorkflowTemplate = {
  name: 'New-Deal Account Research',
  schedule: null,
  enabled: true,
  requiredCredentials: {
    providers: [
      {
        provider: 'salesforce',
        scope: 'read_write',
        reason:
          'Read the opportunity record + write the research summary back to the Notes / Description field.',
      },
      {
        provider: 'linkedin',
        scope: 'read',
        optional: true,
        reason:
          'Optional: pull a recent activity snapshot for the opportunity\'s primary contact.',
      },
    ],
    notes:
      'Salesforce cookie sync via Lens; LinkedIn is opt-in per partner during onboarding.',
  },
  checkModules: [
    {
      name: 'crm_field_equals',
      params: {
        // TODO: tune with design partner data — partner's My Domain
        // Lightning URL pattern (e.g. https://acme.lightning.force.com/...).
        url: 'https://TODO_LIGHTNING_URL',
        selector: '[data-aura-class="forceOutputTextAreaPlainText"]',
        expected: 'TODO_partner_value',
      },
    },
    {
      name: 'url_contains',
      params: {
        // The prospect's homepage — sanity check the company domain
        // resolves and renders. Tune per opportunity / partner.
        url: 'https://example.com',
        contains: 'Example',
      },
    },
  ],
  prompt: [
    'You are doing pre-call research on a newly created opportunity. The goal is a tight, factual brief written back into the opportunity\'s Description field so the AE has context before their first call.',
    '',
    'Step 1. Open the opportunity in Salesforce.',
    '  URL pattern: https://login.salesforce.com/<opportunity_id>',
    '  // TODO: tune with design partner data — replace with the partner\'s My Domain Salesforce URL pattern (e.g. https://acme.lightning.force.com/lightning/r/Opportunity/<id>/view).',
    '',
    'Step 2. Read the opportunity record to capture:',
    '  - Account / company name.',
    '  - Primary contact name, title, email if visible.',
    '  - Opportunity amount, stage, expected close date.',
    '  - Any existing notes the SDR or AE already wrote.',
    '',
    'Step 3. Visit the company\'s public homepage.',
    '  URL: https://<company-domain>',
    '  Extract: tagline, product category, any pricing-page evidence of size (per-seat vs enterprise vs custom).',
    '',
    'Step 4. Search for the company on LinkedIn (if LinkedIn credential is configured) and capture:',
    '  - Headcount range.',
    '  - Recent posts within the last 30 days (titles + dates).',
    '  // TODO: tune with design partner data — drop this step entirely if partner declined the LinkedIn integration.',
    '',
    'Step 5. Compose a brief of the form:',
    '  *Account brief — <company name>*',
    '  • What they do: <one sentence>',
    '  • Size signals: <headcount, pricing tier, fundraising>',
    '  • Recent moves: <recent posts, news, hiring>',
    '  • Suggested talking points: <2–3 bullets the AE can lead with>',
    '',
    'Step 6. Write the brief back to the opportunity\'s Description field in Salesforce. Save the record. Confirm the save succeeded by re-loading the record and verifying the Description shows your brief.',
    '',
    'When done, summarize what you wrote in one line for the audit log.',
  ].join('\n'),
}

export default newDealAccountResearch
