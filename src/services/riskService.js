// Onward — deterministic risk assessment.
//
// Pure functions. No I/O. No LLM. No clock import.
// `today` and `deadline` are passed in; everything is computed from them
// plus the current requirements.
//
// The one exception to purity is reading USER_UTC_OFFSET_MINUTES inside
// endOfDay. That is deliberate: the whole point of endOfDay is to pin
// "end of that day" to the user's local midnight, not UTC midnight, so
// a deadline of "2026-10-16" means the same thing everywhere the user
// lives. The read is a pure lookup — no side effects.

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

/** Slack thresholds, in days. */
export const THRESHOLDS = Object.freeze({
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

  // Deadline math uses the end of the user's local day, not the raw
  // timestamp. A goal due "2026-10-16" is still on time during 2026-10-16,
  // and turns overdue at 00:00 local on 2026-10-17.
  const deadlineEnd = endOfDay(deadline);
  const daysUntilDeadline = daysBetween(now, deadlineEnd);
  const deadlinePassed = now > deadlineEnd;

  const reasons = [];

  // --- Per-item analysis ---------------------------------------------------
  // Each external item gets its own deadline (due_at) and its own
  // expected-arrival date (expected_at). When expected_at is present we
  // treat it as a hard commitment: the item is late when the date has
  // passed, and the goal is late when the expected date is after the
  // item's own deadline.
  const externals = externalOutstanding.map((r) => {
    const T = toNumber(r.typical_turnaround_days);
    const requestedAt = coerceDate(r.requested_at);
    const waiting = r.status === 'waiting_on_other';

    const itemDeadlineDate = coerceDate(r.due_at) ?? deadline;
    const itemDeadlineEnd = endOfDay(itemDeadlineDate);
    const daysUntilItem = daysBetween(now, itemDeadlineEnd);

    const expectedAt = coerceDate(r.expected_at);
    const hard = expectedAt != null;

    let remaining;
    let elapsed = null;
    let overdue = false;
    let daysOverdue = 0;

    if (hard) {
      remaining = Math.max(0, daysBetween(now, expectedAt));
      daysOverdue =
        expectedAt < now ? calDay(now) - calDay(expectedAt) : 0;
      overdue = daysOverdue > 0;
    } else if (T == null) {
      remaining = DEFAULT_UNKNOWN_TURNAROUND_DAYS;
    } else if (waiting && requestedAt) {
      elapsed = daysBetween(requestedAt, now);
      remaining = Math.max(0, T - elapsed);
      overdue = elapsed > T;
      daysOverdue = overdue ? Math.round(elapsed - T) : 0;
    } else {
      remaining = T;
    }

    // Slack for this item: the room between the item's own deadline
    // and the date it's expected to be done.
    const slackFloor = hard ? maxDate(expectedAt, now) : now;
    const slack = hard
      ? calDay(itemDeadlineDate) - calDay(slackFloor)
      : daysUntilItem - (remaining + BUFFER_DAYS);

    const hardLate =
      hard && calDay(expectedAt) > calDay(itemDeadlineDate);

    return {
      req: r,
      T,
      remaining,
      elapsed,
      overdue,
      daysOverdue,
      waiting,
      itemDeadlineDate,
      daysUntilItem,
      expectedAt,
      hard,
      slack,
      hardLate,
    };
  });

  // --- past_turnaround reasons --------------------------------------------
  const overdue = externals.filter((e) => e.overdue);
  for (const o of overdue) {
    reasons.push({
      kind: 'past_turnaround',
      requirement_id: o.req.id,
      label: o.req.label,
      days_overdue: o.daysOverdue,
    });
  }

  // --- expected_after_deadline reasons ------------------------------------
  const lateHard = externals.filter((e) => e.hardLate);
  for (const l of lateHard) {
    reasons.push({
      kind: 'expected_after_deadline',
      requirement_id: l.req.id,
      label: l.req.label,
      expected_at: toIsoDate(l.expectedAt),
      days_late: calDay(l.expectedAt) - calDay(l.itemDeadlineDate),
    });
  }

  // --- Slack and critical path --------------------------------------------
  // If there are externals, the goal's slack is the tightest item slack,
  // and the limiting horizon is that item's deadline distance. If there
  // are no externals, the goal's slack falls back to the old formula.
  let slackDays;
  let limitingDaysUntil;
  let maxRemainingExternal = 0;

  if (externals.length > 0) {
    maxRemainingExternal = Math.max(...externals.map((e) => e.remaining));

    let minSlack = Infinity;
    let minSlackItem = null;
    for (const e of externals) {
      if (e.slack < minSlack) {
        minSlack = e.slack;
        minSlackItem = e;
      }
    }
    slackDays = minSlack;
    limitingDaysUntil = minSlackItem ? minSlackItem.daysUntilItem : daysUntilDeadline;
  } else {
    slackDays = daysUntilDeadline - BUFFER_DAYS;
    limitingDaysUntil = daysUntilDeadline;
  }

  const criticalPathDays = maxRemainingExternal + BUFFER_DAYS;

  // --- Early return: nothing to be at risk about --------------------------
  //
  // If every item on the goal is done, the goal is on track by definition.
  // The buffer and critical path describe work that has to happen; if
  // there is no work left, they don't apply. This must come before the
  // level logic, or a fully-done goal with a short deadline will be
  // flagged as at_risk purely because the buffer doesn't fit.
  if (outstanding.length === 0) {
    return {
      risk_level: 'ok',
      slack_days: round1(slackDays),
      critical_path_days: round1(criticalPathDays),
      days_until_deadline: round1(daysUntilDeadline),
      reasons: [],
      outstanding_count: 0,
      external_outstanding_count: 0,
      self_outstanding_count: 0,
    };
  }

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

  // --- Self actions --------------------------------------------------------
  // A self task with a due_at that has already passed is overdue. We
  // surface this as a task_overdue reason and, if the goal would
  // otherwise be ok, we raise it to tight.
  const overdueSelf = selfOutstanding.filter((r) => {
    const dueAt = coerceDate(r.due_at);
    if (!dueAt) return false;
    return calDay(now) > calDay(dueAt);
  });
  for (const r of overdueSelf) {
    const dueAt = coerceDate(r.due_at);
    reasons.push({
      kind: 'task_overdue',
      requirement_id: r.id,
      label: r.label,
      days_over: calDay(now) - calDay(dueAt),
    });
  }

  if (selfOutstanding.length > 0) {
    reasons.push({
      kind: 'self_actions_outstanding',
      count: selfOutstanding.length,
      labels: selfOutstanding.map((r) => r.label),
    });
  }

  // --- Level ---------------------------------------------------------------
  // Order matters. The first condition that matches wins.
  let level;

  if (deadlinePassed && outstanding.length > 0) {
    level = 'critical';
    reasons.unshift({
      kind: 'deadline_passed',
      days_over: calDay(now) - calDay(deadline),
    });
  } else if (lateHard.length > 0) {
    level = 'critical';
  } else if (overdue.length > 0) {
    level = 'critical';
  } else if (slackDays < 0 && limitingDaysUntil <= CLOSE_DEADLINE_DAYS) {
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

  if (level === 'ok' && overdueSelf.length > 0) {
    level = 'tight';
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

/**
 * Whole-day number for a Date, in UTC year/month/day terms. Used for
 * date-to-date arithmetic where partial days must not drift the count.
 */
function calDay(d) {
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000
  );
}

/**
 * End of the user's local day, as a Date. Given any instant, returns
 * 23:59:59.000 UTC of that day, shifted back by the user's offset.
 *
 *   UTC:      deadline end is 23:59:59 UTC on that date.
 *   UTC-5:    deadline end is 23:59:59 local = 04:59:59 UTC the next day.
 *
 * The offset comes from USER_UTC_OFFSET_MINUTES (minutes east of UTC;
 * US Eastern is -300). Missing or invalid values fall back to 0.
 */
function endOfDay(d) {
  const offsetMinutes = Number(process.env.USER_UTC_OFFSET_MINUTES ?? 0);
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;

  const endUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    + 24 * 60 * 60 * 1000
    - 1;

  return new Date(endUtc - offset * 60 * 1000);
}

function daysBetween(a, b) {
  const ms = b.getTime() - a.getTime();
  return ms / (24 * 60 * 60 * 1000);
}

function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}

function toIsoDate(d) {
  if (!d) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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