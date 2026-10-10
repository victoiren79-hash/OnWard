// Onward — deterministic risk assessment.
//
// Pure functions. No I/O. No LLM. No clock import.
// `today` and `deadline` are passed in; everything is computed from them
// plus the current requirements.
//
// See the design note in the PR/commit for the reasoning behind the
// thresholds and the critical-path definition.

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Days of buffer added on top of the critical path. Product choice. */
export const BUFFER_DAYS = 3;

/** Days assumed for an external item with no turnaround estimate. */
export const DEFAULT_UNKNOWN_TURNAROUND_DAYS = 3;

/**
 * If the deadline is within this many days, a goal whose critical path
 * doesn't fit is critical (it's the eve). Beyond this, negative slack
 * means "start now" — which is at_risk, not critical.
 */
export const CLOSE_DEADLINE_DAYS = 2;

/** Slack thresholds, in days. See design note. */
export const THRESHOLDS = Object.freeze({
  // slack_days < 0        -> critical (only if deadline is close) OR at_risk
  // 0  <= slack < AT_RISK -> at_risk
  // AT_RISK <= slack < TIGHT -> tight
  // TIGHT <= slack        -> ok
  AT_RISK: 2,
  TIGHT: 5,
});

export const LEVELS = Object.freeze(['ok', 'tight', 'at_risk', 'critical']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeRisk(goal, requirements, today) {
  const deadline = coerceDate(goal?.deadline);
  const now = coerceDate(today);

  if (!deadline || !now) {
    throw new Error('[onward/risk] computeRisk: goal.deadline and today are required');
  }

  const reqs = Array.isArray(requirements) ? requirements : [];
  const outstanding = reqs.filter((r) => r && r.status !== 'done');

  const externalOutstanding = outstanding.filter(
    (r) => r.kind === 'external_dependency'
  );
  const selfOutstanding = outstanding.filter((r) => r.kind === 'self_action');

  const daysUntilDeadline = daysBetween(now, deadline);
  const deadlinePassed = daysUntilDeadline < 0;

  const reasons = [];

  // --- Per-item analysis ---------------------------------------------------
  const externals = externalOutstanding.map((r) => {
    const T = toNumber(r.typical_turnaround_days);
    const requestedAt = coerceDate(r.requested_at);
    const waiting = r.status === 'waiting_on_other';

    let remaining;
    let elapsed = null;
    let overdue = false;

    if (T == null) {
      remaining = DEFAULT_UNKNOWN_TURNAROUND_DAYS;
    } else if (waiting && requestedAt) {
      elapsed = daysBetween(requestedAt, now);
      remaining = Math.max(0, T - elapsed);
      overdue = elapsed > T;
    } else {
      remaining = T;
    }

    return { req: r, T, remaining, elapsed, overdue, waiting };
  });

  const overdue = externals.filter((e) => e.overdue);
  for (const o of overdue) {
    reasons.push({
      kind: 'past_turnaround',
      requirement_id: o.req.id,
      label: o.req.label,
      days_overdue: Math.max(0, Math.round(o.elapsed - o.T)),
    });
  }

  // --- Critical path -------------------------------------------------------
  const maxRemainingExternal =
    externals.length === 0 ? 0 : Math.max(...externals.map((e) => e.remaining));
  const criticalPathDays = maxRemainingExternal + BUFFER_DAYS;

  const drivers = externals.filter(
    (e) => e.remaining === maxRemainingExternal && e.remaining > 0
  );
  for (const d of drivers) {
    reasons.push({
      kind: 'critical_path_driver',
      requirement_id: d.req.id,
      label: d.req.label,
      remaining_days: round1(d.remaining),
    });
  }

  if (externals.length === 0) {
    reasons.push({ kind: 'no_external_deps' });
  }

  // --- Slack ---------------------------------------------------------------
  const slackDays = daysUntilDeadline - criticalPathDays;

  // --- Self actions --------------------------------------------------------
  if (selfOutstanding.length > 0) {
    reasons.push({
      kind: 'self_actions_outstanding',
      count: selfOutstanding.length,
      labels: selfOutstanding.map((r) => r.label),
    });
  }

  // --- Level ---------------------------------------------------------------
  // "Critical" is reserved for these situations:
  //   (a) the deadline has passed with outstanding work,
  //   (b) an outstanding external item is past its expected turnaround,
  //   (c) the critical path cannot fit in the remaining days AND the
  //       deadline is close (within CLOSE_DEADLINE_DAYS).
  //
  // If negative slack happens with plenty of time left, the correct
  // signal is "start now" — at_risk, not critical.
  let level;
  if (deadlinePassed && outstanding.length > 0) {
    level = 'critical';
    reasons.unshift({
      kind: 'deadline_passed',
      days_over: Math.round(-daysUntilDeadline),
    });
  } else if (overdue.length > 0) {
    level = 'critical';
  } else if (slackDays < 0 && daysUntilDeadline <= CLOSE_DEADLINE_DAYS) {
    level = 'critical';
  } else if (slackDays < 0) {
    level = 'at_risk';
  } else if (slackDays < THRESHOLDS.AT_RISK) {
    level = 'at_risk';
  } else if (slackDays < THRESHOLDS.TIGHT) {
    level = 'tight';
  } else {
    level = 'ok';
  }

  return {
    risk_level: level,
    slack_days: round1(slackDays),
    critical_path_days: round1(criticalPathDays),
    days_until_deadline: round1(daysUntilDeadline),
    reasons,
    outstanding_count: outstanding.length,
    external_outstanding_count: externalOutstanding.length,
    self_outstanding_count: selfOutstanding.length,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return ms / (24 * 60 * 60 * 1000);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function toNumber(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerceDate(input) {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : new Date(input.getTime());
  }
  if (typeof input === 'string') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}