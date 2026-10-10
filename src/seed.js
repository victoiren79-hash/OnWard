// Onward — one-shot seed script for GoalTypeTemplate.
//
// Inserts the five supported goal types and their commonly-required items.
// Idempotent per goal type: deletes existing rows for the five types below,
// then re-inserts. Does not touch Goal / Requirement / Event / RiskAssessment.
//
// Run once with:  node src/seed.js

import 'dotenv/config';
import { supabase } from './db.js';

// ---------------------------------------------------------------------------
// The five goal types. Keep these keys stable — services will match on them.
// ---------------------------------------------------------------------------

const TEMPLATES = [
  // -------------------------------------------------------------------------
  // 1. Grad / scholarship application
  // -------------------------------------------------------------------------
  {
    goal_type: 'grad_scholarship_application',
    items: [
      // External dependencies
      { label: 'Recommendation letter(s)', kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: false },
      { label: 'Official transcripts',      kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: false },
      { label: 'Test scores (GRE/TOEFL/IELTS) sent to institution', kind: 'external_dependency', typical_turnaround_days: 7, is_commonly_missed: true },
      // Self actions
      { label: 'Statement of purpose / personal statement', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'CV / resume',                                kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Application form submitted',                 kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Financial documents / proof of funds',       kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
      { label: 'Application fee paid',                       kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
    ],
  },

  // -------------------------------------------------------------------------
  // 2. Visa / permit application
  // -------------------------------------------------------------------------
  {
    goal_type: 'visa_permit_application',
    items: [
      // External dependencies
      { label: 'Passport (valid, with sufficient validity)', kind: 'external_dependency', typical_turnaround_days: 30, is_commonly_missed: false },
      { label: 'Police clearance certificate',               kind: 'external_dependency', typical_turnaround_days: 21, is_commonly_missed: true },
      { label: 'Medical examination report',                 kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: true },
      { label: 'Birth certificate (certified copy)',         kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: true },
      // Self actions
      { label: 'Visa application form submitted',            kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Passport-sized photographs',                 kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Proof of accommodation',                     kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
      { label: 'Proof of funds / bank statements',           kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
      { label: 'Visa fee paid',                              kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
    ],
  },

  // -------------------------------------------------------------------------
  // 3. Job application with references
  // -------------------------------------------------------------------------
  {
    goal_type: 'job_application_with_references',
    items: [
      // External dependencies
      { label: 'Reference(s) confirmed and submitted', kind: 'external_dependency', typical_turnaround_days: 7, is_commonly_missed: false },
      // Self actions
      { label: 'Tailored CV / resume',                 kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Cover letter',                         kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Application form submitted',           kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Portfolio / work samples',             kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
      { label: 'References contacted and warned',      kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
    ],
  },

  // -------------------------------------------------------------------------
  // 4. Grant application
  // -------------------------------------------------------------------------
  {
    goal_type: 'grant_application',
    items: [
      // External dependencies
      { label: 'Letters of support from partner organizations', kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: true },
      { label: 'Institutional sign-off / authorized signature', kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: true },
      { label: 'Reference letters',                             kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: false },
      // Self actions
      { label: 'Project proposal / narrative',                  kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Detailed budget and justification',             kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Application form submitted',                    kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Organizational documents (registration, tax status)', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
      { label: 'Letters of intent / pre-proposal (if required)', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
    ],
  },

  // -------------------------------------------------------------------------
  // 5. Signed-form return
  // -------------------------------------------------------------------------
  {
    goal_type: 'signed_form_return',
    items: [
      // External dependencies
      { label: 'Signed form returned by signatory', kind: 'external_dependency', typical_turnaround_days: 5, is_commonly_missed: false },
      { label: 'Countersignature (if required)',    kind: 'external_dependency', typical_turnaround_days: 5, is_commonly_missed: true },
      // Self actions
      { label: 'Form filled out and prepared for signature', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Form sent to signatory',                     kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
      { label: 'Signed copy submitted to final recipient',   kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
    ],
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  const goalTypes = TEMPLATES.map((t) => t.goal_type);
  console.log(`[seed] Seeding ${TEMPLATES.length} goal types: ${goalTypes.join(', ')}`);

  // Idempotent: clear existing rows for these goal types only.
  const { error: delError } = await supabase
    .from('GoalTypeTemplate')
    .delete()
    .in('goal_type', goalTypes);

  if (delError) {
    console.error('[seed] Failed to clear existing rows:', delError.message);
    process.exit(1);
  }

  // Flatten into individual rows.
  const rows = TEMPLATES.flatMap((t) =>
    t.items.map((item) => ({
      goal_type: t.goal_type,
      label: item.label,
      kind: item.kind,
      typical_turnaround_days: item.typical_turnaround_days,
      is_commonly_missed: item.is_commonly_missed,
    }))
  );

  console.log(`[seed] Inserting ${rows.length} rows...`);

  const { data, error: insError } = await supabase
    .from('GoalTypeTemplate')
    .insert(rows)
    .select('id');

  if (insError) {
    console.error('[seed] Insert failed:', insError.message);
    process.exit(1);
  }

  console.log(`[seed] Done. Inserted ${data.length} rows.`);

  // Summary per goal type.
  for (const t of TEMPLATES) {
    const missed = t.items.filter((i) => i.is_commonly_missed).length;
    console.log(
      `[seed]   ${t.goal_type}: ${t.items.length} items (${missed} commonly-missed)`
    );
  }
}

main().catch((err) => {
  console.error('[seed] Unexpected error:', err);
  process.exit(1);
});