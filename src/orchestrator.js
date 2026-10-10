// Onward — statement router and write-path owner.
//
// This is the ONLY module that writes to the database. Every state change
// appends an Event AND updates the affected Requirement(s), in that order.
//
// Routing is content-based. We do NOT depend on any in-memory session
// state — the goals live in the DB and every routing decision can be made
// from the current message plus what's in the DB. Pending confirmations
// (things we've explicitly asked the user and are waiting on) and pending
// proactive flags are persisted so they survive process restarts.

import {
  createGoal,
  getGoal,
  listGoals,
  createRequirement,
  createRequirementsBatch,
  getRequirement,
  listRequirementsForGoal,
  updateRequirement,
  deleteRequirement,
  deleteGoal,
  appendEvent,
  appendEventsBatch,
  listGoalTypeTemplates,
  recordRiskAssessment,
  getLatestRiskAssessment,
  getSession,
  saveSession,
} from './db.js';

import { extractGoal, extractItems, resolveDeadlineReply } from './services/extraction.js';
import {
  interpretUpdate,
  resolveConfirmation,
  classifyIntent,
} from './services/updateInterpreter.js';
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
  phraseCompletenessQuestion,
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

  const session = await getSession();
  const pendingConfirmation = session.pending_confirmation ?? null;

  // The goal the current conversation is about, if any. Populated from
  // the pending confirmation so downstream handlers can use it as the
  // default target — avoiding spurious "which goal" questions.
  const conversationalGoalId =
    pendingConfirmation?.goalId ??
    pendingConfirmation?.goal_id ??
    null;

  if (pendingConfirmation) {
    let resolved = null;
    try {
      resolved = await tryResolveConfirmation(trimmed, pendingConfirmation);
    } catch (e) {
      console.error('[onward] confirmation resolution failed:', e);
      return err(e.code ?? 'internal', e.message);
    }

    if (resolved) {
      const nextConfirmation = resolved.__keepConfirmation ?? null;
      await saveSession({
        pendingConfirmation: nextConfirmation,
        pendingFlag: session.pending_flag ?? null,
      });
      return await consumePendingFlag(resolved);
    }

    // The reply didn't resolve the pending confirmation. Decide whether
    // to re-ask or drop it:
    //
    //   - If the reply could plausibly be an answer (it names a
    //     candidate, or is a short ambiguous reply), re-ask and stop.
    //
    //   - Otherwise, the user has moved on. Drop the pending
    //     confirmation and route this message normally.
    //
    // This prevents a sticky question from swallowing every subsequent
    // message when the user changes the subject.
    const looksLikeAnswer = looksLikeAnswerToConfirmation(trimmed, pendingConfirmation);

    if (pendingConfirmation.sticky && looksLikeAnswer) {
      const reask = await reaskStickyConfirmation(pendingConfirmation);
      if (reask) return reask;
    }

    await saveSession({
      pendingConfirmation: null,
      pendingFlag: session.pending_flag ?? null,
    });
  }

  try {
    // Persist the conversational goal for the duration of this turn, so
    // handlers can pick it up as the default target.
    if (conversationalGoalId) {
      await saveSession({
        pendingConfirmation,
        pendingFlag: session.pending_flag ?? null,
        activeGoalId: conversationalGoalId,
      });
    }

    // Look up active goals once; used both for the classifier's context
    // and for routing after classification.
    let activeGoals = [];
    try {
      activeGoals = await listGoals({ status: 'active' });
    } catch (e) {
      console.error('[onward] handleStatement: failed to list goals for routing', e);
    }

    // Classify intent. Returns null on LLM failure (network, rate limit,
    // credits exhausted, malformed response). When null, we fall back to
    // the regex-based routing below.
    let intent = null;
    try {
      intent = await classifyIntent(
        trimmed,
        activeGoals.map((g) => ({ title: g.title }))
      );
    } catch (e) {
      console.error('[onward] classifyIntent threw unexpectedly:', e);
      intent = null;
    }

    let response = null;

    if (intent === 'delete_goal') {
      response = await handleDeleteGoal(trimmed);
    } else if (intent === 'delete_requirement') {
      response = await handleDeleteRequirement(trimmed);
    } else if (intent === 'add_items') {
      response = await handleAddItems(trimmed);
    } else if (intent === 'create') {
      response = await handleCreate(trimmed);
    } else if (intent === 'query') {
      response = await handleQuery(trimmed);
    } else if (intent === 'update') {
      response = await handleUpdate(trimmed);
    } else {
      // --- Fallback path -------------------------------------------------
      // Either the classifier returned null (LLM failure) or it returned
      // 'unrelated'. In both cases, try the handlers in a sensible order
      // using the existing regex cascade.
      //
      // The regex-based routing here is the safety net for LLM failures.
      // It intentionally mirrors the historical behavior: query first,
      // then delete, then create/add-items via regex hints, then update.

      if (tryHandleQuery(trimmed)) {
        response = await handleQuery(trimmed);
      } else {
        const delIntent = await detectDeleteIntent(trimmed);
        if (delIntent === 'goal') {
          response = await handleDeleteGoal(trimmed);
        } else if (delIntent === 'requirement') {
          response = await handleDeleteRequirement(trimmed);
        } else if (looksLikeCreateStatement(trimmed)) {
          response = await handleCreate(trimmed);
          if (!response) response = await handleUpdate(trimmed);
          if (!response) response = await handleAddItems(trimmed);
        } else if (looksLikeAddItemsStatement(trimmed)) {
          response = await handleAddItems(trimmed);
          if (!response) response = await handleUpdate(trimmed);
          if (!response) response = await handleCreate(trimmed);
        } else {
          response = await handleUpdate(trimmed);
          if (!response) response = await handleAddItems(trimmed);
          if (!response) response = await handleCreate(trimmed);
        }
      }
    }

    // If the classified handler returned null for any reason, fall through
    // to a generic path so we never leave the user without a reply.
    if (!response) {
      response = await handleUpdate(trimmed);
      if (!response) response = await handleAddItems(trimmed);
      if (!response) response = await handleCreate(trimmed);
    }

    if (!response) {
      response = await askForClarification(trimmed);
    }

    return await consumePendingFlag(response);
  } catch (e) {
    console.error('[onward] handleStatement failed:', e);
    return err(e.code ?? 'internal', e.message);
  }
}

async function consumePendingFlag(response) {
  const session = await getSession();
  const flag = session.pending_flag ?? null;
  if (!flag) return response;

  await saveSession({
    pendingConfirmation: session.pending_confirmation ?? null,
    pendingFlag: null,
  });

  const alreadyAboutRisk =
    response?.data?.kind === 'risk' ||
    (response?.data?.report && response.data.report.risk_level);

  const message = alreadyAboutRisk
    ? response.message
    : `${flag.message}\n\n${response.message ?? ''}`.trim();

  return {
    ...response,
    message,
    proactive_flag: {
      goal_id: flag.goalId,
      goal_title: flag.goalTitle,
      from_level: flag.fromLevel,
      to_level: flag.toLevel,
      reasons: flag.reasons,
      action_offer: flag.actionOffer ?? null,
    },
  };
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
    });
  }

  return {
    checked: goals.length,
    flagged,
    proactive_message: lastFlag?.message ?? null,
  };
}

// ---------------------------------------------------------------------------
// Intent detection: query, create, add-items, delete
// ---------------------------------------------------------------------------

const QUERY_PATTERNS = [
  /\bwhat('| i)?s?\s+(left|remaining|at risk|missing|next|now|should i do)\b/i,
  /\bwhat should i do\b/i,
  /\bwhat do i still need\b/i,
  /\bshow me\b/i,
  /\bstatus\b/i,
  /\bwhere am i\b/i,
  /\bhow am i doing\b/i,
];

const CREATE_PATTERNS = [
  /\bi (need|have|want|must|gotta|have to|need to) (to )?(apply|submit|send|file|get|prepare|finish|complete|do|sort out) (for )?/i,
  /\bnew goal\b/i,
  /\bstart (a )?(new )?goal\b/i,
  /\bi'?m applying\b/i,
  /\bhelp me (get|apply|submit|send|file|sort out)\b/i,
];

const ADD_ITEMS_PATTERNS = [
  /\bi (also |still |just )?need\b/i,
  /\bi also have to\b/i,
  /\bi still have to\b/i,
  /\badd (these |those |the )?(items|requirements)?\s*(to|into)\b/i,
  /\bi (don'?t|do not) have\b/i,
  /\bto add\b/i,
];

const DELETE_VERBS = /\b(delete|remove|forget about|forget|drop|get rid of|stop tracking|take off|throw out|scrap|cancel)\b/i;

const NO_LONGER_PATTERNS = [
  /\bno longer need\b/i,
  /\bno longer required\b/i,
  /\bno longer needed\b/i,
  /\bno longer want\b/i,
  /\bdon'?t need\b/i,
  /\bdo not need\b/i,
  /\bdon'?t want\b/i,
  /\bdo not want\b/i,
  /\bnot needed\b/i,
  /\bnot required\b/i,
  /\bisn'?t needed\b/i,
  /\bisn'?t required\b/i,
  /\bnot necessary\b/i,
  /\bcan skip\b/i,
  /\bskip the\b/i,
  /\bis off the list\b/i,
  /\boff the list\b/i,
];

const GOAL_WORDS = /\b(goal|application|the goal|my goal)\b/i;

function tryHandleQuery(text) {
  return QUERY_PATTERNS.some((re) => re.test(text));
}

function looksLikeCreateStatement(text) {
  return CREATE_PATTERNS.some((re) => re.test(text));
}

function looksLikeAddItemsStatement(text) {
  return ADD_ITEMS_PATTERNS.some((re) => re.test(text));
}

async function detectDeleteIntent(text) {
  const hasDeleteVerb = DELETE_VERBS.test(text);
  const hasNoLonger = NO_LONGER_PATTERNS.some((re) => re.test(text));

  if (!hasDeleteVerb && !hasNoLonger) return null;

  if (GOAL_WORDS.test(text)) return 'goal';

  try {
    const goals = await listGoals({ status: null });
    if (goals.length > 0 && looselyNamesAnyGoal(text, goals)) {
      return 'goal';
    }
  } catch (e) {
    console.error('[onward] detectDeleteIntent: goal lookup failed', e);
  }

  return 'requirement';
}

function looselyNamesAnyGoal(text, goals) {
  const tTokens = new Set(tokens(text));
  if (tTokens.size === 0) return false;
  for (const g of goals) {
    const gTokens = tokens(g.title);
    for (const tok of gTokens) {
      if (tTokens.has(tok)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Cross-goal helpers
// ---------------------------------------------------------------------------

async function fetchOpenItemsAcrossGoals() {
  const goals = await listGoals({ status: 'active' });

  const seenGoalIds = new Set();
  const uniqueGoals = goals.filter((g) => {
    if (seenGoalIds.has(g.id)) return false;
    seenGoalIds.add(g.id);
    return true;
  });

  const perGoal = await Promise.all(
    uniqueGoals.map(async (g) => {
      const reqs = await listRequirementsForGoal(g.id);
      const seenReqIds = new Set();
      return reqs
        .filter((r) => {
          if (r.status === 'done') return false;
          if (seenReqIds.has(r.id)) return false;
          seenReqIds.add(r.id);
          return true;
        })
        .map((r) => ({ ...r, goal_id: g.id, goal_title: g.title }));
    })
  );

  return perGoal.flat();
}

// ---------------------------------------------------------------------------
// Delete intents
// ---------------------------------------------------------------------------

async function handleDeleteGoal(text) {
  const goals = await listGoals({ status: null });

  if (goals.length === 0) {
    return {
      intent: 'delete',
      ok: true,
      message: "You don't have any goals to delete.",
      data: {},
    };
  }

  let target = matchGoalByText(text, goals);

  if (!target && goals.length === 1) {
    target = goals[0];
  }

  if (!target) {
    const pendingConfirmation = {
      kind: 'delete_goal_pick',
      candidates: goals.map((g) => ({ goal_id: g.id, goal_title: g.title })),
      sticky: true,
    };
    await saveSession({ pendingConfirmation, pendingFlag: null });
    return {
      intent: 'delete',
      ok: true,
      message: `Which goal do you want to delete — ${goals.map((g) => `"${g.title}"`).join(' or ')}?`,
      data: { candidates: goals.map((g) => ({ goal_id: g.id, goal_title: g.title })) },
      needsConfirmation: pendingConfirmation,
    };
  }

  const pendingConfirmation = {
    kind: 'delete_goal',
    goalId: target.id,
    goalTitle: target.title,
  };
  await saveSession({ pendingConfirmation, pendingFlag: null });

  return {
    intent: 'delete',
    ok: true,
    message: `Really delete "${target.title}"? This removes the goal and all its items. Yes or no.`,
    data: { goal_id: target.id, goal_title: target.title },
    needsConfirmation: pendingConfirmation,
  };
}

async function handleDeleteRequirement(text) {
  const goals = await listGoals({ status: null });
  if (goals.length === 0) {
    return {
      intent: 'delete',
      ok: true,
      message: "You don't have any goals or items.",
      data: {},
    };
  }

  const perGoal = await Promise.all(
    goals.map(async (g) => {
      const reqs = await listRequirementsForGoal(g.id);
      return reqs.map((r) => ({ ...r, goal_id: g.id, goal_title: g.title }));
    })
  );
  const allReqs = perGoal.flat();

  if (allReqs.length === 0) {
    return {
      intent: 'delete',
      ok: true,
      message: "There are no items to delete.",
      data: {},
    };
  }

  const target = matchRequirementByText(text, allReqs);

  if (!target) {
    const listing = allReqs
      .slice(0, 20)
      .map((r) => `"${r.label}" on "${r.goal_title}"`)
      .join(', ');
    return {
      intent: 'delete',
      ok: true,
      message:
        `Which item do you want to delete? For example: "delete the recommendation letter from the scholarship application". Your items: ${listing}.`,
      data: {
        items: allReqs.map((r) => ({
          requirement_id: r.id,
          label: r.label,
          goal_title: r.goal_title,
        })),
      },
    };
  }

  const pendingConfirmation = {
    kind: 'delete_requirement',
    requirementId: target.id,
    label: target.label,
    goalTitle: target.goal_title,
  };
  await saveSession({ pendingConfirmation, pendingFlag: null });

  return {
    intent: 'delete',
    ok: true,
    message: `Really delete "${target.label}" from "${target.goal_title}"? Yes or no.`,
    data: {
      requirement_id: target.id,
      label: target.label,
      goal_title: target.goal_title,
    },
    needsConfirmation: pendingConfirmation,
  };
}

function matchGoalByText(text, goals) {
  const tTokens = new Set(tokens(text));
  if (tTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const g of goals) {
    const gTokens = tokens(g.title);
    if (gTokens.size === 0) continue;
    let overlap = 0;
    for (const tok of gTokens) if (tTokens.has(tok)) overlap += 1;
    const coverage = overlap / gTokens.size;
    const effective = overlap + coverage;
    if (effective > bestScore) {
      secondScore = bestScore;
      bestScore = effective;
      best = g;
    } else if (effective > secondScore) {
      secondScore = effective;
    }
  }

  if (!best) return null;
  const gTokens = tokens(best.title);
  let overlap = 0;
  for (const tok of gTokens) if (tTokens.has(tok)) overlap += 1;

  const isDecisive = bestScore - secondScore >= 1.0;
  const hasEnoughOverlap = overlap >= 2 || gTokens.size === 1;

  return hasEnoughOverlap && isDecisive ? best : null;
}

function matchRequirementByText(text, items) {
  const tTokens = new Set(tokens(text));
  if (tTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  let secondScore = 0;

  for (const r of items) {
    const rTokens = tokens(r.label);
    if (rTokens.size === 0) continue;
    let overlap = 0;
    for (const tok of rTokens) if (tTokens.has(tok)) overlap += 1;
    const coverage = overlap / rTokens.size;
    const effective = overlap + coverage;
    if (effective > bestScore) {
      secondScore = bestScore;
      bestScore = effective;
      best = r;
    } else if (effective > secondScore) {
      secondScore = effective;
    }
  }

  if (!best) return null;
  const rTokens = tokens(best.label);
  let overlap = 0;
  for (const tok of rTokens) if (tTokens.has(tok)) overlap += 1;

  const isDecisive = bestScore - secondScore >= 1.0;
  const hasEnoughOverlap = overlap >= 2 || rTokens.size === 1;

  return hasEnoughOverlap && isDecisive ? best : null;
}

// ---------------------------------------------------------------------------
// Add items to an existing goal
// ---------------------------------------------------------------------------

async function handleAddItems(text) {
  // 1. Extract item names from the message.
  let extraction = null;
  try {
    extraction = await extractItems(text);
  } catch (e) {
    console.error('[onward] extractItems failed:', e);
    return null;
  }

  if (!extraction || extraction.items.length === 0) {
    return null;
  }

  const activeGoals = await listGoals({ status: 'active' });
  if (activeGoals.length === 0) {
    // No goal to add to — let create handle it.
    return null;
  }

  // The goal the current conversation is about, if any. When there is
  // one, it's the default target — we do NOT ask "which goal" unless
  // the user explicitly names a different goal in this message.
  const session = await getSession();
  const conversationalGoalId = session.active_goal_id ?? null;
  const conversationalGoal = conversationalGoalId
    ? activeGoals.find((g) => g.id === conversationalGoalId) ?? null
    : null;

  // 2. Pick the target goal(s).
  //
  // The user may name one goal, several goals, or no goal at all:
  //   - "add X to my scholarship application"           → one goal
  //   - "I also need X for both visa and scholarship"   → two goals
  //   - "I also need X" with an active conversation     → that goal
  //   - "I also need X" with no context                 → ask
  //
  // Resolution order:
  //   a. Every goal whose title matches a goal_hint.
  //   b. Plus every goal whose title tokens overlap the raw message.
  //   c. If none matched and there's a conversational goal, use it.
  //   d. If none matched and there's exactly one active goal, use it.
  //   e. Otherwise, ask which goal.

  const targetGoals = new Set();
  let hasExplicitGoalMatch = false;

  // a. Match against goal_hints from the LLM.
  const hints = extraction.goal_hints ?? [];
  for (const hint of hints) {
    for (const g of activeGoals) {
      if (matchGoalByText(hint, [g])) {
        targetGoals.add(g);
      }
    }
    for (const g of activeGoals) {
      if (looselyNamesAnyGoal(hint, [g])) {
        targetGoals.add(g);
      }
    }
  }

  // b. Also match against the raw message text.
  for (const g of activeGoals) {
    if (looselyNamesAnyGoal(text, [g])) {
      targetGoals.add(g);
    }
  }

  if (targetGoals.size > 0) {
    hasExplicitGoalMatch = true;
  }

  // c. If nothing explicitly matched, use the conversational goal.
  if (!hasExplicitGoalMatch && conversationalGoal) {
    targetGoals.add(conversationalGoal);
    hasExplicitGoalMatch = true;
  }

  // d. If still nothing and there's exactly one active goal, use it.
  if (targetGoals.size === 0 && activeGoals.length === 1) {
    targetGoals.add(activeGoals[0]);
  }

  // e. If still nothing, ask which goal.
  if (targetGoals.size === 0) {
    const pendingConfirmation = {
      kind: 'choose_goal_for_new_item',
      label: extraction.items.map((i) => i.label).join(', '),
      candidates: activeGoals.map((g) => ({ goal_id: g.id, goal_title: g.title })),
      sticky: true,
    };
    await saveSession({ pendingConfirmation, pendingFlag: null });
    return {
      intent: 'add_items',
      ok: true,
      message: `Which goal should I add ${extraction.items.map((i) => `"${i.label}"`).join(', ')} to — ${activeGoals.map((g) => `"${g.title}"`).join(' or ')}?`,
      data: {
        items: extraction.items,
        candidate_goals: activeGoals.map((g) => ({ goal_id: g.id, goal_title: g.title })),
      },
      needsConfirmation: pendingConfirmation,
    };
  }

  // 3. For each target goal, duplicate-check and create the missing items.

  const results = [];

  for (const goal of targetGoals) {
    const existing = await listRequirementsForGoal(goal.id);
    const existingKeys = new Set(existing.map((r) => normalizeLabel(r.label)));

    const toCreate = [];
    const skipped = [];
    for (const item of extraction.items) {
      if (existingKeys.has(normalizeLabel(item.label))) {
        skipped.push(item.label);
      } else {
        toCreate.push(item);
      }
    }

    if (toCreate.length === 0) {
      results.push({ goal, created: [], skipped });
      continue;
    }

    const created = await createRequirementsBatch(
      goal.id,
      toCreate.map((item) => ({
        label: item.label,
        kind: item.kind ?? 'self_action',
        status: item.status ?? 'not_started',
      }))
    );
    await appendEventsBatch(
      created.map((req) => ({
        goalId: goal.id,
        requirementId: req.id,
        rawText: text,
        interpretedChange: {
          type: 'requirement_created',
          via: 'user_statement',
          label: req.label,
          kind: req.kind,
          status: req.status,
        },
      }))
    );

    results.push({ goal, created, skipped });
  }

  // 4. Compose a message covering all target goals.

  const goalsWithAdds = results.filter((r) => r.created.length > 0);
  const goalsWithOnlySkips = results.filter((r) => r.created.length === 0 && r.skipped.length > 0);

  if (goalsWithAdds.length === 0) {
    if (goalsWithOnlySkips.length === 0) {
      return {
        intent: 'add_items',
        ok: true,
        message: `Nothing to add.`,
        data: {},
      };
    }
    const lines = goalsWithOnlySkips.map(
      (r) => `All of those are already on "${r.goal.title}": ${r.skipped.map((s) => `"${s}"`).join(', ')}.`
    );
    return {
      intent: 'add_items',
      ok: true,
      message: lines.join(' '),
      data: {
        goals: results.map((r) => ({
          goal_id: r.goal.id,
          goal_title: r.goal.title,
          skipped: r.skipped,
        })),
      },
    };
  }

  const addLines = [];
  for (const r of goalsWithAdds) {
    const createdList = r.created.map((c) => `"${c.label}"`).join(', ');
    addLines.push(`Added ${createdList} to "${r.goal.title}"`);
  }
  const skipLines = [];
  for (const r of goalsWithOnlySkips) {
    skipLines.push(`already on "${r.goal.title}" (skipped: ${r.skipped.map((s) => `"${s}"`).join(', ')})`);
  }
  for (const r of goalsWithAdds) {
    if (r.skipped.length > 0) {
      skipLines.push(`also skipped on "${r.goal.title}" (already there: ${r.skipped.map((s) => `"${s}"`).join(', ')})`);
    }
  }

  let message = addLines.join('. ') + '.';
  if (skipLines.length > 0) {
    message += ` (${skipLines.join('; ')})`;
  }

  // 5. Re-evaluate risk for every goal we touched, and save the first flag.

  let firstFlag = null;
  for (const r of goalsWithAdds) {
    const reqs = await listRequirementsForGoal(r.goal.id);
    try {
      const { flag } = await checkAndFlag(r.goal, reqs);
      if (flag && !firstFlag) firstFlag = flag;
    } catch (e) {
      console.error('[onward] handleAddItems: checkAndFlag failed for', r.goal.id, e);
    }
  }
  await saveSession({ pendingConfirmation: null, pendingFlag: firstFlag });

  return {
    intent: 'add_items',
    ok: true,
    message,
    data: {
      goals: results.map((r) => ({
        goal_id: r.goal.id,
        goal_title: r.goal.title,
        added: r.created.map(simpleReq),
        skipped: r.skipped,
      })),
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

  // First-ever assessment of a goal: record it but do NOT flag. A brand-new
  // goal that starts at at_risk or critical isn't a crossing — there's no
  // prior level to cross from, and the user hasn't seen anything about
  // this goal yet.
  if (previous === null) {
    return { risk, flagged: false, flag: null };
  }

  const SEVERITY = { ok: 0, tight: 1, at_risk: 2, critical: 3 };
  const prevSeverity = SEVERITY[prevLevel ?? 'ok'] ?? 0;
  const nowSeverity = SEVERITY[risk.risk_level] ?? 0;

  const crossedIn =
    nowSeverity >= SEVERITY.at_risk &&
    nowSeverity > prevSeverity;

  if (!crossedIn) return { risk, flagged: false, flag: null };

  const message = composeProactiveMessage(goal, requirements, risk);
  const actionOffer = pickActionOffer(goal, requirements, risk);

  const flag = {
    goalId: goal.id,
    goalTitle: goal.title,
    fromLevel: prevLevel,
    toLevel: risk.risk_level,
    reasons: risk.reasons,
    message,
    actionOffer,
  };

  return { risk, flagged: true, flag };
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

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

async function handleCreate(text) {
  const draft = await extractGoal(text, { today: now() });
  if (!draft) return null;

  if (!draft.deadline) {
    // Persist the partial goal so the next user turn can be recognized as
    // the deadline answer.
    const pendingConfirmation = {
      kind: 'await_deadline',
      partialGoal: {
        title: draft.title,
        goal_type: draft.goal_type,
        requirements: draft.requirements ?? [],
      },
      sticky: true,
    };
    await saveSession({ pendingConfirmation, pendingFlag: null });
    return {
      intent: 'create',
      ok: true,
      message: `Got it — "${draft.title}". What's the deadline?`,
      data: { partial_goal: { title: draft.title, goal_type: draft.goal_type } },
      needsConfirmation: pendingConfirmation,
    };
  }

  const goal = await createGoal({
    title: draft.title,
    deadline: draft.deadline,
    goalType: draft.goal_type,
  });

  await appendEvent({
    goalId: goal.id,
    rawText: text,
    interpretedChange: { type: 'goal_created', title: goal.title, deadline: goal.deadline, goal_type: goal.goal_type },
  });

  if (draft.requirements.length > 0) {
    const createdReqs = await createRequirementsBatch(
      goal.id,
      draft.requirements.map((r) => ({
        label: r.label,
        kind: r.kind,
        status: r.status ?? 'not_started',
      }))
    );
    await appendEventsBatch(
      createdReqs.map((req) => ({
        goalId: goal.id,
        requirementId: req.id,
        rawText: text,
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
  const completeness = findMissingRequirements(goal, currentReqs, template, { onlyCommonlyMissed: true });

  if (completeness.missing.length > 0) {
    const question = await phraseCompletenessQuestion(completeness.missing);
    const lines = [];
    lines.push(`Got it — "${goal.title}", deadline ${goal.deadline}.`);
    if (question) lines.push(question);

    const { risk, flag } = await checkAndFlag(goal, currentReqs);

    await saveSession({
      pendingConfirmation: {
        kind: 'completeness',
        goalId: goal.id,
        missing: completeness.missing,
        offerText: question ?? null,
        sticky: true,
      },
      pendingFlag: flag,
    });

    return {
      intent: 'create',
      ok: true,
      message: lines.join('\n\n'),
      data: {
        goal: { id: goal.id, title: goal.title, deadline: goal.deadline, goal_type: goal.goal_type },
        requirements: currentReqs.map(simpleReq),
        missing: completeness.missing,
        risk_level: risk.risk_level,
      },
      needsConfirmation: { kind: 'completeness', missing: completeness.missing },
    };
  }

  const { risk, flag } = await checkAndFlag(goal, currentReqs);
  await saveSession({ pendingConfirmation: null, pendingFlag: flag });

  return {
    intent: 'create',
    ok: true,
    message: `Got it — "${goal.title}", deadline ${goal.deadline}.`,
    data: {
      goal: { id: goal.id, title: goal.title, deadline: goal.deadline, goal_type: goal.goal_type },
      requirements: currentReqs.map(simpleReq),
      missing: [],
      risk_level: risk.risk_level,
    },
  };
}

// ---------------------------------------------------------------------------
// Update (cross-goal, multi-item)
// ---------------------------------------------------------------------------

async function handleUpdate(text) {
  const open = await fetchOpenItemsAcrossGoals();
  if (open.length === 0) return null;

  const result = await interpretUpdate(text, open);

  // --- DIAGNOSTIC (temporary) --------------------------------------------
  // Logs the raw shape returned by the interpreter so we can see exactly
  // what it emitted for a given message. Remove after debugging.
  console.log('[debug] interpretUpdate result:', JSON.stringify({
    reason: result.reason,
    proposals_count: (result.proposals ?? []).length,
    proposals: (result.proposals ?? []).map((p) => ({
      label: p.label,
      goal: p.goal_title,
      new_status: p.new_status,
    })),
    ambiguous_count: (result.ambiguous ?? []).length,
    ambiguous: (result.ambiguous ?? []).map((a) => ({
      mention: a.mention,
      candidates: (a.candidates ?? []).map((c) => `${c.label}@${c.goal_title}`),
    })),
    unmatched: result.unmatched_mentions,
    saw_no_change: result.saw_no_change,
  }, null, 2));
  // --- END DIAGNOSTIC -----------------------------------------------------

  const proposals = result.proposals ?? [];
  const ambiguous = result.ambiguous ?? [];
  const unmatched = result.unmatched_mentions ?? [];

  if (proposals.length === 0 && ambiguous.length === 0) {
    if (result.reason === 'no_change' && unmatched.length === 0) {
      return {
        intent: 'update',
        ok: true,
        message: `Nothing to change — that's already where you said it was.`,
        data: {},
      };
    }

    if (unmatched.length > 0) {
      const list = unmatched.map((m) => `"${m}"`).join(', ');
      const verb = unmatched.length === 1 ? 'it' : 'them';
      const prefix = result.reason === 'no_change'
        ? 'That other item is already marked done. '
        : '';

      const activeGoals = await listGoals({ status: 'active' });
      const session = await getSession();
      const conversationalGoalId = session.active_goal_id ?? null;
      const conversationalGoal = conversationalGoalId
        ? activeGoals.find((g) => g.id === conversationalGoalId) ?? null
        : null;

      // Prefer the conversational goal; fall back to the sole active
      // goal if there's exactly one.
      const targetGoal = conversationalGoal
        ?? (activeGoals.length === 1 ? activeGoals[0] : null);

      if (targetGoal) {
        const pendingConfirmation = {
          kind: 'add_unmatched',
          goalId: targetGoal.id,
          goalTitle: targetGoal.title,
          mentions: unmatched,
        };
        await saveSession({ pendingConfirmation, pendingFlag: null, activeGoalId: targetGoal.id });
        return {
          intent: 'update',
          ok: true,
          message: `${prefix}I don't have ${list} on "${targetGoal.title}". Want me to add ${verb}?`,
          data: { unmatched_mentions: unmatched, goal_id: targetGoal.id, goal_title: targetGoal.title },
          needsConfirmation: pendingConfirmation,
        };
      }

      return {
        intent: 'update',
        ok: true,
        message: `${prefix}I don't have ${list} on any of your goals. Which goal should ${verb === 'it' ? 'it' : 'they'} go on?`,
        data: {
          unmatched_mentions: unmatched,
          candidate_goals: activeGoals.map((g) => ({ goal_id: g.id, goal_title: g.title })),
        },
      };
    }

    if (result.reason === 'illegal_transition') {
      const why = (result.illegal_reasons ?? []).join('; ');
      return {
        intent: 'update',
        ok: true,
        message: why ? `I couldn't apply that: ${why}.` : `That step isn't legal. Can you clarify?`,
        data: {},
      };
    }

    if (result.reason === 'no_match' || result.reason === 'new_item') {
      return null;
    }

    return null;
  }

  const applied = [];
  const flags = [];
  for (const p of proposals) {
    const goal = await getGoal(p.goal_id);
    if (!goal) continue;
    try {
      const updated = await applyAndPersist(goal, p.requirement_id, p.new_status, text);
      applied.push(updated);

      const fresh = await listRequirementsForGoal(goal.id);
      const { flag } = await checkAndFlag(goal, fresh);
      if (flag) flags.push(flag);
    } catch (e) {
      console.error('[onward] failed to apply proposal:', e);
    }
  }

  const realAmbiguous = ambiguous.filter((a) => (a.candidates?.length ?? 0) > 1);
  const singleCandidate = ambiguous.filter((a) => (a.candidates?.length ?? 0) === 1);

  const messageParts = [];

  if (applied.length === 1) {
    const u = applied[0];
    messageParts.push(`Got it — "${u.label}" is now ${prettyStatus(u.status)}.`);
  } else if (applied.length > 1) {
    const list = applied.map((u) => `"${u.label}" (${prettyStatus(u.status)})`).join(', ');
    messageParts.push(`Got it — updated ${list}.`);
  }

  let unmatchedPending = null;
  if (unmatched.length > 0) {
    const list = unmatched.map((m) => `"${m}"`).join(', ');
    const verb = unmatched.length === 1 ? 'it' : 'them';

    const targetGoalId = applied[0]?.goal_id ?? null;
    if (targetGoalId) {
      const goal = await getGoal(targetGoalId);
      if (goal) {
        unmatchedPending = {
          kind: 'add_unmatched',
          goalId: goal.id,
          goalTitle: goal.title,
          mentions: unmatched,
        };
        messageParts.push(`I also see ${list} — I don't have ${verb} on "${goal.title}". Want me to add ${verb}?`);
      }
    } else {
      messageParts.push(`I also see ${list} — I don't have ${verb} on any goal. Want me to add ${verb}?`);
    }
  }

  let pendingConfirmation = unmatchedPending;

  if (realAmbiguous.length > 0) {
    const question = composeClarification(realAmbiguous);
    messageParts.push(question);
    pendingConfirmation = {
      kind: 'disambiguate',
      items: realAmbiguous,
      sticky: true,
    };
  } else if (singleCandidate.length === 1) {
    const c = singleCandidate[0].candidates[0];
    messageParts.push(`Should I mark "${c.label}" as done on "${c.goal_title ?? 'that goal'}"?`);
    pendingConfirmation = {
      kind: 'apply_update',
      goalId: c.goal_id,
      requirementId: c.requirement_id,
      newStatus: 'done',
    };
  } else if (singleCandidate.length > 1) {
    const list = singleCandidate
      .map((a) => `"${a.candidates[0].label}" on "${a.candidates[0].goal_title ?? 'that goal'}"`)
      .join(', ');
    messageParts.push(`Should I mark ${list} as done?`);
    pendingConfirmation = {
      kind: 'apply_update_multi',
      updates: singleCandidate.map((a) => ({
        goalId: a.candidates[0].goal_id,
        requirementId: a.candidates[0].requirement_id,
        newStatus: 'done',
      })),
    };
  }

  const flagToSave = flags[0] ?? null;
  await saveSession({ pendingConfirmation, pendingFlag: flagToSave });

  return {
    intent: 'update',
    ok: true,
    message: messageParts.join('\n\n'),
    data: {
      applied: applied.map((u) => ({ requirement_id: u.id, label: u.label, status: u.status })),
      ambiguous: realAmbiguous,
      single_candidate: singleCandidate,
      unmatched_mentions: unmatched,
    },
  };
}

function composeClarification(ambiguous) {
  // Group mentions by their candidate goal set so we can ask a single
  // combined question when they share the same goals. Two mentions that
  // both exist on the same two goals become one question, not two.
  const groups = new Map();

  for (const a of ambiguous) {
    const goalTitles = [...new Set(a.candidates.map((c) => c.goal_title).filter(Boolean))].sort();
    const key = goalTitles.join('||');
    if (!groups.has(key)) groups.set(key, { goalTitles, mentions: [] });
    groups.get(key).mentions.push(a);
  }

  const lines = [];
  for (const { goalTitles, mentions } of groups.values()) {
    const mentionText = mentions.map((m) => `"${m.mention}"`).join(' and ');

    if (goalTitles.length === 1) {
      lines.push(`Should I mark ${mentionText} as done on "${goalTitles[0]}"?`);
    } else if (goalTitles.length > 1) {
      lines.push(
        `Which goal should ${mentionText} apply to — ${goalTitles.map((t) => `"${t}"`).join(' or ')}? You can say "both" or name a goal.`
      );
    } else {
      lines.push(`Which item did you mean by ${mentionText}?`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

async function handleQuery(text) {
  const t = text.toLowerCase();

  if (/at risk|at-risk|critical|tight/.test(t)) {
    const goals = await listGoals({ status: 'active' });
    const entries = [];
    for (const g of goals) {
      const reqs = await listRequirementsForGoal(g.id);
      entries.push({ goal: g, risk: computeRisk(g, reqs, now()) });
    }
    const report = renderRiskReport(entries);
    const prose = report.data.at_risk.length > 0
      ? await phraseReport(report.data)
      : report.lines.join('\n');
    return {
      intent: 'query',
      ok: true,
      message: prose,
      data: { kind: 'risk', report: report.data },
    };
  }

  if (/what should i do|what now|next step/.test(t)) {
    const goals = await listGoals({ status: 'active' });
    const entries = [];
    for (const g of goals) {
      const reqs = await listRequirementsForGoal(g.id);
      entries.push({ goal: g, requirements: reqs, risk: computeRisk(g, reqs, now()) });
    }
    const report = renderActionReport(entries);
    return {
      intent: 'query',
      ok: true,
      message: report.lines.join('\n'),
      data: { kind: 'action', report: report.data },
    };
  }

  const goals = await listGoals({ status: 'active' });
  if (goals.length === 0) {
    return {
      intent: 'query',
      ok: true,
      message: "You don't have any goals yet. Tell me what you're working toward.",
      data: { kind: 'none' },
    };
  }

  const parts = [];
  for (const g of goals) {
    const reqs = await listRequirementsForGoal(g.id);
    const risk = computeRisk(g, reqs, now());
    const report = renderGoalReport(g, reqs, risk);
    parts.push(report.lines.join('\n'));
  }
  return {
    intent: 'query',
    ok: true,
    message: parts.join('\n\n'),
    data: { kind: 'list', goals: goals.map((g) => ({ id: g.id, title: g.title, deadline: g.deadline })) },
  };
}

// ---------------------------------------------------------------------------
// Confirmation resolution
// ---------------------------------------------------------------------------

async function tryResolveConfirmation(text, pc) {
  const t = text.trim().toLowerCase();

  if (/\b(never mind|nevermind|cancel that|forget it|skip it)\b/i.test(t)) {
    await saveSession({ pendingConfirmation: null, pendingFlag: null });
    return { intent: 'confirm', ok: true, message: 'Okay, never mind.', data: { kind: 'cancelled' } };
  }

  if (pc.kind === 'delete_goal_pick' && pc.sticky) {
    const matched = matchGoalByTitle(t, pc.candidates ?? []);
    if (!matched) {
      const resolution = await safeResolveConfirmation(pc, text);
      if (resolution === 'declined') {
        await saveSession({ pendingConfirmation: null, pendingFlag: null });
        return { intent: 'confirm', ok: true, message: 'Okay, no goal to delete.', data: { kind: 'delete_declined' } };
      }
      return null;
    }
    const goal = await getGoal(matched.goal_id);
    if (!goal) {
      await saveSession({ pendingConfirmation: null, pendingFlag: null });
      return { intent: 'confirm', ok: true, message: "That goal is already gone.", data: {} };
    }
    const pendingConfirmation = {
      kind: 'delete_goal',
      goalId: goal.id,
      goalTitle: goal.title,
    };
    await saveSession({ pendingConfirmation, pendingFlag: null });
    return {
      intent: 'confirm',
      ok: true,
      message: `Really delete "${goal.title}"? This removes the goal and all its items. Yes or no.`,
      data: { goal_id: goal.id, goal_title: goal.title },
      needsConfirmation: pendingConfirmation,
    };
  }

  if (pc.kind === 'disambiguate' && pc.sticky) {
    return await resolveStickyDisambiguate(t, pc, text);
  }
    // --- await_deadline ----------------------------------------------------
  // The user was asked "What's the deadline?" for a goal that was extracted
  // without one. Their reply should give a date, and may also mention
  // additional requirements for that goal.
  if (pc.kind === 'await_deadline') {
    let extracted = null;
    try {
      extracted = await resolveDeadlineReply(text, pc.partialGoal);
    } catch (e) {
      console.error('[onward] resolveDeadlineReply failed:', e);
      return null; // fall through to normal routing
    }
    if (!extracted) {
      // Couldn't find a date. Drop the pending confirmation so the message
      // is routed normally (the user might be changing the subject).
      await saveSession({ pendingConfirmation: null, pendingFlag: null });
      return null;
    }

    const goal = await createGoal({
      title: pc.partialGoal.title,
      deadline: extracted.deadline,
      goalType: pc.partialGoal.goal_type,
    });

    await appendEvent({
      goalId: goal.id,
      rawText: text,
      interpretedChange: {
        type: 'goal_created',
        title: goal.title,
        deadline: goal.deadline,
        goal_type: goal.goal_type,
      },
    });

    // Merge the requirements from the original statement with any new items
    // mentioned in the deadline reply.
    const allReqs = [
      ...(pc.partialGoal.requirements ?? []),
      ...(extracted.additionalRequirements ?? []),
    ];

    if (allReqs.length > 0) {
      const createdReqs = await createRequirementsBatch(
        goal.id,
        allReqs.map((r) => ({
          label: r.label,
          kind: r.kind,
          status: r.status ?? 'not_started',
        }))
      );
      await appendEventsBatch(
        createdReqs.map((req) => ({
          goalId: goal.id,
          requirementId: req.id,
          rawText: text,
          interpretedChange: {
            type: 'requirement_created',
            label: req.label,
            kind: req.kind,
            status: req.status,
          },
        }))
      );
    }

    // Now run the completeness check exactly as handleCreate would.
    const template = goal.goal_type
      ? await listGoalTypeTemplates(goal.goal_type)
      : [];
    const currentReqs = await listRequirementsForGoal(goal.id);
    const completeness = findMissingRequirements(goal, currentReqs, template, {
      onlyCommonlyMissed: true,
    });

    if (completeness.missing.length > 0) {
      const question = await phraseCompletenessQuestion(completeness.missing);
      const lines = [];
      lines.push(`Got it — "${goal.title}", deadline ${goal.deadline}.`);
      if (question) lines.push(question);

      const { risk, flag } = await checkAndFlag(goal, currentReqs);

      const nextPending = {
        kind: 'completeness',
        goalId: goal.id,
        missing: completeness.missing,
        offerText: question ?? null,
        sticky: true,
      };
      await saveSession({ pendingConfirmation: nextPending, pendingFlag: flag });
      return {
        intent: 'confirm',
        ok: true,
        message: lines.join('\n\n'),
        data: {
          goal: { id: goal.id, title: goal.title, deadline: goal.deadline, goal_type: goal.goal_type },
          requirements: currentReqs.map(simpleReq),
          missing: completeness.missing,
          risk_level: risk.risk_level,
        },
        needsConfirmation: nextPending,
      };
    }

    const { risk, flag } = await checkAndFlag(goal, currentReqs);
    await saveSession({ pendingConfirmation: null, pendingFlag: flag });
    return {
      intent: 'confirm',
      ok: true,
      message: `Got it — "${goal.title}", deadline ${goal.deadline}.`,
      data: {
        goal: { id: goal.id, title: goal.title, deadline: goal.deadline, goal_type: goal.goal_type },
        requirements: currentReqs.map(simpleReq),
        missing: [],
        risk_level: risk.risk_level,
      },
    };
  }

  if (pc.kind === 'choose_goal_for_new_item' && pc.sticky) {
    const matched = matchGoalByTitle(t, pc.candidates ?? []);
    if (matched) {
      const goal = await getGoal(matched.goal_id);
      if (!goal) {
        await saveSession({ pendingConfirmation: null, pendingFlag: null });
        return err('no_goal', 'That goal seems to be gone.');
      }

      // pc.label can be a single label or a comma-joined list (legacy
      // format from earlier versions). Split on comma to recover items.
      const labels = String(pc.label ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (labels.length === 0) {
        await saveSession({ pendingConfirmation: null, pendingFlag: null });
        return { intent: 'confirm', ok: true, message: "Nothing to add.", data: {} };
      }

      // Dedupe: drop labels already present on the target goal.
      const existing = await listRequirementsForGoal(goal.id);
      const existingKeys = new Set(existing.map((r) => normalizeLabel(r.label)));
      const toCreate = [];
      const skipped = [];
      for (const label of labels) {
        if (existingKeys.has(normalizeLabel(label))) {
          skipped.push(label);
        } else {
          toCreate.push(label);
        }
      }

      if (toCreate.length === 0) {
        await saveSession({ pendingConfirmation: null, pendingFlag: null });
        return {
          intent: 'confirm',
          ok: true,
          message: `All of those are already on "${goal.title}": ${skipped.map((s) => `"${s}"`).join(', ')}.`,
          data: { kind: 'add_declined', skipped },
        };
      }

      const created = await createRequirementsBatch(
        goal.id,
        toCreate.map((label) => ({ label, kind: 'self_action', status: 'not_started' }))
      );
      await appendEventsBatch(
        created.map((req) => ({
          goalId: goal.id,
          requirementId: req.id,
          rawText: text,
          interpretedChange: { type: 'requirement_created', via: 'user_statement', label: req.label },
        }))
      );
      const reqs = await listRequirementsForGoal(goal.id);
      const { risk, flag } = await checkAndFlag(goal, reqs);
      await saveSession({ pendingConfirmation: null, pendingFlag: null });

      const addedPart = created.map((r) => `"${r.label}"`).join(', ');
      const skippedPart = skipped.length > 0
        ? ` (Already there, skipped: ${skipped.map((s) => `"${s}"`).join(', ')}.)`
        : '';

      return {
        intent: 'confirm',
        ok: true,
        message: `Added to "${goal.title}": ${addedPart}.${skippedPart}`,
        data: { kind: 'add_accepted', added: created.map(simpleReq), skipped, risk_level: risk.risk_level },
      };
    }
    const resolution = await safeResolveConfirmation(pc, text);
    if (resolution === 'declined') {
      await saveSession({ pendingConfirmation: null, pendingFlag: null });
      return { intent: 'confirm', ok: true, message: "Okay, skipping that.", data: { kind: 'add_declined' } };
    }
    return null;
  }

  const resolution = await safeResolveConfirmation(pc, text);

  if (resolution === 'unrelated') return null;

  const confirmed = resolution === 'confirmed';

  await saveSession({ pendingConfirmation: null, pendingFlag: null });

  if (pc.kind === 'delete_goal') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: `Okay, keeping "${pc.goalTitle}".`, data: { kind: 'delete_declined' } };
    }
    try {
      await appendEvent({
        goalId: pc.goalId,
        rawText: text,
        interpretedChange: { type: 'goal_deleted', title: pc.goalTitle },
      });
    } catch (e) {
      console.error('[onward] delete_goal: failed to append event', e.message);
    }
    await deleteGoal(pc.goalId);
    await saveSession({ pendingConfirmation: null, pendingFlag: null });
    return {
      intent: 'confirm',
      ok: true,
      message: `Deleted "${pc.goalTitle}".`,
      data: { kind: 'goal_deleted', goal_id: pc.goalId },
    };
  }

  if (pc.kind === 'delete_requirement') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: `Okay, keeping "${pc.label}".`, data: { kind: 'delete_declined' } };
    }
    const current = await getRequirement(pc.requirementId);
    if (!current) {
      await saveSession({ pendingConfirmation: null, pendingFlag: null });
      return { intent: 'confirm', ok: true, message: "That item is already gone.", data: { kind: 'delete_noop' } };
    }
    try {
      await appendEvent({
        goalId: current.goal_id,
        requirementId: pc.requirementId,
        rawText: text,
        interpretedChange: { type: 'requirement_deleted', label: current.label },
      });
    } catch (e) {
      console.error('[onward] delete_requirement: failed to append event', e.message);
    }
    await deleteRequirement(pc.requirementId);
    await saveSession({ pendingConfirmation: null, pendingFlag: null });
    return {
      intent: 'confirm',
      ok: true,
      message: `Deleted "${pc.label}" from "${pc.goalTitle}".`,
      data: { kind: 'requirement_deleted', requirement_id: pc.requirementId },
    };
  }

  if (pc.kind === 'completeness') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: "Okay, I'll leave those out.", data: { kind: 'completeness_declined' } };
    }
    const goal = await getGoal(pc.goalId);
    if (!goal) {
      return { intent: 'confirm', ok: true, message: "That goal seems to be gone.", data: {} };
    }

    // 1. Create the completeness items.
    const createdReqs = await createRequirementsBatch(
      goal.id,
      pc.missing.map((m) => ({ label: m.label, kind: m.kind }))
    );
    await appendEventsBatch(
      createdReqs.map((req) => ({
        goalId: goal.id,
        requirementId: req.id,
        rawText: text,
        interpretedChange: {
          type: 'requirement_created',
          via: 'completeness',
          label: req.label,
          kind: req.kind,
        },
      }))
    );

    // 2. Try to extract any ADDITIONAL items the user mentioned in the
    //    same reply. "add them, and i also need a cv and passport copy"
    //    is a completeness confirm PLUS two extra items for the same goal.
    //    Any extra items go on the same goal (the one the question was
    //    about), unless the message names a different one.
    let extraCreated = [];
    let extraSkipped = [];
    let extraTargetGoal = goal;

    try {
      const extra = await extractItems(text);
      if (extra && extra.items.length > 0) {
        // Extras go on the goal the completeness question was about.
        // The user is answering a question about this goal; anything else
        // they mention belongs to the same goal unless they explicitly
        // say otherwise, which is rare enough to handle in a follow-up
        // turn if it happens.
        //
        // (We deliberately do NOT switch targets based on goal_hints
        // here. The hints are often triggered by the goal title being
        // present in the surrounding context, causing spurious "which
        // goal" questions.)

        // Duplicate-check against the target goal.
        const existing = await listRequirementsForGoal(extraTargetGoal.id);
        const existingKeys = new Set(existing.map((r) => normalizeLabel(r.label)));
        const toCreate = [];
        for (const item of extra.items) {
          if (existingKeys.has(normalizeLabel(item.label))) {
            extraSkipped.push(item.label);
          } else {
            toCreate.push(item);
          }
        }

        if (toCreate.length > 0) {
          extraCreated = await createRequirementsBatch(
            extraTargetGoal.id,
            toCreate.map((item) => ({
              label: item.label,
              kind: item.kind ?? 'self_action',
              status: item.status ?? 'not_started',
            }))
          );
          await appendEventsBatch(
            extraCreated.map((req) => ({
              goalId: extraTargetGoal.id,
              requirementId: req.id,
              rawText: text,
              interpretedChange: {
                type: 'requirement_created',
                via: 'user_statement',
                label: req.label,
                kind: req.kind,
                status: req.status,
              },
            }))
          );
        }
      }
    } catch (e) {
      console.error('[onward] completeness: extra-item extraction failed', e);
    }

    // 3. Recompute risk once for the primary goal (and for the extra
    //    target if it differed).
    const reqs = await listRequirementsForGoal(goal.id);
    const { risk, flag } = await checkAndFlag(goal, reqs);
    if (extraTargetGoal.id !== goal.id && extraCreated.length > 0) {
      const extraReqs = await listRequirementsForGoal(extraTargetGoal.id);
      await checkAndFlag(extraTargetGoal, extraReqs);
    }
    await saveSession({ pendingConfirmation: null, pendingFlag: flag });

    // 4. Compose a message covering both parts.
    const lines = [];
    lines.push(`Added to "${goal.title}": ${createdReqs.map((r) => `"${r.label}"`).join(', ')}.`);
    if (extraCreated.length > 0) {
      lines.push(`Also added to "${extraTargetGoal.title}": ${extraCreated.map((r) => `"${r.label}"`).join(', ')}.`);
    }
    if (extraSkipped.length > 0) {
      lines.push(`(Already there, skipped: ${extraSkipped.map((s) => `"${s}"`).join(', ')}.)`);
    }

    return {
      intent: 'confirm',
      ok: true,
      message: lines.join(' '),
      data: {
        kind: 'completeness_accepted',
        added: createdReqs.map(simpleReq),
        extra_added: extraCreated.map(simpleReq),
        extra_skipped: extraSkipped,
        risk_level: risk.risk_level,
      },
    };
  }

  if (pc.kind === 'add_item') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: "Okay, skipping that.", data: { kind: 'add_declined' } };
    }
    const goal = await getGoal(pc.goalId);
    const req = await createRequirement({ goalId: goal.id, label: pc.label, kind: 'self_action' });
    await appendEvent({
      goalId: goal.id,
      requirementId: req.id,
      rawText: text,
      interpretedChange: { type: 'requirement_created', via: 'user_statement', label: req.label },
    });
    const reqs = await listRequirementsForGoal(goal.id);
    const { risk, flag } = await checkAndFlag(goal, reqs);
    await saveSession({ pendingConfirmation: null, pendingFlag: flag });
    return {
      intent: 'confirm',
      ok: true,
      message: `Added "${req.label}" to your goal.`,
      data: { kind: 'add_accepted', added: simpleReq(req), risk_level: risk.risk_level },
    };
  }

  if (pc.kind === 'add_unmatched') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: "Okay, skipping those.", data: { kind: 'add_declined' } };
    }
    const goal = await getGoal(pc.goalId);
    if (!goal) {
      return { intent: 'confirm', ok: true, message: "That goal seems to be gone.", data: {} };
    }
    const createdReqs = await createRequirementsBatch(
      goal.id,
      pc.mentions.map((m) => ({ label: m, kind: 'self_action' }))
    );
    await appendEventsBatch(
      createdReqs.map((req) => ({
        goalId: goal.id,
        requirementId: req.id,
        rawText: text,
        interpretedChange: {
          type: 'requirement_created',
          via: 'user_statement',
          label: req.label,
        },
      }))
    );
    const reqs = await listRequirementsForGoal(goal.id);
    const { risk, flag } = await checkAndFlag(goal, reqs);
    await saveSession({ pendingConfirmation: null, pendingFlag: flag });
    return {
      intent: 'confirm',
      ok: true,
      message: `Added to "${goal.title}": ${createdReqs.map((r) => r.label).join(', ')}.`,
      data: { kind: 'add_accepted', added: createdReqs.map(simpleReq), risk_level: risk.risk_level },
    };
  }

  if (pc.kind === 'apply_update') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: 'Okay, not changing that.', data: { kind: 'update_declined' } };
    }
    const goal = await getGoal(pc.goalId);
    const updated = await applyAndPersist(goal, pc.requirementId, pc.newStatus, text);
    const reqs = await listRequirementsForGoal(goal.id);
    const { risk, flag } = await checkAndFlag(goal, reqs);
    await saveSession({ pendingConfirmation: null, pendingFlag: flag });
    return {
      intent: 'confirm',
      ok: true,
      message: `Updated "${updated.label}" to ${prettyStatus(updated.status)}.`,
      data: { kind: 'update_applied', requirement: simpleReq(updated), risk_level: risk.risk_level },
    };
  }

  if (pc.kind === 'apply_update_multi') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: 'Okay, not changing anything.', data: { kind: 'update_declined' } };
    }
    const applied = [];
    for (const u of pc.updates ?? []) {
      const goal = await getGoal(u.goalId);
      if (!goal) continue;
      try {
        const updated = await applyAndPersist(goal, u.requirementId, u.newStatus, text);
        applied.push(updated);
        const reqs = await listRequirementsForGoal(goal.id);
        await checkAndFlag(goal, reqs);
      } catch (e) {
        console.error('[onward] apply_update_multi: skipped item', e.message);
      }
    }
    await saveSession({ pendingConfirmation: null, pendingFlag: null });
    if (applied.length === 0) {
      return { intent: 'confirm', ok: true, message: "I couldn't apply any of those.", data: { kind: 'update_declined' } };
    }
    const list = applied.map((u) => `"${u.label}" (${prettyStatus(u.status)})`).join(', ');
    return {
      intent: 'confirm',
      ok: true,
      message: applied.length === 1
        ? `Got it — "${applied[0].label}" is now ${prettyStatus(applied[0].status)}.`
        : `Got it — updated ${list}.`,
      data: { kind: 'update_applied', applied: applied.map(simpleReq) },
    };
  }

  if (pc.kind === 'send_followup') {
    if (!confirmed) {
      return { intent: 'confirm', ok: true, message: 'Okay, not sending anything.', data: { kind: 'send_declined' } };
    }
    const result = await executeAction(pc.requirementId, 'draft_followup', {});
    if (!result.ok) {
      return {
        intent: 'confirm',
        ok: false,
        message: `I couldn't draft that: ${result.reason}`,
        data: { kind: 'send_failed', reason: result.reason },
        error: 'send_failed',
      };
    }
    const toLine = pc.dependsOn ? ` to ${pc.dependsOn}` : '';
    const sandboxNote = result.sandboxed
      ? "\n\n(Heads up: I'm in sandbox mode, so nothing was actually sent — this is the draft I'd send.)"
      : '';
    return {
      intent: 'confirm',
      ok: true,
      message:
        `Here's a draft follow-up${toLine} for "${pc.label}":\n\n` +
        result.draft +
        sandboxNote,
      data: {
        kind: 'followup_drafted',
        requirement_id: pc.requirementId,
        draft: result.draft,
        sandboxed: result.sandboxed,
      },
    };
  }

  return null;
}

async function safeResolveConfirmation(pc, reply) {
  let resolution = null;
  try {
    resolution = await resolveConfirmation(pc, reply);
  } catch (e) {
    console.error('[onward] resolveConfirmation failed, using fallback:', e);
  }

  // Safety net: if the LLM says "unrelated" but the reply clearly STARTS
  // with a positive confirmation phrase, treat it as confirmed. This
  // covers the mixed-message case ("add them, and I also need X") even
  // when the classifier gets confused by the trailing clause.
  if (resolution === 'unrelated' || resolution === null) {
    const t = reply.trim().toLowerCase();

    // Messages that lead with a clear yes/confirm phrase:
    //   "yes", "yeah", "sure", "ok", "okay", "go ahead", "do it",
    //   "add them", "add it", "add those", "add the missing",
    //   "please add", "confirm"
    // followed by anything.
    const leadsWithYes =
      /^(yes|yeah|yep|yup|sure|ok|okay|k|y|go ahead|do it|add (it|them|those|the missing|the missing items)|please add|confirm)\b/i.test(t);

    if (leadsWithYes) {
      return 'confirmed';
    }

    // Messages that clearly lead with a no/decline:
    if (/^(no|nope|nah|not yet|not really|never ?mind|skip it|forget it|don'?t|do not|leave them out|hold off)\b/i.test(t)) {
      return 'declined';
    }

    // Short replies with no obvious signal: treat as confirmation of the
    // pending question if the LLM couldn't decide.
    const wordCount = t.split(/\s+/).length;
    const updateShaped = /\b(came in|arrived|received|sent|submitted|finished|started)\b/i.test(t);
    if (wordCount <= 6 && !updateShaped && resolution === null) {
      return 'confirmed';
    }

    return 'unrelated';
  }

  return resolution;
}

async function resolveStickyDisambiguate(t, pc, originalText) {
  const items = pc.items ?? [];
  const resolved = [];
  const stillOpen = [];

  // --- DIAGNOSTIC (temporary) --------------------------------------------
  console.log('[debug] resolveStickyDisambiguate input:', JSON.stringify({
    user_reply: t,
    item_count: items.length,
    items: items.map((a) => ({
      mention: a.mention,
      candidate_count: (a.candidates ?? []).length,
      candidates: (a.candidates ?? []).map((c) => `${c.label}@${c.goal_title}`),
    })),
  }, null, 2));
  // --- END DIAGNOSTIC -----------------------------------------------------

  // Detect "all goals" answers: "both", "all", "all of them", "everywhere",
  // or a phrase that lists all candidate goal titles in one message.
  const saysBoth = /\b(both|all|all of them|everywhere|every goal|either)\b/i.test(t);

  // Collect every unique goal mentioned across all candidate sets, in case
  // the user answers with a goal name that applies to more than one item.
  const allGoalTitles = new Set();
  for (const a of items) {
    for (const c of a.candidates ?? []) {
      if (c.goal_title) allGoalTitles.add(c.goal_title);
    }
  }

  for (const a of items) {
    const candidates = a.candidates ?? [];
    const status = pc.newStatus ?? a.newStatus ?? 'done';

    // If the user said "both" and this item has multiple candidates,
    // apply every candidate.
    if (saysBoth && candidates.length > 1) {
      for (const c of candidates) {
        const goal = await getGoal(c.goal_id);
        if (!goal) continue;
        try {
          const updated = await applyAndPersist(goal, c.requirement_id, status, originalText);
          resolved.push(updated);
          const reqs = await listRequirementsForGoal(goal.id);
          await checkAndFlag(goal, reqs);
        } catch (e) {
          console.error('[onward] resolveStickyDisambiguate: apply failed', e.message);
        }
      }
      continue;
    }

    // Otherwise try to match a single candidate.
    const picked = matchCandidateInReply(t, candidates);
    if (picked) {
      const goal = await getGoal(picked.goal_id);
      if (!goal) {
        stillOpen.push(a);
        continue;
      }
      try {
        const updated = await applyAndPersist(goal, picked.requirement_id, status, originalText);
        resolved.push(updated);
        const reqs = await listRequirementsForGoal(goal.id);
        await checkAndFlag(goal, reqs);
      } catch (e) {
        stillOpen.push(a);
      }
    } else {
      stillOpen.push(a);
    }
  }

  if (stillOpen.length > 0) {
    const resolution = await safeResolveConfirmation(pc, originalText);
    if (resolution === 'declined') {
      await saveSession({ pendingConfirmation: null, pendingFlag: null });
      return { intent: 'confirm', ok: true, message: "Okay, never mind.", data: { kind: 'cancelled' } };
    }
    // Only treat the reply as "unrelated" (drop the pending state) if
    // nothing resolved AND the user clearly changed the subject.
    if (resolution === 'unrelated' && resolved.length === 0) {
      await saveSession({ pendingConfirmation: null, pendingFlag: null });
      return null;
    }
    const pendingConfirmation = {
      kind: 'disambiguate',
      items: stillOpen,
      sticky: true,
    };
    await saveSession({ pendingConfirmation, pendingFlag: null });
    const question = composeClarification(stillOpen);
    return {
      intent: 'confirm',
      ok: true,
      message: question,
      data: { kind: 'ask_disambiguate', items: stillOpen },
      needsConfirmation: pendingConfirmation,
    };
  }

  await saveSession({ pendingConfirmation: null, pendingFlag: null });
  const list = resolved.map((u) => `"${u.label}" (${prettyStatus(u.status)})`).join(', ');
  return {
    intent: 'confirm',
    ok: true,
    message: resolved.length === 1
      ? `Got it — "${resolved[0].label}" is now ${prettyStatus(resolved[0].status)}.`
      : `Got it — updated ${list}.`,
    data: { kind: 'update_applied', applied: resolved.map(simpleReq) },
  };
}
/**
 * Check whether a user reply could plausibly be an answer to a pending
 * confirmation. Used to decide whether to re-ask a sticky question or
 * drop it and route the message normally.
 *
 * A reply is "plausibly an answer" if:
 *   - it names a candidate goal (for choose_goal_for_new_item,
 *     delete_goal_pick, disambiguate with goal candidates)
 *   - it names a candidate item (for disambiguate)
 *   - it contains "both", "all", "either", or similar choice words
 *   - it is short (<= 6 words) and doesn't match a strong new-intent
 *     signal like "delete", "add", "i need to apply", etc.
 */
function looksLikeAnswerToConfirmation(text, pc) {
  if (!pc) return false;

  const t = text.trim().toLowerCase();
  if (!t) return false;

  // "both" / "all" / "either" style answers.
  if (/\b(both|all|all of them|everywhere|every goal|either)\b/i.test(t)) {
    return true;
  }

  // Names a candidate goal.
  const goalCandidates = (pc.candidates ?? []).filter((c) => c.goal_title);
  if (goalCandidates.length > 0 && matchGoalByTitle(t, goalCandidates)) {
    return true;
  }

  // Names a candidate item (for disambiguate kind).
  const items = pc.items ?? [];
  for (const a of items) {
    const candidates = a.candidates ?? [];
    if (candidates.length > 0 && matchCandidateInReply(t, candidates)) {
      return true;
    }
  }

  // Short replies are likely answers (yes/no style).
  const wordCount = t.split(/\s+/).length;
  if (wordCount <= 6) {
    // But not if the short reply has a strong new-intent signal.
    const strongNewIntent =
      /\b(delete|remove|drop|no longer need|don'?t need|i need to|i want to|new goal|start (a )?(new )?goal|the .* came in|i sent|i received|i finished|i started)\b/i.test(t);
    if (!strongNewIntent) return true;
  }

  return false;
}
async function reaskStickyConfirmation(pc) {
  if (pc.kind === 'disambiguate') {
    const question = composeClarification(pc.items ?? []);
    return {
      intent: 'confirm',
      ok: true,
      message: question,
      data: { kind: 'ask_disambiguate', items: pc.items },
      needsConfirmation: pc,
    };
  }
  if (pc.kind === 'choose_goal_for_new_item') {
    return {
      intent: 'confirm',
      ok: true,
      message: `Which goal should I add "${pc.label}" to — ${pc.candidates.map((c) => `"${c.goal_title}"`).join(' or ')}?`,
      data: { kind: 'ask_goal_choice', candidates: pc.candidates },
      needsConfirmation: pc,
    };
  }
  if (pc.kind === 'delete_goal_pick') {
    return {
      intent: 'confirm',
      ok: true,
      message: `Which goal do you want to delete — ${pc.candidates.map((c) => `"${c.goal_title}"`).join(' or ')}?`,
      data: { kind: 'ask_goal_pick', candidates: pc.candidates },
      needsConfirmation: pc,
    };
  }
  if (pc.kind === 'completeness') {
    const missing = pc.missing ?? [];
    const question = pc.offerText
      ?? (missing.length > 0
        ? `Just to be sure — do you have ${missing.map((m) => m.label).join(', ')}?`
        : `Do you want me to add the missing items?`);
    return {
      intent: 'confirm',
      ok: true,
      message: question,
      data: { kind: 'ask_completeness', missing },
      needsConfirmation: pc,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clarification fallback
// ---------------------------------------------------------------------------

async function askForClarification(text) {
  const goals = await listGoals({ status: 'active' });

  if (goals.length === 0) {
    return {
      intent: 'clarify',
      ok: true,
      message:
        "I'm not sure what you meant. If you're telling me about a goal, " +
        "say something like \"I need to submit a scholarship application by " +
        "December 15 and I still need my transcript.\"",
      data: { kind: 'clarify' },
    };
  }

  const lines = [
    "I'm not sure what you meant by that.",
    '',
    'Your current goals:',
    ...goals.map((g) => `  • ${g.title} (deadline ${g.deadline})`),
    '',
    'You can tell me about a new goal, update progress on one of these, or ask a question.',
  ];

  return {
    intent: 'clarify',
    ok: true,
    message: lines.join('\n'),
    data: { kind: 'clarify', goals: goals.map((g) => ({ id: g.id, title: g.title, deadline: g.deadline })) },
  };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

async function applyAndPersist(goal, requirementId, newStatus, rawText) {
  const reqs = await listRequirementsForGoal(goal.id);
  const current = reqs.find((r) => r.id === requirementId);
  if (!current) throw new Error(`Requirement ${requirementId} not found for goal ${goal.id}`);

  const at = now();
  const next = applyTransition(current, newStatus, { at });

  await updateRequirement(requirementId, {
    status: next.status,
    requested_at: next.requested_at,
    received_at: next.received_at,
    notes: next.notes,
  });

  await appendEvent({
    goalId: goal.id,
    requirementId,
    rawText,
    interpretedChange: {
      type: 'status_changed',
      from: current.status,
      to: next.status,
    },
  });

  return next;
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function matchCandidateInReply(t, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const tTokens = new Set(tokens(t));
  if (tTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const labelTokens = tokens(c.label);
    const goalTokens = tokens(c.goal_title ?? '');

    let score = 0;
    for (const tok of labelTokens) if (tTokens.has(tok)) score += 2;
    for (const tok of goalTokens)  if (tTokens.has(tok)) score += 3;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (candidates.length === 1 && !best) return candidates[0];

  return bestScore >= 2 ? best : null;
}

function matchGoalByTitle(t, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const tTokens = new Set(tokens(t));
  if (tTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const c of candidates) {
    const goalTokens = tokens(c.goal_title ?? '');
    let score = 0;
    for (const tok of goalTokens) if (tTokens.has(tok)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return bestScore >= 1 ? best : null;
}

function tokens(s) {
  if (typeof s !== 'string') return [];
  const stop = new Set([
    'a', 'an', 'the', 'of', 'to', 'for', 'my', 'your', 'from', 'and', 'or',
    'i', 'it', 'its', 'is', 'was', 'be', 'this', 'that', 'one', 'mean',
    'did', 'do', 'does', 'on', 'in', 'by', 'with',
    'no', 'longer', 'not', 'any', 'more', 'need', 'needed', 'want', 'wanted',
    'required', 'require', 'necessary', 'anymore', 'remove', 'delete',
    'also', 'still', 'just',
  ]);
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !stop.has(w));
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

function simpleReqWithGoal(r) {
  return { ...simpleReq(r), goal_id: r.goal_id, goal_title: r.goal_title };
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

function err(code, message) {
  return { intent: 'error', ok: false, message, data: {}, error: code };
}