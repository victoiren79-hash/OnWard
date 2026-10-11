// Onward — orchestrator.
//
// One interpreter call per turn. No regex routing, no cascade, no
// fuzzy matchers. The interpreter decides; this file dispatches.

import {
  createGoal,
  getGoal,
  listGoals,
  getRequirement,
  listRequirementsForGoal,
  updateRequirement,
  updateGoal,
  deleteRequirement,
  deleteGoal,
  appendEvent,
  appendEventsBatch,
  createRequirementsBatch,
  listGoalTypeTemplates,
  recordRiskAssessment,
  getLatestRiskAssessment,
  listEventsForGoal,
  getSession,
  saveSession,
} from './db.js';

import { interpretTurn } from './services/updateInterpreter.js';
import {
  findMissingRequirements,
  normalizeLabel,
} from './services/completenessService.js';
import { computeRisk } from './services/riskService.js';
import { getDueReminders } from './services/reminderService.js';
import {
  renderGoalReport,
  renderRiskReport,
  renderActionReport,
} from './services/reportService.js';
import {
  phraseSuggestion,
  phraseReport,
  phraseProactiveMessage,
} from './services/phrasing.js';
import { applyTransition } from './services/requirementService.js';
import { executeAction } from './services/actionExecutor.js';
import { now } from './services/clock.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function handleStatement(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return err('empty', "I didn't catch that — could you say it again?");
  }
  const trimmed = text.trim();

  try {
    const session = await getSession();
    const state = await loadFullState();
    const history = await loadRecentHistory();

    const pendingContext = session.pending_confirmation ?? null;
    const pendingFlag = session.pending_flag ?? null;

    const action = await interpretTurn({
      userText: trimmed,
      state,
      history,
      today: now(),
      pendingContext,
      pendingFlag,
    });

    const abandonsPending = action.args?.abandons_pending === true;
    if (pendingContext && (abandonsPending || action.tool !== 'ask_user')) {
      await clearPendingConfirmation();
    }

    return await dispatch(action, trimmed, { pendingFlag, pendingContext });
  } catch (e) {
    console.error('[onward] handleStatement failed:', e);
    return err(e.code ?? 'internal', e.message ?? 'something went wrong');
  }
}

// ---------------------------------------------------------------------------
// Reevaluate all goals — the schedule walker
//
// Called on every day advance and on every server restart triggered by
// the demo panel. Walks each active goal's reminder schedule. If any
// moment is due, fires the highest-priority one and marks all due
// moments as fired. Otherwise, clears a stale flag if the goal it
// referred to is no longer at risk.
// ---------------------------------------------------------------------------

export async function reevaluateAllGoals() {
  const goals = await listGoals({ status: 'active' });
  const today = now();

  let firedThisPass = 0;
  let lastFiredFlag = null;
  const riskByGoalId = new Map();

  for (const goal of goals) {
    const reqs = await listRequirementsForGoal(goal.id);

    // Recompute risk regardless — needed for the stale-flag check.
    let risk = null;
    try {
      risk = computeRisk(goal, reqs, today);
      await recordRiskAssessment({
        goalId: goal.id,
        riskLevel: risk.risk_level,
        reasons: risk.reasons,
      });
      riskByGoalId.set(goal.id, risk.risk_level);
    } catch (e) {
      console.error('[onward] reevaluateAllGoals: risk failed for goal', goal.id, e);
      continue;
    }

    // Compute due reminders.
    let due = [];
    try {
      due = getDueReminders(goal, reqs, today, goal.reminders_fired ?? []);
    } catch (e) {
      console.error('[onward] reevaluateAllGoals: reminders failed for goal', goal.id, e);
      continue;
    }

    if (due.length === 0) continue;

    // Fire the top one.
    const top = due[0];
    const facts = buildFlagFacts(goal, reqs, risk, due, top.kind);

    let message;
    try {
      message = await phraseProactiveMessage(facts, top.kind);
    } catch (e) {
      console.warn('[onward] phraseProactiveMessage failed, using fallback:', e.message);
      message = composeProactiveMessageFallback(facts);
    }
    if (!message || !message.trim()) {
      message = composeProactiveMessageFallback(facts);
    }

    const flag = {
      goalId: goal.id,
      goalTitle: goal.title,
      momentKind: top.kind,
      riskLevel: risk.risk_level,
      reasons: risk.reasons,
      message,
    };

    // Mark every due moment as fired, not just the top one. The user
    // got one message that names them all; tomorrow they should not
    // get repeats.
    await markRemindersFired(goal, due.map((d) => d.kind));

    firedThisPass++;
    lastFiredFlag = flag;
  }

  // Decide the new pending flag.
  const session = await getSession();
  const existingFlag = session.pending_flag ?? null;

  let nextFlag = existingFlag;

  if (lastFiredFlag) {
    nextFlag = lastFiredFlag;
  } else if (existingFlag?.goalId) {
    const level = riskByGoalId.get(existingFlag.goalId);
    const isStillRisky = level === 'at_risk' || level === 'critical';
    if (!isStillRisky) {
      nextFlag = null;
    }
  }

  await saveSession({
    pendingConfirmation: session.pending_confirmation ?? null,
    pendingFlag: nextFlag,
    activeGoalId: session.active_goal_id ?? null,
  });

  return {
    checked: goals.length,
    flagged: firedThisPass,
    proactive_message: lastFiredFlag?.message ?? null,
  };
}

/**
 * Append the given kinds to the goal's reminders_fired array and
 * persist. Deduplicates.
 */
async function markRemindersFired(goal, kinds) {
  const existing = Array.isArray(goal.reminders_fired) ? goal.reminders_fired : [];
  const set = new Set(existing);
  for (const k of kinds) set.add(k);
  const next = [...set];

  try {
    await updateGoal(goal.id, { reminders_fired: next });
    // Mutate the local goal object too, in case anything downstream
    // uses it in this same pass.
    goal.reminders_fired = next;
  } catch (e) {
    console.error('[onward] markRemindersFired failed for goal', goal.id, e);
  }
}

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------

async function loadFullState() {
  const goals = await listGoals({ status: 'active' });
  const withReqs = [];
  for (const g of goals) {
    const reqs = await listRequirementsForGoal(g.id);
    withReqs.push({
      id: g.id,
      title: g.title,
      deadline: g.deadline,
      goal_type: g.goal_type,
      status: g.status,
      requirements: reqs.map((r) => ({
        id: r.id,
        label: r.label,
        kind: r.kind,
        status: r.status,
        depends_on: r.depends_on ?? null,
        requested_at: r.requested_at ?? null,
        received_at: r.received_at ?? null,
      })),
    });
  }
  return { goals: withReqs };
}

async function loadRecentHistory() {
  try {
    const goals = await listGoals({ status: 'active' });
    const all = [];
    for (const g of goals) {
      const events = await listEventsForGoal(g.id, { limit: 8 });
      for (const e of events) {
        if (e.raw_text) {
          all.push({ ts: e.timestamp, role: 'user', content: e.raw_text });
        }
        const change = e.interpreted_change ?? {};
        const summary = summarizeChange(change);
        if (summary) {
          all.push({ ts: e.timestamp, role: 'assistant', content: summary });
        }
      }
    }
    all.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    return all.slice(-10).map(({ role, content }) => ({ role, content }));
  } catch (e) {
    console.error('[onward] loadRecentHistory failed:', e);
    return [];
  }
}

function summarizeChange(change) {
  switch (change.type) {
    case 'goal_created':
      return `Created goal "${change.title}" (deadline ${change.deadline}).`;
    case 'requirement_created':
      return `Added "${change.label}".`;
    case 'status_changed':
      return `Marked "${change.label ?? 'item'}" as ${change.to}.`;
    case 'goal_deleted':
      return `Deleted goal "${change.title}".`;
    case 'requirement_deleted':
      return `Deleted "${change.label}".`;
    case 'action_drafted':
      return `Drafted a follow-up.`;
    case 'action_sent':
      return `Sent a follow-up.`;
    case 'action_sandboxed':
      return `Drafted a follow-up (sandbox).`;
    case 'deadline_changed':
      return `Changed deadline of "${change.title}" to ${change.new_deadline}.`;
    case 'reminder_snoozed':
      return `Snoozed reminders for "${change.title}".`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(action, rawText, { pendingFlag = null, pendingContext = null } = {}) {
  switch (action.tool) {
    case 'create_goal':              return doCreateGoal(action, rawText);
    case 'add_items':                return doAddItems(action, rawText);
    case 'update_item':              return doUpdateItem(action, rawText);
    case 'update_items':             return doUpdateItems(action, rawText);
    case 'delete_goal':              return doDeleteGoal(action, rawText);
    case 'delete_item':              return doDeleteItem(action, rawText);
    case 'delete_goal_confirmed':    return doConfirmedDeleteGoal(action, rawText);
    case 'delete_item_confirmed':    return doConfirmedDeleteItem(action, rawText);
    case 'query':                    return doQuery(action, rawText);
    case 'draft_followup':           return doDraftFollowup(action, rawText, pendingFlag);
    case 'send_followup':            return doSendFollowup(action, rawText, pendingFlag);
    case 'snooze_reminder':          return doSnoozeReminder(action, rawText);
    case 'set_new_deadline':         return doSetNewDeadline(action, rawText);
    case 'ask_user':                 return doAskUser(action);
    default:
      return err('unknown_tool', `I don't know how to handle that.`);
  }
}

// ---------------------------------------------------------------------------
// Tool: create_goal
// ---------------------------------------------------------------------------

async function doCreateGoal(action, rawText) {
  const { title, deadline, goal_type, requirements } = action.args;

  if (!deadline) {
    await saveSession({
      pendingConfirmation: {
        kind: 'ask_user',
        question: `Got it — "${title}". What's the deadline?`,
        expects: 'deadline',
        partial: { title, goal_type, requirements: requirements ?? [] },
      },
      pendingFlag: null,
    });
    return {
      intent: 'create',
      ok: true,
      message: `Got it — "${title}". What's the deadline?`,
      data: { kind: 'await_deadline', partial_goal: { title, goal_type } },
    };
  }

  const goal = await createGoal({ title, deadline, goalType: goal_type });

  await appendEvent({
    goalId: goal.id,
    rawText,
    interpretedChange: {
      type: 'goal_created',
      title: goal.title,
      deadline: goal.deadline,
      goal_type: goal.goal_type,
    },
  });

  let createdReqs = [];
  if (Array.isArray(requirements) && requirements.length > 0) {
    createdReqs = await createRequirementsBatch(
      goal.id,
      requirements.map((r) => ({
        label: r.label,
        kind: r.kind ?? 'self_action',
        status: r.status ?? 'not_started',
      }))
    );
    await appendEventsBatch(
      createdReqs.map((req) => ({
        goalId: goal.id,
        requirementId: req.id,
        rawText,
        interpretedChange: {
          type: 'requirement_created',
          label: req.label,
          kind: req.kind,
          status: req.status,
        },
      }))
    );
  }

  const template = goal.goal_type
    ? await listGoalTypeTemplates(goal.goal_type)
    : [];
  const currentReqs = await listRequirementsForGoal(goal.id);

  const fullDiff = findMissingRequirements(goal, currentReqs, template);
  const essentials = fullDiff.missing.filter((m) => m.priority === 'essential');
  const helpfulPool = fullDiff.missing.filter((m) => m.priority === 'helpful');

  const daysUntilDeadline = daysBetween(now(), goal.deadline);

  let suggestionText = null;
  let itemsMentioned = [];
  try {
    const result = await phraseSuggestion(goal, essentials, helpfulPool, {
      userStatedGoal: rawText,
      daysUntilDeadline,
    });
    suggestionText = result.text;
    itemsMentioned = result.items_mentioned ?? [];
  } catch (e) {
    console.warn('[onward] phraseSuggestion failed:', e.message);
    suggestionText = fallbackSuggestion(goal, essentials, helpfulPool);
    itemsMentioned = [
      ...essentials.map((e) => e.label),
      ...helpfulPool.slice(0, 1).map((h) => h.label),
    ];
  }

  // on_creation reminder. This fires the request_by moments for any
  // long-turnaround externals that are already past their request-by
  // date. If the goal is short-fused, this produces a "you need to
  // request X immediately" note alongside the suggestion. If the goal
  // is long-fused, no request_by is due yet and this is a no-op.
  let creationFlag = null;
  try {
    const freshGoal = await getGoal(goal.id);
    const reqsForReminder = await listRequirementsForGoal(goal.id);
    const today = now();
    const due = getDueReminders(freshGoal, reqsForReminder, today, []);
    if (due.length > 0) {
      const risk = computeRisk(freshGoal, reqsForReminder, today);
      const top = due[0];
      const facts = buildFlagFacts(freshGoal, reqsForReminder, risk, due, top.kind);
      let message;
      try {
        message = await phraseProactiveMessage(facts, top.kind);
      } catch (e) {
        message = composeProactiveMessageFallback(facts);
      }
      creationFlag = {
        goalId: freshGoal.id,
        goalTitle: freshGoal.title,
        momentKind: top.kind,
        riskLevel: risk.risk_level,
        reasons: risk.reasons,
        message,
      };
      await markRemindersFired(freshGoal, due.map((d) => d.kind));
    }
  } catch (e) {
    console.error('[onward] doCreateGoal: reminder walk failed:', e);
  }

  // Also still run the risk computation and record it.
  const risk = computeRisk(goal, currentReqs, now());
  await recordRiskAssessment({
    goalId: goal.id,
    riskLevel: risk.risk_level,
    reasons: risk.reasons,
  });

  const header = `Got it — "${goal.title}", deadline ${goal.deadline}.`;
  const parts = [header];
  if (suggestionText) parts.push(suggestionText);
  const message = parts.join('\n\n');

  let pendingOffer = null;
  if (itemsMentioned.length > 0) {
    pendingOffer = {
      kind: 'suggestion_offer',
      goal_id: goal.id,
      goal_title: goal.title,
      offered_labels: itemsMentioned,
      all_missing_labels: fullDiff.missing.map((m) => m.label),
    };
  }

  await saveSession({
    pendingConfirmation: pendingOffer,
    pendingFlag: creationFlag,
    activeGoalId: goal.id,
  });

  return {
    intent: 'create',
    ok: true,
    message,
    data: {
      kind: 'goal_created',
      goal: {
        id: goal.id,
        title: goal.title,
        deadline: goal.deadline,
        goal_type: goal.goal_type,
      },
      requirements: currentReqs.map(simpleReq),
      missing: fullDiff.missing,
      essentials_missing: essentials,
      helpful_missing: helpfulPool,
      offered: itemsMentioned,
      risk_level: risk.risk_level,
    },
    proactive_flag: creationFlag ? slimFlag(creationFlag) : null,
  };
}

function fallbackSuggestion(goal, essentials, helpful) {
  const parts = [];
  if (essentials.length > 0) {
    const labels = essentials.map((e) => e.label).join(', ');
    parts.push(`The essentials for this one are ${labels}.`);
  }
  if (helpful.length > 0) {
    const pick = helpful[0];
    parts.push(`You might also want ${pick.label}.`);
  }
  if (parts.length === 0) {
    parts.push(`Nothing else obvious to add. Anything you want me to track?`);
  } else {
    parts.push(`Tell me which of those you already have, or add anything else.`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Tool: add_items
// ---------------------------------------------------------------------------

async function doAddItems(action, rawText) {
  const goalIds = Array.isArray(action.args.goal_ids)
    ? action.args.goal_ids
    : (typeof action.args.goal_id === 'string' ? [action.args.goal_id] : []);
  const items = Array.isArray(action.args.items) ? action.args.items : [];

  if (goalIds.length === 0) {
    return err('no_goal', 'Which goal should I add that to?');
  }
  if (items.length === 0) {
    return err('no_items', 'What would you like to add?');
  }

  const perGoal = [];
  let totalAdded = 0;
  let lastGoal = null;

  for (const goalId of goalIds) {
    const goal = await getGoal(goalId);
    if (!goal) {
      perGoal.push({ goal_id: goalId, goal_title: '(deleted)', added: [], skipped: [], missing: true });
      continue;
    }
    lastGoal = goal;

    const existing = await listRequirementsForGoal(goal.id);
    const existingKeys = new Set(existing.map((r) => normalizeLabel(r.label)));

    const toCreate = [];
    const skipped = [];
    for (const item of items) {
      if (existingKeys.has(normalizeLabel(item.label))) {
        skipped.push(item.label);
      } else {
        toCreate.push(item);
      }
    }

    if (toCreate.length === 0) {
      perGoal.push({
        goal_id: goal.id,
        goal_title: goal.title,
        added: [],
        skipped,
      });
      continue;
    }

    const created = await createRequirementsBatch(
      goal.id,
      toCreate.map((it) => ({
        label: it.label,
        kind: it.kind ?? 'self_action',
        status: it.status ?? 'not_started',
      }))
    );
    await appendEventsBatch(
      created.map((req) => ({
        goalId: goal.id,
        requirementId: req.id,
        rawText,
        interpretedChange: {
          type: 'requirement_created',
          label: req.label,
          kind: req.kind,
          status: req.status,
        },
      }))
    );

    perGoal.push({
      goal_id: goal.id,
      goal_title: goal.title,
      added: created.map(simpleReq),
      skipped,
    });
    totalAdded += created.length;
  }

  const addParts = [];
  const skipParts = [];

  for (const r of perGoal) {
    if (r.missing) continue;
    if (r.added.length > 0) {
      const labels = r.added.map((a) => `"${a.label}"`).join(', ');
      addParts.push(`${labels} to "${r.goal_title}"`);
    }
    if (r.skipped.length > 0) {
      const labels = r.skipped.map((s) => `"${s}"`).join(', ');
      skipParts.push(`already on "${r.goal_title}": ${labels}`);
    }
  }

  let message;
  if (totalAdded === 0) {
    if (skipParts.length > 0) {
      message = `Nothing to add. ${skipParts.join('; ')}.`;
    } else {
      message = `Nothing to add.`;
    }
  } else if (addParts.length === 1) {
    message = `Added ${addParts[0]}.`;
  } else {
    message = `Added ${addParts.join('; and ')}.`;
  }
  if (totalAdded > 0 && skipParts.length > 0) {
    message += ` (Skipped — ${skipParts.join('; ')}.)`;
  }

  await saveSession({
    pendingConfirmation: null,
    pendingFlag: null,
    activeGoalId: lastGoal?.id ?? null,
  });

  return {
    intent: 'add_items',
    ok: true,
    message,
    data: {
      kind: 'items_added',
      per_goal: perGoal,
      total_added: totalAdded,
      goal_ids: goalIds,
    },
    proactive_flag: null,
  };
}

// ---------------------------------------------------------------------------
// Tool: update_item
// ---------------------------------------------------------------------------

async function doUpdateItem(action, rawText) {
  const { requirement_id, new_status, __compressed_from } = action.args;
  const req = await getRequirement(requirement_id);
  if (!req) return err('no_requirement', 'That item seems to be gone.');

  const goal = await getGoal(req.goal_id);
  if (!goal) return err('no_goal', 'That goal seems to be gone.');

  const result = applyTransition(req, new_status, { at: now() });
  if (!result.ok) {
    const nearest = result.nearestLegal;
    const msg = nearest
      ? `"${req.label}" is currently ${prettyStatus(req.status)}. ` +
        `I can move it to ${prettyStatus(nearest)}. Is that what you meant?`
      : `"${req.label}" can't be changed from ${prettyStatus(req.status)} to ${prettyStatus(new_status)}.`;
    await saveSession({
      pendingConfirmation: {
        kind: 'yes_no',
        question: msg,
        on_yes: nearest
          ? { tool: 'update_item', args: { requirement_id: req.id, new_status: nearest } }
          : null,
      },
      pendingFlag: null,
    });
    return {
      intent: 'update',
      ok: true,
      message: msg,
      data: { kind: 'update_clarify', requirement_id: req.id },
    };
  }

  const next = result.next;
  await updateRequirement(requirement_id, {
    status: next.status,
    requested_at: next.requested_at,
    received_at: next.received_at,
    notes: next.notes,
  });

  await appendEvent({
    goalId: goal.id,
    requirementId: req.id,
    rawText,
    interpretedChange: {
      type: 'status_changed',
      from: req.status,
      to: next.status,
      label: req.label,
      ...(__compressed_from ? { compressed_from: __compressed_from } : {}),
    },
  });

  const fresh = await listRequirementsForGoal(goal.id);
  const { risk, flag } = await checkAndRemind(goal, fresh);
  await saveSession({
    pendingConfirmation: null,
    pendingFlag: flag,
    activeGoalId: goal.id,
  });

  let message = `Got it — "${next.label}" is now ${prettyStatus(next.status)}.`;
  if (__compressed_from) {
    message += ` (Noted that you said it was ${prettyStatus(__compressed_from)} — I moved it forward as far as the timeline allows.)`;
  }

  return {
    intent: 'update',
    ok: true,
    message,
    data: {
      kind: 'update_applied',
      requirement: simpleReq(next),
      risk_level: risk.risk_level,
    },
    proactive_flag: flag ? slimFlag(flag) : null,
  };
}

// ---------------------------------------------------------------------------
// Tool: update_items
// ---------------------------------------------------------------------------

async function doUpdateItems(action, rawText) {
  const updates = Array.isArray(action.args.updates) ? action.args.updates : [];
  if (updates.length === 0) {
    return err('no_updates', 'What would you like to update?');
  }

  const applied = [];
  const failed = [];
  const affectedGoals = new Map();

  for (const u of updates) {
    const req = await getRequirement(u.requirement_id);
    if (!req) {
      failed.push({ requirement_id: u.requirement_id, reason: 'item not found' });
      continue;
    }
    const goal = await getGoal(req.goal_id);
    if (!goal) {
      failed.push({ requirement_id: u.requirement_id, reason: 'goal not found' });
      continue;
    }

    const result = applyTransition(req, u.new_status, { at: now() });
    if (!result.ok) {
      failed.push({
        requirement_id: u.requirement_id,
        label: req.label,
        reason: result.reason,
      });
      continue;
    }

    const next = result.next;
    await updateRequirement(u.requirement_id, {
      status: next.status,
      requested_at: next.requested_at,
      received_at: next.received_at,
      notes: next.notes,
    });

    await appendEvent({
      goalId: goal.id,
      requirementId: req.id,
      rawText,
      interpretedChange: {
        type: 'status_changed',
        from: req.status,
        to: next.status,
        label: req.label,
        ...(u.__compressed_from ? { compressed_from: u.__compressed_from } : {}),
      },
    });

    applied.push({
      requirement_id: next.id,
      label: next.label,
      status: next.status,
      goal_id: goal.id,
      goal_title: goal.title,
      __compressed_from: u.__compressed_from ?? null,
    });

    affectedGoals.set(goal.id, goal);
  }

  let lastFlag = null;
  let lastGoalId = null;
  for (const [goalId, goal] of affectedGoals) {
    const fresh = await listRequirementsForGoal(goalId);
    const { flag } = await checkAndRemind(goal, fresh);
    if (flag && !lastFlag) lastFlag = flag;
    lastGoalId = goalId;
  }

  await saveSession({
    pendingConfirmation: null,
    pendingFlag: lastFlag,
    activeGoalId: lastGoalId,
  });

  const message = composeUpdateItemsReply(applied, failed);

  return {
    intent: 'update',
    ok: true,
    message,
    data: {
      kind: 'updates_applied',
      applied: applied.map((a) => ({
        requirement_id: a.requirement_id,
        label: a.label,
        status: a.status,
        goal_id: a.goal_id,
        goal_title: a.goal_title,
      })),
      failed,
    },
    proactive_flag: lastFlag ? slimFlag(lastFlag) : null,
  };
}

function composeUpdateItemsReply(applied, failed) {
  if (applied.length === 0) {
    if (failed.length > 0) {
      const names = failed.map((f) => f.label ? `"${f.label}"` : 'one of those').join(', ');
      return `I couldn't update ${names}.`;
    }
    return 'Nothing to update.';
  }

  const byStatus = new Map();
  for (const a of applied) {
    if (!byStatus.has(a.status)) byStatus.set(a.status, []);
    byStatus.get(a.status).push(a);
  }

  const clauses = [];
  for (const [status, items] of byStatus) {
    const labels = items.map((i) => `"${i.label}"`);
    const verbPhrase = formatStatusClause(labels, status);
    clauses.push(verbPhrase);
  }

  let sentence;
  if (clauses.length === 1) {
    sentence = clauses[0];
  } else if (clauses.length === 2) {
    sentence = `${clauses[0]} and ${clauses[1]}`;
  } else {
    const last = clauses.pop();
    sentence = `${clauses.join(', ')}, and ${last}`;
  }

  let message = `Got it — ${sentence}.`;

  const compressed = applied.filter((a) => a.__compressed_from);
  if (compressed.length > 0) {
    const notes = compressed.map(
      (c) => `"${c.label}" (you said ${prettyStatus(c.__compressed_from)}, moved to ${prettyStatus(c.status)})`
    );
    message += ` Note: ${notes.join('; ')}.`;
  }

  if (failed.length > 0) {
    const names = failed.map((f) => f.label ? `"${f.label}"` : 'one of those').join(', ');
    message += ` I couldn't update ${names}.`;
  }

  return message;
}

function formatStatusClause(labels, status) {
  const list = joinWithAnd(labels);
  if (status === 'done') {
    return list + (labels.length === 1 ? ' is now done' : ' are now done');
  }
  if (status === 'waiting_on_other') {
    return list + (labels.length === 1 ? ' is now waiting on someone' : ' are now waiting on someone');
  }
  if (status === 'in_progress') {
    return list + (labels.length === 1 ? ' is now in progress' : ' are now in progress');
  }
  if (status === 'not_started') {
    return list + (labels.length === 1 ? ' is back to not started' : ' are back to not started');
  }
  return list + ` ${labels.length === 1 ? 'is' : 'are'} now ${status}`;
}

function joinWithAnd(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')}, and ${last}`;
}

// ---------------------------------------------------------------------------
// Tool: delete_goal / delete_item
// ---------------------------------------------------------------------------

async function doDeleteGoal(action, rawText) {
  const { goal_id } = action.args;
  const goal = await getGoal(goal_id);
  if (!goal) return err('no_goal', 'That goal is already gone.');

  await saveSession({
    pendingConfirmation: {
      kind: 'yes_no',
      question: `Really delete "${goal.title}"? This removes the goal and all its items.`,
      on_yes: { tool: 'delete_goal_confirmed', args: { goal_id: goal.id } },
    },
    pendingFlag: null,
  });

  return {
    intent: 'delete',
    ok: true,
    message: `Really delete "${goal.title}"? This removes the goal and all its items. Yes or no.`,
    data: { kind: 'delete_goal_confirm', goal_id: goal.id },
  };
}

async function doDeleteItem(action, rawText) {
  const { requirement_id } = action.args;
  const req = await getRequirement(requirement_id);
  if (!req) return err('no_requirement', 'That item is already gone.');

  const goal = await getGoal(req.goal_id);
  const goalTitle = goal?.title ?? 'that goal';

  await saveSession({
    pendingConfirmation: {
      kind: 'yes_no',
      question: `Really delete "${req.label}" from "${goalTitle}"?`,
      on_yes: { tool: 'delete_item_confirmed', args: { requirement_id: req.id } },
    },
    pendingFlag: null,
  });

  return {
    intent: 'delete',
    ok: true,
    message: `Really delete "${req.label}" from "${goalTitle}"? Yes or no.`,
    data: { kind: 'delete_item_confirm', requirement_id: req.id },
  };
}

async function doConfirmedDeleteGoal(action, rawText) {
  const { goal_id, goal_title } = action.args;
  let title = goal_title;
  if (!title) {
    const g = await getGoal(goal_id);
    title = g?.title ?? '(unknown goal)';
  }
  await appendEvent({
    goalId: goal_id,
    rawText: rawText ?? null,
    interpretedChange: { type: 'goal_deleted', title },
  });
  await deleteGoal(goal_id);
  await saveSession({ pendingConfirmation: null, pendingFlag: null });
  return {
    intent: 'delete',
    ok: true,
    message: `Deleted "${title}".`,
    data: { kind: 'goal_deleted', goal_id },
  };
}

async function doConfirmedDeleteItem(action, rawText) {
  const { requirement_id, label, goal_id, goal_title } = action.args;
  let finalLabel = label;
  let finalGoalId = goal_id;
  let finalGoalTitle = goal_title;
  if (!finalLabel || !finalGoalId) {
    const req = await getRequirement(requirement_id);
    if (!req) return err('no_requirement', 'That item is already gone.');
    finalLabel = finalLabel ?? req.label;
    finalGoalId = finalGoalId ?? req.goal_id;
    if (!finalGoalTitle) {
      const g = await getGoal(req.goal_id);
      finalGoalTitle = g?.title ?? 'that goal';
    }
  }
  await appendEvent({
    goalId: finalGoalId,
    requirementId: requirement_id,
    rawText: rawText ?? null,
    interpretedChange: { type: 'requirement_deleted', label: finalLabel },
  });
  await deleteRequirement(requirement_id);
  await saveSession({ pendingConfirmation: null, pendingFlag: null });
  return {
    intent: 'delete',
    ok: true,
    message: `Deleted "${finalLabel}" from "${finalGoalTitle}".`,
    data: { kind: 'requirement_deleted', requirement_id },
  };
}

// ---------------------------------------------------------------------------
// Tool: query
// ---------------------------------------------------------------------------

async function doQuery(action, rawText) {
  const kind = action.args.kind ?? 'list';

  if (kind === 'at_risk') {
    const goals = await listGoals({ status: 'active' });
    const entries = [];
    for (const g of goals) {
      const reqs = await listRequirementsForGoal(g.id);
      entries.push({ goal: g, risk: computeRisk(g, reqs, now()) });
    }
    const report = renderRiskReport(entries);
    const prose =
      report.data.at_risk.length > 0
        ? await phraseSafe(report.data, report.lines.join('\n'))
        : report.lines.join('\n');
    return {
      intent: 'query',
      ok: true,
      message: prose,
      data: { kind: 'risk', report: report.data },
    };
  }

  if (kind === 'next') {
    const goals = await listGoals({ status: 'active' });
    const entries = [];
    for (const g of goals) {
      const reqs = await listRequirementsForGoal(g.id);
      entries.push({ goal: g, requirements: reqs, risk: computeRisk(g, reqs, now()) });
    }
    const report = renderActionReport(entries);
    const prose = await phraseSafe(report.data, report.lines.join('\n'));
    return {
      intent: 'query',
      ok: true,
      message: prose,
      data: { kind: 'action', report: report.data },
    };
  }

  const goals = await listGoals({ status: 'active' });
  if (goals.length === 0) {
    return {
      intent: 'query',
      ok: true,
      message: "You don't have any goals yet. Tell me what you're working toward.",
      data: { kind: 'empty' },
    };
  }

  const parts = [];
  const reports = [];
  for (const g of goals) {
    const reqs = await listRequirementsForGoal(g.id);
    const risk = computeRisk(g, reqs, now());
    const report = renderGoalReport(g, reqs, risk);
    reports.push(report.data);
    parts.push(report.lines.join('\n'));
  }

  const fallback = parts.join('\n\n');
  const prose =
    kind === 'left'
      ? await phraseSafe({ reports }, fallback)
      : fallback;

  return {
    intent: 'query',
    ok: true,
    message: prose,
    data: { kind: 'list', reports },
  };
}

async function phraseSafe(reportData, fallback) {
  try {
    const result = await Promise.race([
      phraseReport(reportData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('phrasing timeout')), 4500)
      ),
    ]);
    return result || fallback;
  } catch (e) {
    console.warn('[onward] phraseReport failed, using fallback:', e.message);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Tool: draft_followup / send_followup
// ---------------------------------------------------------------------------

async function doDraftFollowup(action, rawText, pendingFlag) {
  const { requirement_id } = action.args;

  const result = await executeAction(requirement_id, 'draft_followup', {});
  if (!result.ok) {
    return {
      intent: 'followup',
      ok: false,
      message: `I couldn't draft that: ${result.reason}`,
      data: { kind: 'followup_failed', reason: result.reason },
    };
  }

  const req = await getRequirement(requirement_id);
  const goal = req ? await getGoal(req.goal_id) : null;

  const toLine = req?.depends_on ? ` to ${req.depends_on}` : '';
  const sandboxNote = result.sandboxed
    ? "\n\n(Heads up: I'm in sandbox mode, so nothing was actually sent — this is the draft I'd send.)"
    : '';

  await saveSession({
    pendingConfirmation: {
      kind: 'yes_no',
      question: 'Want me to send this?',
      on_yes: {
        tool: 'send_followup',
        args: { requirement_id, draft: result.draft },
      },
    },
    pendingFlag: null,
    activeGoalId: goal?.id ?? null,
  });

  return {
    intent: 'followup',
    ok: true,
    message:
      `Here's a draft follow-up${toLine} for "${req?.label ?? 'that item'}":\n\n` +
      result.draft +
      sandboxNote +
      '\n\nWant me to send it?',
    data: {
      kind: 'followup_drafted',
      requirement_id,
      draft: result.draft,
      sandboxed: result.sandboxed,
    },
  };
}

async function doSendFollowup(action, rawText, pendingFlag) {
  const { requirement_id, draft } = action.args;

  const result = await executeAction(requirement_id, 'send_followup', {
    draft: draft ?? undefined,
  });
  if (!result.ok) {
    return {
      intent: 'followup',
      ok: false,
      message: `I couldn't send that: ${result.reason}`,
      data: { kind: 'followup_failed', reason: result.reason },
    };
  }

  const req = await getRequirement(requirement_id);
  const goal = req ? await getGoal(req.goal_id) : null;

  await saveSession({
    pendingConfirmation: null,
    pendingFlag: null,
    activeGoalId: goal?.id ?? null,
  });

  const sandboxNote = result.sandboxed
    ? " (Sandbox mode — nothing was actually sent, but I logged the draft.)"
    : '';

  return {
    intent: 'followup',
    ok: true,
    message:
      `Sent${req?.depends_on ? ` to ${req.depends_on}` : ''} for "${req?.label ?? 'that item'}".${sandboxNote}`,
    data: {
      kind: 'followup_sent',
      requirement_id,
      sandboxed: result.sandboxed,
      receipt: result.receipt ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: snooze_reminder
//
// Clears the current flag and notes a snooze window. Reminders for the
// goal named in the flag are suppressed until the window expires. The
// moment that fired stays fired — snooze does not rewind the schedule.
// If the user wants to be reminded again about the same moment, they
// need to change something on the goal (add, update, delete an item)
// or advance past a new moment.
// ---------------------------------------------------------------------------

async function doSnoozeReminder(action, rawText) {
  const untilDays = Number(action.args?.until_days ?? 1);
  const days = Number.isFinite(untilDays) && untilDays > 0 ? untilDays : 1;

  const session = await getSession();
  const currentFlag = session.pending_flag ?? null;

  const resumeAt = new Date(now().getTime() + days * 24 * 60 * 60 * 1000);

  await saveSession({
    pendingConfirmation: session.pending_confirmation ?? null,
    pendingFlag: null,
    activeGoalId: session.active_goal_id ?? null,
  });

  const title = currentFlag?.goalTitle ? `"${currentFlag.goalTitle}"` : 'that goal';
  const when = days === 1 ? 'tomorrow' : `in ${days} days`;

  return {
    intent: 'snooze',
    ok: true,
    message: `Okay, I'll stop reminding you about ${title} until ${when}.`,
    data: {
      kind: 'snoozed',
      until: resumeAt.toISOString(),
      days,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: set_new_deadline
//
// Updates a goal's deadline and clears its reminders_fired so the
// schedule recomputes from the new deadline.
// ---------------------------------------------------------------------------

async function doSetNewDeadline(action, rawText) {
  const goalId = action.args?.goal_id;
  const newDeadline = action.args?.new_deadline;

  if (typeof goalId !== 'string' || !goalId.trim()) {
    return err('no_goal', 'Which goal should I set a new deadline for?');
  }
  if (typeof newDeadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDeadline)) {
    return err('bad_deadline', `What should the new deadline be?`);
  }

  const goal = await getGoal(goalId);
  if (!goal) return err('no_goal', 'That goal seems to be gone.');

  const oldDeadline = goal.deadline;

  await updateGoal(goal.id, {
    deadline: newDeadline,
    reminders_fired: [],
  });

  await appendEvent({
    goalId: goal.id,
    rawText,
    interpretedChange: {
      type: 'deadline_changed',
      title: goal.title,
      old_deadline: oldDeadline,
      new_deadline: newDeadline,
    },
  });

  await saveSession({
    pendingConfirmation: null,
    pendingFlag: null,
    activeGoalId: goal.id,
  });

  return {
    intent: 'deadline_changed',
    ok: true,
    message: `Updated "${goal.title}" to deadline ${newDeadline}. The reminder schedule has been reset.`,
    data: {
      kind: 'deadline_changed',
      goal_id: goal.id,
      new_deadline: newDeadline,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: ask_user
// ---------------------------------------------------------------------------

async function doAskUser(action) {
  const question = action.args.question;
  const expectsReply = action.args.expects_reply !== false;
  const dis = action.args.__disambiguate ?? null;

  if (expectsReply) {
    let pending;
    if (dis && Array.isArray(dis.candidates) && dis.candidates.length > 0) {
      pending = {
        kind: 'disambiguate',
        question,
        candidates: dis.candidates,
        pending_action: dis.pending_action ?? null,
      };
    } else {
      pending = {
        kind: 'ask_user',
        question,
      };
    }
    await saveSession({
      pendingConfirmation: pending,
      pendingFlag: null,
    });
  }

  return {
    intent: 'clarify',
    ok: true,
    message: question,
    data: {
      kind: dis ? 'disambiguate' : 'ask_user',
      ...(dis ? { candidates: dis.candidates } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Proactive flagging — on-demand check, used after item changes
//
// This is the "user just did something to the goal" path. It does not
// walk the schedule; that's reevaluateAllGoals. It only fires if a
// request_by moment has become due for an item that wasn't due before
// — for example, when the user adds a new long-turnaround external
// item to a goal that's already close to its deadline.
//
// The rules:
//   - Never fire on the very first check for a goal (no previous
//     risk assessment).
//   - Never fire if there's nothing due in the schedule.
// ---------------------------------------------------------------------------

async function checkAndRemind(goal, requirements) {
  const risk = computeRisk(goal, requirements, now());
  const today = now();
  const due = getDueReminders(goal, requirements, today, goal.reminders_fired ?? []);

  if (due.length === 0) {
    return { risk, flagged: false, flag: null };
  }

  const top = due[0];
  const facts = buildFlagFacts(goal, requirements, risk, due, top.kind);

  let message;
  try {
    message = await phraseProactiveMessage(facts, top.kind);
  } catch (e) {
    console.warn('[onward] phraseProactiveMessage failed, using fallback:', e.message);
    message = composeProactiveMessageFallback(facts);
  }
  if (!message || !message.trim()) {
    message = composeProactiveMessageFallback(facts);
  }

  await markRemindersFired(goal, due.map((d) => d.kind));

  const flag = {
    goalId: goal.id,
    goalTitle: goal.title,
    momentKind: top.kind,
    riskLevel: risk.risk_level,
    reasons: risk.reasons,
    message,
  };

  return { risk, flagged: true, flag };
}

function buildFlagFacts(goal, requirements, risk, dueReminders = [], momentKind = null) {
  const reqs = Array.isArray(requirements) ? requirements : [];

  const done = reqs.filter((r) => r && r.status === 'done');
  const pending = reqs.filter((r) => r && r.status !== 'done');

  const waiting = pending.filter((r) => r.status === 'waiting_on_other');
  const inProgress = pending.filter((r) => r.status === 'in_progress');
  const notStarted = pending.filter((r) => r.status === 'not_started');

  const days = daysUntil(goal.deadline);

  const overdue = (risk.reasons ?? [])
    .filter((r) => r.kind === 'past_turnaround')
    .map((r) => ({
      label: r.label,
      days_overdue: r.days_overdue,
    }));

  const criticalPath = (risk.reasons ?? [])
    .filter((r) => r.kind === 'critical_path_driver')
    .map((r) => ({
      label: r.label,
      remaining_days: r.remaining_days,
    }));

  const describeReq = (r) => {
    const out = { label: r.label, kind: r.kind, status: r.status };
    if (r.depends_on) out.depends_on = r.depends_on;
    if (r.requested_at) out.requested_at = r.requested_at;
    if (r.received_at) out.received_at = r.received_at;
    if (r.typical_turnaround_days != null) {
      out.typical_turnaround_days = r.typical_turnaround_days;
    }
    return out;
  };

  // For request_by moments, build the "which items and by when" list
  // the composer needs.
  const requestByItems = [];
  if (momentKind && String(momentKind).split(':')[0] === 'request_by') {
    for (const d of dueReminders) {
      if (String(d.kind).split(':')[0] !== 'request_by') continue;
      const r = reqs.find((x) => x.id === d.requirement_id);
      if (!r) continue;
      requestByItems.push({
        label: r.label,
        turnaround_days: r.typical_turnaround_days ?? null,
        request_by_date: d.due_on,
      });
    }
  }

  return {
    goal: {
      title: goal.title ?? 'Your goal',
      deadline: goal.deadline,
      days_until_deadline: days,
      risk_level: risk.risk_level,
    },
    done: done.map(describeReq),
    waiting: waiting.map(describeReq),
    in_progress: inProgress.map(describeReq),
    not_started: notStarted.map(describeReq),
    overdue,
    critical_path: criticalPath,
    request_by_items: requestByItems.length > 0 ? requestByItems : undefined,
  };
}

function composeProactiveMessageFallback(facts) {
  const { goal, done, waiting, in_progress, not_started, overdue, request_by_items } = facts;

  const parts = [];

  const days = goal.days_until_deadline;
  let deadlinePhrase;
  if (days == null) deadlinePhrase = 'has no clear deadline';
  else if (days < -1) deadlinePhrase = `was due ${Math.abs(days)} days ago`;
  else if (days === -1) deadlinePhrase = 'was due yesterday';
  else if (days === 0) deadlinePhrase = 'is due today';
  else if (days === 1) deadlinePhrase = 'is due tomorrow';
  else deadlinePhrase = `is due in ${days} days`;

  parts.push(`"${goal.title}" ${deadlinePhrase}.`);

  if (Array.isArray(request_by_items) && request_by_items.length > 0) {
    const list = request_by_items
      .map((r) => `"${r.label}"`)
      .join(', ');
    parts.push(`You should send the request for ${list} soon so they arrive in time.`);
  }

  if (done.length > 0) {
    const labels = done.map((r) => `"${r.label}"`).join(', ');
    parts.push(`You already have ${labels}.`);
  }

  const pendingParts = [];
  if (waiting.length > 0) {
    const list = waiting
      .map((r) => `"${r.label}"${r.requested_at ? ` (sent ${String(r.requested_at).slice(0, 10)})` : ''}`)
      .join(', ');
    pendingParts.push(`waiting on ${list}`);
  }
  if (in_progress.length > 0) {
    const list = in_progress.map((r) => `"${r.label}"`).join(', ');
    pendingParts.push(`working on ${list}`);
  }
  if (not_started.length > 0) {
    const list = not_started.map((r) => `"${r.label}"`).join(', ');
    pendingParts.push(`haven't started ${list}`);
  }
  if (pendingParts.length > 0) {
    parts.push(`Still pending: ${pendingParts.join('; ')}.`);
  }

  if (overdue.length > 0) {
    const lines = overdue.map(
      (o) => `"${o.label}" is ${o.days_overdue} day${o.days_overdue === 1 ? '' : 's'} past its expected turnaround`
    );
    parts.push(`Worth chasing today — ${lines.join('; ')}.`);
  }

  return parts.join(' ');
}

function daysUntil(deadline) {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return null;
  const today = now();
  const a = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = a instanceof Date ? a : new Date(a);
  const db = b instanceof Date ? b : new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  const ua = Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate());
  const ub = Date.UTC(db.getUTCFullYear(), db.getUTCMonth(), db.getUTCDate());
  return Math.round((ub - ua) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

async function clearPendingConfirmation() {
  const session = await getSession();
  await saveSession({
    pendingConfirmation: null,
    pendingFlag: session.pending_flag ?? null,
    activeGoalId: session.active_goal_id ?? null,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simpleReq(r) {
  return {
    requirement_id: r.id,
    label: r.label,
    kind: r.kind,
    status: r.status,
    depends_on: r.depends_on ?? null,
    requested_at: r.requested_at ?? null,
    received_at: r.received_at ?? null,
  };
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

function slimFlag(flag) {
  return {
    goal_id: flag.goalId,
    goal_title: flag.goalTitle,
    moment_kind: flag.momentKind ?? null,
    risk_level: flag.riskLevel ?? flag.toLevel ?? null,
    reasons: flag.reasons,
    message: flag.message,
  };
}

function err(code, message) {
  return { intent: 'error', ok: false, message, data: {}, error: code };
}