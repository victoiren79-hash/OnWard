// Onward — LLM-based extraction.
//
// Two public functions:
//
//   extractGoal(text)   — parse a casual message into a goal draft, or null
//                         if the message isn't a goal statement.
//
//   extractItems(text)  — extract a list of item names the user says they
//                         need, to add to an existing goal. Returns null if
//                         the message has no items to extract.
//
// This module calls the LLM. It does NOT write to the database, does NOT
// run the completeness check, and does NOT compute risk. Its only job is:
// text in → structured object or null out.

import { callLLM } from '../llm.js';

// ---------------------------------------------------------------------------
// Canonical goal types — must match GoalTypeTemplate.goal_type in the DB.
// ---------------------------------------------------------------------------

export const KNOWN_GOAL_TYPES = Object.freeze([
  'grad_scholarship_application',
  'visa_permit_application',
  'job_application_with_references',
  'grant_application',
  'signed_form_return',
  'school_enrollment',
  'camp_registration',
  'doctor_appointment_paperwork',
  'lease_signing',
  'tax_filing',
]);

export const REQUIREMENT_STATUSES = Object.freeze(['not_started', 'done']);

// ---------------------------------------------------------------------------
// Deterministic goal-type detection.
//
// The LLM is unreliable about setting goal_type. When it returns null but
// the message clearly contains a signal, we set the type ourselves. This
// runs AFTER the LLM has produced a draft, and only fills in a null. It
// never overrides a type the LLM set.
// ---------------------------------------------------------------------------

const GOAL_TYPE_SIGNALS = [
  {
    type: 'grad_scholarship_application',
    patterns: [
      /\bgrad\s+school\b/i,
      /\bgrad\s+application\b/i,
      /\bgrad\s+program\b/i,
      /\buniversity\b/i,
      /\bcollege\b/i,
      /\bmaster'?s\b/i,
      /\bph\.?d\b/i,
      /\bdoctoral\b/i,
      /\bscholarship\b/i,
      /\bfellowship\b/i,
      /\badmission(s)?\b/i,
      /\bapply\s+to\s+(a\s+)?(school|university|college|program)\b/i,
      /\b(MIT|Stanford|Harvard|Oxford|Cambridge|Yale|Princeton|Columbia|Berkeley|Caltech)\b/i,
    ],
  },
  {
    type: 'visa_permit_application',
    patterns: [
      /\bvisa\b/i,
      /\bresidence\s+permit\b/i,
      /\bwork\s+permit\b/i,
      /\btravel\s+document\b/i,
      /\bimmigration\b/i,
      /\bembassy\b/i,
      /\bconsulate\b/i,
    ],
  },
  {
    type: 'job_application_with_references',
    patterns: [
      /\bjob\s+application\b/i,
      /\bapply\s+for\s+(a\s+)?(job|position|role|internship)\b/i,
      /\binternship\b/i,
      /\bhiring\b/i,
      /\binterview\b/i,
    ],
  },
  {
    type: 'grant_application',
    patterns: [
      /\bgrant\b/i,
      /\bfunding\s+application\b/i,
      /\bRFP\b/i,
      /\brequest\s+for\s+proposals?\b/i,
      /\bproposal\s+to\b/i,
    ],
  },
  {
    type: 'signed_form_return',
    patterns: [
      /\bsigned\s+form\b/i,
      /\bget\s+(it|the\s+form|a\s+form)\s+signed\b/i,
      /\bcountersign/i,
      /\breturn\s+the\s+form\b/i,
      /\bsignature\s+from\b/i,
    ],
  },
  {
    type: 'school_enrollment',
    patterns: [
      /\benroll\b/i,
      /\benrollment\b/i,
      /\benrolling\b/i,
      /\bkindergarten\b/i,
      /\bpre-?school\b/i,
      /\bpre-?k\b/i,
      /\belementary\s+school\b/i,
      /\bregister\s+(my|our)\s+(kid|child|son|daughter)\s+(in|for)\s+school\b/i,
    ],
  },
  {
    type: 'camp_registration',
    patterns: [
      /\bsummer\s+camp\b/i,
      /\bcamp\s+registration\b/i,
      /\bregister\s+(my|our)\s+(kid|child|son|daughter)\s+for\s+(a\s+)?camp\b/i,
      /\bsign\s+(my|our)\s+(kid|child|son|daughter)\s+up\s+for\s+camp\b/i,
      /\bafter-?school\s+program\b/i,
    ],
  },
  {
    type: 'doctor_appointment_paperwork',
    patterns: [
      /\bdoctor'?s?\s+appointment\b/i,
      /\bspecialist\b/i,
      /\bsurgery\b/i,
      /\bmedical\s+procedure\b/i,
      /\bmedical\s+appointment\b/i,
      /\bprior\s+authorization\b/i,
      /\breferral\s+from\b/i,
    ],
  },
  {
    type: 'lease_signing',
    patterns: [
      /\blease\s+agreement\b/i,
      /\bsign\s+(a\s+)?(new\s+)?lease\b/i,
      /\brenew\s+(my\s+|the\s+)?lease\b/i,
      /\brent(al)?\s+agreement\b/i,
      /\bmove\s+(into|in\s+to)\s+(an?\s+)?(apartment|house)\b/i,
    ],
  },
  {
    type: 'tax_filing',
    patterns: [
      /\bfile\s+(my\s+|our\s+)?tax(es)?\b/i,
      /\btax\s+return\b/i,
      /\bW-?2\b/i,
      /\b1099\b/i,
      /\bIRS\b/i,
    ],
  },
];

/**
 * Look at a user message and return the strongest matching goal_type, or
 * null if none match. Deterministic. Used as a fallback when the LLM
 * returns goal_type: null but the message clearly has a signal.
 */
export function detectGoalType(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const hits = [];
  for (const entry of GOAL_TYPE_SIGNALS) {
    let score = 0;
    for (const re of entry.patterns) {
      if (re.test(text)) score += 1;
    }
    if (score > 0) hits.push({ type: entry.type, score });
  }

  if (hits.length === 0) return null;
  hits.sort((a, b) => b.score - a.score);
  return hits[0].type;
}

// ---------------------------------------------------------------------------
// System prompt — goal extraction
// ---------------------------------------------------------------------------

const GOAL_PROMPT = `
You extract structured goal information from a user's casual message.

Return a JSON object with this exact shape:
{
  "is_goal": boolean,
  "title": string,                        // short human title, e.g. "Grad application to MIT"
  "deadline": string,                     // "YYYY-MM-DD", or null if no date is mentioned
  "goal_type": string | null,             // one of the KNOWN GOAL TYPES below
  "requirements": [
    {
      "label": string,                    // short noun phrase, e.g. "Recommendation letter"
      "kind": "self_action" | "external_dependency",
      "status": "not_started" | "done"
    }
  ]
}

KNOWN GOAL TYPES (use the exact string):
- grad_scholarship_application    — university / grad school / scholarship applications
- visa_permit_application         — visas, residence permits, work permits, travel permits
- job_application_with_references — applying for a job, an internship, a position at a company
- grant_application               — grant or funding applications (typically institutional)
- signed_form_return              — getting a form signed and returned by someone
- school_enrollment               — enrolling a child in a school, kindergarten, or pre-school
- camp_registration               — registering a child for summer camp or an after-school program
- doctor_appointment_paperwork    — specialist visits, medical procedures, referrals, insurance paperwork
- lease_signing                   — signing or renewing a residential lease
- tax_filing                      — filing personal income taxes

RULES:
1. If the message is NOT a goal with a deadline (e.g. small talk, questions,
   self-paced goals like exercise or study, logistics like party planning),
   return {"is_goal": false} and nothing else.
2. A deadline is REQUIRED. If no date can be inferred, set "deadline" to null
   and "is_goal" to true — the system will ask the user. Do NOT invent a date.
   Resolve relative dates ("next Friday", "in two weeks") to YYYY-MM-DD using
   today's date, which will be provided in the user message.
3. "kind" is "external_dependency" ONLY if another person or institution must
   produce, sign, or return the item. Otherwise use "self_action". If unsure,
   use "self_action".
4. Extract only requirements the user actually mentions or clearly implies.
   Do NOT add "commonly needed" items — another part of the system handles that.
5. "status" is "done" ONLY if the user clearly says they already have or have
   completed the item ("I have X", "X is ready", "I got X", "X is done",
   "I already wrote X"). Otherwise "status" is "not_started". When unsure,
   default to "not_started".
6. The "label" should be a short noun phrase the user would recognize, not a
   full sentence. E.g. "Recommendation letter", not "I need to get a rec letter".
   Prefer the phrasing the user used, not a generic version.

7. GOAL TYPE MATCHING. This rule is critical. Set the goal_type whenever
   ANY of the signals below appear in the message. Do NOT wait for the
   message to be unambiguous. Do NOT default to null when a signal is
   present.

     grad_scholarship_application signals:
       "grad school", "grad application", "grad program", "university",
       "college", "master's", "PhD", "doctoral", "scholarship",
       "fellowship", "admission", "admissions", "apply to" followed by
       a school, university, college, or program, or any named
       university or program (MIT, Stanford, Harvard, Oxford,
       Cambridge, Yale, Princeton, Columbia, Berkeley, Caltech)

     visa_permit_application signals:
       "visa", "permit", "residence permit", "work permit",
       "travel document", "immigration", "embassy", "consulate"

     job_application_with_references signals:
       "job application", "position", "role", "internship", "hiring",
       "interview", "apply for a job", "apply for a position"

     grant_application signals:
       "grant", "funding application", "RFP", "request for proposals",
       "proposal to", "grant application"

     signed_form_return signals:
       "signed form", "signature", "get it signed", "countersign",
       "return the form"

     school_enrollment signals:
       "enroll", "enrollment", "enrolling", "kindergarten", "pre-school",
       "pre-K", "elementary school", "register my child for school",
       "register my kid in school", "register my son/daughter for school"

     camp_registration signals:
       "summer camp", "camp registration", "after-school program",
       "register my child for camp", "sign my kid up for camp"

     doctor_appointment_paperwork signals:
       "doctor's appointment", "specialist", "surgery", "medical procedure",
       "medical appointment", "prior authorization", "referral from"

     lease_signing signals:
       "lease agreement", "sign a lease", "renew my lease", "rental agreement",
       "move into an apartment", "move into a house"

     tax_filing signals:
       "file my taxes", "file taxes", "tax return", "W-2", "1099", "IRS"

   If TWO OR MORE signals appear, pick the one whose signal is most
   specific to the primary goal the user is describing. If NO signal
   appears, set goal_type to null.

8. Output ONLY the JSON object. No prose, no code fences, no explanation.

Examples:
- "I need to apply to a university in 3 days, I have passport copy, english
  test scores, transcripts" →
  { "is_goal": true, "title": "University application", "deadline": null,
    "goal_type": "grad_scholarship_application",
    "requirements": [
      { "label": "Passport copy", "kind": "self_action", "status": "done" },
      { "label": "English test scores", "kind": "self_action", "status": "done" },
      { "label": "Transcripts", "kind": "external_dependency", "status": "done" }
    ] }

- "I need to get a signed permission slip from my daughter's school by Friday" →
  { "is_goal": true, "title": "Permission slip from school", "deadline": "<resolved>",
    "goal_type": "signed_form_return",
    "requirements": [
      { "label": "Permission slip", "kind": "external_dependency", "status": "not_started" }
    ] }

- "I need to submit my grad school application to MIT by November 5" →
  { "is_goal": true, "title": "Grad school application to MIT",
    "deadline": "<resolved>",
    "goal_type": "grad_scholarship_application",
    "requirements": [] }

- "I need to enroll my daughter in school before November 15" →
  { "is_goal": true, "title": "School enrollment for my daughter",
    "deadline": "<resolved>",
    "goal_type": "school_enrollment",
    "requirements": [] }

- "I have to file my taxes by April 15" →
  { "is_goal": true, "title": "File taxes", "deadline": "<resolved>",
    "goal_type": "tax_filing",
    "requirements": [] }

- "what's the weather like" → { "is_goal": false }
`.trim();

// ---------------------------------------------------------------------------
// System prompt — item extraction (add to existing goal)
// ---------------------------------------------------------------------------

const ITEMS_PROMPT = `
You extract a list of items that a user says they need, still need, or
also need. The user is describing items to add to an EXISTING goal — they
are NOT creating a new goal.

Return a JSON object with this exact shape:
{
  "items": [
    {
      "label": string,
      "kind": "self_action" | "external_dependency",
      "status": "not_started" | "done"
    }
  ],
  "goal_hints": [ string ]
}

RULES:
1. Extract every item the user names. "I also need a passport copy,
   application form and transcripts" is THREE items.
2. "label" is a short noun phrase, e.g. "Passport copy", not a full
   sentence. Prefer the phrasing the user used, with one exception:
   if the user's phrasing clearly refers to an item that appears in
   a known goal type template (e.g. "rec letter" -> "Recommendation
   letter(s)", "transcripts" -> "Official transcripts"), use the
   template phrasing as the label. This lets the completeness check
   recognize the item. Do not stretch — only canonicalize when the
   correspondence is unambiguous.
3. "kind" is "external_dependency" ONLY if another person or institution
   must produce, sign, or return the item. Otherwise "self_action". If
   unsure, use "self_action".
4. "status" is "done" ONLY if the user says they already have the item.
   Otherwise "not_started".
5. "goal_hints" is an array of goal names the user mentions in the
   message. Examples:
     - "add transcripts to my scholarship application"
         → ["scholarship application"]
     - "I also need transcripts for both visa application and
        scholarship application"
         → ["visa application", "scholarship application"]
     - "I also need a police clearance"
         → []
   If they don't name a specific goal, use an empty array. Do NOT guess
   a goal name from context.
6. If the message is NOT a statement about items the user needs — e.g.
   it's a question, a status update ("I sent the letter"), a goal
   statement with a deadline ("I need to apply for X by Y"), or small
   talk — return { "items": [], "goal_hints": [] }. Do NOT extract
   items from a goal statement with a deadline; that's a different code
   path.
7. Output ONLY the JSON object. No prose, no code fences.

Examples:
- "I also need passport copy, application form filled and transcripts" →
  { "items": [
      { "label": "Passport copy", "kind": "self_action", "status": "not_started" },
      { "label": "Application form", "kind": "self_action", "status": "not_started" },
      { "label": "Transcripts", "kind": "external_dependency", "status": "not_started" }
    ], "goal_hints": [] }

- "add a recommendation letter to my scholarship application" →
  { "items": [
      { "label": "Recommendation letter", "kind": "external_dependency", "status": "not_started" }
    ], "goal_hints": ["scholarship application"] }

- "i also need transcripts for both visa application and scholarship
  application" →
  { "items": [
      { "label": "Transcripts", "kind": "external_dependency", "status": "not_started" }
    ], "goal_hints": ["visa application", "scholarship application"] }

- "I don't have any of those documents, can you add them" →
  { "items": [], "goal_hints": [] }  // this is a confirmation, not an add

- "I need to apply for a visa by November 1" →
  { "items": [], "goal_hints": [] }  // goal statement, not an item add
`.trim();

// ---------------------------------------------------------------------------
// Public API — goal extraction
// ---------------------------------------------------------------------------

export async function extractGoal(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('[onward/extraction] extractGoal: text must be a non-empty string');
  }

  const today = opts.today instanceof Date ? opts.today : new Date();
  const todayIso = toIsoDate(today);

  const userMessage = `Today is ${todayIso}.\n\nMessage:\n${text}`;

  const raw = await callLLM(GOAL_PROMPT, userMessage, { temperature: 0 });

  if (raw.is_goal === false) return null;

  const draft = validateGoalDraft(raw);

  // Deterministic goal_type backfill. If the LLM returned null but the
  // message clearly contains a signal, set the type here. Runs AFTER
  // validation so the LLM never gets to invent a bad type, and it never
  // overrides a type the LLM did set.
  if (!draft.goal_type) {
    const detected = detectGoalType(text);
    if (detected) {
      draft.goal_type = detected;
    }
  }

  return draft;
}

// ---------------------------------------------------------------------------
// Public API — item extraction
// ---------------------------------------------------------------------------

/**
 * Extract item names from a message that says the user needs them, to be
 * added to an existing goal.
 */
export async function extractItems(text) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const raw = await callLLM(ITEMS_PROMPT, text, { temperature: 0 });

  if (!raw || typeof raw !== 'object') return null;

  const items = Array.isArray(raw.items)
    ? raw.items
      .filter((it) => it && typeof it.label === 'string' && it.label.trim())
      .map((it) => ({
        label: it.label.trim(),
        kind: it.kind === 'external_dependency' ? 'external_dependency' : 'self_action',
        status: it.status === 'done' ? 'done' : 'not_started',
      }))
    : [];

  if (items.length === 0) return null;

  const goal_hints = Array.isArray(raw.goal_hints)
    ? raw.goal_hints
      .filter((h) => typeof h === 'string' && h.trim())
      .map((h) => h.trim())
    : (typeof raw.goal_hint === 'string' && raw.goal_hint.trim()
        ? [raw.goal_hint.trim()]
        : []);

  return { items, goal_hints };
}

// ---------------------------------------------------------------------------
// Validation — goal draft
// ---------------------------------------------------------------------------

export function validateGoalDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError('output is not a JSON object', raw);
  }

  if (typeof raw.title !== 'string' || !raw.title.trim()) {
    throw validationError('"title" must be a non-empty string', raw.title);
  }

  let deadline = null;
  if (raw.deadline != null) {
    if (typeof raw.deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.deadline)) {
      throw validationError('"deadline" must be "YYYY-MM-DD" or null', raw.deadline);
    }
    if (Number.isNaN(new Date(raw.deadline).getTime())) {
      throw validationError('"deadline" is not a real calendar date', raw.deadline);
    }
    deadline = raw.deadline;
  }

  let goalType = null;
  if (raw.goal_type != null) {
    if (typeof raw.goal_type !== 'string' || !KNOWN_GOAL_TYPES.includes(raw.goal_type)) {
      throw validationError(
        `"goal_type" must be one of [${KNOWN_GOAL_TYPES.join(', ')}] or null`,
        raw.goal_type
      );
    }
    goalType = raw.goal_type;
  }

  if (!Array.isArray(raw.requirements)) {
    throw validationError('"requirements" must be an array', raw.requirements);
  }
  const requirements = raw.requirements.map((r, i) => validateRequirement(r, i));

  return {
    title: raw.title.trim(),
    deadline,
    goal_type: goalType,
    requirements,
  };
}

function validateRequirement(r, index) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw validationError(`requirements[${index}] is not an object`, r);
  }
  if (typeof r.label !== 'string' || !r.label.trim()) {
    throw validationError(`requirements[${index}].label must be a non-empty string`, r.label);
  }
  if (r.kind !== 'self_action' && r.kind !== 'external_dependency') {
    throw validationError(
      `requirements[${index}].kind must be "self_action" or "external_dependency"`,
      r.kind
    );
  }

  const status = REQUIREMENT_STATUSES.includes(r.status) ? r.status : 'not_started';

  return { label: r.label.trim(), kind: r.kind, status };
}

function validationError(what, got) {
  const err = new Error(
    `[onward/extraction] Invalid LLM output: ${what}. Got: ${JSON.stringify(got)}`
  );
  err.code = 'EXTRACTION_INVALID';
  return err;
}

// ---------------------------------------------------------------------------
// Deadline reply resolver
// ---------------------------------------------------------------------------

export async function resolveDeadlineReply(text, partialGoal, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const today = opts.today instanceof Date ? opts.today : new Date();
  const todayIso = toIsoDate(today);
  const goalTitle = partialGoal?.title ?? 'their goal';
  const goalType = partialGoal?.goal_type ?? 'unknown';

  const systemPrompt = `
The user was just asked for the deadline of a goal called "${goalTitle}"
(type: ${goalType}).

Their reply may contain:
  - a deadline, expressed as a date or a relative time ("in 3 days",
    "next Friday", "tomorrow", "March 15")
  - optionally, additional requirements they want on the goal

Return JSON:
{
  "deadline": string | null,   // "YYYY-MM-DD", or null if no date was found
  "additional_requirements": [
    { "label": string, "kind": "self_action" | "external_dependency", "status": "not_started" | "done" }
  ]
}

RULES:
- Today is ${todayIso}. Resolve all relative dates against today.
- "in 3 days" → three days after today.
- "next Friday" → the upcoming Friday.
- If no date can be found in the reply, set "deadline" to null.
- "additional_requirements" is for items mentioned in the reply that
  weren't in the original goal. If the reply only contains a date, use [].
- "kind" is "external_dependency" ONLY if another person or institution
  must produce, sign, or return the item. Otherwise "self_action".
- "status" is "done" ONLY if the user says they already have it.

Return ONLY the JSON object.
`.trim();

  const raw = await callLLM(systemPrompt, text, { temperature: 0 });
  if (!raw || typeof raw !== 'object') return null;

  const deadline =
    typeof raw.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.deadline)
      ? raw.deadline
      : null;

  if (!deadline) return null;

  const additionalRequirements = Array.isArray(raw.additional_requirements)
    ? raw.additional_requirements
      .filter((r) => r && typeof r.label === 'string' && r.label.trim())
      .map((r) => ({
        label: r.label.trim(),
        kind: r.kind === 'external_dependency' ? 'external_dependency' : 'self_action',
        status: r.status === 'done' ? 'done' : 'not_started',
      }))
    : [];

  return { deadline, additionalRequirements };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toIsoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}