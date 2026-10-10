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
]);

export const TOOLS = Object.freeze([
  'create_goal',
  'add_items',
  'update_item',
  'delete_goal',
  'delete_item',
  'delete_goal_confirmed',
  'delete_item_confirmed',
  'query',
  'draft_followup',
  'send_followup',
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
  '  - Optionally, a proactive flag with an action offer.',
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
  '     job_application_with_references, grant_application, signed_form_return',
  '',
  '2. add_items',
  '   Use when the user is naming items to add to one or more EXISTING',
  '   goals, OR when the user is resolving a suggestion_offer.',
  '   Args:',
  '     goal_ids:   array of goal ids to add the items to. One id if the',
  '                 user named one goal. Multiple ids if the user named',
  '                 several, or said "all" / "both" / "everywhere" /',
  '                 "all my goals" — in that case include EVERY active',
  '                 goal id.',
  '     items:      array of { label, kind, status }',
  '',
  '   GOAL TARGETING RULE:',
  '   Read the user\'s message for the goals to add to.',
  '     - Names one goal ("to my job application") -> goal_ids has one id.',
  '     - Names several ("to my job and scholarship applications",',
  '       "for my visa, job, and grant applications") -> goal_ids has',
  '       all of them.',
  '     - Says "all" / "both" / "everywhere" / "all my goals" / "every',
  '       goal" -> goal_ids has every active goal id.',
  '     - Names none and there is exactly one active goal -> that one.',
  '     - Names none and there is a conversational goal the user was',
  '       just talking about -> that one.',
  '     - Names none and there are multiple active goals and no context',
  '       -> use ask_user with a question naming the candidate goals.',
  '   Do NOT silently pick one goal when the user said "both" or "all".',
  '',
  '   When resolving a suggestion_offer, goal_ids has exactly the goal',
  '   from the pending (see PENDING section).',
  '',
  '3. update_item',
  '   Use when the user is reporting a status change to an existing item.',
  '   Args:',
  '     requirement_id: id of the item',
  '     new_status:     one of the legal next statuses listed for that item',
  '',
  '   PHRASING -> STATUS MAPPING.',
  '',
  '   Do not match against a list of phrasings. Reason about what the',
  '   user means. Every status change describes one of three situations.',
  '',
  '   SELF_ACTION items (the user produces it themselves):',
  '     - The item does not exist yet. -> not_started',
  '     - The item is in progress. -> in_progress',
  '     - The item exists in its finished form. -> done',
  '',
  '   EXTERNAL_DEPENDENCY items (someone else produces it):',
  '     - The request has not gone out yet. -> not_started',
  '     - The request is out and the response has not come back.',
  '       -> waiting_on_other',
  '     - The item has arrived. -> done',
  '',
  '   The distinguishing question is: does the user currently have the',
  '   finished item in hand? If yes, done. If no, decide whether they',
  '   are waiting on someone else (external, waiting_on_other), actively',
  '   working on it themselves (self, in_progress), or haven\'t started',
  '   (not_started).',
  '',
  '   ITEM MATCHING:',
  '     If the user mentions an item loosely, look for a matching item in',
  '     the state. If exactly one item matches by label, use its id. If',
  '     two or more items match, pick the one with the best label overlap',
  '     and emit the operation on it. DO NOT emit ask_user to ask which',
  '     one. The system will detect the cross-goal collision afterward',
  '     and ask the user to disambiguate with the candidate list.',
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
  '   item, OR when a proactive flag with an action_offer is present and',
  '   the user says yes to the offer.',
  '   Args: requirement_id.',
  '',
  '10. send_followup',
  '    Use when a draft was just shown and the user says to send it.',
  '    Args: requirement_id, draft (or null).',
  '',
  '11. ask_user',
  '    Use ONLY when the message is genuinely ambiguous and no tool fits.',
  '    Do NOT use ask_user to disambiguate between two items with the same',
  '    label on different goals — pick one and let the system handle it.',
  '    Args: question, expects_reply (default true).',
  '',
  'RULES:',
  '1. For EVERY action that references an existing goal or item, use the',
  '   real id from the state or the pending context. Never invent ids.',
  '2. If the user says they no longer need / want / drop / cancel / remove',
  '   an item or goal, use delete_item or delete_goal.',
  '3. If the message names a whole goal, use delete_goal. If it names an',
  '   item inside a goal, use delete_item.',
  '4. If the message is a question, use query.',
  '5. If the user is confirming a previous question, and the previous',
  '   question is visible in history or in the PENDING section, resolve it.',
  '6. If the user changes topic mid-question, treat it as a new action and',
  '   set args.abandons_pending = true.',
  '7. Prefer a specific tool over ask_user.',
  '8. Set "confidence" to your actual confidence. Below 0.5 downgrades to',
  '   ask_user automatically.',
  '',
  'PENDING SECTION — read this carefully when present:',
  '',
  'The user message is preceded by a "Pending question" block. It tells you',
  'what you asked last and what the user is replying to. Three kinds matter:',
  '',
  '  kind: "suggestion_offer"',
  '    You just created a goal and suggested some items. The block lists',
  '    "Offered labels" and "All missing labels".',
  '',
  '    Resolve the user\'s reply like this:',
  '      "add them" / "yes" / "yes add them" / "no, add them" / "sure"',
  '        -> add_items with goal_ids: [<the goal from the pending>]',
  '           and the OFFERED LABELS as the items.',
  '      "add all of them" / "add everything"',
  '        -> add_items with the same goal and ALL MISSING LABELS.',
  '      "I have X and Y" / "I already have X"',
  '        -> add_items with the goal and the items the user names, status done.',
  '      "no" / "none" / "nothing else"',
  '        -> ask_user with a short acknowledgement, expects_reply false.',
  '      anything that is clearly a new topic',
  '        -> emit the tool for the new topic and set abandons_pending: true.',
  '',
  '  kind: "yes_no"',
  '    A yes/no confirmation you asked. The block tells you what "yes"',
  '    will execute. If the user confirms, emit that tool with those args.',
  '    If they decline, use ask_user with a short acknowledgement.',
  '',
  '  kind: "disambiguate"',
  '    The user mentioned an item that exists on TWO OR MORE goals with',
  '    the same label. You asked which one. The block lists candidate',
  '    requirement ids, labels, and goal titles.',
  '',
  '    On this turn, your ONLY job is to figure out WHICH candidate the',
  '    user picked. Do not pick the tool — the system will override you',
  '    with the correct tool afterward. Just look at the user\'s reply',
  '    and identify the candidate. You can emit any tool that references',
  '    the chosen candidate\'s requirement_id; the system will convert it',
  '    to the right operation. Emitting update_item with the chosen',
  '    requirement_id is the safest choice.',
  '',
  '    If the user declines ("never mind", "no", "cancel"), emit ask_user',
  '    with a short acknowledgement and expects_reply false.',
  '',
  '    If the reply is clearly a new topic, set abandons_pending: true.',
  '',
  '  kind: "ask_user"',
  '    An open question you asked. The user\'s reply answers it. Decide what',
  '    tool the answer implies. If the reply is unrelated, set',
  '    abandons_pending: true and handle the new topic.',
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

  const collision = checkCrossGoalCollision(action, state);
  if (collision) {
    return collision;
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
      // Accept either goal_ids (preferred) or a legacy single goal_id.
      let rawIds = Array.isArray(args.goal_ids) ? args.goal_ids : null;
      if (!rawIds && typeof args.goal_id === 'string') {
        rawIds = [args.goal_id];
      }

      // Normalize: strings only, dedupe, keep only ids that exist.
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

      // Fallbacks when the model didn't name any valid goal.
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
  const lines = ['Proactive flag (you raised this earlier and the user has not acted on it):'];
  if (flag.goal_title) lines.push(`  Goal: "${flag.goal_title}"`);
  if (flag.to_level) lines.push(`  Risk level: ${flag.to_level}`);
  if (flag.message) lines.push(`  Message you showed: ${flag.message}`);
  if (flag.action_offer && flag.action_offer.requirement_id) {
    const a = flag.action_offer;
    lines.push(
      `  Action offer: draft a follow-up for id=${a.requirement_id} ` +
        `label=${JSON.stringify(a.label)}` +
        (a.depends_on ? ` to ${JSON.stringify(a.depends_on)}` : '')
    );
    lines.push(
      '  If the user says yes / wants a follow-up / asks you to chase it, emit draft_followup with that requirement_id.'
    );
  }
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
  if (tool === 'update_item' && args.requirement_id) {
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
  return 'I want to make sure I got that right. Could you rephrase?';
}