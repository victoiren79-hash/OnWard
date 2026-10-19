// Onward — orchestrator.
//
// One interpreter call per turn. The interpreter decides which tools to
// run; this file runs them, merges the results, and produces the reply.
//
// The interpreter can return multiple actions per turn. They are sorted
// by a fixed order (destructive actions last, ask_user after writes,
// query after everything) and run one after another. The last writer of
// the session wins; that is why delete confirmations must be last.

import {
  createGoal,
  getGoal,
  listGoals,
  getRequirement,
  listRequirementsForGoal,
  listRequirementsForGoals,
  updateRequirement,
  updateGoal,
  deleteRequirement,
  deleteGoal,
  appendEvent,
  appendEventsBatch,
  createRequirementsBatch,
  listGoalTypeTemplates,
  recordRiskAssessment,
  getSession,
  saveSession,
  appendTurn,
  listEventsForGoal,
} from './db.js';

import { interpretTurn } from './services/updateInterpreter.js';
import {
  findMissingRequirements,
  normalizeLabel,
} from './services/completenessService.js';
import { computeRisk } from './services/riskService.js';
import { getDueReminders, kindRoot } from './services/reminderService.js';
import {
  renderGoalReport,
  renderRiskReport,
  renderActionReport,
  renderAdvice,
  renderLateOptions,
} from './services/reportService.js';
import { phraseProactiveMessage } from './services/phrasing.js';
import {
  pick,
  joinWithAnd,
  classifyReply,
  classifySmallTalk,
  friendlyDate,
  formatTime,
  readTimeTag,
  writeTimeTag,
  bestLabelMatch,
  isoDatePlusDays,
  suggestRequirements,
  resolveDeadlinesReply,
  phraseAnswer,
} from './services/conversation.js';
import { applyTransition, allowedNextStates } from './services/requirementService.js';
import { executeAction } from './services/actionExecutor.js';
import { now } from './services/clock.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const USE_LLM_PHRASING =
  (process.env.USE_LLM_PHRASING ?? 'true').toLowerCase() !== 'false';

// Kept short on purpose: the deterministic fallback text now reads just as
// naturally as the LLM version, so there's no reason to make a busy person
// wait out a slow model call before falling back to it.
const PHRASING_TIMEOUT_MS = 3500;
const SUGGEST_TIMEOUT_MS = 8000;
const DEADLINE_REPLY_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------------------
// Undo
//
// Every change a turn makes registers how to reverse itself. "Undo" reverses
// everything the last changing turn did. Kept in memory: it survives as long
// as the server process does.
// ---------------------------------------------------------------------------

const undoStack = [];
let turnCounter = 0;
const UNDO_RE = /^\s*(undo( that| it| this)?|put (it|that|them) back|oops,? (undo|put it back)|revert( that)?)[.!\s]*$/i;
const GOAL_LEVEL_KINDS = new Set(['overdue', 'due_today', 'two_days_out', 'seven_days_out']);

function pushUndo(label, run) {
  undoStack.push({ turn: turnCounter, label, run });
  if (undoStack.length > 60) undoStack.shift();
}

async function doUndo() {
  if (undoStack.length === 0) {
    return {
      intent: 'undo',
      ok: true,
      message: "There's nothing recent to undo.",
      data: { kind: 'undo_empty' },
      proactive_flag: null,
    };
  }
  const turn = undoStack[undoStack.length - 1].turn;
  const undone = [];
  const failed = [];
  while (undoStack.length > 0 && undoStack[undoStack.length - 1].turn === turn) {
    const entry = undoStack.pop();
    try {
      await entry.run();
      undone.push(entry.label);
    } catch (e) {
      console.error('[onward] undo failed for', entry.label, e);
      failed.push(entry.label);
    }
  }
  const parts = [];
  if (undone.length > 0) {
    parts.push(pick([
      `Okay, I undid the change to ${joinWithAnd([...new Set(undone)])}.`,
      `Done, ${joinWithAnd([...new Set(undone)])} is back the way it was.`,
    ]));
  }
  if (failed.length > 0) {
    parts.push(`I couldn't undo ${joinWithAnd([...new Set(failed)])}.`);
  }
  return {
    intent: 'undo',
    ok: failed.length === 0,
    message: parts.join(' '),
    data: { kind: 'undone', undone, failed },
    proactive_flag: null,
  };
}

// ---------------------------------------------------------------------------
// Notes: a time of day and a progress log live in Requirement.notes
// ---------------------------------------------------------------------------

function localIsoDay() {
  const offset = Number(process.env.USER_UTC_OFFSET_MINUTES ?? 0);
  const t = new Date(now().getTime() + (Number.isFinite(offset) ? offset : 0) * 60000);
  return t.toISOString().slice(0, 10);
}

function buildNotes(base, change = {}) {
  let notes = base ?? null;
  if (change.due_time !== undefined) notes = writeTimeTag(notes, change.due_time);
  if (change.progress_note) {
    notes = `${notes ? notes + '\n' : ''}${localIsoDay()}: ${change.progress_note}`;
  }
  return notes;
}

function hasNoteChange(change) {
  return change.due_time !== undefined || Boolean(change.progress_note);
}

function snapshotOf(req) {
  return {
    status: req.status,
    requested_at: req.requested_at ?? null,
    received_at: req.received_at ?? null,
    notes: req.notes ?? null,
    depends_on: req.depends_on ?? null,
    typical_turnaround_days: req.typical_turnaround_days ?? null,
    due_at: req.due_at ?? null,
    expected_at: req.expected_at ?? null,
    linked_requirement_id: req.linked_requirement_id ?? null,
  };
}

async function buildItemPatch(req, args) {
  const patch = {};
  if (typeof args.depends_on === 'string' && args.depends_on.trim()) {
    patch.depends_on = args.depends_on.trim();
  }
  if (args.turnaround_days != null && Number.isFinite(Number(args.turnaround_days))) {
    patch.typical_turnaround_days = Math.round(Number(args.turnaround_days));
  }
  if (typeof args.due_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.due_at)) {
    patch.due_at = args.due_at;
  }
  if (typeof args.expected_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.expected_at)) {
    patch.expected_at = args.expected_at;
  }
  let linkedTo = null;
  if (typeof args.linked_label === 'string' && args.linked_label.trim()) {
    const siblings = (await listRequirementsForGoal(req.goal_id)).filter((x) => x.id !== req.id);
    const m = bestLabelMatch(args.linked_label, siblings);
    if (m) {
      patch.linked_requirement_id = m.item.id;
      linkedTo = m.item.label;
    }
  }
  const noteChange = {};
  if (typeof args.due_time === 'string') noteChange.due_time = args.due_time;
  if (typeof args.progress_note === 'string' && args.progress_note.trim()) {
    noteChange.progress_note = args.progress_note.trim();
  }
  return { patch, noteChange, linkedTo };
}

// A failed reminder walk must never turn a saved change into an error message.
async function safeCheckAndRemind(goal, requirements) {
  try {
    return await checkAndRemind(goal, requirements);
  } catch (e) {
    console.error('[onward] reminder check failed (change was saved):', e);
    return { risk: { risk_level: 'ok', reasons: [] }, flagged: false, flag: null };
  }
}

// ---------------------------------------------------------------------------
// Timing helper
// ---------------------------------------------------------------------------

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    console.error(`[onward/timing] ${label} ${Date.now() - t0}ms`);
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('phrasing timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Like withTimeout, but actually cancels the underlying request when the
// time is up, so a slow call stops eating rate limit in the background.
// fn receives an AbortSignal and should pass it down to callLLM.
async function withAbortableTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new Error('phrasing timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function handleStatement(text) {
  return timed('total', () => handleStatementInner(text));
}

async function handleStatementInner(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return err('empty', "Sorry, I didn't hear anything. Say that again?");
  }
  const trimmed = text.trim();

  try {
    const [session, state] = await timed('loadFullState', () =>
      Promise.all([getSession(), loadFullState()])
    );

    const pendingContext = session.pending_confirmation ?? null;
    const pendingFlag = await getValidatedPendingFlag(session);
    const history = Array.isArray(session.recent_turns) ? session.recent_turns : [];

    turnCounter++;

    const remember = (response) => {
      if (!response?.data?.retryable) {
        appendTurn(trimmed, response.message).catch((e) =>
          console.warn('[onward] appendTurn failed:', e.message)
        );
      }
      return response;
    };

    if (UNDO_RE.test(trimmed)) {
      return remember(finalize(await doUndo()));
    }

    // ---- yes / no on a pending yes_no question ----------------------------
    if (
      pendingContext &&
      pendingContext.kind === 'yes_no' &&
      pendingContext.on_yes &&
      typeof pendingContext.on_yes.tool === 'string'
    ) {
      const reply = classifyReply(trimmed);

      if (reply === 'yes') {
        await clearPendingConfirmation();
        const response = await dispatch(
          {
            tool: pendingContext.on_yes.tool,
            args: pendingContext.on_yes.args ?? {},
            confidence: 1,
          },
          trimmed,
          { pendingFlag, pendingContext }
        );
        return remember(finalize(response));
      }

      if (reply === 'no') {
        await clearPendingConfirmation();
        return remember({
          intent: 'cancel',
          ok: true,
          message: pick([
            "No problem, I'll leave it as it is.",
            'Okay, leaving it alone.',
            'Sure, no changes.',
          ]),
          data: {},
          proactive_flag: null,
        });
      }
    }

    // ---- goals that were waiting for a date -------------------------------
    let parked = null;
    if (pendingContext && pendingContext.kind === 'await_deadlines') {
      const handled = await timed('deadlineReply', () =>
        handleDeadlineReply(trimmed, pendingContext)
      );
      if (handled.response) return remember(finalize(handled.response));
      // Not about the dates. Handle what they said, then come back to it.
      parked = pendingContext;
    }

    // ---- greetings and thanks ---------------------------------------------
    if (!pendingContext) {
      const talk = classifySmallTalk(trimmed);
      if (talk === 'greeting') {
        return remember({
          intent: 'greeting',
          ok: true,
          message: pick([
            "Hey! What are you working on?",
            "Hi there. What's on your plate?",
            "Hey, what do you need to get done?",
          ]),
          data: {},
          proactive_flag: null,
        });
      }
      if (talk === 'thanks') {
        return remember({
          intent: 'thanks',
          ok: true,
          message: pick(['Anytime.', 'You got it.', 'No problem.', 'Happy to help.']),
          data: {},
          proactive_flag: null,
        });
      }
    }

    // ---- everything else goes to the interpreter ---------------------------
    const actions = await timed('interpretTurn', () =>
      interpretTurn({
        userText: trimmed,
        state,
        history,
        today: now(),
        pendingContext,
        pendingFlag,
        activeGoalId: session.active_goal_id ?? null,
      })
    );

    if (!Array.isArray(actions) || actions.length === 0) {
      return err('empty_actions', "Sorry, I lost you there. Can you say that again?");
    }

    const abandons = actions.some((a) => a.args?.abandons_pending === true);
    const hasAsk = actions.some(
      (a) => a.tool === 'ask_user' && a.args?.expects_reply !== false
    );

    if (pendingContext && (abandons || !hasAsk)) {
      await clearPendingConfirmation();
    }

    const sorted = sortActions(actions);

    const response = await timed('dispatch', () =>
      runActions(sorted, trimmed, { pendingFlag, pendingContext })
    );

    if (parked) await reparkDeadlines(parked, response);

    return remember(finalize(response));
  } catch (e) {
    console.error('[onward] handleStatement failed:', e);

    const msg =
      typeof e.message === 'string' && !e.message.startsWith('[onward/')
        ? e.message
        : "Hmm, something went wrong on my end. Can you try that again?";

    const base = err(e.code ?? 'internal', msg);
    if (e.retryable === true) {
      base.data = { ...(base.data ?? {}), retryable: true };
    }
    return base;
  }
}

// Remove internal bookkeeping before a response leaves the orchestrator.
function finalize(response) {
  if (response && typeof response === 'object' && '_carried' in response) {
    const { _carried, ...clean } = response;
    return clean;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Action ordering
// ---------------------------------------------------------------------------

const ACTION_ORDER = new Map([
  ['undo', -1],
  ['create_goal', 0],
  ['add_items', 1],
  ['update_item', 1],
  ['update_items', 1],
  ['note_context', 1],
  ['move_item', 1],
  ['set_new_deadline', 1],
  ['snooze_reminder', 1],
  ['draft_followup', 1],
  ['send_followup', 1],
  ['complete_goal', 2],
  ['delete_item', 3],
  ['delete_item_confirmed', 3],
  ['delete_goal', 4],
  ['delete_goal_confirmed', 4],
  ['ask_user', 5],
  ['reply', 6],
  ['query', 7],
]);

function sortActions(actions) {
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const xo = ACTION_ORDER.get(x.a.tool) ?? 99;
      const yo = ACTION_ORDER.get(y.a.tool) ?? 99;
      if (xo !== yo) return xo - yo;
      return x.i - y.i;
    })
    .map((x) => x.a);
}

// ---------------------------------------------------------------------------
// runActions — runs the actions in order, joins the results
// ---------------------------------------------------------------------------

async function runActions(actions, rawText, ctx) {
  const results = [];

  // All create_goal actions in a message are handled together so that several
  // goals share one confirmation, one suggestion pass and one deadline question.
  const creates = actions.filter((a) => a.tool === 'create_goal');
  const rest = actions.filter((a) => a.tool !== 'create_goal');
  const queue = [];
  if (creates.length > 0) queue.push({ batch: creates });
  for (const a of rest) queue.push({ action: a });

  let carried = null;

  for (const job of queue) {
    let r;
    try {
      r = job.batch
        ? await doCreateGoals(job.batch, rawText)
        : await dispatch(job.action, rawText, ctx);
    } catch (e) {
      console.error('[onward] action failed:', job.batch ? 'create_goal' : job.action.tool, e);
      const msg =
        typeof e.message === 'string' && !e.message.startsWith('[onward/')
          ? e.message
          : "Hmm, I couldn't save that one. Can you try again?";
      const failure = err(e.code ?? 'internal', msg);
      if (e.retryable === true) {
        failure.data = { ...(failure.data ?? {}), retryable: true };
      }
      if (results.length === 0) return failure;
      const mergedMessages = results
        .map((x) => x.message)
        .filter(Boolean)
        .concat(failure.message);
      return {
        intent: results[results.length - 1].intent,
        ok: false,
        message: mergedMessages.join('\n\n'),
        data: { kind: 'multi_partial', results: results.map((x) => x.data) },
        proactive_flag: lastFlag(results),
      };
    }
    if (r && r._carried) carried = r._carried;
    results.push(finalize(r));
  }

  // Later actions in the same turn reset the session. If goal creation left
  // something the user still needs to answer, put it back.
  if (carried) {
    const session = await getSession();
    const current = session.pending_confirmation ?? null;
    if (carried.kind === 'await_deadlines' || !current) {
      await saveSession({
        pendingConfirmation: carried,
        pendingFlag: session.pending_flag ?? null,
        activeGoalId: session.active_goal_id ?? null,
      });
    }
  }

  if (results.length === 1) return results[0];

  return {
    intent: results[results.length - 1].intent,
    ok: results.every((r) => r.ok),
    message: results.map((r) => r.message).filter(Boolean).join('\n\n'),
    data: { kind: 'multi', results: results.map((r) => r.data) },
    proactive_flag: lastFlag(results),
  };
}

function lastFlag(results) {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].proactive_flag) return results[i].proactive_flag;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reevaluate all goals
// ---------------------------------------------------------------------------

export async function reevaluateAllGoals() {
  const goals = await listGoals({ status: 'active' });
  const today = now();

  const goalIds = goals.map((g) => g.id);
  const allReqs = await listRequirementsForGoals(goalIds);
  const reqsByGoalId = new Map();
  for (const r of allReqs) {
    if (!reqsByGoalId.has(r.goal_id)) reqsByGoalId.set(r.goal_id, []);
    reqsByGoalId.get(r.goal_id).push(r);
  }

  let firedThisPass = 0;
  let lastFiredFlag = null;
  const riskByGoalId = new Map();

  for (const goal of goals) {
    const reqs = reqsByGoalId.get(goal.id) ?? [];

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

    let due = [];
    try {
      due = getDueReminders(goal, reqs, today, goal.reminders_fired ?? []);
    } catch (e) {
      console.error('[onward] reevaluateAllGoals: reminders failed for goal', goal.id, e);
      continue;
    }

    if (due.length === 0) continue;

    const top = due[0];
    const facts = buildFlagFacts(goal, reqs, risk, due, top.kind);
    const message = await buildReminderMessage(facts, top.kind);

    const flag = {
      goalId: goal.id,
      goalTitle: goal.title,
      momentKind: top.kind,
      riskLevel: risk.risk_level,
      reasons: risk.reasons,
      message,
    };

    await markRemindersFired(goal, due.map((d) => d.kind));

    firedThisPass++;
    lastFiredFlag = flag;
  }

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

async function markRemindersFired(goal, kinds) {
  const existing = Array.isArray(goal.reminders_fired) ? goal.reminders_fired : [];
  const set = new Set(existing);
  for (const k of kinds) set.add(k);
  const next = [...set];

  try {
    await updateGoal(goal.id, { reminders_fired: next });
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

  const goalIds = goals.map((g) => g.id);
  const allReqs = await listRequirementsForGoals(goalIds);

  const reqsByGoalId = new Map();
  for (const r of allReqs) {
    if (!reqsByGoalId.has(r.goal_id)) reqsByGoalId.set(r.goal_id, []);
    reqsByGoalId.get(r.goal_id).push(r);
  }

  const withReqs = goals.map((g) => {
    const reqs = reqsByGoalId.get(g.id) ?? [];
    return {
      id: g.id,
      title: g.title,
      deadline: g.deadline,
      goal_type: g.goal_type,
      status: g.status,
      deadline_time: readTimeTag(g.context),
      context: writeTimeTag(g.context ?? null, null),
      requirements: reqs.map((r) => ({
        due_time: readTimeTag(r.notes),
        id: r.id,
        label: r.label,
        kind: r.kind,
        status: r.status,
        depends_on: r.depends_on ?? null,
        requested_at: r.requested_at ?? null,
        received_at: r.received_at ?? null,
        due_at: r.due_at ?? null,
        expected_at: r.expected_at ?? null,
        linked_requirement_id: r.linked_requirement_id ?? null,
      })),
    };
  });

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
    case 'goal_completed':
      return `Completed goal "${change.title}".`;
    case 'context_noted':
      return `Noted context on "${change.title}".`;
    case 'item_moved':
      return `Moved "${change.label}" to "${change.to_goal_title ?? change.new_goal_title ?? 'a new goal'}".`;
    case 'details_changed':
      return `Updated details on "${change.label}".`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(action, rawText, { pendingFlag = null, pendingContext = null } = {}) {
  if (action.tool === 'delete_goal_confirmed' || action.tool === 'delete_item_confirmed') {
    const isGoal = action.tool === 'delete_goal_confirmed';
    const id = isGoal ? action.args?.goal_id : action.args?.requirement_id;
    const expectedTool = pendingContext?.on_yes?.tool;
    const expectedId = isGoal
      ? pendingContext?.on_yes?.args?.goal_id
      : pendingContext?.on_yes?.args?.requirement_id;

    const confirmed =
      pendingContext?.kind === 'yes_no' &&
      expectedTool === action.tool &&
      expectedId === id;

    if (!confirmed) {
      return err('not_confirmed', "I want to double check before deleting anything. Which one do you mean?");
    }
  }

  switch (action.tool) {
    case 'create_goal':              return doCreateGoals([action], rawText);
    case 'add_items':                return doAddItems(action, rawText, pendingContext);
    case 'update_item':              return doUpdateItem(action, rawText);
    case 'update_items':             return doUpdateItems(action, rawText);
    case 'delete_goal':              return doDeleteGoal(action, rawText);
    case 'delete_item':              return doDeleteItem(action, rawText);
    case 'delete_goal_confirmed':    return doConfirmedDeleteGoal(action, rawText);
    case 'delete_item_confirmed':    return doConfirmedDeleteItem(action, rawText);
    case 'query':                    return doQuery(action, rawText);
    case 'reply':                    return doReply(action);
    case 'undo':                     return doUndo();
    case 'draft_followup':           return doDraftFollowup(action, rawText, pendingFlag);
    case 'send_followup':            return doSendFollowup(action, rawText, pendingFlag);
    case 'snooze_reminder':          return doSnoozeReminder(action, rawText);
    case 'set_new_deadline':         return doSetNewDeadline(action, rawText);
    case 'ask_user':                 return doAskUser(action);
    case 'complete_goal':            return doCompleteGoal(action, rawText);
    case 'note_context':             return doNoteContext(action, rawText);
    case 'move_item':                return doMoveItem(action, rawText);
    default:
      return err('unknown_tool', "Hmm, I'm not sure how to do that one.");
  }
}

// ---------------------------------------------------------------------------
// Tool: create_goal (one or many goals in a single message)
//
// Everything in one turn is handled together:
//   - goals that have a date are created right away, in parallel
//   - goals without a date are parked and asked about in ONE question
//   - one suggestion pass covers every new goal, typed or not
//   - one confirmation message covers all of it
// ---------------------------------------------------------------------------

async function createOneGoal(args, rawText) {
  const { title, deadline, goal_type, requirements } = args;

  const [goal, template] = await Promise.all([
    createGoal({
      title,
      deadline,
      goalType: goal_type,
      context: writeTimeTag(null, args.deadline_time ?? null),
    }),
    goal_type
      ? listGoalTypeTemplates(goal_type).catch((e) => {
          console.warn('[onward] createOneGoal: template load failed:', e.message);
          return [];
        })
      : Promise.resolve([]),
  ]);

  let createdReqs = [];
  try {
    if (Array.isArray(requirements) && requirements.length > 0) {
      const insertedAt = now();
      const seenLabels = new Set();
      const unique = requirements.filter((r) => {
        const key = normalizeLabel(r.label);
        if (seenLabels.has(key)) return false;
        seenLabels.add(key);
        return true;
      });
      const rows = unique.map((r) => {
        const isDone = r.status === 'done';
        const isWaiting = r.status === 'waiting_on_other';
        return {
          label: r.label,
          kind: r.kind ?? 'self_action',
          status: r.status ?? 'not_started',
          dependsOn: r.depends_on ?? null,
          typicalTurnaroundDays: r.turnaround_days ?? null,
          dueAt: r.due_at ?? null,
          expectedAt: r.expected_at ?? null,
          receivedAt: isDone ? insertedAt.toISOString() : null,
          requestedAt: isWaiting ? insertedAt.toISOString() : null,
          notes: buildNotes(null, {
            due_time: r.due_time ?? undefined,
            progress_note: r.progress_note ?? undefined,
          }),
        };
      });

      createdReqs = await createRequirementsBatch(goal.id, rows);

      // "Drinks only after the guest count": link by name, now that every
      // task in this goal has an id.
      for (let i = 0; i < unique.length; i++) {
        const wanted = unique[i].linked_label;
        if (!wanted) continue;
        const target = bestLabelMatch(
          wanted,
          createdReqs.filter((x) => x.id !== createdReqs[i].id)
        );
        if (target) {
          const updated = await updateRequirement(createdReqs[i].id, {
            linked_requirement_id: target.item.id,
          });
          createdReqs[i] = { ...createdReqs[i], ...(updated ?? {}), linked_requirement_id: target.item.id };
        }
      }

      const events = [
        {
          goalId: goal.id,
          rawText,
          interpretedChange: {
            type: 'goal_created',
            title: goal.title,
            deadline: goal.deadline,
            goal_type: goal.goal_type,
          },
        },
        ...createdReqs.map((req) => ({
          goalId: goal.id,
          requirementId: req.id,
          rawText,
          interpretedChange: {
            type: 'requirement_created',
            label: req.label,
            kind: req.kind,
            status: req.status,
          },
        })),
      ];
      await appendEventsBatch(events);
    } else {
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
    }
  } catch (e) {
    console.error('[onward] createOneGoal: insert failed, rolling back goal', goal.id, e);
    try {
      await deleteGoal(goal.id);
    } catch (rollbackErr) {
      console.error('[onward] createOneGoal: rollback failed', rollbackErr);
    }
    throw e;
  }

  return { goal, createdReqs, template };
}

async function doCreateGoals(actions, rawText) {
  const active = await listGoals({ status: 'active' });
  const activeByKey = new Map(active.map((g) => [normalizeLabel(g.title), g]));

  const ready = [];
  const needDate = [];
  const dupes = [];
  const seen = new Set();

  for (const a of actions) {
    const args = a.args ?? {};
    const key = normalizeLabel(args.title);
    if (seen.has(key)) continue;
    seen.add(key);

    if (activeByKey.has(key)) {
      dupes.push(activeByKey.get(key));
      continue;
    }

    if (args.deadline) {
      ready.push(args);
    } else {
      needDate.push({
        title: args.title,
        goal_type: args.goal_type ?? null,
        requirements: args.requirements ?? [],
      });
    }
  }

  return finishCreation({ ready, needDate, dupes, heldOffers: [], rawText });
}

async function finishCreation({
  ready,
  needDate,
  dupes = [],
  heldOffers = [],
  rawText,
  defaultedTitles = [],
  lead = null,
}) {
  const today = now();

  // ---- create the goals that have a date ----------------------------------
  const settled = await Promise.allSettled(ready.map((a) => createOneGoal(a, rawText)));
  const created = [];
  const failedTitles = [];
  let firstError = null;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      created.push(s.value);
    } else {
      failedTitles.push(ready[i].title);
      firstError = firstError ?? s.reason;
      console.error('[onward] finishCreation: could not create', ready[i].title, s.reason);
    }
  });
  if (
    created.length === 0 &&
    failedTitles.length > 0 &&
    needDate.length === 0 &&
    dupes.length === 0
  ) {
    throw firstError;
  }

  // ---- risk + the most urgent reminder across the new goals ----------------
  let candidate = null;
  for (const c of created) {
    try {
      const risk = computeRisk(c.goal, c.createdReqs, today);
      c.risk = risk;
      recordRiskAssessment({
        goalId: c.goal.id,
        riskLevel: risk.risk_level,
        reasons: risk.reasons,
      }).catch((e) => console.warn('[onward] recordRiskAssessment failed:', e.message));

      const due = getDueReminders(c.goal, c.createdReqs, today, []);
      if (due.length > 0 && (!candidate || due[0].priority < candidate.due[0].priority)) {
        candidate = { c, due, risk };
      }
    } catch (e) {
      console.error('[onward] finishCreation: risk/reminder walk failed:', e);
    }
  }

  // The reminder message and the suggestions don't depend on each other,
  // so they run at the same time.
  const buildCreationFlag = async () => {
    if (!candidate) return null;
    try {
      const top = candidate.due[0];
      const facts = buildFlagFacts(
        candidate.c.goal,
        candidate.c.createdReqs,
        candidate.risk,
        candidate.due,
        top.kind
      );
      const message = await buildReminderMessage(facts, top.kind);
      await markRemindersFired(candidate.c.goal, candidate.due.map((d) => d.kind));
      return {
        goalId: candidate.c.goal.id,
        goalTitle: candidate.c.goal.title,
        momentKind: top.kind,
        riskLevel: candidate.risk.risk_level,
        reasons: candidate.risk.reasons,
        message,
      };
    } catch (e) {
      console.error('[onward] finishCreation: reminder build failed:', e);
      return null;
    }
  };

  const entries = created.map((c) => {
    const diff = findMissingRequirements(c.goal, c.createdReqs, c.template);
    return {
      goal: c.goal,
      existing: c.createdReqs,
      essentials: diff.missing.filter((m) => m.priority === 'essential'),
      helpful: diff.missing.filter((m) => m.priority !== 'essential'),
      all: diff.missing,
    };
  });

  const [creationFlag, suggestion] = await Promise.all([
    buildCreationFlag(),
    buildSuggestions(entries, {
      userText: rawText,
      today,
      askAtEnd: needDate.length === 0,
    }),
  ]);

  const newOffers = offerEntriesFrom(entries, suggestion);
  const offerEntries = [...heldOffers, ...newOffers];

  // ---- what the user still has to answer -----------------------------------
  let pending = null;
  if (needDate.length > 0) {
    pending = {
      kind: 'await_deadlines',
      question: composeDeadlineQuestion(needDate.map((p) => p.title)),
      expects: 'deadline',
      partials: needDate,
      held_offers: offerEntries,
    };
  } else {
    pending = buildOfferPending(offerEntries);
  }

  // ---- the reply -------------------------------------------------------------
  const parts = [];
  if (lead) parts.push(lead);
  const createdLine = composeCreatedLine(created, today, defaultedTitles, dupes);
  if (createdLine) parts.push(createdLine);
  if (failedTitles.length > 0) {
    parts.push(
      `I couldn't save ${joinWithAnd(failedTitles)} just now. Can you say ${failedTitles.length === 1 ? 'that one' : 'those'} again?`
    );
  }
  if (suggestion.text) parts.push(suggestion.text);
  if (needDate.length > 0) parts.push(pending.question);
  const message = parts.join('\n\n');

  const session = await getSession();
  await saveSession({
    pendingConfirmation: pending,
    pendingFlag: creationFlag,
    activeGoalId: created.length > 0
      ? created[created.length - 1].goal.id
      : session.active_goal_id ?? null,
  });

  const slimGoals = created.map((c) => ({
    id: c.goal.id,
    title: c.goal.title,
    deadline: c.goal.deadline,
    goal_type: c.goal.goal_type,
  }));

  let data;
  if (created.length === 1) {
    data = {
      kind: 'goal_created',
      goal: slimGoals[0],
      requirements: created[0].createdReqs.map(simpleReq),
      offered: newOffers.flatMap((o) => o.offered_labels),
      risk_level: created[0].risk?.risk_level ?? null,
    };
  } else if (created.length > 1) {
    data = { kind: 'goals_created', goals: slimGoals };
  } else {
    data = {
      kind: 'await_deadline',
      partial_goals: needDate.map(({ title, goal_type }) => ({ title, goal_type })),
    };
  }
  data.awaiting_deadline = needDate.map((p) => p.title);

  return {
    intent: 'create',
    ok: true,
    message,
    data,
    proactive_flag: creationFlag ? slimFlag(creationFlag) : null,
    _carried: pending,
  };
}

// ---- suggestion helpers ------------------------------------------------------

async function buildSuggestions(entries, { userText, today, askAtEnd }) {
  const empty = { text: '', per_goal: [] };
  if (entries.length === 0) return empty;

  if (USE_LLM_PHRASING) {
    try {
      return await withAbortableTimeout(
        (signal) => suggestRequirements(entries, { userText, today, askAtEnd, signal }),
        SUGGEST_TIMEOUT_MS
      );
    } catch (e) {
      console.warn('[onward] suggestRequirements failed:', e.message);
    }
  }
  return fallbackSuggestions(entries, askAtEnd);
}

// Used when the LLM is off or slow: only goals with a template have anything
// to say.
function fallbackSuggestions(entries, askAtEnd = true) {
  const perGoal = [];
  const bits = [];
  for (const e of entries) {
    const picked = [
      ...e.essentials,
      ...(e.essentials.length === 0 ? e.helpful.slice(0, 1) : []),
    ];
    perGoal.push({
      goal_id: e.goal.id,
      items: picked.map((p) => ({ label: p.label, kind: p.kind })),
    });
    if (picked.length > 0) {
      bits.push(
        `For ${e.goal.title}, you'll probably want ${joinWithAnd(picked.map((p) => p.label))}.`
      );
    }
  }
  if (bits.length === 0) return { text: '', per_goal: perGoal };
  const closing = askAtEnd ? ' Want me to add those?' : " I can add those too.";
  return { text: bits.join(' ') + closing, per_goal: perGoal };
}

function offerEntriesFrom(entries, suggestion) {
  const byGoal = new Map((suggestion.per_goal ?? []).map((pg) => [pg.goal_id, pg.items ?? []]));
  const out = [];
  for (const e of entries) {
    const items = byGoal.get(e.goal.id) ?? [];
    if (items.length === 0) continue;
    const offeredLabels = items.map((i) => i.label);
    const allMissing = [...new Set([...e.all.map((m) => m.label), ...offeredLabels])];
    out.push({
      goal_id: e.goal.id,
      goal_title: e.goal.title,
      offered_items: items,
      offered_labels: offeredLabels,
      all_missing_labels: allMissing,
    });
  }
  return out;
}

function buildOfferPending(entries) {
  if (!entries || entries.length === 0) return null;
  const first = entries[0];
  const base = {
    kind: 'suggestion_offer',
    goal_id: first.goal_id,
    goal_title: first.goal_title,
    offered_labels: first.offered_labels,
    offered_items: first.offered_items,
    all_missing_labels: first.all_missing_labels,
  };
  if (entries.length === 1) return base;

  const offers = {};
  for (const e of entries) {
    offers[e.goal_id] = {
      goal_title: e.goal_title,
      offered_labels: e.offered_labels,
      offered_items: e.offered_items,
      all_missing_labels: e.all_missing_labels,
    };
  }
  return { ...base, multi: true, offers };
}

// Find the kind (self vs external) a suggestion was offered with, so that
// "yes, add them" keeps the right kind even when the interpreter guesses.
function offeredKindFor(pendingContext, goalId, label) {
  if (!pendingContext || pendingContext.kind !== 'suggestion_offer') return null;
  const key = normalizeLabel(label);
  const pools = [];
  if (pendingContext.offers && typeof pendingContext.offers === 'object') {
    for (const [gid, offer] of Object.entries(pendingContext.offers)) {
      if (!goalId || gid === goalId) pools.push(offer?.offered_items ?? []);
    }
  }
  if (!goalId || pendingContext.goal_id === goalId) {
    pools.push(pendingContext.offered_items ?? []);
  }
  for (const pool of pools) {
    for (const it of pool) {
      if (normalizeLabel(it.label) === key) return it.kind ?? null;
    }
  }
  return null;
}

// ---- message helpers ----------------------------------------------------------

function composeCreatedLine(created, today, defaultedTitles = [], dupes = []) {
  const parts = [];

  if (created.length === 1) {
    const { goal } = created[0];
    const when = friendlyDate(goal.deadline, today, readTimeTag(goal.context));
    const tasks = taskCountText(created[0]);
    parts.push(
      pick([
        `Okay, ${goal.title} is on the list, due ${when}${tasks}.`,
        `Got it. ${goal.title}, due ${when}${tasks}.`,
        `Done. I've got ${goal.title} down for ${when}${tasks}.`,
      ])
    );
  } else if (created.length > 1) {
    const list = created.map(
      (c) =>
        `${c.goal.title} (${friendlyDate(c.goal.deadline, today, readTimeTag(c.goal.context))}${taskCountText(c, true)})`
    );
    parts.push(
      pick([
        `Okay, I've added ${joinWithAnd(list)}.`,
        `Got it. That's ${joinWithAnd(list)}.`,
      ])
    );
  }

  if (defaultedTitles.length > 0) {
    parts.push(
      `There was no date for ${joinWithAnd(defaultedTitles)}, so I set it a week out. Tell me if you want a different day.`
    );
  }
  if (dupes.length > 0) {
    parts.push(`You're already tracking ${joinWithAnd(dupes.map((g) => g.title))}.`);
  }
  return parts.join(' ');
}

function taskCountText(c, short = false) {
  const n = c.createdReqs.length;
  if (n === 0) return '';
  const done = c.createdReqs.filter((r) => r.status === 'done').length;
  if (short) return `, ${n} task${n === 1 ? '' : 's'}`;

  // Say it the way a person would, not a tally: skip the count entirely
  // when nothing is done yet, and only call out progress when there's
  // something worth mentioning. No trailing period — the caller's
  // sentence template supplies that.
  if (done === 0) return '';
  if (done === n) return n === 1 ? ' — already got that one' : ' — you already have everything for it';
  return ` — ${done} of ${n} already done`;
}

function composeDeadlineQuestion(titles) {
  if (titles.length === 1) {
    return pick([
      `When does ${titles[0]} need to be done?`,
      `When's ${titles[0]} due?`,
      `What's the deadline for ${titles[0]}?`,
    ]);
  }
  const list = joinWithAnd(titles);
  return pick([
    `When are ${list} due? You can answer them all in one go.`,
    `What dates should I put on ${list}? One answer is fine.`,
  ]);
}

// ---- answering "when is it due?" ----------------------------------------------

async function handleDeadlineReply(text, pending) {
  const partials = Array.isArray(pending.partials) ? pending.partials : [];
  if (partials.length === 0) {
    await clearPendingConfirmation();
    return { response: null };
  }
  const titles = partials.map((p) => p.title);

  let res;
  try {
    res = await withTimeout(
      resolveDeadlinesReply(text, partials, now()),
      DEADLINE_REPLY_TIMEOUT_MS
    );
  } catch (e) {
    console.warn('[onward] resolveDeadlinesReply failed:', e.message);
    return {
      response: {
        intent: 'clarify',
        ok: true,
        message: `Sorry, I missed that. When ${titles.length === 1 ? 'is' : 'are'} ${joinWithAnd(titles)} due?`,
        data: { kind: 'await_deadline', retryable: true },
        proactive_flag: null,
      },
    };
  }

  if (res.answers.length === 0) {
    if (res.unrelated) return { response: null };
    return {
      response: {
        intent: 'clarify',
        ok: true,
        message: pick([
          `I didn't catch a date there. When ${titles.length === 1 ? 'is' : 'are'} ${joinWithAnd(titles)} due?`,
          `Sorry, what date should I use for ${joinWithAnd(titles)}?`,
        ]),
        data: { kind: 'await_deadline' },
        proactive_flag: null,
      },
    };
  }

  const ready = [];
  const remaining = [];
  const defaulted = [];
  partials.forEach((p, i) => {
    const a = res.answers.find((x) => x.index === i);
    if (!a) {
      remaining.push(p);
      return;
    }
    let deadline = a.deadline;
    if (!deadline && a.no_deadline) {
      deadline = isoDatePlusDays(now(), 7);
      defaulted.push(p.title);
    }
    if (!deadline) {
      remaining.push(p);
      return;
    }
    ready.push({
      title: p.title,
      deadline,
      goal_type: p.goal_type ?? null,
      requirements: p.requirements ?? [],
    });
  });

  // "Yes add them, and Friday" — honour the yes for goals that already exist.
  let held = Array.isArray(pending.held_offers) ? pending.held_offers : [];
  let lead = null;
  if (held.length > 0 && res.accepts_suggestions === true) {
    const msgs = [];
    for (const offer of held) {
      const r = await doAddItems(
        {
          args: {
            goal_ids: [offer.goal_id],
            items: (offer.offered_items ?? []).map((i) => ({
              label: i.label,
              kind: i.kind,
              status: 'not_started',
            })),
          },
        },
        text,
        null
      );
      if (r?.ok && r.message) msgs.push(r.message);
    }
    lead = msgs.join(' ') || null;
    held = [];
  } else if (res.accepts_suggestions === false) {
    held = [];
  }

  const response = await finishCreation({
    ready,
    needDate: remaining,
    heldOffers: held,
    rawText: text,
    defaultedTitles: defaulted,
    lead,
  });
  return { response };
}

// The user said something unrelated while goals were waiting for a date. We
// handled their message; now put the question back so a later "Friday" works.
async function reparkDeadlines(parked, response) {
  const session = await getSession();
  const current = session.pending_confirmation ?? null;
  const parkedTitles = (parked.partials ?? []).map((p) => p.title);

  if (current && current.kind === 'await_deadlines') {
    const keys = new Set((current.partials ?? []).map((p) => normalizeLabel(p.title)));
    const older = (parked.partials ?? []).filter((p) => !keys.has(normalizeLabel(p.title)));
    const merged = {
      ...current,
      partials: [...older, ...(current.partials ?? [])],
      held_offers: [...(parked.held_offers ?? []), ...(current.held_offers ?? [])],
    };
    merged.question = composeDeadlineQuestion(merged.partials.map((p) => p.title));
    await saveSession({
      pendingConfirmation: merged,
      pendingFlag: session.pending_flag ?? null,
      activeGoalId: session.active_goal_id ?? null,
    });
    if (older.length > 0 && response && typeof response.message === 'string') {
      response.message += `\n\nI also still need a date for ${joinWithAnd(older.map((p) => p.title))}.`;
    }
    return;
  }

  if (!current) {
    await saveSession({
      pendingConfirmation: parked,
      pendingFlag: session.pending_flag ?? null,
      activeGoalId: session.active_goal_id ?? null,
    });
    if (parkedTitles.length > 0 && response && typeof response.message === 'string') {
      response.message += `\n\nBy the way, I still need a date for ${joinWithAnd(parkedTitles)}.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool: reply (small talk, "what can you do", anything that needs no change)
// ---------------------------------------------------------------------------

function doReply(action) {
  const text = String(action.args?.text ?? '').trim();
  return {
    intent: 'reply',
    ok: true,
    message: text || "I'm here. What do you need?",
    data: { kind: 'reply' },
    proactive_flag: null,
  };
}

// ---------------------------------------------------------------------------
// Tool: add_items
// ---------------------------------------------------------------------------

async function doAddItems(action, rawText, pendingContext = null) {
  const goalIds = Array.isArray(action.args.goal_ids)
    ? action.args.goal_ids
    : (typeof action.args.goal_id === 'string' ? [action.args.goal_id] : []);
  const items = Array.isArray(action.args.items) ? action.args.items : [];

  if (goalIds.length === 0) {
    return err('no_goal', 'Which goal should I put that on?');
  }
  if (items.length === 0) {
    return err('no_items', 'What do you want me to add?');
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

    let template = [];
    if (goal.goal_type) {
      try {
        template = await listGoalTypeTemplates(goal.goal_type);
      } catch (e) {
        console.warn('[onward] doAddItems: template load failed:', e.message);
        template = [];
      }
    }

    const existing = await listRequirementsForGoal(goal.id);
    const existingKeys = new Set(existing.map((r) => normalizeLabel(r.label)));

    const toCreate = [];
    const skipped = [];
    const insertedAt = now();

    for (const item of items) {
      const key = normalizeLabel(item.label);
      const near = bestLabelMatch(item.label, existing);
      const nearDuplicate = near && near.ratio === 1 && near.shared >= 1;
      if (existingKeys.has(key) || nearDuplicate) {
        skipped.push(item.label);
        continue;
      }
      existingKeys.add(key);

      const templateRow = template.find((t) => normalizeLabel(t.label) === key);
      const offeredKind = offeredKindFor(pendingContext, goal.id, item.label);

      let kind;
      if (templateRow?.kind) {
        kind = templateRow.kind;
      } else if (offeredKind) {
        kind = offeredKind;
      } else if (item.kind === 'external_dependency') {
        kind = 'external_dependency';
      } else {
        kind = 'self_action';
      }

      const typicalTurnaroundDays =
        item.turnaround_days ??
        (kind === 'external_dependency'
          ? templateRow?.typical_turnaround_days ?? null
          : null);

      const isDone = item.status === 'done';

      toCreate.push({
        label: item.label,
        kind,
        status: item.status ?? 'not_started',
        dependsOn: item.depends_on ?? null,
        typicalTurnaroundDays,
        dueAt: item.due_at ?? null,
        expectedAt: item.expected_at ?? null,
        linkedRequirementId: item.linked_requirement_id ?? null,
        receivedAt: isDone ? insertedAt.toISOString() : null,
        requestedAt: item.status === 'waiting_on_other' ? insertedAt.toISOString() : null,
        notes: buildNotes(null, {
          due_time: item.due_time ?? undefined,
          progress_note: item.progress_note ?? undefined,
        }),
        _linkedLabel: item.linked_label ?? null,
      });
    }

    if (toCreate.length === 0) {
      perGoal.push({ goal_id: goal.id, goal_title: goal.title, added: [], skipped });
      continue;
    }

    const created = await createRequirementsBatch(goal.id, toCreate);

    for (let i = 0; i < created.length; i++) {
      const wanted = toCreate[i]._linkedLabel;
      if (!wanted) continue;
      const target = bestLabelMatch(
        wanted,
        [...existing, ...created].filter((x) => x.id !== created[i].id)
      );
      if (target) {
        await updateRequirement(created[i].id, { linked_requirement_id: target.item.id });
        created[i] = { ...created[i], linked_requirement_id: target.item.id };
      }
    }

    {
      const createdIds = created.map((c) => c.id);
      pushUndo(joinWithAnd(created.map((c) => c.label)), async () => {
        for (const id of createdIds) await deleteRequirement(id);
      });
    }

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
  const skippedLabels = [];
  const skippedTitles = [];
  for (const r of perGoal) {
    if (r.missing) continue;
    if (r.added.length > 0) {
      addParts.push(`${joinWithAnd(r.added.map((a) => a.label))} to ${r.goal_title}`);
    }
    if (r.skipped.length > 0) {
      skippedLabels.push(...r.skipped);
      skippedTitles.push(r.goal_title);
    }
  }

  const alreadyThere =
    skippedLabels.length > 0
      ? `${joinWithAnd(skippedLabels)} ${skippedLabels.length === 1 ? 'was' : 'were'} already on ${joinWithAnd([...new Set(skippedTitles)])}.`
      : '';

  let message;
  if (totalAdded === 0) {
    message = alreadyThere
      ? `${alreadyThere} Nothing new to add.`
      : 'Nothing new to add.';
  } else {
    const list = joinWithAnd(addParts);
    message = pick([
      `Added ${list}.`,
      `Done, I added ${list}.`,
      `Sure thing. Added ${list}.`,
    ]);
    if (alreadyThere) message += ` ${alreadyThere}`;
  }

  const session = await getSession();
  await saveSession({
    pendingConfirmation: null,
    pendingFlag: null,
    activeGoalId: lastGoal?.id ?? session.active_goal_id ?? null,
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
  const { requirement_id, new_status, __compressed_from, depends_on, expected_at, due_at } = action.args;
  const { due_time } = action.args;

  const req = await getRequirement(requirement_id);
  if (!req) return err('no_requirement', "I can't find that one anymore.");

  const goal = await getGoal(req.goal_id);
  if (!goal) return err('no_goal', "I can't find that goal anymore.");

  const { patch, noteChange, linkedTo } = await buildItemPatch(req, action.args);
  const hasDetails = Object.keys(patch).length > 0 || hasNoteChange(noteChange);
  const snapshot = snapshotOf(req);

  const messageParts = [];
  let eventPayload = null;

  if (new_status) {
    const result = applyTransition(req, new_status, { at: now() });
    if (!result.ok) {
      const nearest = result.nearestLegal;
      const msg = nearest
        ? `${req.label} is ${prettyStatus(req.status)} right now, so the closest I can do is ${prettyStatus(nearest)}. Want me to do that?`
        : `I can't take ${req.label} from ${prettyStatus(req.status)} to ${prettyStatus(new_status)}.`;
      const session = await getSession();
      await saveSession({
        pendingConfirmation: {
          kind: 'yes_no',
          question: msg,
          on_yes: nearest
            ? { tool: 'update_item', args: { requirement_id: req.id, new_status: nearest } }
            : null,
        },
        pendingFlag: null,
        activeGoalId: session.active_goal_id ?? null,
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
      notes: hasNoteChange(noteChange)
        ? buildNotes(next.notes ?? req.notes ?? null, noteChange)
        : next.notes,
      ...patch,
    });

    eventPayload = {
      type: 'status_changed',
      from: req.status,
      to: next.status,
      label: req.label,
      ...(__compressed_from ? { compressed_from: __compressed_from } : {}),
    };

    messageParts.push(statusLine(req.label, next.status, patch.depends_on ?? req.depends_on));
  } else {
    if (!hasDetails) {
      return err('no_details', `What should I change on ${req.label}?`);
    }
    await updateRequirement(requirement_id, {
      ...patch,
      ...(hasNoteChange(noteChange) ? { notes: buildNotes(req.notes ?? null, noteChange) } : {}),
    });
    eventPayload = { type: 'details_changed', label: req.label, ...patch };
  }

  pushUndo(req.label, () => updateRequirement(req.id, snapshot));

  if (hasDetails) {
    const bits = [];
    const dueDate = patch.due_at ?? req.due_at;
    const dueTime = noteChange.due_time ?? readTimeTag(req.notes);
    if (patch.due_at || noteChange.due_time !== undefined) {
      if (dueDate) {
        bits.push(`It's due ${friendlyDate(dueDate, now(), dueTime)}.`);
      } else if (dueTime) {
        bits.push(`I noted ${formatTime(dueTime)} for it.`);
      }
    }
    if (patch.expected_at) {
      bits.push(`You're expecting it ${friendlyDate(patch.expected_at, now())}.`);
    }
    if (patch.typical_turnaround_days != null) {
      bits.push(`That usually takes about ${patch.typical_turnaround_days} days.`);
    }
    if (noteChange.progress_note) bits.push(`I noted ${noteChange.progress_note}.`);
    if (linkedTo) bits.push(`It now waits on ${linkedTo}.`);
    if (patch.depends_on && !new_status) bits.push(`Waiting on ${patch.depends_on}.`);
    if (bits.length > 0) {
      if (!new_status) messageParts.push(`Got it, I updated ${req.label}.`);
      messageParts.push(bits.join(' '));
    }
  }

  await appendEvent({
    goalId: goal.id,
    requirementId: req.id,
    rawText,
    interpretedChange: eventPayload,
  });

  const fresh = await listRequirementsForGoal(goal.id);
  const { risk, flag } = await safeCheckAndRemind(goal, fresh);

  const lateReason = (risk.reasons ?? []).find(
    (r) => r.kind === 'expected_after_deadline' && r.requirement_id === req.id
  );
  if (lateReason) {
    messageParts.push(renderLateOptions(lateReason.label, req.depends_on ?? null));
  }

  const session = await getSession();
  await saveSession({
    pendingConfirmation: null,
    pendingFlag: flag,
    activeGoalId: goal.id,
  });
  void session;

  return {
    intent: 'update',
    ok: true,
    message: messageParts.join(' '),
    data: {
      kind: 'update_applied',
      requirement: simpleReq({ ...req, ...patch, status: new_status ?? req.status }),
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

    let newStatus = null;
    let compressedFrom = null;
    if (typeof u.new_status === 'string') {
      const result = applyTransition(req, u.new_status, { at: now() });
      if (!result.ok) {
        const legal = allowedNextStates(req.kind, req.status);
        const nearest = pickNearestLegal(u.new_status, legal);
        if (!nearest) {
          failed.push({
            requirement_id: u.requirement_id,
            label: req.label,
            reason: result.reason,
          });
          continue;
        }
        const retry = applyTransition(req, nearest, { at: now() });
        if (!retry.ok) {
          failed.push({
            requirement_id: u.requirement_id,
            label: req.label,
            reason: retry.reason,
          });
          continue;
        }
        newStatus = retry.next;
        compressedFrom = u.new_status;
      } else {
        newStatus = result.next;
      }
    }

    const { patch, noteChange } = await buildItemPatch(req, u);
    const anyDetail = Object.keys(patch).length > 0 || hasNoteChange(noteChange);
    const snapshot = snapshotOf(req);

    if (newStatus) {
      await updateRequirement(u.requirement_id, {
        status: newStatus.status,
        requested_at: newStatus.requested_at,
        received_at: newStatus.received_at,
        notes: hasNoteChange(noteChange)
          ? buildNotes(newStatus.notes ?? req.notes ?? null, noteChange)
          : newStatus.notes,
        ...patch,
      });
      pushUndo(req.label, () => updateRequirement(req.id, snapshot));
      await appendEvent({
        goalId: goal.id,
        requirementId: req.id,
        rawText,
        interpretedChange: {
          type: 'status_changed',
          from: req.status,
          to: newStatus.status,
          label: req.label,
          ...(compressedFrom ? { compressed_from: compressedFrom } : {}),
        },
      });
      applied.push({
        requirement_id: newStatus.id,
        label: newStatus.label,
        status: newStatus.status,
        from_status: req.status,
        goal_id: goal.id,
        goal_title: goal.title,
        __compressed_from: compressedFrom ?? null,
      });
    } else if (anyDetail) {
      await updateRequirement(u.requirement_id, {
        ...patch,
        ...(hasNoteChange(noteChange) ? { notes: buildNotes(req.notes ?? null, noteChange) } : {}),
      });
      pushUndo(req.label, () => updateRequirement(req.id, snapshot));
      await appendEvent({
        goalId: goal.id,
        requirementId: req.id,
        rawText,
        interpretedChange: {
          type: 'details_changed',
          label: req.label,
          ...patch,
        },
      });
      applied.push({
        requirement_id: req.id,
        label: req.label,
        status: req.status,
        from_status: req.status,
        goal_id: goal.id,
        goal_title: goal.title,
        __compressed_from: null,
      });
    } else {
      continue;
    }

    affectedGoals.set(goal.id, goal);
  }

  let lastFlag = null;
  let lastGoalId = null;
  for (const [goalId, goal] of affectedGoals) {
    const fresh = await listRequirementsForGoal(goalId);
    const { flag } = await safeCheckAndRemind(goal, fresh);
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

function composeUpdateItemsReply(applied, failed) {
  const failedLabels = failed.map((f) => f.label ?? 'one of those');

  if (applied.length === 0) {
    if (failed.length > 0) {
      return `I couldn't change ${joinWithAnd(failedLabels)}, ${prettyFailureReason(failed[0].reason)}.`;
    }
    return "I didn't see anything to change there.";
  }

  const byStatus = new Map();
  for (const a of applied) {
    if (!byStatus.has(a.status)) byStatus.set(a.status, []);
    byStatus.get(a.status).push(a);
  }

  const clauses = [];
  for (const [status, list] of byStatus) {
    clauses.push(formatStatusClause(list.map((i) => i.label), status));
  }

  let message = pick([
    `Got it, ${joinWithAnd(clauses)}.`,
    `Okay, ${joinWithAnd(clauses)}.`,
  ]);

  if (failed.length > 0) {
    message += ` I couldn't change ${joinWithAnd(failedLabels)}, ${prettyFailureReason(failed[0].reason)}.`;
  }

  return message;
}

function prettyFailureReason(reason) {
  if (typeof reason !== 'string') return "that isn't a change I can make right now";
  if (/no-op transition/.test(reason)) return "it's already like that";
  if (/illegal transition/.test(reason)) return "that isn't a change I can make from where it is now";
  if (/unknown target status/.test(reason)) return "I don't recognize that status";
  if (/unknown current status/.test(reason)) return 'it has an unexpected status';
  if (/unknown kind/.test(reason)) return 'it is a kind of item I do not recognize';
  if (/not found/.test(reason)) return "I couldn't find it";
  return reason;
}

function formatStatusClause(labels, status) {
  const list = joinWithAnd(labels);
  const many = labels.length > 1;
  if (status === 'done') return `${list} ${many ? 'are' : 'is'} done`;
  if (status === 'waiting_on_other') return `${list} ${many ? 'are' : 'is'} with someone else now`;
  if (status === 'in_progress') return `${list} ${many ? 'are' : 'is'} in progress`;
  if (status === 'not_started') return `${list} ${many ? 'are' : 'is'} back on the to-do list`;
  return `${list} ${many ? 'are' : 'is'} now ${status}`;
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
      question: `Delete ${goal.title}? That removes all its items too.`,
      on_yes: { tool: 'delete_goal_confirmed', args: { goal_id: goal.id } },
    },
    pendingFlag: null,
  });

  return {
    intent: 'delete',
    ok: true,
    message: `Delete ${goal.title}? That removes all its items too.`,
    data: { kind: 'delete_goal_confirm', goal_id: goal.id },
  };
}

// Removing a single task happens right away (the user asked for it) and can
// be undone. Whole goals still ask first.
async function doDeleteItem(action, rawText) {
  const { requirement_id } = action.args;
  const req = await getRequirement(requirement_id);
  if (!req) return err('no_requirement', "That one's already gone.");
  return doConfirmedDeleteItem({ args: { requirement_id } }, rawText);
}

async function doConfirmedDeleteGoal(action, rawText) {
  const { goal_id, goal_title } = action.args;
  const before = await getGoal(goal_id);
  if (!before) return err('no_goal', 'That goal is already gone.');

  let title = goal_title || before.title || '(unknown goal)';

  // Snapshot the goal and every one of its requirements so deletion can be
  // undone. This must happen BEFORE the deletes below, and the goal row
  // itself must be deleted last so a failure partway through never leaves
  // an orphaned goal with no requirements.
  const beforeReqs = await listRequirementsForGoal(goal_id);
  const goalSnapshot = {
    title: before.title,
    deadline: before.deadline,
    goalType: before.goal_type,
    status: before.status,
    context: before.context ?? null,
  };
  const reqSnapshots = beforeReqs.map((r) => ({
    label: r.label,
    kind: r.kind,
    status: r.status,
    dependsOn: r.depends_on ?? null,
    typicalTurnaroundDays: r.typical_turnaround_days ?? null,
    requestedAt: r.requested_at ?? null,
    receivedAt: r.received_at ?? null,
    notes: r.notes ?? null,
    dueAt: r.due_at ?? null,
    expectedAt: r.expected_at ?? null,
    linkedRequirementId: null, // relinked by id after recreation, see below
  }));
  const linkMap = beforeReqs.map((r) => r.linked_requirement_id ?? null);

  // Log the deletion while the goal row still exists, so the event's
  // goal_id reference is always valid.
  await appendEvent({
    goalId: goal_id,
    rawText: rawText ?? null,
    interpretedChange: { type: 'goal_deleted', title },
  });

  // Actually delete: requirements first, then the goal itself, so the
  // goal never outlives its items even if this is interrupted.
  for (const r of beforeReqs) {
    await deleteRequirement(r.id);
  }
  await deleteGoal(goal_id);

  pushUndo(title, async () => {
    const restoredGoal = await createGoal(goalSnapshot);
    let restoredReqs = [];
    if (reqSnapshots.length > 0) {
      restoredReqs = await createRequirementsBatch(restoredGoal.id, reqSnapshots);
      // Re-link requirements that pointed at each other, now that the
      // restored rows have new ids. Positional correspondence with
      // beforeReqs/linkMap is preserved by createRequirementsBatch.
      const oldIdToNewId = new Map(beforeReqs.map((r, i) => [r.id, restoredReqs[i]?.id]));
      for (let i = 0; i < restoredReqs.length; i++) {
        const oldLinked = linkMap[i];
        if (!oldLinked) continue;
        const newLinked = oldIdToNewId.get(oldLinked);
        if (newLinked) {
          await updateRequirement(restoredReqs[i].id, { linked_requirement_id: newLinked });
        }
      }
    }
  });

  await saveSession({ pendingConfirmation: null, pendingFlag: null });

  return {
    intent: 'delete',
    ok: true,
    message: `Okay, ${title} is gone.`,
    data: { kind: 'goal_deleted', goal_id },
  };
}

async function doConfirmedDeleteItem(action, rawText) {
  const { requirement_id } = action.args;
  const req = await getRequirement(requirement_id);
  if (!req) return err('no_requirement', "That one's already gone.");

  const goal = await getGoal(req.goal_id);
  const goalTitle = goal?.title ?? 'that goal';

  const snapshot = {
    label: req.label,
    kind: req.kind,
    status: req.status,
    dependsOn: req.depends_on ?? null,
    typicalTurnaroundDays: req.typical_turnaround_days ?? null,
    requestedAt: req.requested_at ?? null,
    receivedAt: req.received_at ?? null,
    notes: req.notes ?? null,
    dueAt: req.due_at ?? null,
    expectedAt: req.expected_at ?? null,
    linkedRequirementId: req.linked_requirement_id ?? null,
  };

  await appendEvent({
    goalId: req.goal_id,
    requirementId: null,
    rawText: rawText ?? null,
    interpretedChange: { type: 'requirement_deleted', label: req.label },
  });

  await deleteRequirement(requirement_id);
  pushUndo(req.label, async () => {
    await createRequirementsBatch(req.goal_id, [snapshot]);
  });

  const session = await getSession();
  await saveSession({
    pendingConfirmation: null,
    pendingFlag: null,
    activeGoalId: req.goal_id ?? session.active_goal_id ?? null,
  });

  return {
    intent: 'delete',
    ok: true,
    message: pick([
      `Okay, I removed ${req.label} from ${goalTitle}. Say "undo" if that was a mistake.`,
      `Done, ${req.label} is off ${goalTitle}. You can say "undo" to bring it back.`,
    ]),
    data: { kind: 'requirement_deleted', requirement_id },
  };
}

// ---------------------------------------------------------------------------
// Tool: query
// ---------------------------------------------------------------------------

async function spokenAnswer(kind, rawText, report, fallbackLines) {
  if (USE_LLM_PHRASING) {
    try {
      return await withTimeout(
        phraseAnswer({
          kind,
          question: rawText,
          today: now(),
          data: { report: report.data ?? report, plain_text: fallbackLines.join('\n') },
        }),
        PHRASING_TIMEOUT_MS + 3000
      );
    } catch (e) {
      console.warn('[onward] phraseAnswer failed:', e.message);
    }
  }
  return fallbackLines.join('\n');
}

async function doQuery(action, rawText) {
  const kind = action.args.kind ?? 'list';

  if (kind === 'missing') return doQueryMissing(rawText);

  const goals = await listGoals({ status: 'active' });
  if (goals.length === 0) {
    return {
      intent: 'query',
      ok: true,
      message: "You don't have anything on your list yet. Tell me what you're working toward and when it's due.",
      data: { kind: 'empty' },
    };
  }

  const allReqs = await listRequirementsForGoals(goals.map((g) => g.id));
  const byGoal = new Map();
  for (const r of allReqs) {
    if (!byGoal.has(r.goal_id)) byGoal.set(r.goal_id, []);
    byGoal.get(r.goal_id).push(r);
  }

  const today = now();
  const entries = goals.map((g) => {
    const reqs = byGoal.get(g.id) ?? [];
    return { goal: g, requirements: reqs, risk: computeRisk(g, reqs, today) };
  });

  if (kind === 'at_risk') {
    const report = renderRiskReport(entries);
    return {
      intent: 'query',
      ok: true,
      message: await spokenAnswer(kind, rawText, report, report.lines),
      data: { kind: 'risk', report: report.data },
    };
  }

  if (kind === 'next' || kind === 'time') {
    const report = renderActionReport(entries, today);
    return {
      intent: 'query',
      ok: true,
      message: await spokenAnswer(kind, rawText, report, report.lines),
      data: { kind: 'action', report: report.data },
    };
  }

  if (kind === 'advice') {
    const report = renderAdvice(entries);
    return {
      intent: 'query',
      ok: true,
      message: await spokenAnswer(kind, rawText, report, report.lines),
      data: { kind: 'advice', report: report.data },
    };
  }

  const reports = [];
  const lines = [];
  for (const e of entries) {
    const report = renderGoalReport(e.goal, e.requirements, e.risk, today);
    reports.push(report.data);
    if (lines.length > 0) lines.push('');
    lines.push(...report.lines);
  }

  return {
    intent: 'query',
    ok: true,
    message: await spokenAnswer(kind, rawText, { data: { goals: reports } }, lines),
    data: { kind: 'list', reports },
  };
}

// "What am I missing?" works for every goal, typed or not.
async function doQueryMissing(rawText) {
  const goals = await listGoals({ status: 'active' });
  if (goals.length === 0) {
    return {
      intent: 'query',
      ok: true,
      message: "You don't have anything on your list yet. Tell me what you're working toward and when it's due.",
      data: { kind: 'empty' },
    };
  }

  const allReqs = await listRequirementsForGoals(goals.map((g) => g.id));
  const byGoal = new Map();
  for (const r of allReqs) {
    if (!byGoal.has(r.goal_id)) byGoal.set(r.goal_id, []);
    byGoal.get(r.goal_id).push(r);
  }

  const entries = [];
  for (const g of goals) {
    const reqs = byGoal.get(g.id) ?? [];
    let template = [];
    if (g.goal_type) {
      try {
        template = await listGoalTypeTemplates(g.goal_type);
      } catch (e) {
        console.warn('[onward] doQueryMissing: template load failed:', e.message);
      }
    }
    const diff = findMissingRequirements(g, reqs, template);
    entries.push({
      goal: g,
      existing: reqs,
      essentials: diff.missing.filter((m) => m.priority === 'essential'),
      helpful: diff.missing.filter((m) => m.priority !== 'essential'),
      all: diff.missing,
    });
  }

  const suggestion = await buildSuggestions(entries, {
    userText: rawText,
    today: now(),
    askAtEnd: true,
  });
  const offers = offerEntriesFrom(entries, suggestion);

  if (offers.length === 0) {
    return {
      intent: 'query',
      ok: true,
      message: pick([
        "Honestly, it looks like you've got everything covered. Anything else you're thinking of?",
        "Nothing jumps out at me. If you think of something, just tell me.",
      ]),
      data: { kind: 'missing', missing: [] },
    };
  }

  const session = await getSession();
  await saveSession({
    pendingConfirmation: buildOfferPending(offers),
    pendingFlag: null,
    activeGoalId: session.active_goal_id ?? null,
  });

  return {
    intent: 'query',
    ok: true,
    message: suggestion.text,
    data: { kind: 'missing', suggestions: offers },
  };
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
      message: `I couldn't put that together: ${result.reason}.`,
      data: { kind: 'followup_failed', reason: result.reason },
    };
  }

  const req = await getRequirement(requirement_id);
  const goal = req ? await getGoal(req.goal_id) : null;

  const toLine = req?.depends_on ? ` to ${req.depends_on}` : '';
  const sandboxNote = '';

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
      `Here's a draft${toLine} for ${req?.label ?? 'that item'}:\n\n` +
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
      message: `I couldn't send that: ${result.reason}.`,
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
    ? " (Test mode: nothing actually went out, but I saved the draft.)"
    : '';

  return {
    intent: 'followup',
    ok: true,
    message:
      `Done, sent${req?.depends_on ? ` to ${req.depends_on}` : ''} about ${req?.label ?? 'that item'}.${sandboxNote}`,
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

  const title = currentFlag?.goalTitle ? `"${currentGoalTitle(currentFlag)}"` : 'that goal';
  const when = days === 1 ? 'tomorrow' : `in ${days} days`;

  return {
    intent: 'snooze',
    ok: true,
    message: `Okay, I'll leave ${title} alone until ${when}.`,
    data: {
      kind: 'snoozed',
      until: resumeAt.toISOString(),
      days,
    },
  };
}

function currentGoalTitle(flag) {
  return flag?.goalTitle ?? 'that goal';
}

// ---------------------------------------------------------------------------
// Tool: set_new_deadline
// ---------------------------------------------------------------------------

async function doSetNewDeadline(action, rawText) {
  const goalId = action.args?.goal_id;
  const newDeadline = action.args?.new_deadline;
  const newTime = action.args?.new_deadline_time ?? null;

  if (typeof goalId !== 'string' || !goalId.trim()) {
    return err('no_goal', 'Which goal should I change the deadline on?');
  }
  if (typeof newDeadline !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDeadline)) {
    return err('bad_deadline', 'What should the new deadline be?');
  }

  const goal = await getGoal(goalId);
  if (!goal) return err('no_goal', "I can't find that goal anymore.");

  const oldDeadline = goal.deadline;
  const oldContext = goal.context ?? null;
  const oldFired = Array.isArray(goal.reminders_fired) ? goal.reminders_fired : [];

  // Keep the old time of day unless a new one was given.
  const context = newTime ? writeTimeTag(oldContext, newTime) : oldContext;

  // Goal-level reminder moments that are already behind us for the NEW date
  // are marked as sent, so changing a deadline never replays old reminders or
  // stacks duplicates. Moments still ahead will fire when they come.
  const reqs = await listRequirementsForGoal(goal.id);
  let behind = [];
  try {
    behind = getDueReminders({ ...goal, deadline: newDeadline }, reqs, now(), [])
      .map((d) => d.kind)
      .filter((k) => GOAL_LEVEL_KINDS.has(kindRoot(k)));
  } catch (e) {
    console.warn('[onward] doSetNewDeadline: reminder probe failed:', e.message);
  }

  await updateGoal(goal.id, {
    deadline: newDeadline,
    reminders_fired: behind,
    context,
  });

  pushUndo(goal.title, () =>
    updateGoal(goal.id, {
      deadline: oldDeadline,
      reminders_fired: oldFired,
      context: oldContext,
    })
  );

  await appendEvent({
    goalId: goal.id,
    rawText,
    interpretedChange: {
      type: 'deadline_changed',
      title: goal.title,
      old_deadline: oldDeadline,
      new_deadline: newDeadline,
      new_time: newTime,
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
    message: `Done, ${goal.title} is now due ${friendlyDate(newDeadline, now(), newTime ?? readTimeTag(context))}.`,
    data: {
      kind: 'deadline_changed',
      goal_id: goal.id,
      new_deadline: newDeadline,
      new_deadline_time: newTime ?? readTimeTag(context),
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
  const retryable = action.args.__retryable === true;

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
    const sessionNow = await getSession();
    await saveSession({
      pendingConfirmation: pending,
      pendingFlag: null,
      activeGoalId: sessionNow.active_goal_id ?? null,
    });
  }

  const data = { kind: dis ? 'disambiguate' : 'ask_user' };
  if (dis) data.candidates = dis.candidates;
  if (retryable) data.retryable = true;

  return {
    intent: 'clarify',
    ok: true,
    message: question,
    data,
  };
}

// ---------------------------------------------------------------------------
// Tool: complete_goal
// ---------------------------------------------------------------------------

async function doCompleteGoal(action, rawText) {
  const { goal_id, spin_off, spin_off_deadline } = action.args;

  const goal = await getGoal(goal_id);
  if (!goal) return err('no_goal', 'That goal seems to be gone.');
  if (goal.status !== 'active') {
    return err('no_active_goal', `"${goal.title}" isn't an active goal.`);
  }

  const reqs = await listRequirementsForGoal(goal.id);

  const spinOffIds = Array.isArray(spin_off) ? spin_off : [];
  const spinItems = reqs.filter(
    (r) => spinOffIds.includes(r.id) && r.status !== 'done'
  );

  const needsDate = spinItems.some((r) => !r.due_at && !r.expected_at);
  if (needsDate && !spin_off_deadline) {
    const labels = spinItems
      .filter((r) => !r.due_at && !r.expected_at)
      .map((r) => `"${r.label}"`)
      .join(', ');
    const question = `When should ${labels} be due on its own? Then I'll wrap up ${goal.title}.`;
    await saveSession({
      pendingConfirmation: { kind: 'ask_user', question },
      pendingFlag: null,
    });
    return {
      intent: 'complete',
      ok: true,
      message: question,
      data: { kind: 'complete_await_date', goal_id: goal.id },
    };
  }

  const spunOff = [];
  for (const item of spinItems) {
    const itemDue = item.due_at ? String(item.due_at).slice(0, 10) : null;
    const itemExpected = item.expected_at ? String(item.expected_at).slice(0, 10) : null;
    const deadline = spin_off_deadline ?? itemDue ?? itemExpected;
    if (!deadline) continue;

    const newGoal = await createGoal({
      title: item.label,
      deadline,
      goalType: null,
      context: goal.context ?? null,
    });

    await updateRequirement(item.id, {
      goal_id: newGoal.id,
      due_at: item.due_at ?? deadline,
    });

    await appendEventsBatch([
      {
        goalId: goal.id,
        requirementId: item.id,
        rawText,
        interpretedChange: {
          type: 'item_moved',
          label: item.label,
          to_goal_id: newGoal.id,
          to_goal_title: newGoal.title,
        },
      },
      {
        goalId: newGoal.id,
        requirementId: item.id,
        rawText,
        interpretedChange: {
          type: 'item_moved',
          label: item.label,
          from_goal_id: goal.id,
          from_goal_title: goal.title,
        },
      },
    ]);

    spunOff.push({ label: item.label, goal_id: newGoal.id, deadline });
  }

  const spunIds = new Set(spinItems.map((r) => r.id));
  const leftovers = reqs
    .filter((r) => r.status !== 'done' && !spunIds.has(r.id))
    .map((r) => r.label);

  await updateGoal(goal.id, { status: 'completed' });

  await appendEvent({
    goalId: goal.id,
    rawText,
    interpretedChange: {
      type: 'goal_completed',
      title: goal.title,
      open_items: leftovers,
    },
  });

  const nextActiveGoalId = spunOff[0]?.goal_id ?? goal.id;

  await saveSession({
    pendingConfirmation: null,
    pendingFlag: null,
    activeGoalId: nextActiveGoalId,
  });

  const messageParts = [
    pick([
      `Nice, ${goal.title} is wrapped up.`,
      `Great, ${goal.title} is done.`,
      `${goal.title} is closed out. Nice work.`,
    ]),
  ];
  for (const s of spunOff) {
    messageParts.push(`${s.label} is its own task now, due ${friendlyDate(s.deadline, now())}.`);
  }
  if (leftovers.length > 0) {
    messageParts.push(`Still open: ${joinWithAnd(leftovers)}.`);
  }

  return {
    intent: 'complete',
    ok: true,
    message: messageParts.join(' '),
    data: {
      kind: 'goal_completed',
      goal_id: goal.id,
      spun_off: spunOff,
      leftovers,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: note_context
// ---------------------------------------------------------------------------

async function doNoteContext(action, rawText) {
  const { goal_id, text } = action.args;
  const goal = await getGoal(goal_id);
  if (!goal) return err('no_goal', 'That goal seems to be gone.');

  const clean = String(text ?? '').trim().slice(0, 300);
  if (!clean) return err('no_text', 'What should I note down?');

  const existing = goal.context ?? '';
  const lines = existing.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.includes(clean)) {
    lines.push(clean);
  }
  const newContext = lines.join('\n');

  await updateGoal(goal.id, { context: newContext });

  await appendEvent({
    goalId: goal.id,
    rawText,
    interpretedChange: {
      type: 'context_noted',
      title: goal.title,
      text: clean,
    },
  });

  return {
    intent: 'note_context',
    ok: true,
    message: `Got it, I'll remember that for ${goal.title}.`,
    data: { kind: 'context_noted', goal_id: goal.id, text: clean },
  };
}

// ---------------------------------------------------------------------------
// Tool: move_item
// ---------------------------------------------------------------------------

async function doMoveItem(action, rawText) {
  const {
    requirement_id,
    to_goal_id,
    to_goal_title,
    new_goal_title,
    deadline,
    from_goal_id,
    from_goal_title,
  } = action.args;

  const item = await getRequirement(requirement_id);
  if (!item) return err('no_requirement', 'That item seems to be gone.');

  const sourceGoal = await getGoal(item.goal_id);
  const sourceGoalTitle = sourceGoal?.title ?? from_goal_title ?? 'that goal';

  let targetGoal = null;
  if (to_goal_id) {
    targetGoal = await getGoal(to_goal_id);
    if (!targetGoal) return err('no_goal', 'That target goal seems to be gone.');
  } else if (typeof new_goal_title === 'string' && new_goal_title.trim()) {
    if (
      typeof deadline !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ) {
      return err('bad_deadline', `What deadline should "${item.label}" have?`);
    }
    targetGoal = await createGoal({
      title: new_goal_title.trim(),
      deadline,
      goalType: null,
      context: sourceGoal?.context ?? null,
    });
  } else {
    return err('no_target', 'Where should I move it?');
  }

  await updateRequirement(item.id, { goal_id: targetGoal.id });

  await appendEventsBatch([
    {
      goalId: sourceGoal?.id ?? item.goal_id,
      requirementId: item.id,
      rawText,
      interpretedChange: {
        type: 'item_moved',
        label: item.label,
        to_goal_id: targetGoal.id,
        to_goal_title: targetGoal.title,
      },
    },
    {
      goalId: targetGoal.id,
      requirementId: item.id,
      rawText,
      interpretedChange: {
        type: 'item_moved',
        label: item.label,
        from_goal_id: sourceGoal?.id ?? item.goal_id,
        from_goal_title: sourceGoalTitle,
      },
    },
  ]);

  return {
    intent: 'move_item',
    ok: true,
    message: `Moved ${item.label} over to ${targetGoal.title}.`,
    data: {
      kind: 'item_moved',
      requirement_id: item.id,
      from_goal_id: sourceGoal?.id ?? item.goal_id,
      to_goal_id: targetGoal.id,
    },
  };
}

// ---------------------------------------------------------------------------
// Reminder-message helper
// ---------------------------------------------------------------------------

async function buildReminderMessage(facts, momentKind) {
  if (kindRoot(momentKind) === 'task_due') {
    return composeProactiveMessageFallback(facts);
  }
  if (!USE_LLM_PHRASING) {
    return composeProactiveMessageFallback(facts);
  }
  try {
    const m = await withAbortableTimeout(
      (signal) => phraseProactiveMessage(facts, momentKind, { signal }),
      PHRASING_TIMEOUT_MS
    );
    if (m && m.trim()) return m;
  } catch (e) {
    console.warn('[onward] phraseProactiveMessage failed:', e.message);
  }
  return composeProactiveMessageFallback(facts);
}

// ---------------------------------------------------------------------------
// Proactive flagging
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
  const message = await buildReminderMessage(facts, top.kind);

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

  let dueTasks = null;
  if (Array.isArray(dueReminders) && dueReminders.length > 0) {
    const tasks = dueReminders.filter((d) => kindRoot(d.kind) === 'task_due');
    if (tasks.length > 0) {
      dueTasks = tasks.map((t) => ({ label: t.label }));
    }
  }

  const facts = {
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
  if (dueTasks) facts.due_tasks = dueTasks;
  return facts;
}

// A short, texting-style note built with no LLM call. Used when LLM
// phrasing is off, or when it times out — so a slow model never trades
// away the natural tone, just the extra polish. One sentence of "when",
// one of "what matters most right now." Never lists every item.
function composeProactiveMessageFallback(facts) {
  const { goal, done, waiting, in_progress, not_started, overdue, request_by_items, due_tasks } = facts;
  void done;

  const days = goal.days_until_deadline;
  let when;
  if (days == null) when = 'has no deadline set';
  else if (days < -1) when = `was due ${Math.abs(days)} days ago`;
  else if (days === -1) when = 'was due yesterday';
  else if (days === 0) when = 'is due today';
  else if (days === 1) when = 'is due tomorrow';
  else if (days <= 7) when = `is due in ${days} days`;
  else when = `is due ${new Date(goal.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  // Pick the single most pressing thing to mention, in priority order.
  let focus = null;
  if (Array.isArray(due_tasks) && due_tasks.length > 0) {
    focus = `${plainLabel(due_tasks[0].label)} is due today`;
  } else if (overdue.length > 0) {
    focus = `${plainLabel(overdue[0].label)} is running late`;
  } else if (Array.isArray(request_by_items) && request_by_items.length > 0) {
    focus = `worth requesting ${plainLabel(request_by_items[0].label)} soon`;
  } else if (waiting.length > 0) {
    focus = `still waiting on ${plainLabel(waiting[0].label)}`;
  } else if (in_progress.length > 0) {
    focus = `${plainLabel(in_progress[0].label)} is still in progress`;
  } else if (not_started.length > 0) {
    focus = `${plainLabel(not_started[0].label)} hasn't been started`;
  }

  const more = waiting.length + in_progress.length + not_started.length - 1;
  const tail = more > 0 ? `, plus ${more} more thing${more === 1 ? '' : 's'}` : '';

  if (!focus) return `${goal.title} ${when}, and you're all caught up.`;
  return `${goal.title} ${when} — ${focus}${tail}.`;
}

// Shorten a long or technical requirement label to the plain-English gist
// a person would actually say out loud, e.g. drop a parenthetical acronym
// list: "Test scores (GRE/TOEFL/IELTS) sent to institution" -> "test scores".
function plainLabel(label) {
  if (typeof label !== 'string' || !label.trim()) return 'that item';
  let s = label.replace(/\([^)]*\)/g, '').trim();
  s = s.replace(/\s+sent to [a-z0-9 ]+$/i, '').trim();
  s = s.replace(/\s{2,}/g, ' ');
  if (!s) s = label.trim();
  return s.length > 40 ? label.trim() : s.charAt(0).toLowerCase() + s.slice(1);
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

// getSession() caches the Session row in module memory for the life of the
// process (see db.js) so it isn't re-fetched on every turn. That's fine for
// normal use, but it means a pending_flag written before someone edits the
// database directly — e.g. wiping tables in Supabase to "start fresh" — can
// keep pointing at a goal that no longer exists, and nothing ever notices
// because the cache is never invalidated by external changes.
//
// This checks the flag's goal against the database before trusting it, and
// self-heals the session if the goal is gone or no longer active. Call this
// instead of reading session.pending_flag directly anywhere it reaches the
// user (a reply, a dashboard poll, interpreter context).
export async function getValidatedPendingFlag(session = null) {
  const s = session ?? (await getSession());
  const flag = s.pending_flag ?? null;
  if (!flag || !flag.goalId) return flag;

  let goal;
  try {
    goal = await getGoal(flag.goalId);
  } catch (e) {
    console.warn('[onward] getValidatedPendingFlag: lookup failed, keeping flag:', e.message);
    return flag;
  }

  if (goal && goal.status === 'active') return flag;

  // Stale — the goal is gone (or no longer active). Clear it so this
  // doesn't keep resurfacing on every subsequent read.
  await saveSession({
    pendingConfirmation: s.pending_confirmation ?? null,
    pendingFlag: null,
    activeGoalId: s.active_goal_id ?? null,
  });
  return null;
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
    due_at: r.due_at ?? null,
    expected_at: r.expected_at ?? null,
    linked_requirement_id: r.linked_requirement_id ?? null,
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

function statusLine(label, status, dependsOn) {
  switch (status) {
    case 'done':
      return pick([`Nice, ${label} is done.`, `${label} is checked off.`, `Done, ${label} is complete.`]);
    case 'in_progress':
      return pick([`Okay, ${label} is in progress.`, `Got it, you're working on ${label}.`]);
    case 'waiting_on_other':
      return dependsOn
        ? pick([`Okay, ${label} is with ${dependsOn} now.`, `Got it, waiting on ${dependsOn} for ${label}.`])
        : pick([`Okay, you're waiting to hear back on ${label}.`, `Got it, ${label} is out of your hands for now.`]);
    case 'not_started':
      return `Okay, ${label} is back on the to-do list.`;
    default:
      return `Okay, ${label} is now ${prettyStatus(status)}.`;
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