// Onward — single-turn interpreter.
//
// One LLM call per user turn. The model is given the user's message,
// the full current state, recent history, and any pending context.
//
// The model returns ONE structured action from a closed set of tools.
// This file validates the action, applies a deterministic goal_type
// backfill for create_goal, checks for cross-goal label collisions,
// and deterministically resolves disambiguation turns.

import { callLLM } from '../llm.js';
import { allowedNextStates, STATUSES } from './requirementService.js';
import { detectGoalType } from './extraction.js';
import { normalizeLabel } from './completenessService.js';

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
]);

export const QUERY_KINDS = Object.freeze(['left', 'at_risk', 'next', 'list']);

const CONFIDENCE_FLOOR = 0.5;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are Onward, a proactive assistant for deadline-bound goals that depend',
  'on other people or institutions responding. The user talks to you in plain',
  'language. Your job is to pick ONE action per turn, using the tools below,',
  'and return it as JSON. Do not narrate. Do not explain. Just the action.',
  '',
  'You are given:',
  '  - The user\'s current goals, each with an id, title, deadline, goal_type.',
  '  - Each goal\'s requirements with ids, labels, kinds, statuses, and the',
  '    legal next statuses for each item.',
  '  - The last few turns of the conversation.',
  '  - Optionally, the question you previously asked and are waiting on.',
  '  - Optionally, a reminder you already showed the user (a "flag").',
  '  - The user\'s new message.',
  '',
  'AVAILABLE TOOLS:',
  '',
  '1. create_goal',
  '   Use when the user is describing a NEW goal with a deadline.',
  '   Args:',
  '     title:      short human title',
  '     deadline:   "YYYY-MM-DD" (resolve relative dates against today)',
  '     goal_type:  one of the known types below, or null if unsure',
  '     requirements: array of { label, kind, status }',
  '   Known goal types:',
  '     grad_scholarship_application, visa_permit_application,',
  '     job_application_with_references, grant_application, signed_form_return,',
  '     school_enrollment, camp_registration, doctor_appointment_paperwork,',
  '     lease_signing, tax_filing',
  '',
  '2. add_items',
  '   Use when the user is naming items to add to one or more EXISTING',
  '   goals, OR when the user is resolving a suggestion_offer.',
  '   Args:',
  '     goal_ids:   array of goal ids to add the items to.',
  '     items:      array of { label, kind, status }',
  '',
  '3. update_item',
  '   Use when the user is reporting a SINGLE status change on ONE item.',
  '   Args:',
  '     requirement_id: id of the item',
  '     new_status:     one of the legal next statuses listed for that item',
  '',
  '3b. update_items',
  '   Use when the user reports MORE THAN ONE status change in a single',
  '   message. This is mandatory when there are two or more changes. Do',
  '   NOT use update_item in that case. Do NOT pick one change and drop',
  '   the others.',
  '   Args:',
  '     updates: array of { requirement_id, new_status }, one entry per',
  '     change, in the order the user mentioned them.',
  '',
  '   EXAMPLES — study these carefully, they are the pattern to follow:',
  '',
  '   User message: "I just received the police clearance and paid the',
  '   visa fees"',
  '   -> { "tool": "update_items", "args": { "updates": [',
  '        { "requirement_id": "<police clearance id>", "new_status": "done" },',
  '        { "requirement_id": "<visa fee id>",         "new_status": "done" }',
  '      ] } }',
  '',
  '   User message: "I sent the reference request and finished my CV"',
  '   -> { "tool": "update_items", "args": { "updates": [',
  '        { "requirement_id": "<reference id>", "new_status": "waiting_on_other" },',
  '        { "requirement_id": "<cv id>",        "new_status": "done" }',
  '      ] } }',
  '',
  '   User message: "the transcript arrived and I\'m working on the',
  '   personal statement"',
  '   -> { "tool": "update_items", "args": { "updates": [',
  '        { "requirement_id": "<transcript id>", "new_status": "done" },',
  '        { "requirement_id": "<sop id>",        "new_status": "in_progress" }',
  '      ] } }',
  '',
  '   User message: "the birth certificate came in"',
  '   -> { "tool": "update_item", "args": {',
  '        "requirement_id": "<birth cert id>", "new_status": "done"',
  '      } }',
  '   (Only one change, so update_item.)',
  '',
  '   The test: count the distinct status changes in the message. One',
  '   change -> update_item. Two or more -> update_items with all of',
  '   them. If you emit update_item for a message that contains more',
  '   than one change, you are wrong.',
  '',
  '   PHRASING -> STATUS MAPPING (applies to update_item and update_items).',
  '',
  '   Do not match against a list of phrasings. Reason about what the',
  '   user means. Every status change describes one of three situations.',
  '',
  '   SELF_ACTION items (the user produces it themselves):',
  '     - The item does not exist yet. -> not_started',
  '     - The item is in progress: the user is actively working on it',
  '       right now, present tense, unfinished. "I\'m filling in the',
  '       form", "I\'m drafting it", "I\'m working on it". -> in_progress',
  '     - The item exists in its finished form. -> done',
  '       This includes completions phrased as actions in the past tense:',
  '         "I filled the form" / "the form is filled" /',
  '         "I filled out the form"',
  '         "I wrote it" / "it\'s written"',
  '         "I finished it" / "it\'s done" / "it\'s ready"',
  '         "I submitted it" / "I sent it"',
  '       If the user describes having completed the action, the item',
  '       is done. "I filled the form" means the form is filled. That',
  '       is done, NOT in progress.',
  '',
  '   EXTERNAL_DEPENDENCY items (someone else produces it):',
  '     - The request has not gone out yet. -> not_started',
  '     - The request is out and the response has not come back.',
  '       -> waiting_on_other',
  '     - The item has arrived. -> done',
  '',
  '   The distinguishing question: does the user currently have the',
  '   finished item in hand? If yes, done. If no, decide whether they',
  '   are waiting on someone else (external, waiting_on_other), actively',
  '   working on it themselves (self, in_progress), or haven\'t started',
  '   (not_started).',
  '',
  '   Special rule for self_action: "I did X" and "X is now in a state"',
  '   both mean the item exists now. -> done. Only "I am doing X" or',
  '   "I\'m working on X" (present tense, unfinished) is in_progress.',
  '',
  '   ITEM MATCHING:',
  '     If the user mentions an item loosely, look for a matching item in',
  '     the state. If exactly one item matches by label, use its id. If',
  '     two or more items match, pick the one with the best label overlap',
  '     and emit the operation on it. The system will detect cross-goal',
  '     collisions afterward.',
  '',
  '   ILLEGAL TRANSITIONS:',
  '     If the user\'s phrasing implies a status not in the item\'s legal_next',
  '     list, emit the CLOSEST LEGAL status with a note in "reason".',
  '',
  '4. delete_goal',
  '   Use when the user wants to remove an entire goal.',
  '   Args: goal_id.',
  '',
  '5. delete_item',
  '   Use when the user wants to remove an item but keep the goal.',
  '   Args: requirement_id.',
  '',
  '6. delete_goal_confirmed',
  '   Emit ONLY when resolving a yes/no pending and the user said yes to',
  '   deleting a goal. Args: goal_id.',
  '',
  '7. delete_item_confirmed',
  '   Emit ONLY when resolving a yes/no pending and the user said yes to',
  '   deleting an item. Args: requirement_id.',
  '',
  '8. query',
  '   Use when the user is asking about their goals or state.',
  '   Args: kind — one of "left", "at_risk", "next", "list".',
  '',
  '9. draft_followup',
  '   Use when the user wants a follow-up drafted for an overdue external',
  '   item. Args: requirement_id.',
  '',
  '10. send_followup',
  '    Use when a draft was just shown and the user says to send it.',
  '    Args: requirement_id, draft (or null).',
  '',
  '11. snooze_reminder',
  '    Use when the user asks you to stop reminding them for a while.',
  '    Examples: "snooze", "remind me tomorrow", "not now", "in 3 days",',
  '    "give me a week", "leave me alone about it for now".',
  '    Args:',
  '      until_days: integer, days to snooze. Default 1.',
  '        "tomorrow" -> 1, "in 3 days" -> 3, "next week" -> 7,',
  '        "not now" -> 1.',
  '    The system clears the current flag and does not re-remind about',
  '    the same moment. It will remind again at the next scheduled',
  '    moment (for example, two_days_out after seven_days_out).',
  '',
  '12. set_new_deadline',
  '    Use when a goal has passed its deadline and the user wants to',
  '    give it a new deadline, OR when the user asks to change a',
  '    deadline on an existing goal.',
  '    Examples: "extend it to December 1", "set a new deadline of',
  '    next Friday", "move the deadline to the 20th", "change the visa',
  '    deadline to Nov 30".',
  '    Args:',
  '      goal_id:       id of the goal',
  '      new_deadline:  "YYYY-MM-DD" (resolve relative dates against today)',
  '    The system updates the goal and clears its reminder schedule so',
  '    the reminders restart from the new deadline.',
  '',
  '13. ask_user',
  '    Use ONLY when the message is genuinely ambiguous.',
  '    Args: question, expects_reply (default true).',
  '',
  'RULES:',
  '1. Use the real id from the state or the pending context. Never invent ids.',
  '2. No longer need / want / drop / cancel -> delete_item or delete_goal.',
  '3. Names a whole goal -> delete_goal. Names an item -> delete_item.',
  '4. Question -> query.',
  '5. Confirming a previous question -> resolve via the pending.',
  '6. New topic mid-question -> new action + abandons_pending: true.',
  '7. Prefer a specific tool over ask_user.',
  '8. Set "confidence" to your real confidence. Below 0.5 downgrades to ask_user.',
  '9. If the message contains more than one status change, you MUST use',
  '   update_items and include every change. This overrides any other',
  '   preference.',
  '',
  'PENDING SECTION — read this carefully when present:',
  '',
  'The user message is preceded by a "Pending question" block when one exists.',
  '',
  '  kind: "suggestion_offer"',
  '    You just created a goal and suggested some items.',
  '    "add them" / "yes" -> add_items with goal_ids: [the goal], items: OFFERED LABELS.',
  '    "add all" -> add_items with ALL MISSING LABELS.',
  '    "I have X" -> add_items with X, status done.',
  '    "no" / "none" -> ask_user with a short acknowledgement.',
  '    new topic -> emit the new action + abandons_pending: true.',
  '',
  '  kind: "yes_no"',
  '    Yes -> emit the on_yes tool with on_yes.args.',
  '    No -> ask_user with a short acknowledgement.',
  '',
  '  kind: "disambiguate"',
  '    Identify which candidate the user picked. Emit update_item with',
  '    that candidate\'s requirement_id. The system overrides the tool.',
  '    Decline -> ask_user with a short acknowledgement.',
  '    New topic -> emit the new action + abandons_pending: true.',
  '',
  '  kind: "ask_user"',
  '    Resolve the reply to the tool it implies.',
  '',
  'REMINDER FLAG — read this carefully when present:',
  '',
  'The user message may be preceded by a "Reminder flag" block. It shows',
  'a message you already displayed to the user. Two things it may trigger:',
  '',
  '1. The user wants to act on it. For example, if the flag says "you',
  '   should send the request for the police clearance by Nov 8", the',
  '   user might say "I sent it" or "done" or "sent it yesterday".',
  '   That is a status update on the requirement the flag names.',
  '   Emit update_item with the appropriate id from the state.',
  '',
  '2. The user wants to dismiss or defer it. For example, "snooze",',
  '   "not now", "later", "I\'ll do it tomorrow", "remind me in 3',
  '   days". Emit snooze_reminder with until_days.',
  '',
  '3. If the deadline has passed and the user says "extend it" or',
  '   "set a new deadline" or "change it to <date>", emit',
  '   set_new_deadline with the new date.',
  '',
  '4. If the user says something unrelated, handle it as a new topic',
  '   and set args.abandons_pending: true.',
  '',
  'Return ONLY a JSON object with this shape:',
  '{',
  '  "tool": string,',
  '  "args": object,',
  '  "confidence": 0.0-1.0,',
  '  "reason": string',
  '}',
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
}) {
  if (typeof userText !== 'string' || !userText.trim()) {
    return askUser('Could you say that again?');
  }

  const todayIso = toIsoDate(today instanceof Date ? today : new Date());
  const stateText = renderState(state);
  const historyText = renderHistory(history);
  const pendingText = renderPendingContext(pendingContext);
  const flagText = renderPendingFlag(pendingFlag);

  const sections = [
    `Today is ${todayIso}.`,
    '',
    'Current state:',
    stateText || '(no goals yet)',
  ];

  if (pendingText) sections.push('', pendingText);
  if (flagText) sections.push('', flagText);

  sections.push(
    '',
    'Recent conversation (oldest first):',
    historyText || '(this is the first message)',
    '',
    `User's new message:\n${userText}`
  );

  const userMessage = sections.join('\n');

  let raw;
  try {
    raw = await callLLM(SYSTEM_PROMPT, userMessage, { temperature: 0 });
  } catch (e) {
    console.error('[onward/interpreter] Groq call failed:', e.message);
    return askUser(
      "I had trouble reaching my reasoning service just now. Could you repeat what you said?"
    );
  }

  const action = validateAction(raw, state);

  if (
    action.tool === 'create_goal' &&
    (!action.args.goal_type || action.args.goal_type === null)
  ) {
    const detected = detectGoalType(userText);
    if (detected) {
      action.args.goal_type = detected;
    }
  }

  const isResolvingDisambiguate =
    pendingContext && pendingContext.kind === 'disambiguate';

  if (isResolvingDisambiguate) {
    const resolved = resolveDisambiguate(action, pendingContext, userText);
    if (resolved) {
      return resolved;
    }
    return askUser(pendingContext.question ?? 'Which one did you mean?');
  }

  if (action.tool !== 'update_items') {
    const collision = checkCrossGoalCollision(action, state);
    if (collision) {
      return collision;
    }
  }

  return action;
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

  const reqId = action.args?.requirement_id;
  if (reqId) {
    chosen = candidates.find((c) => c.requirement_id === reqId) ?? null;
  }

  if (!chosen) {
    const goalId = action.args?.goal_id;
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
    return `Which "${label}" — the one on "${goalTitles[0]}" or "${goalTitles[1]}"?`;
  }
  const list = goalTitles.map((t) => `"${t}"`).join(', ');
  return `Which "${label}" — on ${list}?`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateAction(raw, state) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return askUser("I didn't catch that. Could you rephrase?");
  }
  if (typeof raw.tool !== 'string' || !TOOLS.includes(raw.tool)) {
    return askUser("I didn't catch that. Could you rephrase?");
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
        return askUser('What should I call this goal?');
      }
      if (args.deadline != null) {
        if (
          typeof args.deadline !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(args.deadline)
        ) {
          return askUser("What's the deadline?");
        }
      }
      if (args.goal_type != null && !KNOWN_GOAL_TYPES.includes(args.goal_type)) {
        args.goal_type = null;
      }
      if (!Array.isArray(args.requirements)) {
        args.requirements = [];
      }
      return { tool: 'create_goal', args, confidence, reason };
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
            `Which goal should I add that to — ${active
              .map((g) => `"${g.title}"`)
              .join(' or ')}?`
          );
        }
      }

      if (!Array.isArray(args.items) || args.items.length === 0) {
        return askUser('What would you like to add?');
      }
      const items = args.items
        .filter((it) => it && typeof it.label === 'string' && it.label.trim())
        .map((it) => ({
          label: it.label.trim(),
          kind: it.kind === 'external_dependency' ? 'external_dependency' : 'self_action',
          status: it.status === 'done' ? 'done' : 'not_started',
        }));
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
      const item = reqsById.get(args.requirement_id);
      if (!item) {
        return askUser('Which item did you mean?');
      }
      if (typeof args.new_status !== 'string' || !STATUSES.includes(args.new_status)) {
        return askUser(`What status should "${item.label}" be in?`);
      }

      const legal = allowedNextStates(item.kind, item.status);
      if (!legal.includes(args.new_status)) {
        const nearest = pickNearestLegal(args.new_status, legal);
        if (nearest) {
          return {
            tool: 'update_item',
            args: {
              requirement_id: item.id,
              goal_id: item.goal_id,
              goal_title: item.goal_title,
              label: item.label,
              new_status: nearest,
              __compressed_from: args.new_status,
            },
            confidence: Math.min(confidence, 0.6),
            reason: reason
              ? `${reason} (compressed ${args.new_status} -> ${nearest})`
              : `compressed ${args.new_status} -> ${nearest}`,
          };
        }
        return askUser(
          `"${item.label}" is currently ${prettyStatus(item.status)}. ` +
            `What should I change it to?`
        );
      }
      return {
        tool: 'update_item',
        args: {
          requirement_id: item.id,
          goal_id: item.goal_id,
          goal_title: item.goal_title,
          label: item.label,
          new_status: args.new_status,
        },
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

      for (const u of rawUpdates) {
        if (!u || typeof u !== 'object') continue;
        const item = reqsById.get(u.requirement_id);
        if (!item) continue;
        if (seenIds.has(item.id)) continue;
        if (typeof u.new_status !== 'string' || !STATUSES.includes(u.new_status)) continue;

        seenIds.add(item.id);

        const legal = allowedNextStates(item.kind, item.status);
        let targetStatus = u.new_status;
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
        };
        if (compressedFrom) entry.__compressed_from = compressedFrom;
        validUpdates.push(entry);
      }

      if (validUpdates.length === 0) {
        return askUser('Which items do you want to update?');
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
      const item = reqsById.get(args.requirement_id);
      if (!item) return askUser('Which item do you want to delete?');
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
      const item = reqsById.get(args.requirement_id);
      if (!item) return askUser('Which item do you want to delete?');
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
      return { tool: 'query', args, confidence, reason };
    }

    case 'draft_followup':
    case 'send_followup': {
      const item = reqsById.get(args.requirement_id);
      if (!item) return askUser('Which item should I follow up on?');
      if (item.kind !== 'external_dependency') {
        return askUser(
          `"${item.label}" isn't waiting on anyone else, so there's nothing to chase.`
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
      if (
        typeof args.new_deadline !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(args.new_deadline)
      ) {
        return askUser('What should the new deadline be?');
      }
      return {
        tool: 'set_new_deadline',
        args: {
          goal_id: goal.id,
          goal_title: goal.title,
          new_deadline: args.new_deadline,
        },
        confidence,
        reason,
      };
    }

    case 'ask_user': {
      if (typeof args.question !== 'string' || !args.question.trim()) {
        return askUser('Could you say that again?');
      }
      return {
        tool: 'ask_user',
        args: {
          question: args.question.trim(),
          expects_reply: args.expects_reply !== false,
          ...(args.__disambiguate ? { __disambiguate: args.__disambiguate } : {}),
        },
        confidence,
        reason,
      };
    }

    default:
      return askUser('Could you say that again?');
  }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderState(state) {
  const goals = state?.goals ?? [];
  if (goals.length === 0) return '';
  const lines = [];
  for (const g of goals) {
    lines.push(
      `GOAL id=${g.id} title=${JSON.stringify(g.title)} ` +
        `deadline=${g.deadline} goal_type=${g.goal_type ?? 'null'} status=${g.status}`
    );
    for (const r of g.requirements ?? []) {
      const legal = allowedNextStates(r.kind, r.status);
      lines.push(
        `  ITEM id=${r.id} label=${JSON.stringify(r.label)} kind=${r.kind} ` +
          `status=${r.status} legal_next=[${legal.join(', ')}]` +
          (r.depends_on ? ` depends_on=${JSON.stringify(r.depends_on)}` : '') +
          (r.requested_at ? ` requested_at=${r.requested_at}` : '') +
          (r.received_at ? ` received_at=${r.received_at}` : '')
      );
    }
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

function askUser(question) {
  return {
    tool: 'ask_user',
    args: { question, expects_reply: true },
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
      return `Did you mean to update "${item.label}"? I'm not sure. Could you confirm?`;
    }
  }
  if (tool === 'delete_goal' && args.goal_id) {
    const goal = goalsById.get(args.goal_id);
    if (goal) {
      return `Did you mean to delete "${goal.title}"? I'm not sure. Could you confirm?`;
    }
  }
  if (tool === 'delete_item' && args.requirement_id) {
    const item = reqsById.get(args.requirement_id);
    if (item) {
      return `Did you mean to delete "${item.label}"? I'm not sure. Could you confirm?`;
    }
  }
  if (tool === 'add_items' && Array.isArray(args.items) && args.items.length > 0) {
    const labels = args.items.map((i) => `"${i.label}"`).join(', ');
    return `Did you mean to add ${labels}? I'm not sure. Could you confirm?`;
  }
  if (tool === 'create_goal' && typeof args.title === 'string') {
    return `Did you mean to create a goal called "${args.title}"? I'm not sure. Could you confirm?`;
  }
  if (tool === 'set_new_deadline' && args.goal_id) {
    const goal = goalsById.get(args.goal_id);
    if (goal) {
      return `Did you mean to change the deadline on "${goal.title}"? I'm not sure. Could you confirm?`;
    }
  }
  return 'I want to make sure I got that right. Could you rephrase?';
}