// Onward — tests for getDueReminders, focused on the task_due moment.
// Run with:  node --test
//
// A self_action item with its own due_at fires a task_due reminder on
// the calendar day of its due_at. The reminder is suppressed when it
// has already fired, when the item is done, or when its linked
// requirement has arrived.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getDueReminders, kindRoot } from './reminderService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Goal deadline is far enough away that none of the goal-level moments
// (seven_days_out, two_days_out, due_today, overdue) fire during the
// test window. We only want task_due to be exercised here.
function goal(overrides = {}) {
  return {
    id: 'g1',
    deadline: '2026-12-01',
    ...overrides,
  };
}

function selfTask(overrides = {}) {
  return {
    id: 'r-self-1',
    label: 'Call the school',
    kind: 'self_action',
    status: 'not_started',
    due_at: '2026-10-16',
    requested_at: null,
    received_at: null,
    typical_turnaround_days: null,
    linked_requirement_id: null,
    ...overrides,
  };
}

function extReq(overrides = {}) {
  return {
    id: 'r-ext-1',
    label: 'School report',
    kind: 'external_dependency',
    status: 'waiting_on_other',
    due_at: null,
    requested_at: '2026-10-14',
    received_at: null,
    typical_turnaround_days: 3,
    linked_requirement_id: null,
    ...overrides,
  };
}

function kindsOf(due) {
  return due.map((d) => d.kind);
}

// ---------------------------------------------------------------------------
// task_due fires on its due date
// ---------------------------------------------------------------------------

test('task_due fires on the day the task is due', () => {
  const r = selfTask();
  const today = new Date('2026-10-16T08:00:00Z');
  const due = getDueReminders(goal(), [r], today, []);
  assert.ok(kindsOf(due).includes(`task_due:${r.id}`), 'expected task_due to be due');
});

test('task_due has priority 2', () => {
  const r = selfTask();
  const today = new Date('2026-10-16T08:00:00Z');
  const due = getDueReminders(goal(), [r], today, []);
  const hit = due.find((d) => d.kind === `task_due:${r.id}`);
  assert.ok(hit);
  assert.equal(hit.priority, 2);
});

test('task_due fires after the fire-on moment (later in the same day)', () => {
  const r = selfTask();
  const today = new Date('2026-10-16T23:59:00Z');
  const due = getDueReminders(goal(), [r], today, []);
  assert.ok(kindsOf(due).includes(`task_due:${r.id}`));
});

// ---------------------------------------------------------------------------
// alreadyFired suppresses
// ---------------------------------------------------------------------------

test('task_due is suppressed when already fired', () => {
  const r = selfTask();
  const today = new Date('2026-10-16T08:00:00Z');
  const due = getDueReminders(goal(), [r], today, [`task_due:${r.id}`]);
  assert.ok(!kindsOf(due).includes(`task_due:${r.id}`), 'should not re-fire');
});

// ---------------------------------------------------------------------------
// linked_requirement_id done suppresses
// ---------------------------------------------------------------------------

test('task_due is suppressed when its linked requirement is done', () => {
  const linked = extReq({ id: 'r-ext-linked', status: 'done' });
  const r = selfTask({ linked_requirement_id: linked.id });
  const today = new Date('2026-10-16T08:00:00Z');
  const due = getDueReminders(goal(), [r, linked], today, []);
  assert.ok(
    !kindsOf(due).includes(`task_due:${r.id}`),
    'linked done should suppress'
  );
});

test('task_due still fires when its linked requirement is not done', () => {
  const linked = extReq({ id: 'r-ext-linked', status: 'waiting_on_other' });
  const r = selfTask({ linked_requirement_id: linked.id });
  const today = new Date('2026-10-16T08:00:00Z');
  const due = getDueReminders(goal(), [r, linked], today, []);
  assert.ok(kindsOf(due).includes(`task_due:${r.id}`), 'linked not done should not suppress');
});

// ---------------------------------------------------------------------------
// Does not fire before the due date
// ---------------------------------------------------------------------------

test('task_due does not fire before its due date', () => {
  const r = selfTask();
  const today = new Date('2026-10-15T12:00:00Z');
  const due = getDueReminders(goal(), [r], today, []);
  assert.ok(!kindsOf(due).includes(`task_due:${r.id}`), 'should not fire early');
});

// ---------------------------------------------------------------------------
// Sanity: kindRoot strips the id suffix
// ---------------------------------------------------------------------------

test('kindRoot("task_due:abc") === "task_due"', () => {
  assert.equal(kindRoot('task_due:abc'), 'task_due');
  assert.equal(kindRoot('task_due'), 'task_due');
});