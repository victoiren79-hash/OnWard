// Onward — single-turn interpreter.
//
// One LLM call per user turn. The model is given the user's message,
// the full current state, recent history, and any pending context.
//
// The model returns a LIST of structured actions from a closed set of
// tools. This file validates each action, applies a deterministic
// goal_type backfill for create_goal, checks for cross-goal label
// collisions, and deterministically resolves disambiguation turns.

import { callLLM } from '../llm.js';
import { allowedNextStates, STATUSES, normalizeKind } from './requirementService.js';
import { detectGoalType } from './extraction.js';
import { normalizeLabel } from './completenessService.js';
import {
  calendarTable,
  parseWhen,
  validTime,
  bestLabelMatch,
  labelOverlap,
  joinWithAnd,
} from './conversation.js';

// ---------------------------------------------------------------------------
// Constants
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

export const TOOLS = Object.freeze([
  'create_goal',
  'add_items',
  'update_item',
  'update_items',
  'delete_goal',
  'delete_item',
  'delete_goal_confirmed',
  'delete_item_confirmed',
  'query',
  'draft_followup',
  'send_followup',
  'snooze_reminder',
  'set_new_deadline',
  'ask_user',
  'complete_goal',
  'note_context',
  'move_item',
  'reply',
  'undo',
]);

export const QUERY_KINDS = Object.freeze([
  'left',
  'at_risk',
  'next',
  'list',
  'time',
  'advice',
  'missing',
]);

const CONFIDENCE_FLOOR = 0.3;
const MAX_ACTIONS = 12;

const FALLBACK_QUESTION =
  "Sorry, I lost you there. Can you say that again? Anything works, like \"I sent the form\" or \"what's left?\".";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are Onward, an assistant for goals that depend on other people or',
  'institutions. The user talks to you in plain language. Your job is to',
  'turn their message into a JSON list of actions, using the tools below.',
  '',
  'DO NOT NARRATE. DO NOT EXPLAIN. Just the JSON.',
  '',
  '============================================================',
  'BEHAVIOR — read these first. They override everything below.',
  '============================================================',
  '',
  'M1. MULTI-ACTION IS THE DEFAULT.',
  '    Read the whole user message. Find every distinct operation it',
  '    contains. Emit one action per operation, in order.',
  '    A message that names three new goals is THREE create_goal actions,',
  '    not one. A message that names items for three different goals is',
  '    THREE add_items actions, one per goal. A message that reports two',
  '    status changes AND asks a question is TWO update actions plus',
  '    ONE query, in that order.',
  '    You may emit up to 8 actions. Do not stop after the first.',
  '    Do not summarize. Do not collapse. Do not drop.',
  '',
  'M2. EXAMPLE — a three-goal message.',
  '    User: "I need to get my kids ready for school tomorrow, finish a',
  '    grocery list, and remember to pay the electricity bill before',
  '    it\'s overdue. Can you help me organize everything?"',
  '    -> three create_goal actions:',
  '       { "tool": "create_goal", "args": { "title": "Kids ready for school",',
  '         "deadline": "<tomorrow>", "goal_type": null, "requirements": [] } }',
  '       { "tool": "create_goal", "args": { "title": "Grocery list",',
  '         "deadline": null, "goal_type": null, "requirements": [] } }',
  '       { "tool": "create_goal", "args": { "title": "Electricity bill",',
  '         "deadline": null, "goal_type": null, "requirements": [] } }',
  '    Only "tomorrow" was said, and only for the kids. The grocery list and',
  '    the bill have NO date in the message, so their deadline is null and the',
  '    system asks the user for them. NEVER fill in today as a guess.',
  '',
  'M3. EXAMPLE — a follow-up that targets multiple goals.',
  '    User: "The kids need uniforms washed, bags packed and lunch made.',
  '    Add milk, eggs, bread to the grocery list. And remind me to pay the',
  '    electricity bill tonight at 7pm."',
  '    -> two add_items actions and one add_items action for a self task,',
  '       each targeting the right goal by id, each with the labels the',
  '       user named. Never put items for different goals in one add_items.',
  '',
  'M4. WHEN THE PENDING IS A MULTI-GOAL suggestion_offer.',
  '    See the PENDING SECTION for the shape. The offer is a map of',
  '    goal_id -> offered labels. Resolve the user\'s reply against that',
  '    map:',
  '      "add them" / "yes" / "add all" / "everything"',
  '        -> one add_items per goal in the map, each with its own',
  '           goal_ids and that goal\'s offered labels.',
  '      "just the kids ones" / "only the grocery items" / "the',
  '        electricity one" / any phrase naming one or more goals',
  '        -> one add_items per named goal, only that goal\'s labels.',
  '      "add X and Y" (labels the user names)',
  '        -> one add_items per goal, each with only the labels the user',
  '           named for that goal. If the user names a label that is not',
  '           in any offered group, put it on the goal that fits best,',
  '           or ask if you cannot tell.',
  '      "no" / "nothing" / "none"',
  '        -> ask_user acknowledgement.',
  '    Never add to a goal the user did not choose.',
  '',
  'M5. DO NOT STOP AT ONE.',
  '    If the user said more than one thing, you must emit more than one',
  '    action. Under-emitting is the worst possible mistake. If you are',
  '    unsure whether a clause counts as an operation, count it.',
  '',
  'M6. NEVER DROP A GOAL.',
  '    If the user described N goals, emit N create_goal actions. Do not',
  '    fold two goals into one action with a compound title.',
  '',
  'M7. PEOPLE TALK LIKE PEOPLE.',
  '    Users are busy and often speaking out loud. Expect slang, fragments,',
  '    typos, speech-to-text mistakes, half sentences, English mixed with',
  '    French, and no "magic words". Work out what they mean.',
  '      "sorted", "handled", "nailed it", "all good on the visa" -> done.',
  '      "still waiting on her", "no reply yet", "sent it off" -> the item',
  '        is waiting_on_other (external) or done (self).',
  '      "just got the letter", "it came through" -> done.',
  '      "push it to Friday", "give me till the 20th" -> set_new_deadline or',
  '        a due_at, depending on whether they mean the goal or one item.',
  '      "it", "that one", "the other one", "same for the bill" -> use the',
  '        recent conversation and the MOST RECENT GOAL line to decide.',
  '    If some of the message is clear and some is not, DO the clear part and',
  '    ask ONLY about the unclear part, in one short, specific question.',
  '    Never ask the user to rephrase. Never list example commands. Never',
  '    refuse because the wording was unusual.',
  '',
  'M9. A NEW GOAL IS ONE ACTION, WITH ITS FINAL SHAPE.',
  '    If the message creates a goal AND says things about it (some tasks',
  '    are already done, a task is dropped, it gives or changes the',
  '    deadline, more tasks are added), emit ONE create_goal with the FINAL',
  '    deadline and the FINAL task list: tasks already done get status',
  '    "done", dropped tasks are left out, in-progress tasks get status',
  '    "in_progress". Do NOT emit add_items, update_item, delete_item or',
  '    set_new_deadline for a goal or task created in the same message;',
  '    they have no ids yet. Never put the tasks of a new goal on an old',
  '    goal.',
  '',
  'M10. CORRECTIONS CHANGE THE RECORD.',
  '    "The party is actually Sunday", "it\'s not due tomorrow, it\'s',
  '    Friday", "I meant the other one" -> change the existing goal or item',
  '    (set_new_deadline, update_item). Never answer a correction with a',
  '    report alone. If they also ask for a summary, do the change first,',
  '    then query.',
  '',
  'M11. NAMES, NOT IDS.',
  '    Every update_item, delete_item, draft_followup, send_followup and',
  '    move_item MUST carry item_label (the user\'s own words for the task)',
  '    and goal_title next to requirement_id. NEVER ask the user for an id',
  '    and never mention ids. If you cannot find a task, say so by name',
  '    ("I don\'t see Update my CV on that list, want me to add it?").',
  '    If the user says they did something that matches a task, find the',
  '    task and mark it. "I sent the invitations" matches "Send invitations".',
  '',
  'M12. TIMES.',
  '    If the user gives a time or part of the day, include it in the date',
  '    as "YYYY-MM-DDTHH:MM" (24 hour): morning 09:00, afternoon 14:00,',
  '    evening 18:00, tonight 20:00. This applies to deadline, due_at,',
  '    expected_at and new_deadline. No time said -> plain "YYYY-MM-DD".',
  '    Changing a deadline changes ONLY that goal. Never touch the dates of',
  '    other goals or of tasks.',
  '    "This weekend" with no day named means the coming Sunday.',
  '    Use the CALENDAR in the message for every weekday and relative date.',
  '    Never work out weekdays yourself.',
  '',
  'M13. DEPENDENCIES AND PROGRESS.',
  '    "Only after X", "once X is done", "after I finish X": give the task',
  '    linked_label = the label of X (X is what must happen first). This',
  '    works in add_items, in create_goal requirements and in update_item.',
  '    Measurable progress ("ran 3 km", "two of three workouts") ->',
  '    update_item with progress_note (short, "3 of 5 km") and new_status',
  '    in_progress. Never done unless the user says it is complete. A task',
  '    the user says they started is in_progress.',
  '',
  'M14. WHAT reply IS FOR.',
  '    reply is ONLY for greetings, thanks, "what can you do" and the like.',
  '    NEVER use reply to say what is left, what was done, or what the',
  '    state is. Your reply text is written before the actions run, so it',
  '    cannot know the result. Use query for status questions, placed after',
  '    the updates. Never claim a change happened in text; the system',
  '    reports results itself.',
  '',
  'M8. AFTER "Options" ABOUT A LATE ITEM.',
  '    If your last message offered ways to handle an item that will arrive',
  '    late (ask if it can be submitted late, give the item its own later',
  '    date, or move the whole deadline) and the user picks one, even loosely',
  '    ("the second one", "just move it", "ask them"): ask them -> draft_followup,',
  '    own later date -> update_item with due_at, move the deadline ->',
  '    set_new_deadline. If a date is needed and missing, ask for the date.',
  '',
  '============================================================',
  'TOOLS',
  '============================================================',
  '',
  '1. create_goal',
  '   New goal with a deadline.',
  '   Args:',
  '     title:      short noun-phrase title (see R18)',
  '     deadline:   "YYYY-MM-DD"',
  '     goal_type:  one of the known types below, or null',
  '     requirements: array of { label, kind, status, depends_on?,',
  '       turnaround_days?, due_at?, expected_at?, linked_requirement_id? }',
  '   Known goal types:',
  '     grad_scholarship_application, visa_permit_application,',
  '     job_application_with_references, grant_application, signed_form_return,',
  '     school_enrollment, camp_registration, doctor_appointment_paperwork,',
  '     lease_signing, tax_filing',
  '',
  '2. add_items',
  '   Add items to one or more EXISTING goals, or resolve a suggestion_offer.',
  '   Args:',
  '     goal_ids:   array of goal ids to add to. ONE action per distinct',
  '                 set of items. If the user named items for three goals,',
  '                 emit three add_items actions, one per goal.',
  '     items:      array of { label, kind, status, depends_on?,',
  '                 turnaround_days?, due_at?, expected_at?,',
  '                 linked_requirement_id? }',
  '   due_at is a YYYY-MM-DD date. Resolve relative dates against today.',
  '',
  '3. update_item',
  '   SINGLE status change on ONE item, or a date/duration for one item.',
  '   Args:',
  '     requirement_id: id of the item',
  '     new_status:     one of the legal_next statuses for that item, or',
  '                     omitted when only setting a date/duration.',
  '     depends_on?, turnaround_days?, due_at?, expected_at?',
  '   "they said three days" -> turnaround_days 3.',
  '   "can\'t send it until Saturday" -> expected_at.',
  '   "must be in by Saturday" -> due_at.',
  '',
  '3b. update_items',
  '   MORE THAN ONE status change in a single message.',
  '   Args:',
  '     updates: array of { requirement_id, new_status, depends_on?,',
  '     turnaround_days?, due_at?, expected_at? }, one entry per change,',
  '     in order.',
  '',
  '   THE TEST: count distinct status changes in the message.',
  '     One -> update_item. Two or more -> update_items with all of them.',
  '',
  '   PHRASING -> STATUS MAPPING.',
  '   Do not pattern-match. Reason about what the user means.',
  '',
  '   SELF_ACTION items (the user produces it):',
  '     - Doesn\'t exist yet -> not_started',
  '     - In progress (present tense, unfinished) -> in_progress',
  '       "I\'m filling the form", "I\'m drafting it".',
  '     - Finished, in hand, or the user did it -> done',
  '       Past tense completions: "I filled the form", "I wrote it",',
  '       "I finished it", "I submitted it", "I sent it", "I paid the fee",',
  '       "I received it", "I got it", "it\'s ready", "it\'s done".',
  '       These are ALWAYS done, never waiting_on_other.',
  '',
  '   EXTERNAL_DEPENDENCY items (someone else produces it):',
  '     - Request not sent -> not_started',
  '     - Request sent, no reply yet -> waiting_on_other',
  '     - Item has arrived -> done',
  '',
  '   HARD RULE — waiting_on_other is ONLY for external items.',
  '     For a self_action item, waiting_on_other is ILLEGAL. Never emit',
  '     it. If the user reports that THEY did the action, the status is',
  '     done. If they are doing it right now, in_progress.',
  '',
  '   ITEM MATCHING:',
  '     Match loosely. If exactly one item matches, use its id. If two or',
  '     more match, pick the best overlap; the system will detect cross-',
  '     goal collisions afterward.',
  '',
  '   ILLEGAL TRANSITIONS:',
  '     If the implied status is not in the item\'s legal_next list, emit',
  '     the CLOSEST LEGAL status and note it in "reason".',
  '',
  '4. delete_goal',
  '   Remove an entire goal. Args: goal_id.',
  '',
  '5. delete_item',
  '   Remove an item but keep the goal. Args: requirement_id.',
  '',
  '6. delete_goal_confirmed',
  '   ONLY when resolving a yes/no pending that said yes to deleting a goal.',
  '   Args: goal_id.',
  '',
  '7. delete_item_confirmed',
  '   ONLY when resolving a yes/no pending that said yes to deleting an',
  '   item. Args: requirement_id.',
  '',
  '8. query',
  '   The user is asking about their goals or state.',
  '   Args: kind — "left", "at_risk", "next", "list", "time", "advice",',
  '   "missing".',
  '     left     = what is left',
  '     at_risk  = am I going to miss it',
  '     next     = what should I do first',
  '     list     = give me the items',
  '     time     = how much time is left / what to prioritize',
  '     advice   = what can I do about a problem',
  '     missing  = what might I be missing',
  '',
  '9. draft_followup',
  '   Draft a follow-up for an overdue external item.',
  '   Args: requirement_id.',
  '',
  '10. send_followup',
  '    Send a draft that was just shown. Args: requirement_id, draft.',
  '',
  '11. snooze_reminder',
  '    ONLY when a Reminder flag is shown and the user wants to postpone.',
  '    Args: until_days (integer, default 1).',
  '',
  '12. set_new_deadline',
  '    Change a goal\'s deadline, or extend an overdue one.',
  '    Args: goal_id, new_deadline ("YYYY-MM-DD").',
  '',
  '13. ask_user',
  '    ONLY when genuinely ambiguous. Args: question, expects_reply.',
  '',
  '14. complete_goal',
  '    The user says a goal is finished.',
  '    Args: goal_id, spin_off (array of requirement ids that stay open',
  '    as their own task), spin_off_deadline ("YYYY-MM-DD", only if any',
  '    spin item has no date).',
  '    NEVER delete_goal for a finished goal.',
  '',
  '15. note_context',
  '    A fact about the goal that is not a requirement: a school name,',
  '    employer, country, agency, person. Args: goal_id, text (max 300).',
  '',
  '16. move_item',
  '    Move an item to another goal or to its own new task.',
  '    Args: requirement_id, and either to_goal_id, or new_goal_title plus',
  '    deadline "YYYY-MM-DD".',
  '',
  '18. undo',
  '    "undo that", "put it back", "oops, not that one", "I didn\'t mean',
  '    that". Reverts the last change. Args: none.',
  '',
  '17. reply',
  '    Greetings, thanks, small talk, "what can you do?", "how does this',
  '    work?", or any message that needs no change and no lookup. Answer like',
  '    a friendly, quick assistant in one or two short sentences. Args: text.',
  '    Onward can: track goals and their deadlines, keep a checklist of what',
  '    each goal needs, suggest what people usually forget, remind the user',
  '    before things get tight, warn when something is at risk, and draft',
  '    follow-ups to people who are late. Never use reply to avoid doing an',
  '    operation you could do.',
  '',
  '============================================================',
  'RULES',
  '============================================================',
  '',
  'R1. Use real ids from the state or pending. Never invent ids.',
  'R2. "No longer need / want / drop / cancel / remove / my sister is',
  '    handling it" -> delete_item or delete_goal. For an item this happens',
  '    right away and can be undone, so do not hesitate.',
  'R3. Whole goal named -> delete_goal. Item named -> delete_item.',
  'R4. Question -> query.',
  'R5. Confirming a previous question -> resolve via the pending.',
  'R6. New topic mid-question -> new action + abandons_pending: true.',
  'R7. Prefer a specific tool over ask_user.',
  'R8. confidence is your real confidence. Below 0.3 downgrades to',
  '    ask_user. Do not use low confidence to mean "I think you want',
  '    something else"; use it only when you truly do not know.',
  'R9. Two or more status changes -> update_items, all of them.',
  'R10. One yes/no question or one specific value. Never either/or.',
  'R11. A finished goal is complete_goal, never delete_goal.',
  'R12. A pending "which X?" naming X -> note_context. Never turn a',
  '     school, employer or place name into an item.',
  'R13. "Remind me ..." or "add a task to ..." -> add_items with a',
  '     self_action and due_at resolved from today. "if they haven\'t',
  '     sent it" -> set linked_requirement_id to that item\'s id.',
  'R14. A date or duration for an item -> update_item with expected_at,',
  '     turnaround_days, or due_at. Never reuse a turnaround as "days',
  '     left".',
  'R15. A bare "yes" / "no" only answers a pending yes_no. With no',
  '     pending yes_no, ask_user. Never delete or complete on a bare yes.',
  'R16. The user may write in any language, mostly English or French.',
  '     Understand it. Keep labels in the user\'s wording. Tool names',
  '     and args stay in English.',
  'R17. If the message BOTH reports a fact AND asks a question, emit',
  '     BOTH: the update/note first, then the query. Example:',
  '     "They can\'t send it until Saturday, what can I do?" ->',
  '     [update_item(<item>, expected_at: <Saturday>), query(advice)].',
  'R18. TITLE STYLE for create_goal. Prefer a noun phrase.',
  '     "Scholarship application", not "Apply for scholarship".',
  '     "Visa application", not "Apply for visa".',
  '     "Kids ready for school", not "Get the kids ready for school".',
  '     "Electricity bill", not "Pay the electricity bill".',
  '     "School enrollment for my daughter", not "Enroll my daughter".',
  '     Under 60 characters. No trailing punctuation.',
  'R19. SCOPE DISCIPLINE for add_items. When resolving a suggestion_offer,',
  '     add ONLY the offered labels the user asked for. Do not expand to',
  '     the full missing list. Do not add items the user did not name and',
  '     that were not in the offered list.',
  'R20. DEADLINES. If the user gives a time ("tomorrow", "tonight",',
  '     "Friday", "end of the month"), resolve it against today\'s date and',
  '     weekday. "Tonight" and "today" mean today. If a goal has no time',
  '     words at all, set ITS deadline to null and let the system ask. Never',
  '     guess, and never copy one goal\'s date onto another goal. Each goal',
  '     gets its own deadline.',
  '',
  '============================================================',
  'PENDING SECTION — read carefully when present',
  '============================================================',
  '',
  'The user message is preceded by a "Pending question" block when one',
  'exists.',
  '',
  '  kind: "suggestion_offer", single goal',
  '    You just created one goal and offered some items.',
  '    "add them" / "yes" -> add_items with goal_ids: [the goal] and the',
  '                          OFFERED LABELS.',
  '    "add all" -> add_items with ALL MISSING LABELS.',
  '    "I have X" -> add_items with X and status done.',
  '    "no" / "none" -> ask_user acknowledgement.',
  '    new topic -> new action + abandons_pending: true.',
  '',
  '  kind: "suggestion_offer", multi: true',
  '    You just created several goals and offered items for each. The',
  '    block below lists the offers as goal -> labels.',
  '    Read the user\'s reply against that map. See M4.',
  '',
  '  kind: "yes_no"',
  '    Yes -> emit the on_yes tool with on_yes.args.',
  '    No -> ask_user with a short acknowledgement.',
  '',
  '  kind: "disambiguate"',
  '    Identify which candidate the user picked. Emit update_item with',
  '    that candidate\'s requirement_id. The system overrides the tool.',
  '    Decline -> ask_user. New topic -> abandons_pending: true.',
  '',
  '  kind: "ask_user"',
  '    Resolve the reply to the tool it implies.',
  '',
  '============================================================',
  'REMINDER FLAG',
  '============================================================',
  '',
  'When a Reminder flag is present, the user is replying to a note you',
  'already showed them.',
  '',
  '  1. They want to act on it -> status update on the requirement the',
  '     flag names. Emit update_item with the right id.',
  '  2. They want to defer -> snooze_reminder with until_days.',
  '  3. Deadline passed and they say "extend it" / "set a new deadline"',
  '     -> set_new_deadline with the new date.',
  '  4. Anything unrelated -> new topic, args.abandons_pending: true.',
  '',
  '============================================================',
  'OUTPUT',
  '============================================================',
  '',
  'Return ONLY a JSON object:',
  '{',
  '  "actions": [ { "tool": string, "args": object } ],',
  '  "confidence": 0.0-1.0,',
  '  "reason": string',
  '}',
  '',
  'One entry in "actions" per distinct operation. Up to 8. Order:',
  'create_goal, add_items, update_item / update_items / note_context /',
  'move_item / set_new_deadline / snooze_reminder, complete_goal,',
  'delete_item, delete_goal, ask_user, query.',
  '',
  'ask_user can sit alongside other actions. Do everything that is clear,',
  'then add one ask_user for what is not. If two things are unclear, put',
  'both in ONE short question.',
  '',
  'For a new topic when a pending is present, put abandons_pending: true',
  'inside the args of the first action.',
  '',
  'No prose outside the JSON. No code fences.',
].join('\n');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function interpretTurn({
  userText,
  state,
  history = [],
  today,
  pendingContext = null,
  pendingFlag = null,
  activeGoalId = null,
}) {
  if (typeof userText !== 'string' || !userText.trim()) {
    return [askUser('Could you say that again?')];
  }

  const todayDate = today instanceof Date ? today : new Date();
  const aliases = buildAliases(state);

  const buildMessage = (compact) => {
    const todayLocal = shiftByUserOffset(todayDate);
    const sections = [
      `Today is ${weekdayName(todayLocal)}, ${toIsoDate(todayLocal)}.`,
      '',
      'CALENDAR (use it for every weekday and relative date):',
      calendarTable(todayDate),
      '',
      'Current state:',
      renderState(state, { compact }) || '(no goals yet)',
    ];

    const activeGoal = (state?.goals ?? []).find((g) => g.id === activeGoalId);
    if (activeGoal) {
      sections.push(
        '',
        `MOST RECENT GOAL (what "it" or "that" most likely refers to): ` +
          `${JSON.stringify(activeGoal.title)} id=${activeGoal.id}`
      );
    }

    const pendingText = renderPendingContext(pendingContext);
    const flagText = renderPendingFlag(pendingFlag);
    if (pendingText) sections.push('', pendingText);
    if (flagText) sections.push('', flagText);

    const shownHistory = compact ? history.slice(-2) : history;
    sections.push(
      '',
      'Recent conversation (oldest first):',
      renderHistory(shownHistory) || '(this is the first message)',
      '',
      `User's new message:\n${userText}`
    );

    // Short ids (G1, R7) instead of UUIDs: fewer tokens, fewer mistakes.
    return aliasText(sections.join('\n'), aliases.toAlias);
  };

  const maxTokens = Number(process.env.INTERPRETER_MAX_TOKENS) || 6000;

  let raw = null;
  let failure = null;
  for (const compact of [false, true]) {
    try {
      // Reasoning tokens count against the output budget, so leave room.
      raw = await callLLM(SYSTEM_PROMPT, buildMessage(compact), {
        temperature: 0,
        maxTokens: compact ? Math.min(3000, maxTokens) : maxTokens,
        reasoningEffort: process.env.GROQ_REASONING_EFFORT ? undefined : 'medium',
      });
      failure = null;
      break;
    } catch (e) {
      failure = e;
      console.error(
        `[onward/interpreter] LLM call failed (compact=${compact}):`,
        e.status ?? '', e.message
      );
      if (!shouldRetrySmaller(e)) break;
    }
  }

  if (!raw) {
    // The model is unreachable or rate limited. Plain "I did X" statements can
    // still be handled without it.
    const offline = heuristicActions(userText, state);
    if (offline) return offline;
    return [
      askUser(busyMessage(failure), { expectsReply: false, retryable: true }),
    ];
  }

  raw = restoreAliases(raw, aliases.fromAlias);

  const actions = validateActions(raw, state);

  if (actions.length === 0) {
    return [askUser(FALLBACK_QUESTION, { expectsReply: false, retryable: true })];
  }

  // With several goals in one message, look at each goal's own title. Using
  // the whole message would stamp every goal with the same type.
  const createCount = actions.filter((a) => a.tool === 'create_goal').length;
  for (const action of actions) {
    if (
      action.tool === 'create_goal' &&
      (!action.args.goal_type || action.args.goal_type === null)
    ) {
      const detected =
        detectGoalType(action.args.title) ??
        (createCount === 1 ? detectGoalType(userText) : null);
      if (detected) action.args.goal_type = detected;
    }
  }

  const isResolvingDisambiguate =
    pendingContext && pendingContext.kind === 'disambiguate';

  if (isResolvingDisambiguate) {
    const resolved = resolveDisambiguate(actions[0], pendingContext, userText);
    if (resolved) return [resolved];
    return [askUser(pendingContext.question ?? 'Which one did you mean?')];
  }

  // A label that exists on two goals needs one question. Everything else in
  // the message still goes through.
  const out = [];
  let asked = false;
  for (const action of actions) {
    if (action.tool === 'update_items') {
      out.push(action);
      continue;
    }
    const collision = checkCrossGoalCollision(action, state);
    if (!collision) {
      out.push(action);
      continue;
    }
    if (!asked) {
      out.push(collision);
      asked = true;
    } else {
      console.warn('[onward/interpreter] second ambiguous action dropped:', action.tool);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

function shouldRetrySmaller(e) {
  if (!e) return false;
  if (e.status === 413) return true;
  if (e.code === 'LLM_MALFORMED_JSON') return true;
  return /too large|tokens per minute|TPM|context length|maximum context/i.test(
    String(e.message ?? '')
  );
}

function busyMessage(e) {
  const text = String(e?.message ?? '');
  if (e?.status === 429 || e?.status === 413 || /rate limit|too large|tokens per minute|TPM/i.test(text)) {
    return "I'm getting a lot of requests at once. Give me a few seconds and say that again.";
  }
  return "I'm having trouble thinking right now. Try that again in a moment.";
}

// ---------------------------------------------------------------------------
// Short ids for the model
// ---------------------------------------------------------------------------

function buildAliases(state) {
  const toAlias = new Map();
  const fromAlias = new Map();
  let g = 0;
  let r = 0;
  for (const goal of state?.goals ?? []) {
    const ga = `G${++g}`;
    toAlias.set(goal.id, ga);
    fromAlias.set(ga, goal.id);
    for (const req of goal.requirements ?? []) {
      const ra = `R${++r}`;
      toAlias.set(req.id, ra);
      fromAlias.set(ra, req.id);
    }
  }
  return { toAlias, fromAlias };
}

function aliasText(text, toAlias) {
  let out = text;
  for (const [real, alias] of toAlias) out = out.split(real).join(alias);
  return out;
}

function restoreAliases(value, fromAlias) {
  if (typeof value === 'string') return fromAlias.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => restoreAliases(v, fromAlias));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreAliases(v, fromAlias);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Offline heuristic: "I sent the invitations" without the model
// ---------------------------------------------------------------------------

const DONE_VERB_RE =
  /\b(sent|finished|completed|did|paid|booked|ordered|bought|picked up|cleaned|received|got|submitted|wrote|made|confirmed|handled|sorted|signed|filed|called|emailed|mailed|packed|done with)\b/i;
const NOT_DONE_RE =
  /\b(haven'?t|have not|not yet|didn'?t|did not|still need|need to|going to|gonna|will|want to|should|forgot)\b/i;

function heuristicActions(userText, state) {
  const t = String(userText ?? '');
  if (/\?/.test(t) || NOT_DONE_RE.test(t) || !DONE_VERB_RE.test(t)) return null;

  const all = [];
  for (const g of state?.goals ?? []) {
    for (const r of g.requirements ?? []) {
      if (r.status !== 'done') all.push({ ...r, goal_id: g.id, goal_title: g.title });
    }
  }
  if (all.length === 0) return null;

  const goalHit = bestLabelMatch(
    t,
    (state?.goals ?? []).map((g) => ({ id: g.id, label: g.title }))
  );
  let pool = all;
  if (goalHit && goalHit.tied.length === 1) {
    const narrowed = all.filter((r) => r.goal_id === goalHit.item.id);
    if (narrowed.length > 0) pool = narrowed;
  }

  const best = bestLabelMatch(t, pool);
  if (!best || best.tied.length !== 1) return null;

  const item = best.item;
  if (item.kind !== 'self_action' && !/\b(received|got|arrived|came)\b/i.test(t)) return null;

  const action = validateAction(
    {
      tool: 'update_item',
      args: {
        requirement_id: item.id,
        new_status: 'done',
        item_label: item.label,
        goal_title: item.goal_title,
      },
      confidence: 0.7,
      reason: 'offline heuristic',
    },
    state
  );
  return action.tool === 'update_item' ? [action] : null;
}

// ---------------------------------------------------------------------------
// A message that creates a goal and also talks about it
//
// The model cannot know ids for goals that do not exist yet, so anything it
// aimed at "the goal being created" (add tasks, mark one done, drop one, set
// the deadline) is folded into the create_goal itself.
// ---------------------------------------------------------------------------

function foldIntoCreates(rawActions, state) {
  const list = Array.isArray(rawActions) ? rawActions : [];
  if (!list.some((a) => a && a.tool === 'create_goal')) return list;

  const goalIds = new Set((state?.goals ?? []).map((g) => g.id));
  const itemIds = new Set();
  const existingItems = [];
  for (const g of state?.goals ?? []) {
    for (const r of g.requirements ?? []) {
      itemIds.add(r.id);
      existingItems.push(r);
    }
  }

  const clones = new Map();
  for (const a of list) {
    if (a && a.tool === 'create_goal') {
      const args = a.args && typeof a.args === 'object' ? a.args : {};
      clones.set(a, {
        ...a,
        args: {
          ...args,
          requirements: Array.isArray(args.requirements)
            ? args.requirements.filter((r) => r && typeof r === 'object').map((r) => ({ ...r }))
            : [],
        },
      });
    }
  }
  const firstClone = clones.values().next().value;

  const out = [];
  let lastSeen = null;

  const targetFor = (args) => {
    const hint = args?.goal_title;
    if (hint) {
      for (const c of clones.values()) {
        if (normalizeLabel(c.args.title) === normalizeLabel(hint)) return c;
      }
    }
    return lastSeen ?? firstClone;
  };

  const hasLabel = (target, label) =>
    target.args.requirements.some((r) => normalizeLabel(r.label) === normalizeLabel(label));

  const applyUpdate = (target, upd) => {
    const said = String(upd.item_label ?? upd.label ?? '').trim();
    if (!said || itemIds.has(upd.requirement_id)) return false;
    const createMatch = bestLabelMatch(said, target.args.requirements);
    if (!createMatch) return false;
    const existingMatch = bestLabelMatch(said, existingItems);
    if (existingMatch && existingMatch.ratio > createMatch.ratio) return false;
    const r = createMatch.item;
    if (STATUSES.includes(upd.new_status)) r.status = upd.new_status;
    if (upd.due_at) r.due_at = upd.due_at;
    if (upd.due_time) r.due_time = upd.due_time;
    if (upd.linked_label) r.linked_label = upd.linked_label;
    if (upd.progress_note) r.progress_note = upd.progress_note;
    return true;
  };

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.tool === 'create_goal') {
      const clone = clones.get(entry);
      lastSeen = clone;
      out.push(clone);
      continue;
    }

    const args = entry.args && typeof entry.args === 'object' ? entry.args : {};

    if (entry.tool === 'add_items') {
      const ids = Array.isArray(args.goal_ids)
        ? args.goal_ids
        : typeof args.goal_id === 'string' ? [args.goal_id] : [];
      const anyKnown = ids.some((id) => goalIds.has(id));
      if (!anyKnown) {
        const target = targetFor(args);
        for (const it of Array.isArray(args.items) ? args.items : []) {
          if (!it || typeof it.label !== 'string' || hasLabel(target, it.label)) continue;
          target.args.requirements.push({ ...it });
        }
        continue;
      }
    }

    if (entry.tool === 'set_new_deadline' && !goalIds.has(args.goal_id)) {
      const target = targetFor(args);
      if (args.new_deadline) target.args.deadline = args.new_deadline;
      if (args.new_deadline_time) target.args.deadline_time = args.new_deadline_time;
      continue;
    }

    if (entry.tool === 'update_item') {
      if (applyUpdate(targetFor(args), args)) continue;
    }

    if (entry.tool === 'update_items') {
      const target = targetFor(args);
      const rest = (Array.isArray(args.updates) ? args.updates : []).filter(
        (u) => !(u && typeof u === 'object' && applyUpdate(target, u))
      );
      if (rest.length === 0) continue;
      out.push({ ...entry, args: { ...args, updates: rest } });
      continue;
    }

    if (entry.tool === 'delete_item' && !itemIds.has(args.requirement_id)) {
      const said = String(args.item_label ?? args.label ?? '').trim();
      const target = targetFor(args);
      const match = said ? bestLabelMatch(said, target.args.requirements) : null;
      if (match) {
        target.args.requirements = target.args.requirements.filter((r) => r !== match.item);
        continue;
      }
    }

    out.push(entry);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cross-goal collision detection
// ---------------------------------------------------------------------------

export function checkCrossGoalCollision(action, state) {
  const singleItemTools = new Set([
    'update_item',
    'delete_item',
    'draft_followup',
    'send_followup',
  ]);
  if (!singleItemTools.has(action.tool)) return null;

  const reqId = action.args?.requirement_id;
  if (!reqId) return null;

  const goals = state?.goals ?? [];

  let chosen = null;
  for (const g of goals) {
    for (const r of g.requirements ?? []) {
      if (r.id === reqId) {
        chosen = { ...r, goal_id: g.id, goal_title: g.title };
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) return null;

  const chosenKey = normalizeLabel(chosen.label);

  const siblings = [];
  for (const g of goals) {
    if (g.id === chosen.goal_id) continue;
    for (const r of g.requirements ?? []) {
      if (normalizeLabel(r.label) === chosenKey) {
        siblings.push({ ...r, goal_id: g.id, goal_title: g.title });
      }
    }
  }

  if (siblings.length === 0) return null;

  const candidates = [chosen, ...siblings];

  const goalTitles = [...new Set(candidates.map((c) => c.goal_title))];
  const question = composeDisambiguateQuestion(chosen.label, goalTitles);

  const pendingActionArgs = { ...action.args };
  delete pendingActionArgs.requirement_id;
  delete pendingActionArgs.goal_id;
  delete pendingActionArgs.goal_title;
  delete pendingActionArgs.label;

  return {
    tool: 'ask_user',
    args: {
      question,
      expects_reply: true,
      __disambiguate: {
        candidates: candidates.map((c) => ({
          requirement_id: c.id,
          label: c.label,
          goal_id: c.goal_id,
          goal_title: c.goal_title,
        })),
        pending_action: {
          tool: action.tool,
          args: pendingActionArgs,
        },
      },
    },
    confidence: 0.4,
    reason: `disambiguate: "${chosen.label}" exists on ${candidates.length} goals`,
  };
}

// ---------------------------------------------------------------------------
// Disambiguation resolution
// ---------------------------------------------------------------------------

function resolveDisambiguate(action, pending, userText) {
  const candidates = pending.candidates ?? [];
  if (candidates.length === 0) return null;

  const pendingTool = pending.pending_action?.tool;
  const pendingArgs = pending.pending_action?.args ?? {};
  if (!pendingTool) return null;

  let chosen = null;

  const reqId = action?.args?.requirement_id;
  if (reqId) {
    chosen = candidates.find((c) => c.requirement_id === reqId) ?? null;
  }

  if (!chosen) {
    const goalId = action?.args?.goal_id;
    if (goalId) {
      chosen = candidates.find((c) => c.goal_id === goalId) ?? null;
    }
  }

  if (!chosen) {
    const lower = String(userText ?? '').toLowerCase();
    const matches = candidates
      .map((c) => {
        const title = String(c.goal_title ?? '').toLowerCase();
        const label = String(c.label ?? '').toLowerCase();
        let score = 0;
        if (title && lower.includes(title)) score += title.length;
        for (const word of title.split(/\s+/)) {
          if (word.length > 3 && lower.includes(word)) score += word.length;
        }
        if (label && lower.includes(label)) score += label.length;
        return { c, score };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score);

    if (matches.length > 0) {
      const best = matches[0];
      const second = matches[1];
      if (!second || best.score > second.score) {
        chosen = best.c;
      }
    }
  }

  if (!chosen) return null;

  return {
    tool: pendingTool,
    args: {
      ...pendingArgs,
      requirement_id: chosen.requirement_id,
      goal_id: chosen.goal_id,
      goal_title: chosen.goal_title,
      label: chosen.label,
    },
    confidence: 0.85,
    reason: `resolved disambiguate to "${chosen.goal_title}"`,
  };
}

function composeDisambiguateQuestion(label, goalTitles) {
  if (goalTitles.length === 2) {
    return `Which ${label} do you mean, the one for ${goalTitles[0]} or ${goalTitles[1]}?`;
  }
  const list = goalTitles.join(', ');
  return `Which ${label} do you mean? It's on ${list}.`;
}

// ---------------------------------------------------------------------------
// Validation — array shape
// ---------------------------------------------------------------------------

export function validateActions(raw, state) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [askUser(FALLBACK_QUESTION)];
  }

  if (Array.isArray(raw.actions)) {
    const slice = foldIntoCreates(raw.actions, state).slice(0, MAX_ACTIONS);
    const results = [];
    for (const entry of slice) {
      if (!entry || typeof entry !== 'object') continue;
      const single = validateAction(
        {
          tool: entry.tool,
          args: entry.args,
          confidence: entry.confidence ?? raw.confidence,
          reason: entry.reason ?? raw.reason,
        },
        state
      );
      results.push(single);
    }

    if (results.length === 0) {
      return [askUser(FALLBACK_QUESTION)];
    }

    // A question about one part of the message must not throw away the parts
    // that were clear. Keep the real actions and put ONE question after them.
    const acting = results.some(
      (r) => r.tool !== 'ask_user' && r.tool !== 'reply' && r.tool !== 'query'
    );
    // reply text is written before the actions run, so it cannot describe
    // their result. When anything changes state, the system speaks for itself.
    const real = results.filter(
      (r) => r.tool !== 'ask_user' && !(acting && r.tool === 'reply')
    );

    const seenQuestions = new Set();
    const asks = results.filter((r) => {
      if (r.tool !== 'ask_user') return false;
      const key = String(r.args.question).trim().toLowerCase();
      if (seenQuestions.has(key)) return false;
      seenQuestions.add(key);
      return true;
    });
    if (asks.length === 0) return real;
    if (real.length === 0) {
      return [asks.length === 1 ? asks[0] : mergeAsks(asks)];
    }
    return [...real, asks.length === 1 ? asks[0] : mergeAsks(asks)];
  }

  if (typeof raw.tool === 'string') {
    return [validateAction(raw, state)];
  }

  return [askUser(FALLBACK_QUESTION)];
}

// ---------------------------------------------------------------------------
// Validation — one action
// ---------------------------------------------------------------------------

export function validateAction(raw, state) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return askUser(FALLBACK_QUESTION);
  }
  if (typeof raw.tool !== 'string' || !TOOLS.includes(raw.tool)) {
    return askUser(FALLBACK_QUESTION);
  }

  const confidence = clampNumber(raw.confidence, 0, 1, 0.5);
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  const args = raw.args && typeof raw.args === 'object' ? raw.args : {};

  const goalsById = new Map((state?.goals ?? []).map((g) => [g.id, g]));
  const reqsById = new Map();
  for (const g of state?.goals ?? []) {
    for (const r of g.requirements ?? []) {
      reqsById.set(r.id, { ...r, goal_id: g.id, goal_title: g.title });
    }
  }

  if (confidence < CONFIDENCE_FLOOR && raw.tool !== 'ask_user') {
    return askUser(composeLowConfidenceQuestion(raw.tool, args, reqsById, goalsById));
  }

  switch (raw.tool) {
    case 'create_goal': {
      if (typeof args.title !== 'string' || !args.title.trim()) {
        return askUser('What should I call this one?');
      }
      const deadlineWhen = whenFields(args.deadline, args.deadline_time);
      if (args.deadline != null && !deadlineWhen.date) {
        return askUser("When is that due?");
      }
      if (args.goal_type != null && !KNOWN_GOAL_TYPES.includes(args.goal_type)) {
        args.goal_type = null;
      }
      const reqs = Array.isArray(args.requirements) ? args.requirements : [];
      const normalized = [];
      for (const r of reqs) {
        const n = normalizeRequirement(r);
        if (n) normalized.push(n);
      }
      return {
        tool: 'create_goal',
        args: {
          title: args.title.trim(),
          deadline: deadlineWhen.date,
          deadline_time: deadlineWhen.time,
          goal_type: args.goal_type ?? null,
          requirements: normalized,
        },
        confidence,
        reason,
      };
    }

    case 'add_items': {
      let rawIds = Array.isArray(args.goal_ids) ? args.goal_ids : null;
      if (!rawIds && typeof args.goal_id === 'string') {
        rawIds = [args.goal_id];
      }

      const active = state?.goals ?? [];
      const seen = new Set();
      const validIds = [];
      for (const id of rawIds ?? []) {
        if (typeof id !== 'string') continue;
        if (seen.has(id)) continue;
        if (!goalsById.has(id)) continue;
        seen.add(id);
        validIds.push(id);
      }

      if (validIds.length === 0) {
        if (active.length === 1) {
          validIds.push(active[0].id);
        } else if (active.length === 0) {
          return askUser('What goal is that for?');
        } else {
          return askUser(
            `Which one should I put that on, ${joinOr(active.map((g) => g.title))}?`
          );
        }
      }

      if (!Array.isArray(args.items) || args.items.length === 0) {
        return askUser('What would you like to add?');
      }
      const items = [];
      for (const it of args.items) {
        const n = normalizeAddedItem(it, reqsById);
        if (n) items.push(n);
      }
      if (items.length === 0) {
        return askUser('What would you like to add?');
      }

      return {
        tool: 'add_items',
        args: { goal_ids: validIds, items },
        confidence,
        reason,
      };
    }

    case 'update_item': {
      const item = resolveItem(args, reqsById, goalsById);
      if (!item) {
        return askUser(notFoundQuestion(args, goalsById, 'update'));
      }

      const hasStatus =
        typeof args.new_status === 'string' && STATUSES.includes(args.new_status);

      const detailFields = extractDetailFields(args);

      const statusEqualsCurrent = hasStatus && args.new_status === item.status;
      const effectiveStatus = statusEqualsCurrent ? null : (hasStatus ? args.new_status : null);

      if (!effectiveStatus && !hasAnyDetail(detailFields)) {
        return askUser(`What should I do with ${item.label}? Mark it done, change the date, or something else?`);
      }

      const baseArgs = {
        requirement_id: item.id,
        goal_id: item.goal_id,
        goal_title: item.goal_title,
        label: item.label,
      };

      if (!effectiveStatus) {
        return {
          tool: 'update_item',
          args: { ...baseArgs, ...detailFields },
          confidence,
          reason,
        };
      }

      const legal = allowedNextStates(item.kind, item.status);
      if (!legal.includes(effectiveStatus)) {
        const nearest = pickNearestLegal(effectiveStatus, legal);
        if (nearest) {
          const out = {
            ...baseArgs,
            new_status: nearest,
            __compressed_from: effectiveStatus,
            ...detailFields,
          };
          return {
            tool: 'update_item',
            args: out,
            confidence: Math.min(confidence, 0.6),
            reason: reason
              ? `${reason} (compressed ${effectiveStatus} -> ${nearest})`
              : `compressed ${effectiveStatus} -> ${nearest}`,
          };
        }
        return askUser(
          `${item.label} is ${prettyStatus(item.status)} right now. What should it be?`
        );
      }

      return {
        tool: 'update_item',
        args: { ...baseArgs, new_status: effectiveStatus, ...detailFields },
        confidence,
        reason,
      };
    }

    case 'update_items': {
      const rawUpdates = Array.isArray(args.updates) ? args.updates : [];
      if (rawUpdates.length === 0) {
        return askUser('What would you like to update?');
      }

      const validUpdates = [];
      const seenIds = new Set();

      const notFound = [];
      for (const u of rawUpdates) {
        if (!u || typeof u !== 'object') continue;
        const item = resolveItem(u, reqsById, goalsById);
        if (!item) {
          if (u.item_label) notFound.push(String(u.item_label));
          continue;
        }
        if (seenIds.has(item.id)) continue;

        const hasStatus =
          typeof u.new_status === 'string' && STATUSES.includes(u.new_status);
        const detailFields = extractDetailFields(u);

        const statusEqualsCurrent = hasStatus && u.new_status === item.status;
        const effectiveStatus = statusEqualsCurrent ? null : (hasStatus ? u.new_status : null);

        if (!effectiveStatus && !hasAnyDetail(detailFields)) continue;

        seenIds.add(item.id);

        if (!effectiveStatus) {
          validUpdates.push({
            requirement_id: item.id,
            goal_id: item.goal_id,
            goal_title: item.goal_title,
            label: item.label,
            ...detailFields,
          });
          continue;
        }

        const legal = allowedNextStates(item.kind, item.status);
        let targetStatus = effectiveStatus;
        let compressedFrom = undefined;

        if (!legal.includes(targetStatus)) {
          const nearest = pickNearestLegal(targetStatus, legal);
          if (nearest) {
            compressedFrom = targetStatus;
            targetStatus = nearest;
          } else {
            continue;
          }
        }

        const entry = {
          requirement_id: item.id,
          goal_id: item.goal_id,
          goal_title: item.goal_title,
          label: item.label,
          new_status: targetStatus,
          ...detailFields,
        };
        if (compressedFrom) entry.__compressed_from = compressedFrom;
        validUpdates.push(entry);
      }

      if (validUpdates.length === 0) {
        return askUser(
          notFound.length > 0
            ? `I don't see ${joinWithAnd(notFound)} on your list. Want me to add ${notFound.length === 1 ? 'it' : 'them'}?`
            : 'Which tasks do you mean?'
        );
      }

      if (validUpdates.length === 1) {
        const u = validUpdates[0];
        return {
          tool: 'update_item',
          args: u,
          confidence,
          reason,
        };
      }

      return {
        tool: 'update_items',
        args: { updates: validUpdates },
        confidence,
        reason,
      };
    }

    case 'delete_goal': {
      const goal = goalsById.get(args.goal_id);
      if (!goal) return askUser('Which goal do you want to delete?');
      return {
        tool: 'delete_goal',
        args: { goal_id: goal.id, goal_title: goal.title },
        confidence,
        reason,
      };
    }

    case 'delete_item': {
      const item = resolveItem(args, reqsById, goalsById);
      if (!item) return askUser(notFoundQuestion(args, goalsById, 'delete'));
      return {
        tool: 'delete_item',
        args: {
          requirement_id: item.id,
          label: item.label,
          goal_id: item.goal_id,
          goal_title: item.goal_title,
        },
        confidence,
        reason,
      };
    }

    case 'delete_goal_confirmed': {
      const goal = goalsById.get(args.goal_id);
      if (!goal) return askUser('Which goal do you want to delete?');
      return {
        tool: 'delete_goal_confirmed',
        args: { goal_id: goal.id, goal_title: goal.title },
        confidence,
        reason,
      };
    }

    case 'delete_item_confirmed': {
      const item = resolveItem(args, reqsById, goalsById);
      if (!item) return askUser(notFoundQuestion(args, goalsById, 'delete'));
      return {
        tool: 'delete_item_confirmed',
        args: {
          requirement_id: item.id,
          label: item.label,
          goal_id: item.goal_id,
          goal_title: item.goal_title,
        },
        confidence,
        reason,
      };
    }

    case 'query': {
      if (!QUERY_KINDS.includes(args.kind)) {
        args.kind = 'list';
      }
      return { tool: 'query', args: { kind: args.kind }, confidence, reason };
    }

    case 'draft_followup':
    case 'send_followup': {
      const item = resolveItem(args, reqsById, goalsById);
      if (!item) return askUser(notFoundQuestion(args, goalsById, 'other'));
      if (item.kind !== 'external_dependency') {
        return askUser(
          `${item.label} isn't waiting on anyone else, so there's nobody to chase.`
        );
      }
      const outArgs = {
        requirement_id: item.id,
        label: item.label,
        goal_id: item.goal_id,
        goal_title: item.goal_title,
        depends_on: item.depends_on ?? null,
      };
      if (raw.tool === 'send_followup') {
        outArgs.draft = typeof args.draft === 'string' ? args.draft : null;
      }
      return { tool: raw.tool, args: outArgs, confidence, reason };
    }

    case 'snooze_reminder': {
      let days = Number(args.until_days);
      if (!Number.isFinite(days) || days <= 0) days = 1;
      days = Math.min(90, Math.round(days));
      return {
        tool: 'snooze_reminder',
        args: { until_days: days },
        confidence,
        reason,
      };
    }

    case 'set_new_deadline': {
      const goal = goalsById.get(args.goal_id);
      if (!goal) return askUser('Which goal should I set a new deadline for?');
      const newWhen = whenFields(args.new_deadline, args.new_deadline_time);
      if (!newWhen.date) {
        return askUser('What should the new deadline be?');
      }
      return {
        tool: 'set_new_deadline',
        args: {
          goal_id: goal.id,
          goal_title: goal.title,
          new_deadline: newWhen.date,
          new_deadline_time: newWhen.time,
        },
        confidence,
        reason,
      };
    }

    case 'complete_goal': {
      const resolved = resolveGoalId(args.goal_id, goalsById);
      if (!resolved) {
        const active = state?.goals ?? [];
        if (active.length === 1) {
          // fall through with the single active goal
        } else {
          return askUser('Which goal did you finish?');
        }
      }
      const goal = resolved ?? (state?.goals ?? [])[0];
      if (!goal) return askUser('Which goal did you finish?');

      const spinOffIds = Array.isArray(args.spin_off) ? args.spin_off : [];
      const goalReqs = goal.requirements ?? [];
      const spinOff = [];
      for (const id of spinOffIds) {
        if (typeof id !== 'string') continue;
        const req = goalReqs.find((r) => r.id === id);
        if (!req) continue;
        if (req.status === 'done') continue;
        if (!spinOff.includes(req.id)) spinOff.push(req.id);
      }

      const spinOffDeadline = parseWhen(args.spin_off_deadline).date;

      return {
        tool: 'complete_goal',
        args: {
          goal_id: goal.id,
          goal_title: goal.title,
          spin_off: spinOff,
          spin_off_deadline: spinOffDeadline,
        },
        confidence,
        reason,
      };
    }

    case 'note_context': {
      const resolved = resolveGoalId(args.goal_id, goalsById);
      let goal = resolved;
      if (!goal) {
        const active = state?.goals ?? [];
        if (active.length === 1) goal = active[0];
      }
      if (!goal) return askUser('Which goal is that about?');
      if (typeof args.text !== 'string' || !args.text.trim()) {
        return askUser('What should I note down?');
      }
      const text = args.text.trim().slice(0, 300);
      return {
        tool: 'note_context',
        args: { goal_id: goal.id, goal_title: goal.title, text },
        confidence,
        reason,
      };
    }

    case 'move_item': {
      const item = resolveItem(args, reqsById, goalsById);
      if (!item) return askUser(notFoundQuestion(args, goalsById, 'other'));

      const hasToGoal =
        typeof args.to_goal_id === 'string' && goalsById.has(args.to_goal_id);
      const hasNewGoal =
        typeof args.new_goal_title === 'string' && args.new_goal_title.trim().length > 0;

      if (hasToGoal && hasNewGoal) {
        return askUser('Where should I move it — an existing goal, or a new one?');
      }

      if (hasToGoal) {
        if (args.to_goal_id === item.goal_id) {
          return askUser(`"${item.label}" is already on "${item.goal_title}".`);
        }
        const target = goalsById.get(args.to_goal_id);
        return {
          tool: 'move_item',
          args: {
            requirement_id: item.id,
            label: item.label,
            from_goal_id: item.goal_id,
            from_goal_title: item.goal_title,
            to_goal_id: target.id,
            to_goal_title: target.title,
          },
          confidence,
          reason,
        };
      }

      if (hasNewGoal) {
        if (!parseWhen(args.deadline).date) {
          return askUser('What deadline should the new task have?');
        }
        return {
          tool: 'move_item',
          args: {
            requirement_id: item.id,
            label: item.label,
            from_goal_id: item.goal_id,
            from_goal_title: item.goal_title,
            new_goal_title: args.new_goal_title.trim(),
            deadline: parseWhen(args.deadline).date,
          },
          confidence,
          reason,
        };
      }

      return askUser('Where should I move it?');
    }

    case 'undo': {
      return { tool: 'undo', args: {}, confidence, reason };
    }

    case 'reply': {
      const text = typeof args.text === 'string' ? args.text.trim().slice(0, 500) : '';
      if (!text) return askUser(FALLBACK_QUESTION);
      return { tool: 'reply', args: { text }, confidence, reason };
    }

    case 'ask_user': {
      if (typeof args.question !== 'string' || !args.question.trim()) {
        return askUser('Could you say that again?');
      }
      const outArgs = {
        question: args.question.trim(),
        expects_reply: args.expects_reply !== false,
      };
      if (args.__disambiguate) outArgs.__disambiguate = args.__disambiguate;
      if (args.__retryable) outArgs.__retryable = true;
      return {
        tool: 'ask_user',
        args: outArgs,
        confidence,
        reason,
      };
    }

    default:
      return askUser('Could you say that again?');
  }
}

// ---------------------------------------------------------------------------
// Per-tool normalization helpers
// ---------------------------------------------------------------------------

function normalizeRequirement(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.label !== 'string' || !raw.label.trim()) return null;
  const label = raw.label.trim();
  const kindRaw = raw.kind;
  const kind = normalizeKind(kindRaw) ?? 'self_action';
  if (normalizeKind(kindRaw) === null && kindRaw != null) {
    console.warn('[onward/interpreter] bad kind', kindRaw);
  }
  const status = startStatus(raw.status, kind);
  const dependsOn =
    typeof raw.depends_on === 'string' && raw.depends_on.trim()
      ? raw.depends_on.trim()
      : null;
  const turnaround = Number(raw.turnaround_days);
  const turnaroundDays =
    Number.isFinite(turnaround) && turnaround > 0 ? Math.round(turnaround) : null;
  const due = whenFields(raw.due_at, raw.due_time);
  return {
    label,
    kind,
    status,
    depends_on: dependsOn,
    turnaround_days: turnaroundDays,
    due_at: due.date,
    due_time: due.time,
    expected_at: isoOrNull(raw.expected_at),
    linked_requirement_id: null,
    linked_label:
      typeof raw.linked_label === 'string' && raw.linked_label.trim()
        ? raw.linked_label.trim()
        : null,
    progress_note:
      typeof raw.progress_note === 'string' && raw.progress_note.trim()
        ? raw.progress_note.trim().slice(0, 120)
        : null,
  };
}

function normalizeAddedItem(raw, reqsById) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.label !== 'string' || !raw.label.trim()) return null;
  const label = raw.label.trim();

  const kindVal = normalizeKind(raw.kind);
  const kind = kindVal === 'external_dependency' ? 'external_dependency' : kindVal === 'self_action' ? 'self_action' : null;

  const status = startStatus(raw.status, kind ?? 'self_action');
  const dependsOn =
    typeof raw.depends_on === 'string' && raw.depends_on.trim()
      ? raw.depends_on.trim()
      : null;
  const turnaround = Number(raw.turnaround_days);
  const turnaroundDays =
    Number.isFinite(turnaround) && turnaround > 0 ? Math.round(turnaround) : null;

  const due = whenFields(raw.due_at, raw.due_time);
  const dueAt = due.date;
  const expectedAt = isoOrNull(raw.expected_at);

  let linked = null;
  if (typeof raw.linked_requirement_id === 'string' && reqsById.has(raw.linked_requirement_id)) {
    linked = raw.linked_requirement_id;
  }

  return {
    label,
    kind,
    status,
    depends_on: dependsOn,
    turnaround_days: turnaroundDays,
    due_at: dueAt,
    due_time: due.time,
    expected_at: expectedAt,
    linked_requirement_id: linked,
    linked_label:
      typeof raw.linked_label === 'string' && raw.linked_label.trim()
        ? raw.linked_label.trim()
        : null,
    progress_note:
      typeof raw.progress_note === 'string' && raw.progress_note.trim()
        ? raw.progress_note.trim().slice(0, 120)
        : null,
  };
}

function extractDetailFields(args) {
  const out = {};
  if (typeof args.depends_on === 'string' && args.depends_on.trim()) {
    out.depends_on = args.depends_on.trim();
  }
  const t = Number(args.turnaround_days);
  if (Number.isFinite(t) && t > 0) out.turnaround_days = Math.round(t);
  const due = whenFields(args.due_at, args.due_time);
  if (due.date) out.due_at = due.date;
  if (due.time) out.due_time = due.time;
  const exp = isoOrNull(args.expected_at);
  if (exp) out.expected_at = exp;
  if (typeof args.progress_note === 'string' && args.progress_note.trim()) {
    out.progress_note = args.progress_note.trim().slice(0, 120);
  }
  if (typeof args.linked_label === 'string' && args.linked_label.trim()) {
    out.linked_label = args.linked_label.trim();
  }
  return out;
}

function hasAnyDetail(fields) {
  return Object.keys(fields).length > 0;
}

function isoOrNull(v) {
  return parseWhen(v).date;
}

function whenFields(value, explicitTime) {
  const w = parseWhen(value);
  return { date: w.date, time: w.time ?? validTime(explicitTime) };
}

// Statuses a brand-new task may start with.
function startStatus(raw, kind) {
  if (raw === 'done') return 'done';
  if (raw === 'in_progress') return 'in_progress';
  if (raw === 'waiting_on_other' && kind === 'external_dependency') return 'waiting_on_other';
  return 'not_started';
}

/**
 * Find the item the user means. The model's id is trusted only when it agrees
 * with the words the user used (item_label); otherwise the list is searched by
 * name, inside the named goal when there is one.
 */
function resolveItem(args, reqsById, goalsById) {
  const claimed = reqsById.get(args?.requirement_id) ?? null;
  const said = String(args?.item_label ?? '').trim();
  const goalHint =
    goalsById.get(args?.goal_id) ??
    [...goalsById.values()].find(
      (g) => args?.goal_title && normalizeLabel(g.title) === normalizeLabel(args.goal_title)
    ) ??
    null;

  if (!said) return claimed;

  const pool = [...reqsById.values()].filter(
    (r) => !goalHint || r.goal_id === goalHint.id
  );
  const best = bestLabelMatch(said, pool);

  if (claimed) {
    const mine = labelOverlap(said, claimed.label);
    if (mine.shared >= 1 && (!best || mine.shared >= best.shared)) return claimed;
  }
  if (!best) return null;
  if (best.tied.length > 1) {
    return claimed && best.tied.some((t) => t.id === claimed.id) ? claimed : best.item;
  }
  return best.item;
}

function notFoundQuestion(args, goalsById, verb) {
  const said = String(args?.item_label ?? '').trim();
  const goal = goalsById.get(args?.goal_id) ?? null;
  const where = goal ? ` on ${goal.title}` : '';
  if (!said) {
    return verb === 'delete'
      ? 'Which task do you want me to remove?'
      : 'Which task do you mean?';
  }
  if (verb === 'delete') {
    return `I don't see ${said}${where}, so there's nothing to remove.`;
  }
  if (verb === 'update') {
    return `I don't see ${said}${where} on your list. Want me to add it?`;
  }
  return `I don't see ${said}${where} on your list.`;
}

function resolveGoalId(raw, goalsById) {
  if (typeof raw === 'string' && goalsById.has(raw)) return goalsById.get(raw);
  return null;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderState(state, { compact = false } = {}) {
  const goals = state?.goals ?? [];
  if (goals.length === 0) return '';
  const lines = [];
  for (const g of goals) {
    const ctx = g.context == null ? 'null' : JSON.stringify(g.context);
    lines.push(
      `GOAL id=${g.id} title=${JSON.stringify(g.title)} ` +
        `deadline=${String(g.deadline).slice(0, 10)}` +
        `${g.deadline_time ? ` deadline_time=${g.deadline_time}` : ''} ` +
        `goal_type=${g.goal_type ?? 'null'} status=${g.status} ` +
        `context=${ctx}`
    );
    let skippedDone = 0;
    for (const r of g.requirements ?? []) {
      if (compact && r.status === 'done') {
        skippedDone++;
        continue;
      }
      const legal = allowedNextStates(r.kind, r.status);
      const extras = [];
      if (r.due_time) extras.push(`due_time=${r.due_time}`);
      if (r.depends_on) extras.push(`depends_on=${JSON.stringify(r.depends_on)}`);
      if (r.requested_at) extras.push(`requested_at=${r.requested_at}`);
      if (r.received_at) extras.push(`received_at=${r.received_at}`);
      if (r.due_at) extras.push(`due_at=${r.due_at}`);
      if (r.expected_at) extras.push(`expected_at=${r.expected_at}`);
      if (r.linked_requirement_id) extras.push(`linked_to=${r.linked_requirement_id}`);
      lines.push(
        `  ITEM id=${r.id} label=${JSON.stringify(r.label)} kind=${r.kind} ` +
          `status=${r.status} legal_next=[${legal.join(', ')}]` +
          (extras.length > 0 ? ` ${extras.join(' ')}` : '')
      );
    }
    if (skippedDone > 0) lines.push(`  (${skippedDone} more items already done, not shown)`);
  }
  return lines.join('\n');
}

function renderHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  return history
    .slice(-10)
    .map((h) => `${h.role === 'user' ? 'USER' : 'ONWARD'}: ${String(h.content ?? '')}`)
    .join('\n');
}

function renderPendingContext(pc) {
  if (!pc || typeof pc !== 'object') return '';

  const lines = ['Pending question (you asked the user this and are waiting on a reply):'];

  if (pc.kind === 'suggestion_offer' && pc.multi === true && pc.offers && typeof pc.offers === 'object') {
    lines.push('  Kind: suggestion_offer, multi: true');
    lines.push('  You just created several goals and offered items for each.');
    lines.push('  Offered labels, per goal (goal_id -> goal_title -> labels):');
    for (const [goalId, offer] of Object.entries(pc.offers)) {
      const title = offer?.goal_title ?? '(unknown)';
      lines.push(`    - goal_id=${goalId}  title=${JSON.stringify(title)}`);
      const offered = Array.isArray(offer?.offered_labels) ? offer.offered_labels : [];
      if (offered.length === 0) {
        lines.push('        (nothing offered for this goal)');
      } else {
        for (const label of offered) {
          lines.push(`        - ${JSON.stringify(label)}`);
        }
      }
    }
    lines.push('  How to resolve — see rule M4:');
    lines.push('    "add them" / "yes" / "add all" / "everything"');
    lines.push('      -> one add_items per goal in this map, each with its');
    lines.push('         own goal_ids and that goal\'s offered labels.');
    lines.push('    "just the kids ones" / "only the grocery items" / any');
    lines.push('    phrase naming one or more goals');
    lines.push('      -> one add_items per named goal, only that goal\'s labels.');
    lines.push('    "add X and Y" where X and Y are labels the user named');
    lines.push('      -> one add_items per goal, each with the labels for it.');
    lines.push('    "no" / "none" -> ask_user with a short acknowledgement.');
    lines.push('    new topic -> emit the new action + abandons_pending: true.');
    return lines.join('\n');
  }

  if (pc.kind === 'suggestion_offer') {
    lines.push(`  Kind: suggestion_offer`);
    lines.push(`  Goal: "${pc.goal_title ?? '(unknown)'}" id=${pc.goal_id ?? '?'}`);
    lines.push(`  You just created this goal and suggested items for it.`);
    if (Array.isArray(pc.offered_labels) && pc.offered_labels.length > 0) {
      lines.push(`  Offered labels (these are the items you named):`);
      for (const l of pc.offered_labels) {
        lines.push(`    - ${JSON.stringify(l)}`);
      }
    }
    if (Array.isArray(pc.all_missing_labels) && pc.all_missing_labels.length > 0) {
      lines.push(`  All missing labels on this goal (superset):`);
      for (const l of pc.all_missing_labels) {
        lines.push(`    - ${JSON.stringify(l)}`);
      }
    }
    lines.push('  How to resolve:');
    lines.push('    "add them" / "yes" / "no, add them" / "sure"');
    lines.push('      -> add_items with goal_ids: [<goal id>] and the OFFERED LABELS.');
    lines.push('    "add all of them" / "add everything"');
    lines.push('      -> add_items with the same goal and ALL MISSING LABELS.');
    lines.push('    "I have X and Y" / "I already have X"');
    lines.push('      -> add_items with the same goal and the items named, status done.');
    lines.push('    "no" / "none" / "nothing else"');
    lines.push('      -> ask_user with a short acknowledgement, expects_reply false.');
    lines.push('    anything that is clearly a new topic');
    lines.push('      -> emit the tool for the new topic and set abandons_pending: true.');
    return lines.join('\n');
  }

  if (pc.kind === 'await_deadlines') {
    lines.push('  Kind: await_deadlines');
    lines.push('  You created goals and asked the user for the dates of these:');
    for (const p of pc.partials ?? []) {
      lines.push(`    - ${JSON.stringify(p.title)}`);
    }
    lines.push('  The system reads date replies for these on its own. If the user');
    lines.push('  has moved on to something else, handle the new message normally.');
    lines.push('  Do NOT create these goals again.');
    return lines.join('\n');
  }

  if (pc.kind === 'disambiguate') {
    lines.push(`  Kind: disambiguate`);
    lines.push(`  Question you asked: ${JSON.stringify(pc.question ?? '')}`);
    if (Array.isArray(pc.candidates) && pc.candidates.length > 0) {
      lines.push(`  Candidates (pick one based on the user's reply):`);
      for (const c of pc.candidates) {
        lines.push(
          `    - requirement_id=${c.requirement_id} ` +
            `label=${JSON.stringify(c.label)} ` +
            `on goal ${JSON.stringify(c.goal_title)} (goal_id=${c.goal_id})`
        );
      }
    }
    if (pc.pending_action && typeof pc.pending_action === 'object') {
      lines.push(
        `  pending_action (the system will execute this once you pick): ` +
          `tool=${pc.pending_action.tool} ` +
          `args=${JSON.stringify(pc.pending_action.args ?? {})}`
      );
    }
    lines.push('  Your job on this turn: identify WHICH candidate the user picked.');
    lines.push('  Emit any tool that references the chosen candidate\'s');
    lines.push('  requirement_id (update_item is safest). The system will');
    lines.push('  override the tool with pending_action.tool afterward.');
    lines.push('  If the reply declines, emit ask_user with expects_reply false.');
    lines.push('  If the reply is a new topic, set abandons_pending: true.');
    return lines.join('\n');
  }

  if (typeof pc.question === 'string' && pc.question.trim()) {
    lines.push(`  Question: ${pc.question.trim()}`);
  }

  if (Array.isArray(pc.candidates) && pc.candidates.length > 0) {
    lines.push('  Candidates the user can pick from:');
    for (const c of pc.candidates) {
      const id = c.id ?? c.requirement_id ?? c.goal_id ?? '?';
      const label = c.label ?? c.goal_title ?? c.title ?? '?';
      const extra = c.goal_title && c.label ? ` (on "${c.goal_title}")` : '';
      lines.push(`    - id=${id} label=${JSON.stringify(label)}${extra}`);
    }
  }

  if (pc.on_yes && typeof pc.on_yes === 'object') {
    lines.push(
      `  If the user says yes, the system will execute: tool=${pc.on_yes.tool} args=${JSON.stringify(pc.on_yes.args ?? {})}`
    );
    lines.push('  Emit that tool directly with those args if the user confirms.');
  }

  lines.push('  Decide: is the user\'s new message an answer, or a new topic?');
  lines.push('  If an answer, emit the tool that resolves it using the ids above.');
  lines.push('  If a new topic, emit the tool for the new topic and set args.abandons_pending = true.');

  return lines.join('\n');
}

function renderPendingFlag(flag) {
  if (!flag || typeof flag !== 'object') return '';
  const lines = ['Reminder flag (you showed this to the user and they have not acted on it):'];
  if (flag.goal_title) lines.push(`  Goal: "${flag.goal_title}"`);
  if (flag.moment_kind) lines.push(`  Moment: ${flag.moment_kind}`);
  if (flag.risk_level) lines.push(`  Risk: ${flag.risk_level}`);
  if (flag.message) lines.push(`  Message you showed: ${flag.message}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function mergeAsks(asks) {
  return {
    tool: 'ask_user',
    args: {
      question: asks
        .slice(0, 3)
        .map((a) => a.args.question)
        .join(' '),
      expects_reply: true,
    },
    confidence: 0.5,
    reason: 'merged questions',
  };
}

function askUser(question, { expectsReply = true, retryable = false } = {}) {
  const args = { question, expects_reply: expectsReply };
  if (retryable) args.__retryable = true;
  return {
    tool: 'ask_user',
    args,
    confidence: 0,
    reason: 'fallback',
  };
}

function clampNumber(v, lo, hi, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function toIsoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekdayName(d) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[d.getUTCDay()];
}

function shiftByUserOffset(d) {
  const offsetMinutes = Number(process.env.USER_UTC_OFFSET_MINUTES ?? 0);
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  return new Date(d.getTime() + offset * 60 * 1000);
}

function joinOr(items) {
  const list = (items ?? []).filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} or ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`;
}

function prettyStatus(s) {
  switch (s) {
    case 'not_started':      return 'not started';
    case 'in_progress':      return 'in progress';
    case 'waiting_on_other': return 'waiting on someone';
    case 'done':             return 'done';
    default:                 return s;
  }
}

function pickNearestLegal(proposed, legal) {
  if (!Array.isArray(legal) || legal.length === 0) return null;
  if (legal.includes(proposed)) return proposed;
  const ORDER = ['done', 'waiting_on_other', 'in_progress', 'not_started'];
  const proposedIdx = ORDER.indexOf(proposed);
  if (proposedIdx < 0) return legal[0];
  const forward = proposed === 'done';
  const sorted = [...legal].sort((a, b) => {
    const ai = ORDER.indexOf(a);
    const bi = ORDER.indexOf(b);
    return forward ? ai - bi : bi - ai;
  });
  return sorted[0] ?? null;
}

function composeLowConfidenceQuestion(tool, args, reqsById, goalsById) {
  if ((tool === 'update_item' || tool === 'update_items') && args.requirement_id) {
    const item = reqsById.get(args.requirement_id);
    if (item) {
      return `Just checking, do you want me to update ${item.label}?`;
    }
  }
  if (tool === 'delete_goal' && args.goal_id) {
    const goal = goalsById.get(args.goal_id);
    if (goal) {
      return `Just checking, do you want me to delete ${goal.title}?`;
    }
  }
  if (tool === 'delete_item' && args.requirement_id) {
    const item = reqsById.get(args.requirement_id);
    if (item) {
      return `Just checking, do you want me to delete ${item.label}?`;
    }
  }
  if (tool === 'add_items' && Array.isArray(args.items) && args.items.length > 0) {
    const labels = args.items.map((i) => i.label).join(', ');
    return `Just checking, do you want me to add ${labels}?`;
  }
  if (tool === 'create_goal' && typeof args.title === 'string') {
    return `Just checking, should I start tracking ${args.title}?`;
  }
  if (tool === 'set_new_deadline' && args.goal_id) {
    const goal = goalsById.get(args.goal_id);
    if (goal) {
      return `Just checking, do you want to change the deadline on ${goal.title}?`;
    }
  }
  return "I want to make sure I get this right. What did you want me to do?";
}