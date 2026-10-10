// Onward — one-shot seed script for GoalTypeTemplate.
//
// Inserts the five supported goal types and their commonly-required items.
// Idempotent per goal type: deletes existing rows for the five types below,
// then re-inserts. Does not touch Goal / Requirement / Event / RiskAssessment.
//
// Run once with:  node src/seed.js
//
// Each item has a `priority`:
//   'essential' — always surface this on goal creation if missing
//   'helpful'   — surface context-dependently (deadline, phrasing, etc.)

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
      // Essential — no viable application without these
      { label: 'Official transcripts',      kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: false, priority: 'essential' },
      { label: 'Recommendation letter(s)',  kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: false, priority: 'essential' },
      { label: 'Test scores (GRE/TOEFL/IELTS) sent to institution', kind: 'external_dependency', typical_turnaround_days: 7, is_commonly_missed: true, priority: 'essential' },

      // Helpful — matter for some versions, depend on context
      { label: 'Statement of purpose / personal statement', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'CV / resume',                                kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Application form submitted',                 kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Financial documents / proof of funds',       kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'Application fee paid',                       kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
    ],
  },

  // -------------------------------------------------------------------------
  // 2. Visa / permit application
  // -------------------------------------------------------------------------
  {
    goal_type: 'visa_permit_application',
    items: [
      // Essential
      { label: 'Passport (valid, with sufficient validity)', kind: 'external_dependency', typical_turnaround_days: 30, is_commonly_missed: false, priority: 'essential' },
      { label: 'Police clearance certificate',               kind: 'external_dependency', typical_turnaround_days: 21, is_commonly_missed: true,  priority: 'essential' },
      { label: 'Birth certificate (certified copy)',         kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: true,  priority: 'essential' },

      // Helpful
      { label: 'Medical examination report',                 kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'Visa application form submitted',            kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Passport-sized photographs',                 kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Proof of accommodation',                     kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'Proof of funds / bank statements',           kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'Visa fee paid',                              kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
    ],
  },

  // -------------------------------------------------------------------------
  // 3. Job application with references
  // -------------------------------------------------------------------------
  {
    goal_type: 'job_application_with_references',
    items: [
      // Essential
      { label: 'Tailored CV / resume',                 kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'essential' },
      { label: 'Reference(s) confirmed and submitted', kind: 'external_dependency', typical_turnaround_days: 7, is_commonly_missed: false, priority: 'essential' },

      // Helpful
      { label: 'Cover letter',                         kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Application form submitted',           kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Portfolio / work samples',             kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'References contacted and warned',      kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
    ],
  },

  // -------------------------------------------------------------------------
  // 4. Grant application
  // -------------------------------------------------------------------------
  {
    goal_type: 'grant_application',
    items: [
      // Essential
      { label: 'Project proposal / narrative',                  kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'essential' },
      { label: 'Letters of support from partner organizations', kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: true,  priority: 'essential' },
      { label: 'Institutional sign-off / authorized signature', kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: true,  priority: 'essential' },

      // Helpful
      { label: 'Reference letters',                             kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Detailed budget and justification',             kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Application form submitted',                    kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Organizational documents (registration, tax status)', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'Letters of intent / pre-proposal (if required)', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true,  priority: 'helpful' },
    ],
  },

  // -------------------------------------------------------------------------
  // 5. Signed-form return
  // -------------------------------------------------------------------------
  {
    goal_type: 'signed_form_return',
    items: [
      // Essential
      { label: 'Signed form returned by signatory', kind: 'external_dependency', typical_turnaround_days: 5, is_commonly_missed: false, priority: 'essential' },
      { label: 'Form filled out and prepared for signature', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'essential' },

      // Helpful
      { label: 'Countersignature (if required)',    kind: 'external_dependency', typical_turnaround_days: 5, is_commonly_missed: true,  priority: 'helpful' },
      { label: 'Form sent to signatory',            kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
      { label: 'Signed copy submitted to final recipient', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false, priority: 'helpful' },
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
      priority: item.priority,
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
    const essential = t.items.filter((i) => i.priority === 'essential').length;
    const missed = t.items.filter((i) => i.is_commonly_missed).length;
    console.log(
      `[seed]   ${t.goal_type}: ${t.items.length} items (${essential} essential, ${missed} commonly-missed)`
    );
  }
}

main().catch((err) => {
  console.error('[seed] Unexpected error:', err);
  process.exit(1);
});