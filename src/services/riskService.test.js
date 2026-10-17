// Onward — tests for computeRisk.
// Run with:  node --test
//
// Fixed today: 2026-10-15T12:00:00Z unless a case says otherwise.
// Fixed goal deadline: 2026-10-16 unless a case says otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRisk, BUFFER_DAYS, THRESHOLDS } from './riskService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-10-15T12:00:00Z');

function goal(deadline = '2026-10-16') {
  return { id: 'g', deadline };
}

function ext(overrides = {}) {
  return {
    id: 'r-ext-1',
    label: 'School report',
    kind: 'external_dependency',
    status: 'waiting_on_other',
    requested_at: '2026-10-15',
    received_at: null,
    typical_turnaround_days: 3,
    due_at: null,
    expected_at: null,
    linked_requirement_id: null,
    ...overrides,
  };
}

function self(overrides = {}) {
  return {
    id: 'r-self-1',
    label: 'Fill the form',
    kind: 'self_action',
    status: 'not_started',
    requested_at: null,
    received_at: null,
    typical_turnaround_days: null,
    due_at: null,
    expected_at: null,
    linked_requirement_id: null,
    ...overrides,
  };
}

function reasonOf(risk, kind) {
  return (risk.reasons ?? []).find((r) => r.kind === kind) ?? null;
}

// ---------------------------------------------------------------------------
// R1 — one external waiting, on the eve of the deadline -> critical
// ---------------------------------------------------------------------------

test('R1: external waiting with 3-day turnaround on the eve -> critical', () => {
  const r = ext();
  const risk = computeRisk(goal('2026-10-16'), [r], TODAY);
  assert.equal(risk.risk_level, 'critical');
});

// ---------------------------------------------------------------------------
// R2 — R1 plus expected_at one day after the deadline -> critical, reason
// ---------------------------------------------------------------------------

test('R2: expected_at after the deadline -> critical with expected_after_deadline', () => {
  const r = ext({ expected_at: '2026-10-17' });
  const risk = computeRisk(goal('2026-10-16'), [r], TODAY);
  assert.equal(risk.risk_level, 'critical');
  const late = reasonOf(risk, 'expected_after_deadline');
  assert.ok(late, 'expected an expected_after_deadline reason');
  assert.equal(late.days_late, 1);
});

// ---------------------------------------------------------------------------
// R3 — R1 with item due_at and expected_at both 2026-10-17 -> at_risk
// ---------------------------------------------------------------------------

test('R3: item due_at and expected_at on 2026-10-17 -> at_risk, no late reason', () => {
  const r = ext({ due_at: '2026-10-17', expected_at: '2026-10-17' });
  const risk = computeRisk(goal('2026-10-16'), [r], TODAY);
  assert.equal(risk.risk_level, 'at_risk');
  assert.equal(reasonOf(risk, 'expected_after_deadline'), null);
});

// ---------------------------------------------------------------------------
// R4 — every item done -> ok, no reasons
// ---------------------------------------------------------------------------

test('R4: all items done -> ok, no reasons', () => {
  const r = ext({ status: 'done', received_at: '2026-10-15T09:00:00Z' });
  const risk = computeRisk(goal('2026-10-16'), [r], TODAY);
  assert.equal(risk.risk_level, 'ok');
  assert.deepEqual(risk.reasons, []);
});

// ---------------------------------------------------------------------------
// R5 — today after the deadline with an open self item -> critical + deadline_passed
// ---------------------------------------------------------------------------

test('R5: deadline passed with a not_started self item -> critical, first reason deadline_passed', () => {
  const lateToday = new Date('2026-10-18T12:00:00Z');
  const s = self();
  const risk = computeRisk(goal('2026-10-16'), [s], lateToday);
  assert.equal(risk.risk_level, 'critical');
  assert.equal(risk.reasons[0].kind, 'deadline_passed');
  assert.equal(risk.reasons[0].days_over, 2);
});

// ---------------------------------------------------------------------------
// R6 — self task overdue but goal far off -> tight + task_overdue
// ---------------------------------------------------------------------------

test('R6: self item due yesterday, goal weeks away -> tight with task_overdue', () => {
  const s = self({ due_at: '2026-10-14' });
  const risk = computeRisk(goal('2026-11-30'), [s], TODAY);
  assert.equal(risk.risk_level, 'tight');
  const overdue = reasonOf(risk, 'task_overdue');
  assert.ok(overdue, 'expected a task_overdue reason');
  assert.equal(overdue.days_over, 1);
});

// ---------------------------------------------------------------------------
// R7 — external not_started with a wide deadline -> ok
// ---------------------------------------------------------------------------

test('R7: external not_started with a wide deadline -> ok', () => {
  const r = ext({
    status: 'not_started',
    requested_at: null,
    typical_turnaround_days: 14,
  });
  const risk = computeRisk(goal('2026-11-30'), [r], TODAY);
  assert.equal(risk.risk_level, 'ok');
});

// ---------------------------------------------------------------------------
// Extra: exported constants
// ---------------------------------------------------------------------------

test('exports are frozen and stable', () => {
  assert.ok(Object.isFrozen(THRESHOLDS));
  assert.equal(BUFFER_DAYS, 3);
  assert.equal(THRESHOLDS.AT_RISK, 2);
  assert.equal(THRESHOLDS.TIGHT, 5);
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('does not mutate inputs', () => {
  const reqs = [ext({ expected_at: '2026-10-17' })];
  const snapshot = JSON.stringify(reqs);
  computeRisk(goal('2026-10-16'), reqs, TODAY);
  assert.equal(JSON.stringify(reqs), snapshot);
});

test('throws on missing deadline or today', () => {
  assert.throws(() => computeRisk({}, [], TODAY), /deadline and today are required/);
  assert.throws(() => computeRisk(goal(), [], null), /deadline and today are required/);
});