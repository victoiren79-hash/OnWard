// Onward — deterministic reminder scheduling.
//
// Pure functions. No I/O. No LLM. No clock import. `today` is passed in.
//
// Every goal has a fixed schedule of reminder moments derived from its
// deadline, plus a per-requirement "request by" moment derived from each
// external item's typical turnaround, plus a per-task "task due" moment
// for self_action items that have their own due_at.
//
// This file answers one question: given a goal, its items, today's date,
// and the set of moments that have already fired, which moments are due
// now?
//
// It does NOT send anything, does NOT compose any message, does NOT
// touch the DB. The caller takes the returned list, picks the top one,
// composes a message, and records the moment as fired.

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Days of buffer added on top of an external item's typical turnaround
 * when computing its request_by moment. A week of slack: the user is
 * reminded to send a request a week before the item's turnaround would
 * put them past the deadline.
 */
export const REQUEST_BY_BUFFER_DAYS = 7;

/**
 * Goal-level moments. Each is defined as an offset from the deadline
 * in days. Positive offsets are before the deadline, negative offsets
 * are after.
 *
 * The order here is the order of precedence: if multiple goal-level
 * moments are due on the same day, the earlier one in this array wins.
 */
export const GOAL_LEVEL_MOMENTS = Object.freeze([
  { kind: 'overdue',         offset_days: -1 },
  { kind: 'due_today',       offset_days:  0 },
  { kind: 'two_days_out',    offset_days:  2 },
  { kind: 'seven_days_out',  offset_days:  7 },
]);

/**
 * Priority for sorting all due reminders, highest first. Lower number
 * means "fire this one first."
 *
 *   overdue         the goal is past its deadline
 *   due_today       the goal itself is due today
 *   task_due        a self task inside the goal is due today
 *   request_by      an external item needs to be requested soon
 *   two_days_out    two days until the goal deadline
 *   seven_days_out  one week until the goal deadline
 *
 * The exact numbers only matter as an ordering. Changing them is safe
 * as long as the relative order stays: overdue < due_today < task_due
 * < request_by < two_days_out < seven_days_out.
 */
const PRIORITY = Object.freeze({
  overdue:          0,
  due_today:        1,
  task_due:         2,
  request_by:       3,
  two_days_out:     4,
  seven_days_out:   5,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the reminders that are due for a goal right now.
 *
 * @param {object}   goal                — must have { id, deadline }
 * @param {Array}    requirements        — items on the goal
 * @param {Date}     today               — the current date
 * @param {string[]} alreadyFired        — kinds already fired for this goal
 * @returns {Array<{
 *   kind: string,
 *   requirement_id?: string,
 *   label?: string,
 *   due_on: string,
 *   priority: number
 * }>} sorted by priority ascending (most urgent first)
 */
export function getDueReminders(goal, requirements, today, alreadyFired = []) {
  const deadline = coerceDate(goal?.deadline);
  const now = coerceDate(today);

  if (!deadline || !now) {
    throw new Error('[onward/reminder] goal.deadline and today are required');
  }

  const fired = new Set(Array.isArray(alreadyFired) ? alreadyFired : []);
  const reqs = Array.isArray(requirements) ? requirements : [];

  const outstanding = reqs.filter((r) => r && r.status !== 'done');

  const due = [];

  // --- Goal-level moments -------------------------------------------------
  // Only fire if there is something outstanding. A completed goal does
  // not need to be reminded about itself.
  //
  // Goal-level moments keep their start-of-day semantics: the moment
  // becomes due at 00:00 of the computed day, using the deadline's own
  // day in UTC. Per-item moments below do the same thing.
  if (outstanding.length > 0) {
    for (const m of GOAL_LEVEL_MOMENTS) {
      if (fired.has(m.kind)) continue;
      const fireOn = addDays(deadline, -m.offset_days);
      if (now.getTime() >= fireOn.getTime()) {
        due.push({
          kind: m.kind,
          due_on: toIsoDate(fireOn),
          priority: PRIORITY[m.kind] ?? 99,
        });
      }
    }
  }

  // --- Per-requirement request_by moments ---------------------------------
  for (const r of reqs) {
    if (!r || r.kind !== 'external_dependency') continue;
    if (r.status === 'done') continue;
    if (r.status === 'waiting_on_other') continue;

    const T = toNumber(r.typical_turnaround_days);
    if (T == null) continue;

    const kind = `request_by:${r.id}`;
    if (fired.has(kind)) continue;

    const fireOn = addDays(deadline, -(T + REQUEST_BY_BUFFER_DAYS));
    if (now.getTime() >= fireOn.getTime()) {
      due.push({
        kind,
        requirement_id: r.id,
        label: r.label,
        due_on: toIsoDate(fireOn),
        priority: PRIORITY.request_by,
      });
    }
  }

  // --- Per-task task_due moments ------------------------------------------
  // A self task with a due_at fires once, on its due date, at 00:00 UTC
  // of that day. If the task has a linked_requirement_id and that linked
  // item is already done, the reminder is suppressed — the task no longer
  // matters because what it depended on has arrived.
  for (const r of reqs) {
    if (!r || r.kind !== 'self_action') continue;
    if (r.status === 'done') continue;
    if (!r.due_at) continue;

    const kind = `task_due:${r.id}`;
    if (fired.has(kind)) continue;

    if (r.linked_requirement_id) {
      const linked = reqs.find((x) => x && x.id === r.linked_requirement_id);
      if (linked && linked.status === 'done') continue;
    }

    const dueAt = coerceDate(r.due_at);
    if (!dueAt) continue;

    const fireOn = new Date(Date.UTC(
      dueAt.getUTCFullYear(),
      dueAt.getUTCMonth(),
      dueAt.getUTCDate()
    ));

    if (now.getTime() >= fireOn.getTime()) {
      due.push({
        kind,
        requirement_id: r.id,
        label: r.label,
        due_on: toIsoDate(fireOn),
        priority: PRIORITY.task_due,
      });
    }
  }

  // Sort by priority ascending, then by due_on ascending (earlier first),
  // then by label for stable output when priorities tie.
  due.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.due_on !== b.due_on) return a.due_on < b.due_on ? -1 : 1;
    const al = String(a.label ?? '');
    const bl = String(b.label ?? '');
    return al.localeCompare(bl);
  });

  return due;
}

/**
 * Group due reminders by kind for the composer. Returns an object with
 * one entry per kind present, each holding the array of reminders of
 * that kind, in the original order.
 *
 * Example output:
 *   {
 *     request_by: [ { kind, requirement_id, label, ... }, ... ],
 *     seven_days_out: [ { kind, ... } ]
 *   }
 */
export function groupByKind(dueReminders) {
  const list = Array.isArray(dueReminders) ? dueReminders : [];
  const out = {};
  for (const r of list) {
    const k = kindRoot(r.kind);
    if (!out[k]) out[k] = [];
    out[k].push(r);
  }
  return out;
}

/**
 * Strip the ":<id>" suffix from a per-requirement kind, if present.
 * "request_by:abc" -> "request_by". "seven_days_out" -> "seven_days_out".
 */
export function kindRoot(kind) {
  if (typeof kind !== 'string') return '';
  const i = kind.indexOf(':');
  return i < 0 ? kind : kind.slice(0, i);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function toIsoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
  if (typeof input === 'string' || typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}