// Onward — tests for RiskService.
// Run with:  node --test src/services/riskService.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRisk, BUFFER_DAYS, THRESHOLDS } from './riskService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const D = (s) => new Date(s); // date helper
const iso = (s) => s;          // readable alias for date-only strings

function ext(overrides = {}) {
  return {
    id: overrides.id ?? 'ext-1',
    label: overrides.label ?? 'Recommendation letter',
    kind: 'external_dependency',
    status: overrides.status ?? 'waiting_on_other',
    typical_turnaround_days: overrides.typical_turnaround_days ?? 10,
    requested_at: overrides.requested_at ?? null,
    received_at: null,
    ...overrides,
  };
}

function self(overrides = {}) {
  return {
    id: overrides.id ?? 'self-1',
    label: overrides.label ?? 'Write SOP',
    kind: 'self_action',
    status: overrides.status ?? 'not_started',
    typical_turnaround_days: null,
    requested_at: null,
    received_at: null,
    ...overrides,
  };
}

const GOAL = (deadline) => ({ id: 'g1', deadline });

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test('S1: no requirements, deadline far away → ok, buffer-only critical path', () => {
  const out = computeRisk(GOAL(iso('2026-06-01')), [], D('2026-03-01'));
  assert.equal(out.risk_level, 'ok');
  assert.equal(out.critical_path_days, BUFFER_DAYS); // 0 external + buffer
  assert.equal(out.external_outstanding_count, 0);
  assert.ok(out.reasons.some((r) => r.kind === 'no_external_deps'));
});

test('S2: one external, not yet requested, plenty of time → ok', () => {
  const r = ext({ status: 'not_started', typical_turnaround_days: 10, requested_at: null });
  const out = computeRisk(GOAL(iso('2026-06-01')), [r], D('2026-03-01'));
  // critical path = 10 + 3 = 13; deadline ~92 days away; slack ~79
  assert.equal(out.risk_level, 'ok');
  assert.equal(out.critical_path_days, 13);
  assert.ok(out.slack_days > 70);
  assert.ok(out.reasons.some((r) => r.kind === 'critical_path_driver' && r.label === 'Recommendation letter'));
});

test('S3: one external requested today, tight but not broken → ok', () => {
  const r = ext({ typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  // deadline 20 days out, critical path = 10 + 3 = 13, slack = 7 → ok (>= 5)
  const out = computeRisk(GOAL(iso('2026-03-21')), [r], D('2026-03-01'));
  assert.equal(out.risk_level, 'ok');
  assert.equal(out.slack_days, 7);
});

test('S4: one external, slack in [2,5) → tight', () => {
  const r = ext({ typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  // deadline 17 days out: slack = 17 - 13 = 4 → tight
  const out = computeRisk(GOAL(iso('2026-03-18')), [r], D('2026-03-01'));
  assert.equal(out.risk_level, 'tight');
  assert.equal(out.slack_days, 4);
});

test('S5: one external, slack in [0,2) → at_risk', () => {
  const r = ext({ typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  // deadline 14 days out: slack = 14 - 13 = 1 → at_risk
  const out = computeRisk(GOAL(iso('2026-03-15')), [r], D('2026-03-01'));
  assert.equal(out.risk_level, 'at_risk');
  assert.equal(out.slack_days, 1);
});

test('S6: one external, slack < 0 → critical (path does not fit)', () => {
  const r = ext({ typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  // deadline 12 days out: slack = 12 - 13 = -1 → critical
  const out = computeRisk(GOAL(iso('2026-03-13')), [r], D('2026-03-01'));
  assert.equal(out.risk_level, 'critical');
  assert.ok(out.slack_days < 0);
});

test('S7: external item already past its turnaround → critical, regardless of slack', () => {
  const r = ext({
    typical_turnaround_days: 10,
    requested_at: D('2026-02-01'), // 28 days elapsed
  });
  // deadline is generous, slack would otherwise be ok — but the item is
  // 18 days overdue, so the level must be critical.
  const out = computeRisk(GOAL(iso('2026-06-01')), [r], D('2026-03-01'));
  assert.equal(out.risk_level, 'critical');
  const overdue = out.reasons.find((x) => x.kind === 'past_turnaround');
  assert.ok(overdue);
  assert.equal(overdue.requirement_id, 'ext-1');
  assert.equal(overdue.days_overdue, 18);
});

test('S8: multiple externals, critical path is the max, not the sum → ok', () => {
  const a = ext({ id: 'a', label: 'Transcript', typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  const b = ext({ id: 'b', label: 'Recommendation', typical_turnaround_days: 8, requested_at: D('2026-03-01') });
  const c = ext({ id: 'c', label: 'Test scores', typical_turnaround_days: 7, requested_at: D('2026-03-01') });
  // critical path = max(10,8,7) + 3 = 13; deadline 30 days out; slack 17 → ok
  const out = computeRisk(GOAL(iso('2026-03-31')), [a, b, c], D('2026-03-01'));
  assert.equal(out.risk_level, 'ok');
  assert.equal(out.critical_path_days, 13);
  // Only the max driver is listed as critical_path_driver.
  const drivers = out.reasons.filter((r) => r.kind === 'critical_path_driver');
  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].label, 'Transcript');
});

test('S9: deadline passed with outstanding items → critical + deadline_passed reason', () => {
  const r = self({ status: 'not_started' });
  const out = computeRisk(GOAL(iso('2026-02-25')), [r], D('2026-03-01'));
  assert.equal(out.risk_level, 'critical');
  const dp = out.reasons.find((x) => x.kind === 'deadline_passed');
  assert.ok(dp);
  assert.equal(dp.days_over, 4);
});

test('S10: all items done → critical path is buffer-only, no alarms', () => {
  const a = ext({ status: 'done', requested_at: D('2026-02-01'), typical_turnaround_days: 10 });
  const b = self({ status: 'done' });
  const out = computeRisk(GOAL(iso('2026-03-15')), [a, b], D('2026-03-01'));
  // No outstanding externals → critical path = BUFFER_DAYS
  assert.equal(out.critical_path_days, BUFFER_DAYS);
  assert.equal(out.outstanding_count, 0);
  assert.equal(out.risk_level, 'ok');
  assert.ok(out.reasons.some((r) => r.kind === 'no_external_deps'));
  assert.ok(!out.reasons.some((r) => r.kind === 'self_actions_outstanding'));
});

test('S11: self-actions outstanding are reported but do not drive the path', () => {
  const s1 = self({ id: 's1', label: 'Write SOP', status: 'in_progress' });
  const s2 = self({ id: 's2', label: 'Pay application fee', status: 'not_started' });
  const out = computeRisk(GOAL(iso('2026-04-01')), [s1, s2], D('2026-03-01'));
  // critical path = 0 external + 3 buffer = 3; deadline 31 days out; slack 28 → ok
  assert.equal(out.risk_level, 'ok');
  assert.equal(out.critical_path_days, BUFFER_DAYS);
  assert.equal(out.self_outstanding_count, 2);
  const sa = out.reasons.find((r) => r.kind === 'self_actions_outstanding');
  assert.ok(sa);
  assert.equal(sa.count, 2);
  assert.deepEqual(sa.labels.sort(), ['Pay application fee', 'Write SOP']);
});

test('S12: requested_at in the past reduces remaining turnaround (item close to done)', () => {
  const r = ext({
    typical_turnaround_days: 14,
    requested_at: D('2026-02-24'), // 5 days elapsed
  });
  // remaining = 14 - 5 = 9; critical path = 9 + 3 = 12; deadline 20 days out; slack 8 → ok
  const out = computeRisk(GOAL(iso('2026-03-21')), [r], D('2026-03-01'));
  assert.equal(out.critical_path_days, 12);
  assert.equal(out.slack_days, 8);
  assert.equal(out.risk_level, 'ok');
});

test('S13: threshold boundary — slack exactly 2 → tight (not at_risk)', () => {
  const r = ext({ typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  // deadline 15 days out: slack = 15 - 13 = 2 → tight (>= AT_RISK)
  const out = computeRisk(GOAL(iso('2026-03-16')), [r], D('2026-03-01'));
  assert.equal(out.slack_days, 2);
  assert.equal(out.risk_level, 'tight');
});

test('S14: threshold boundary — slack exactly 5 → ok', () => {
  const r = ext({ typical_turnaround_days: 10, requested_at: D('2026-03-01') });
  // deadline 18 days out: slack = 18 - 13 = 5 → ok
  const out = computeRisk(GOAL(iso('2026-03-19')), [r], D('2026-03-01'));
  assert.equal(out.slack_days, 5);
  assert.equal(out.risk_level, 'ok');
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('does not mutate inputs', () => {
  const r = ext({ requested_at: D('2026-03-01') });
  const reqs = [r];
  const snapshot = JSON.stringify(reqs);
  computeRisk(GOAL(iso('2026-04-01')), reqs, D('2026-03-01'));
  assert.equal(JSON.stringify(reqs), snapshot);
});

test('throws on missing deadline or today', () => {
  assert.throws(() => computeRisk({}, [], D('2026-03-01')), /deadline and today are required/);
  assert.throws(() => computeRisk(GOAL(iso('2026-04-01')), [], null), /deadline and today are required/);
});

test('exports are frozen and stable', () => {
  assert.ok(Object.isFrozen(THRESHOLDS));
  assert.equal(BUFFER_DAYS, 3);
  assert.equal(THRESHOLDS.AT_RISK, 2);
  assert.equal(THRESHOLDS.TIGHT, 5);
});