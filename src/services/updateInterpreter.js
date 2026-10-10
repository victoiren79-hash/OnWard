// Onward — interpret a casual status update.
//
// Takes a user utterance and a list of open requirements (possibly spanning
// multiple goals). Returns a structured multi-item result:
//
//   {
//     ok: true,
//     proposals: [ { requirement_id, goal_id, goal_title, label, new_status, confidence } ],
//     ambiguous: [ { mention, reason, candidates: [...] } ],
//     unmatched_mentions: [ string ],   // mentions that didn't correspond to any open item
//     reason: 'ok' | 'no_match' | 'no_change' | 'illegal_transition' | ...
//   }
//
// - proposals           → the LLM matched these confidently. Caller applies them.
// - ambiguous           → the LLM recognized an update but couldn't pick a
//                         target. Caller asks.
// - unmatched_mentions  → mentions the LLM saw but that don't correspond to
//                         any open item. Caller may offer to add them.
// - no_match            → the message isn't an update at all.
//
// This module ALSO exports resolveConfirmation, which classifies a reply
// to a pending confirmation as 'confirmed' / 'declined' / 'unrelated'.
// That function replaces the regex-based yes/no detection that used to
// live in orchestrator.js.
//
// The LLM proposes; the deterministic layer validates against legal
// transitions and matching ids before returning.

import { callLLM } from '../llm.js';
import { allowedNextStates, STATUSES } from './requirementService.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Above this, a proposal is applied without asking. Below, it becomes ambiguous. */
export const APPLY_CONFIDENCE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// System prompt — update interpretation
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `
You interpret a user's casual status update about their goals.

You are given:
  - The user's message.
  - A list of open items, each with: id, goal_id, goal_title, label, kind,
    current status, and the ONLY legal next statuses for that item.

A single message may describe ONE update or MANY. Extract every update you
can identify. Do not stop at the first one.

Return a JSON object with this exact shape:
{
  "matched": boolean,
  "proposals": [
    {
      "requirement_id": string,
      "new_status": "not_started" | "in_progress" | "waiting_on_other" | "done",
      "confidence": number,
      "reason": string
    }
  ],
  "ambiguous": [
    {
      "mention": string,
      "candidates": [string],
      "reason": string
    }
  ],
  "unmatched_mentions": [ string ]
}

RULES:
1. A message is an UPDATE only if it describes a change of state for one
   or more open items. Merely mentioning an item, discussing the goal,
   replying to a question, or asking a question is NOT an update. If the
   message is not an update, set "matched" to false.
2. Extract EVERY update in the message. "I got the cv, transcript and
   recommendation letter" is THREE proposals, not one.
3. NEGATIONS ARE NOT UPDATES. If the message says the user no longer
   needs an item, no longer wants it, that it is no longer required, or
   that it should be removed / deleted / dropped / skipped / forgotten,
   that is a DELETION, not a status update. Do NOT propose any status
   change for the item mentioned. Set "matched" to false and put in the
   reason that this is a deletion, not an update.

   Examples that are NOT updates (set matched to false):
     - "I no longer need the recommendation letter"
     - "the transcript isn't required anymore"
     - "drop the application fee"
     - "I don't need the financial documents"
     - "the portfolio is off the list"
     - "remove the recommendation letter"
     - "cancel the portfolio"
     - "I can skip the test scores"

4. PARTIAL MATCHES. If a message mentions several items and only some of
   them correspond to open items in the list, DO NOT reject the whole
   message. Set "matched" to true, include proposals for the ones you
   matched, and for the ones you couldn't match put them in
   "unmatched_mentions" as an array of strings.

   Example: message "I just got the CV, cover letter and transcript" where
   CV and Cover letter are already in status "done" and Transcript does not
   exist in the list →
     matched=true, proposals=[], ambiguous=[],
     unmatched_mentions=["transcript"]

   Example: message "I got the CV and the transcript" where CV is
   already done and Transcript is in the list as waiting_on_other →
     matched=true,
     proposals=[{ requirement_id: <transcript id>, new_status: "done", ... }],
     ambiguous=[],
     unmatched_mentions=[]

5. ALREADY-DONE ITEMS. If the user says they have/received/finished an
   item that is ALREADY in status "done" in the list, don't propose a
   status change for it. Just skip it silently. Do NOT include it in
   proposals and do NOT include it in unmatched_mentions.

6. For each update, pick the specific open item whose label best matches
   the mention. If the mention could refer to two or more items (e.g. the
   same label exists on two goals), DO NOT pick one — put it in "ambiguous"
   instead, listing the candidate requirement_ids.
7. "new_status" MUST be one of the legal next statuses for the chosen item.
   If the natural reading maps to a status that isn't legal, choose the
   closest legal status and lower your confidence.
8. "confidence" per proposal, 0 to 1:
     1.0    = the message unambiguously names this item AND a state change
     0.7-0.9 = very likely the right item, small ambiguity
     0.4-0.6 = plausible, but could be another item
     < 0.4   = guessing — put it in "ambiguous" instead of proposing it

PHRASING → STATUS MAPPING. This is the most important rule. Read it
carefully. Different verbs describe different ends of the same process.
Map them by MEANING, not by literal keyword.

  A. What the USER did — the user is the SENDER:
     - "I sent it / I sent the request / I submitted the request /
        the request went out / I reached out / I asked them for it /
        I emailed them / I mailed it / I mailed the request"
       → new_status = "waiting_on_other"   (for external_dependency items)
       → new_status = "in_progress" or "done" for self_action items —
         pick "done" only if the user says they finished it

  B. What the COUNTERPARTY did — the item came back to the user:
     - "it came in / it arrived / I received it / I just received it /
        I got it back / they sent it / they returned it / it's here /
        I have it now / it's done now / it showed up / it landed /
        they got back to me / it finally came"
       → new_status = "done"

     IMPORTANT: any phrase where the ITEM comes TO the user, or the user
     ends up HOLDING the item, maps to "done". "Received" always means
     done. "Arrived" always means done. "Got it back" always means done.
     "Came in" always means done. If the user is on the receiving end,
     the state is done — regardless of how the item got there.

  C. The user started work:
     - "I started / I began / I'm working on it / I'm writing it /
        I'm preparing it"
       → new_status = "in_progress"

  D. The user finished (for self_action items):
     - "I finished / I completed / I'm done with it / I wrote it"
       → new_status = "done"

  E. Not started yet:
     - "I haven't started / I still need to / I haven't done it"
       → new_status = "not_started"

  F. Nothing has changed — the user is still waiting on someone:
     - "still waiting / no word yet / they haven't replied /
        nothing yet / still nothing / no update"
       → new_status = "waiting_on_other"

CRITICAL — "sent" vs "received" vs "waiting":
  These three describe three different points in the same flow.
    "I sent the request"           → the USER is the sender
                                     → waiting_on_other
    "I received it"                → the USER is the recipient
                                     → done
    "still waiting / no word yet"  → nothing has changed
                                     → waiting_on_other

  If the verb describes the item ARRIVING at the user, or the user HAVING
  the item, it's "done". If the verb describes the user SENDING something
  OUT, it's "waiting_on_other". If the verb describes an ongoing wait with
  no progress, it's "waiting_on_other".

  NEVER map "received", "arrived", "came in", "got it back", "got it", or
  "it's here" to "waiting_on_other". Those words mean the item is in the
  user's hands. The state is done.

CRITICAL DISAMBIGUATION — "sent" vs "came in":
    "I sent the request"   → the USER is the sender → waiting_on_other
    "the request came in"  → the USER is the recipient → done

AMBIGUITY IS PER ITEM, NOT PER STATEMENT. If the user names three items
and all three exist on the SAME goal, that is NOT ambiguous — return three
proposals. If an item exists on multiple goals and the user's message does
not clearly pick one, put it in "ambiguous" with its candidates.

Return ONLY the JSON object. No prose, no code fences.
`.trim();

// ---------------------------------------------------------------------------
// System prompt — confirmation resolution
// ---------------------------------------------------------------------------

const CONFIRMATION_PROMPT = `
You are deciding whether the user's reply to the assistant is a YES, a NO,
or UNRELATED to a question the assistant just asked.

Return JSON: { "resolution": "confirmed" | "declined" | "unrelated" }

DEFINITIONS:

"confirmed" — the user is agreeing, or is asking for the action to happen.
Examples:
  - "yes"
  - "yeah go ahead"
  - "sure"
  - "okay"
  - "do it"
  - "add them"
  - "please add them"
  - "go for it"
  - "sounds good"
  - "no, add them"         ← the "no" denies the premise, the "add them"
                             affirms the action → CONFIRMED
  - "no I don't have any of those, can you add them"  ← same pattern
  - "I don't have any of those, please add"           ← same pattern
  - "nope, add them anyway"                           ← same pattern
  - "none of those, add them"                         ← same pattern
  - "no" alone, when the assistant asked "do you want me to add X?" → this
    is ambiguous, but if the assistant offered to add and the user says
    just "no", it is a DECLINE. Only "no, ..." followed by a positive
    instruction is a CONFIRM. Bare "no" is a decline.
    - "add them, and i also need a cv and passport copy"  ← the first
                                                          clause is the
                                                          confirm, the
                                                          second is a
                                                          follow-up
                                                          request →
                                                          CONFIRMED
  - "yes, and I need a passport copy too"               ← same pattern
  - "add those, plus a cv"                              ← same pattern
  - "sure, and add my transcripts while you're at it"   ← same pattern
IMPORTANT — MIXED MESSAGES:
When a reply contains BOTH a confirmation of the pending question AND a
new instruction or item, return "confirmed". The pending question is
being answered yes. The new instruction is separate and will be handled
by the system after the confirmation is resolved. Do NOT return
"unrelated" just because the message contains extra content.

Concrete examples of mixed messages, all CONFIRMED:
  - "add them, and i also need a cv and passport copy"
  - "add them, and i need a cv and passport copy too"
  - "add them. i also need a cv"
  - "yes, and add a passport copy too"
  - "sure, and while you're at it add my transcripts"
  - "add those, plus a cv"
  - "go ahead, and add a cv and passport copy as well"
  - "do it, and i also want to add a police clearance"

The leading clause is the answer to the pending question. The trailing
clause is a follow-up. Both parts matter, but the classification of THIS
message is about the leading clause. If the leading clause says "add
them", "yes", "go ahead", "do it", "sure", "okay", the whole message is
CONFIRMED.


"declined" — the user is refusing, or saying the action should not happen.
Examples:
  - "no"
  - "nope"
  - "not yet"
  - "skip it"
  - "leave them out"
  - "don't add them"
  - "don't include them"
  - "forget it"
  - "keep them off"
  - "cancel"
  - "never mind"
  - "no thanks"
  - "I'll do it myself"
  - "I already have them"  ← refusing to add because they're already done

"unrelated" — the reply is a new statement, question, or command that is
not answering the assistant's question. If the user changes topic, gives
a new instruction, or reports a status update, that is unrelated.
Examples:
  - "I sent the request to Prof Lee" (status update, not answering)
  - "what's left?" (new question)
  - "delete the visa application" (new command)
  - "I want to create a new goal" (new intent)

DECISION PROCEDURE:
1. Read the question the assistant just asked.
2. Read the user's reply.
3. Decide whether the reply addresses the question at all. If it doesn't,
   return "unrelated".
4. If it does, decide whether the user wants the action performed
   (confirmed), or does not (declined).
5. When a reply contains BOTH a "no"-shaped word AND a positive instruction
   for the action, the affirmative instruction WINS. The user is denying
   the premise, not the action. Return "confirmed".
6. When a reply is only a negation word with nothing after it, and the
   assistant asked a yes/no question, return "declined".

Return ONLY the JSON object. No prose, no code fences.
`.trim();

// ---------------------------------------------------------------------------
// Public API — update interpretation
// ---------------------------------------------------------------------------

export async function interpretUpdate(text, openItems) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('[onward/updateInterpreter] text must be a non-empty string');
  }
  if (!Array.isArray(openItems)) {
    throw new Error('[onward/updateInterpreter] openItems must be an array');
  }

  if (openItems.length === 0) {
    return {
      ok: false,
      reason: 'no_match',
      proposals: [],
      ambiguous: [],
      unmatched_mentions: [],
      message: 'There are no open items to update.',
    };
  }

  const itemLines = openItems.map((r) => {
    const next = allowedNextStates(r.kind, r.status);
    return [
      `- id: ${r.id}`,
      `  goal_id: ${r.goal_id}`,
      r.goal_title ? `  goal_title: ${JSON.stringify(r.goal_title)}` : null,
      `  label: ${JSON.stringify(r.label)}`,
      `  kind: ${r.kind}`,
      `  current_status: ${r.status}`,
      `  legal_next_statuses: [${next.map((s) => JSON.stringify(s)).join(', ')}]`,
      r.depends_on ? `  depends_on: ${JSON.stringify(r.depends_on)}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });

  const userMessage =
    `Open items (${openItems.length} total, across goals):\n\n` +
    itemLines.join('\n\n') +
    `\n\nUser message:\n${text}\n\n` +
    `Reminder: extract EVERY update in the message as a separate proposal. ` +
    `An item is only ambiguous if the same label exists on multiple goals ` +
    `and the message doesn't pick one. Apply the PHRASING → STATUS MAPPING. ` +
    `IMPORTANT: if the user says they no longer need / want / require an ` +
    `item, or asks to remove / delete / drop / skip it, that is a DELETION, ` +
    `not a status update. Set matched=false for it. ` +
    `PARTIAL MATCHES: if some mentioned items are in the list and others ` +
    `aren't, set matched=true and put the unknown mentions in ` +
    `unmatched_mentions.`;

  const raw = await callLLM(SYSTEM_PROMPT, userMessage, { temperature: 0 });

  return postProcess(raw, openItems);
}

// ---------------------------------------------------------------------------
// Public API — confirmation resolution
// ---------------------------------------------------------------------------

/**
 * Classify a user's reply to a pending confirmation as one of:
 *   'confirmed'  — the user agreed
 *   'declined'   — the user refused
 *   'unrelated'  — the reply is a new statement, question, or command
 *
 * @param {object} pc     — the pending confirmation object from session
 * @param {string} reply  — the user's message
 * @returns {Promise<'confirmed' | 'declined' | 'unrelated'>}
 */
export async function resolveConfirmation(pc, reply) {
  if (!pc || typeof pc !== 'object') {
    throw new Error('[onward/updateInterpreter] resolveConfirmation: pc is required');
  }
  if (typeof reply !== 'string' || !reply.trim()) {
    return 'unrelated';
  }

  const questionText = describeConfirmation(pc);
  const userMessage =
    `Question we asked the user:\n${questionText}\n\n` +
    `User's reply:\n${reply}`;

  let raw;
  try {
    raw = await callLLM(CONFIRMATION_PROMPT, userMessage, { temperature: 0 });
  } catch (e) {
    console.error('[onward/updateInterpreter] resolveConfirmation LLM call failed:', e);
    throw e;
  }

  const resolution = typeof raw?.resolution === 'string'
    ? raw.resolution.toLowerCase().trim()
    : '';

  if (resolution === 'confirmed' || resolution === 'declined' || resolution === 'unrelated') {
    return resolution;
  }
  return 'unrelated';
}

/**
 * Describe a pending confirmation in plain English so the LLM classifier
 * has context. This is the ONLY place that knows how to translate each
 * pc.kind into a sentence.
 */
function describeConfirmation(pc) {
  switch (pc.kind) {
    case 'completeness': {
      const labels = (pc.missing || []).map((m) => m.label).filter(Boolean);
      return labels.length > 0
        ? `We asked the user whether they have these items or want them added: ${labels.join(', ')}.`
        : `We asked the user whether they want the missing items added to their goal.`;
    }

    case 'add_item':
      return `We asked the user whether to add "${pc.label}" to their goal.`;

    case 'add_unmatched': {
      const labels = Array.isArray(pc.mentions) ? pc.mentions.join(', ') : '(unknown)';
      return `We asked the user whether to add these items (${labels}) to their goal "${pc.goalTitle ?? ''}".`;
    }

    case 'apply_update':
      return `We asked the user to confirm updating a requirement to "${pc.newStatus}".`;

    case 'apply_update_multi': {
      const count = Array.isArray(pc.updates) ? pc.updates.length : 0;
      return `We asked the user to confirm updating ${count} items.`;
    }

    case 'send_followup':
      return `We asked the user whether we should draft a follow-up message for "${pc.label}".`;

    case 'delete_goal':
      return `We asked the user to confirm DELETING the goal "${pc.goalTitle}". This is a destructive, irreversible action.`;

    case 'delete_requirement':
      return `We asked the user to confirm DELETING "${pc.label}" from "${pc.goalTitle}". This is a destructive, irreversible action.`;

    case 'delete_goal_pick':
      return `We asked the user which goal they want to delete.`;

    case 'disambiguate': {
      const items = Array.isArray(pc.items) ? pc.items : [];
      const mentions = items.map((i) => i.mention).filter(Boolean);
      return mentions.length > 0
        ? `We asked the user which item they meant by: ${mentions.join(', ')}.`
        : `We asked the user to pick which item they meant.`;
    }

    case 'choose_goal_for_new_item':
      return `We asked the user which goal to add "${pc.label}" to.`;

    default:
      return `We asked a confirmation question of kind "${pc.kind}".`;
  }
}

// ---------------------------------------------------------------------------
// Validation and post-processing
// ---------------------------------------------------------------------------

export function postProcess(raw, openItems) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('output is not a JSON object', raw);
  }
  if (typeof raw.matched !== 'boolean') {
    throw invalid('"matched" must be a boolean', raw.matched);
  }

  const rawUnmatched = Array.isArray(raw.unmatched_mentions)
    ? raw.unmatched_mentions.filter((m) => typeof m === 'string' && m.trim())
    : [];

  if (!raw.matched) {
    const reasonText = typeof raw.reason === 'string' ? raw.reason : '';
    const looksLikeNewItem = /new item|not in the list|haven't|hasn't|not previously/i.test(reasonText);
    return {
      ok: false,
      reason: looksLikeNewItem ? 'new_item' : 'no_match',
      proposals: [],
      ambiguous: [],
      unmatched_mentions: rawUnmatched,
      message: reasonText || 'No matching item.',
    };
  }

  const rawProposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  const rawAmbiguous = Array.isArray(raw.ambiguous) ? raw.ambiguous : [];

  const byId = new Map(openItems.map((r) => [r.id, r]));

  const proposals = [];
  const ambiguous = [];
  let sawNoChange = false;
  let sawIllegal = false;
  const illegalReasons = [];

  // --- Validate proposals -------------------------------------------------
  for (const p of rawProposals) {
    if (!p || typeof p !== 'object') {
      throw invalid('proposal is not an object', p);
    }
    if (typeof p.requirement_id !== 'string' || !p.requirement_id) {
      throw invalid('proposal.requirement_id must be a non-empty string', p.requirement_id);
    }
    if (typeof p.new_status !== 'string' || !STATUSES.includes(p.new_status)) {
      throw invalid(`proposal.new_status must be one of ${STATUSES.join(', ')}`, p.new_status);
    }
    const conf = typeof p.confidence === 'number' ? p.confidence : 0;
    if (conf < 0 || conf > 1) {
      throw invalid('proposal.confidence must be in [0, 1]', p.confidence);
    }

    const item = byId.get(p.requirement_id);
    if (!item) {
      throw invalid(
        `proposal.requirement_id ${p.requirement_id} is not in the open items`,
        p.requirement_id
      );
    }

    if (p.new_status === item.status) {
      sawNoChange = true;
      continue;
    }

    const legal = allowedNextStates(item.kind, item.status);
    if (!legal.includes(p.new_status)) {
      sawIllegal = true;
      illegalReasons.push(
        `"${item.label}" cannot go from "${item.status}" to "${p.new_status}"`
      );
      continue;
    }

    proposals.push({
      requirement_id: item.id,
      goal_id: item.goal_id,
      goal_title: item.goal_title ?? null,
      label: item.label,
      new_status: p.new_status,
      confidence: conf,
      reason: typeof p.reason === 'string' ? p.reason : '',
      needs_confirmation: conf < APPLY_CONFIDENCE_THRESHOLD,
    });
  }

  // --- Validate ambiguous -------------------------------------------------
  for (const a of rawAmbiguous) {
    if (!a || typeof a !== 'object') continue;
    const mention = typeof a.mention === 'string' ? a.mention : '';
    const candidateIds = Array.isArray(a.candidates) ? a.candidates : [];
    const candidates = [];
    for (const id of candidateIds) {
      const item = byId.get(id);
      if (!item) continue;
      candidates.push({
        requirement_id: item.id,
        goal_id: item.goal_id,
        goal_title: item.goal_title ?? null,
        label: item.label,
        status: item.status,
      });
    }
    if (candidates.length === 0) continue;

    if (candidates.length === 1) {
      const c = candidates[0];
      const targetStatus = pickDefaultStatusFor(c, a.suggested_status);
      if (!targetStatus) continue;
      proposals.push({
        requirement_id: c.requirement_id,
        goal_id: c.goal_id,
        goal_title: c.goal_title,
        label: c.label,
        new_status: targetStatus,
        confidence: 0.85,
        reason: 'single candidate',
        needs_confirmation: false,
      });
      continue;
    }

    ambiguous.push({
      mention: mention || candidates[0].label,
      reason: typeof a.reason === 'string' ? a.reason : '',
      candidates,
    });
  }

  let reason = 'ok';
  if (proposals.length === 0 && ambiguous.length === 0) {
    if (sawIllegal) reason = 'illegal_transition';
    else if (sawNoChange) reason = 'no_change';
    else if (rawUnmatched.length > 0) reason = 'ok';
    else reason = 'no_match';
  }

  return {
    ok: proposals.length > 0 || rawUnmatched.length > 0,
    reason,
    proposals,
    ambiguous,
    unmatched_mentions: rawUnmatched,
    illegal_reasons: illegalReasons,
    saw_no_change: sawNoChange,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function invalid(what, got) {
  const err = new Error(
    `[onward/updateInterpreter] Invalid LLM output: ${what}. Got: ${JSON.stringify(got)}`
  );
  err.code = 'INTERPRETATION_INVALID';
  return err;
}
// ---------------------------------------------------------------------------
// Public API — intent classification
// ---------------------------------------------------------------------------

/**
 * Classify a user's message into one of the top-level intent kinds used by
 * the router. Replaces the collection of regex checks in orchestrator.js.
 *
 * Returns one of:
 *   'delete_goal' | 'delete_requirement' | 'add_items'
 *   | 'create' | 'query' | 'update' | 'unrelated'
 *
 * If the LLM call fails for any reason (network error, rate limit, credits
 * exhausted, malformed response), this function returns null. The caller
 * is expected to fall back to its previous regex-based routing.
 *
 * @param {string} text
 * @param {Array<{title: string}>} goals  — summary of active goals for context
 * @returns {Promise<string | null>}
 */
export async function classifyIntent(text, goals = []) {
  if (typeof text !== 'string' || !text.trim()) return null;

  const goalList = Array.isArray(goals) && goals.length > 0
    ? goals.map((g) => `"${g.title}"`).join(', ')
    : '(none)';

  const systemPrompt = `
You classify a user's message into ONE intent kind for a personal goal
tracker. The user has goals, each with a deadline and a checklist of
items. Some items depend on other people or institutions.

The user's current goals are: ${goalList}

Pick exactly ONE of these categories:

  delete_goal          — the user wants to remove an entire goal.
                         Examples: "delete the visa application",
                         "I no longer need that scholarship",
                         "cancel the whole MIT thing".

  delete_requirement   — the user wants to remove one or more ITEMS from
                         a goal, but keep the goal.
                         Examples: "I no longer need the recommendation
                         letter", "drop the application fee",
                         "remove the portfolio from my scholarship".

  add_items            — the user is naming items to ADD to an existing
                         goal (not creating a new goal).
                         Examples: "I also need a police clearance",
                         "add transcripts to the scholarship",
                         "I still need my medical exam".

  create               — the user is describing a NEW goal with a deadline.
                         Examples: "I need to apply for a visa by Nov 1",
                         "new goal: submit my grant application by
                         March 30".

  query                — the user is asking a question about their goals
                         or state.
                         Examples: "what's left?", "what's at risk?",
                         "what should I do now?", "show me my goals".

  update               — the user is reporting a STATUS CHANGE to an
                         existing item.
                         Examples: "I sent the request", "the transcript
                         came in", "I finished the SOP".

  unrelated            — none of the above (small talk, unclear, a bare
                         noun with no verb, etc.).

Rules:
- If a message names items but doesn't state a status change and isn't
  asking a question, prefer "add_items" (naming new items) over "update".
- If the message says the user no longer needs/wants something, that's a
  delete. If it names a whole goal ("the visa application"), it's
  "delete_goal". If it names an item inside a goal, it's
  "delete_requirement".
- If nothing is clear, choose "unrelated" — do NOT guess.
- Ignore typos and small grammatical errors.

Return JSON: { "intent": "<category>" }

Return ONLY the JSON object.
`.trim();

  let raw;
  try {
    raw = await callLLM(systemPrompt, text, { temperature: 0 });
  } catch (e) {
    // Log and return null. The caller falls back to regex routing.
    console.error('[onward/updateInterpreter] classifyIntent LLM call failed:', e.message);
    return null;
  }

  const intent = typeof raw?.intent === 'string' ? raw.intent.trim() : '';
  const valid = new Set([
    'delete_goal',
    'delete_requirement',
    'add_items',
    'create',
    'query',
    'update',
    'unrelated',
  ]);
  return valid.has(intent) ? intent : null;
}

function pickDefaultStatusFor(candidate, suggested) {
  if (suggested && ['not_started', 'in_progress', 'waiting_on_other', 'done'].includes(suggested)) {
    return suggested;
  }
  return 'done';
}