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
]);

export const REQUIREMENT_STATUSES = Object.freeze(['not_started', 'done']);

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
  "goal_type": string | null,             // one of the KNOWN GOAL TYPES below, or null if unsure
  "requirements": [
    {
      "label": string,                    // short noun phrase, e.g. "Recommendation letter"
      "kind": "self_action" | "external_dependency",
      "status": "not_started" | "done"
    }
  ]
}

KNOWN GOAL TYPES (use the exact string, or null if the message doesn't clearly fit one):
- grad_scholarship_application    — university / grad school / scholarship applications
- visa_permit_application         — visas, residence permits, work permits, travel permits
- job_application_with_references — applying for a job, an internship, a position at a company
- grant_application               — grant or funding applications (typically institutional)
- signed_form_return              — getting a form signed and returned by someone

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
7. Goal type matching: read the whole message. Only set a goal_type when the
   message clearly fits one of the five types. "Applying for a job" alone is
   job_application_with_references. "Applying to a university / grad program /
   scholarship" is grad_scholarship_application. If the type is genuinely
   ambiguous, set it to null.
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
   sentence. Prefer the phrasing the user used.
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

  return validateGoalDraft(raw);
}

// ---------------------------------------------------------------------------
// Public API — item extraction
// ---------------------------------------------------------------------------

/**
 * Extract item names from a message that says the user needs them, to be
 * added to an existing goal.
 *
 * @param {string} text
 * @returns {Promise<{items: Array<{label: string, kind: string, status: string}>, goal_hint: string|null} | null>}
 *   Returns null if there are no items to extract.
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
// Internals
// ---------------------------------------------------------------------------
/**
 * Parse a user's reply to "What's the deadline?" — a message that should
 * contain a date, and may also mention additional requirements for the
 * pending goal.
 *
 * @param {string} text
 * @param {{title: string, goal_type: string|null}} partialGoal
 * @param {object} [opts]
 * @param {Date}   [opts.today]
 * @returns {Promise<{deadline: string, additionalRequirements: Array} | null>}
 */
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
function toIsoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}