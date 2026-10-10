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
import {
  renderGoalReport,
  renderRiskReport,
  renderActionReport,
} from './services/reportService.js';
import {
  phraseSuggestion,
  phraseReport,
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

export async function reevaluateAllGoals() {
  const goals = await listGoals({ status: 'active' });
  let flagged = 0;
  let lastFlag = null;

  for (const goal of goals) {
    const reqs = await listRequirementsForGoal(goal.id);
    try {
      const { flag } = await checkAndFlag(goal, reqs);
      if (flag) {
        flagged++;
        lastFlag = flag;
      }
    } catch (e) {
      console.error('[onward] reevaluateAllGoals: failed for goal', goal.id, e);
    }
  }

  if (lastFlag) {
    const session = await getSession();
    await saveSession({
      pendingConfirmation: session.pending_confirmation ?? null,
      pendingFlag: lastFlag,
      activeGoalId: session.active_goal_id ?? null,
    });
  }

  return {
    checked: goals.length,
    flagged,
    proactive_message: lastFlag?.message ?? null,
  };
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
    case 'delete_goal':              return doDeleteGoal(action, rawText);
    case 'delete_item':              return doDeleteItem(action, rawText);
    case 'delete_goal_confirmed':    return doConfirmedDeleteGoal(action, rawText);
    case 'delete_item_confirmed':    return doConfirmedDeleteItem(action, rawText);
    case 'query':                    return doQuery(action, rawText);
    case 'draft_followup':           return doDraftFollowup(action, rawText, pendingFlag);
    case 'send_followup':            return doSendFollowup(action, rawText, pendingFlag);
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

  const { risk, flag } = await checkAndFlag(goal, currentReqs);

  const header = `Got it — "${goal.title}", deadline ${goal.deadline}.`;
  const message = suggestionText
    ? `${header}\n\n${suggestionText}`
    : header;

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
    pendingFlag: flag,
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
    proactive_flag: flag ? slimFlag(flag) : null,
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
//
// Accepts goal_ids (array). Adds the named items to every goal in the
// list, deduplicating per goal. Returns one response summarizing what
// went where.
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
  let lastFlag = null;

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

    const reqs = await listRequirementsForGoal(goal.id);
    const { flag } = await checkAndFlag(goal, reqs);
    if (flag) lastFlag = flag;

    perGoal.push({
      goal_id: goal.id,
      goal_title: goal.title,
      added: created.map(simpleReq),
      skipped,
    });
    totalAdded += created.length;
  }

  // Compose one reply summarizing all goals.
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
    pendingFlag: lastFlag,
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
    proactive_flag: lastFlag ? slimFlag(lastFlag) : null,
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
  const { risk, flag } = await checkAndFlag(goal, fresh);
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
// Tool: delete_goal / delete_item (ask for confirmation)
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

  if (goal) {
    const fresh = await listRequirementsForGoal(goal.id);
    await checkAndFlag(goal, fresh);
  }

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
// Proactive risk flagging
// ---------------------------------------------------------------------------

async function checkAndFlag(goal, requirements) {
  const risk = computeRisk(goal, requirements, now());
  const previous = await getLatestRiskAssessment(goal.id);
  const prevLevel = previous?.risk_level ?? null;

  await recordRiskAssessment({
    goalId: goal.id,
    riskLevel: risk.risk_level,
    reasons: risk.reasons,
  });

  const SEVERITY = { ok: 0, tight: 1, at_risk: 2, critical: 3 };
  const prevSeverity = SEVERITY[prevLevel ?? 'ok'] ?? 0;
  const nowSeverity = SEVERITY[risk.risk_level] ?? 0;

  if (previous === null) {
    if (nowSeverity >= SEVERITY.at_risk) {
      const message = composeProactiveMessage(goal, requirements, risk);
      const actionOffer = pickActionOffer(goal, requirements, risk);
      return {
        risk,
        flagged: true,
        flag: {
          goalId: goal.id,
          goalTitle: goal.title,
          fromLevel: null,
          toLevel: risk.risk_level,
          reasons: risk.reasons,
          message,
          actionOffer,
        },
      };
    }
    return { risk, flagged: false, flag: null };
  }

  const crossedIn =
    nowSeverity >= SEVERITY.at_risk && nowSeverity > prevSeverity;

  if (!crossedIn) return { risk, flagged: false, flag: null };

  const message = composeProactiveMessage(goal, requirements, risk);
  const actionOffer = pickActionOffer(goal, requirements, risk);

  return {
    risk,
    flagged: true,
    flag: {
      goalId: goal.id,
      goalTitle: goal.title,
      fromLevel: prevLevel,
      toLevel: risk.risk_level,
      reasons: risk.reasons,
      message,
      actionOffer,
    },
  };
}

function pickActionOffer(goal, requirements, risk) {
  const reasons = risk.reasons ?? [];
  const overdue = reasons.find((r) => r.kind === 'past_turnaround');
  const driver = reasons.find((r) => r.kind === 'critical_path_driver');
  const candidate = overdue ?? driver;
  if (!candidate) return null;

  const req = requirements.find((r) => r.id === candidate.requirement_id);
  if (!req) return null;
  if (req.kind !== 'external_dependency') return null;
  if (!req.requested_at) return null;

  return {
    requirement_id: req.id,
    label: req.label,
    depends_on: req.depends_on ?? null,
  };
}

function composeProactiveMessage(goal, requirements, risk) {
  const title = goal.title ?? 'Your goal';
  const lines = [];

  const days = daysUntil(goal.deadline);
  let deadlinePhrase;
  if (days === null) {
    deadlinePhrase = 'has no clear deadline';
  } else if (days < -1) {
    deadlinePhrase = `was due ${Math.abs(days)} days ago`;
  } else if (days === -1) {
    deadlinePhrase = 'was due yesterday';
  } else if (days === 0) {
    deadlinePhrase = 'is due today';
  } else if (days === 1) {
    deadlinePhrase = 'is due tomorrow';
  } else {
    deadlinePhrase = `is due in ${days} days`;
  }

  const outstanding = (requirements ?? []).filter((r) => r && r.status !== 'done');
  const overdueExternal = (risk.reasons ?? []).find((r) => r.kind === 'past_turnaround');

  if (risk.risk_level === 'critical') {
    lines.push(`Heads up — "${title}" ${deadlinePhrase}.`);
  } else {
    lines.push(`Quick note — "${title}" ${deadlinePhrase}.`);
  }

  if (outstanding.length === 0) {
    lines.push(`Nothing's outstanding — you're set.`);
  } else if (outstanding.length === 1) {
    lines.push(`Still outstanding: "${outstanding[0].label}".`);
  } else {
    const list = outstanding.map((r) => `"${r.label}"`).join(', ');
    lines.push(`Still outstanding: ${list}.`);
  }

  if (overdueExternal) {
    const d = overdueExternal.days_overdue;
    lines.push(
      `"${overdueExternal.label}" is ${d} day${d === 1 ? '' : 's'} past its expected turnaround — worth chasing.`
    );
  }

  return lines.join(' ');
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
    from_level: flag.fromLevel,
    to_level: flag.toLevel,
    reasons: flag.reasons,
    action_offer: flag.actionOffer,
  };
}

function err(code, message) {
  return { intent: 'error', ok: false, message, data: {}, error: code };
}