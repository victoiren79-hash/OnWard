// Onward — tests for ReportService.
// Run with:  node --test src/services/reportService.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderGoalReport,
  renderRiskReport,
  renderActionReport,
} from './reportService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GOAL = {
  id: 'g1',
  title: 'Grad application — MIT',
  deadline: '2026-03-15',
  goal_type: 'grad_scholarship_application',
  status: 'active',
};

function req(overrides = {}) {
  return {
    id: overrides.id ?? 'r1',
    label: overrides.label ?? 'Recommendation letter',
    kind: overrides.kind ?? 'external_dependency',
    status: overrides.status ?? 'waiting_on_other',
    depends_on: overrides.depends_on ?? 'Prof. Lee',
    typical_turnaround_days: overrides.typical_turnaround_days ?? 10,
    requested_at: overrides.requested_at ?? '2026-03-01',
    received_at: overrides.received_at ?? null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderGoalReport
// ---------------------------------------------------------------------------

test('goal report: header shows title and deadline', () => {
  const out = renderGoalReport(GOAL, []);
  assert.match(out.lines[0], /Grad application — MIT/);
  assert.match(out.lines[0], /2026-03-15/);
});

test('goal report: empty requirements handled', () => {
  const out = renderGoalReport(GOAL, []);
  assert.ok(out.lines.some((l) => l === 'No requirements recorded yet.'));
  assert.deepEqual(out.data.items, []);
});

test('goal report: each requirement is one line with status glyph', () => {
  const reqs = [
    req({ id: 'a', label: 'Recommendation letter', status: 'waiting_on_other', depends_on: 'Prof. Lee', requested_at: '2026-03-01' }),
    req({ id: 'b', label: 'Transcript', kind: 'external_dependency', status: 'done', received_at: '2026-03-05' }),
    req({ id: 'c', label: 'Statement of purpose', kind: 'self_action', status: 'in_progress' }),
    req({ id: 'd', label: 'Application fee', kind: 'self_action', status: 'not_started' }),
  ];
  const out = renderGoalReport(GOAL, reqs);

  // All four labels present
  for (const label of ['Recommendation letter', 'Transcript', 'Statement of purpose', 'Application fee']) {
    assert.ok(out.lines.some((l) => l.includes(label)), `missing line for ${label}`);
  }

  // Glyphs match statuses
  assert.ok(out.lines.some((l) => l.startsWith('⏳ Recommendation letter')));
  assert.ok(out.lines.some((l) => l.startsWith('✅ Transcript')));
  assert.ok(out.lines.some((l) => l.startsWith('▶ Statement of purpose')));
  assert.ok(out.lines.some((l) => l.startsWith('⬜ Application fee')));

  // waiting line includes who and since when
  const wl = out.lines.find((l) => l.includes('Recommendation letter'));
  assert.match(wl, /waiting on someone/);
  assert.match(wl, /Prof\. Lee/);
  assert.match(wl, /requested 2026-03-01/);

  // done line includes received date
  const dl = out.lines.find((l) => l.includes('Transcript'));
  assert.match(dl, /\(2026-03-05\)/);
});

test('goal report: data.items mirrors the lines', () => {
  const reqs = [req({ id: 'a' })];
  const out = renderGoalReport(GOAL, reqs);
  assert.equal(out.data.items.length, 1);
  assert.equal(out.data.items[0].requirement_id, 'a');
  assert.equal(out.data.items[0].status, 'waiting_on_other');
  assert.equal(out.data.items[0].status_label, 'waiting on someone');
});

test('goal report: outstanding items render before done items', () => {
  const reqs = [
    req({ id: 'done', label: 'Transcript', status: 'done', received_at: '2026-03-05' }),
    req({ id: 'open', label: 'Recommendation letter', status: 'waiting_on_other' }),
  ];
  const out = renderGoalReport(GOAL, reqs);
  const idxOpen = out.lines.findIndex((l) => l.includes('Recommendation letter'));
  const idxDone = out.lines.findIndex((l) => l.includes('Transcript'));
  assert.ok(idxOpen < idxDone);
});

test('goal report: optional risk line appears when risk is provided', () => {
  const out = renderGoalReport(GOAL, [], { risk_level: 'at_risk' });
  assert.ok(out.lines.some((l) => l === 'Risk: at risk'));
  assert.equal(out.data.risk_level, 'at_risk');
});

test('goal report: rejects missing goal id', () => {
  assert.throws(() => renderGoalReport({}, []), /goal with id is required/);
});

// ---------------------------------------------------------------------------
// renderRiskReport
// ---------------------------------------------------------------------------

test('risk report: nothing at risk → clean message', () => {
  const out = renderRiskReport([
    { goal: GOAL, risk: { risk_level: 'ok', slack_days: 20, reasons: [] } },
    { goal: GOAL, risk: { risk_level: 'tight', slack_days: 4, reasons: [] } },
  ]);
  assert.deepEqual(out.lines, ['Nothing is at risk right now.']);
  assert.deepEqual(out.data.at_risk, []);
});

test('risk report: critical goal renders with reasons as bullets', () => {
  const risk = {
    risk_level: 'critical',
    slack_days: -1,
    critical_path_days: 13,
    reasons: [
      { kind: 'past_turnaround', requirement_id: 'r1', label: 'Recommendation letter', days_overdue: 3 },
      { kind: 'critical_path_driver', requirement_id: 'r2', label: 'Transcript', remaining_days: 10 },
    ],
  };
  const out = renderRiskReport([{ goal: GOAL, risk }]);

  assert.ok(out.lines.some((l) => l.includes('Grad application — MIT — critical')));
  assert.ok(out.lines.some((l) => l.includes('slack -1 days')));

  const bullets = out.lines.filter((l) => l.startsWith('  • '));
  assert.equal(bullets.length, 2);
  assert.match(bullets[0], /Recommendation letter is 3 days past its expected turnaround/);
  assert.match(bullets[1], /Transcript still needs ~10 days/);

  assert.equal(out.data.at_risk.length, 1);
  assert.equal(out.data.at_risk[0].risk_level, 'critical');
});

test('risk report: no_external_deps reason is suppressed as a bullet', () => {
  const risk = {
    risk_level: 'at_risk',
    slack_days: 1,
    critical_path_days: 3,
    reasons: [{ kind: 'no_external_deps' }],
  };
  const out = renderRiskReport([{ goal: GOAL, risk }]);
  const bullets = out.lines.filter((l) => l.startsWith('  • '));
  assert.equal(bullets.length, 0);
});

test('risk report: singular/plural handling in reasons', () => {
  const risk = {
    risk_level: 'critical',
    slack_days: -0.5,
    critical_path_days: 10,
    reasons: [
      { kind: 'past_turnaround', requirement_id: 'r1', label: 'Transcript', days_overdue: 1 },
      { kind: 'deadline_passed', days_over: 1 },
    ],
  };
  const out = renderRiskReport([{ goal: GOAL, risk }]);
  const bullets = out.lines.filter((l) => l.startsWith('  • '));
  assert.match(bullets[0], /Transcript is 1 day past/); // not "days"
  assert.match(bullets[1], /Deadline passed 1 day ago\./); // not "days"
});

// ---------------------------------------------------------------------------
// renderActionReport
// ---------------------------------------------------------------------------

test('action report: nothing outstanding → clean message', () => {
  const out = renderActionReport([
    { goal: GOAL, requirements: [req({ status: 'done', received_at: '2026-03-05' })], risk: { risk_level: 'ok' } },
  ]);
  assert.deepEqual(out.lines, ['Nothing outstanding right now.']);
  assert.deepEqual(out.data.goals, []);
});

test('action report: items ordered by status priority', () => {
  const reqs = [
    req({ id: 'a', label: 'Not started item', kind: 'self_action', status: 'not_started', depends_on: null, requested_at: null }),
    req({ id: 'b', label: 'Waiting item', status: 'waiting_on_other' }),
    req({ id: 'c', label: 'In progress item', kind: 'self_action', status: 'in_progress', depends_on: null, requested_at: null }),
  ];
  const out = renderActionReport([
    { goal: GOAL, requirements: reqs, risk: { risk_level: 'tight' } },
  ]);
  const iWaiting = out.lines.findIndex((l) => l.includes('Waiting item'));
  const iProgress = out.lines.findIndex((l) => l.includes('In progress item'));
  const iNotStarted = out.lines.findIndex((l) => l.includes('Not started item'));
  assert.ok(iWaiting < iProgress);
  assert.ok(iProgress < iNotStarted);
});

test('action report: goals ranked by risk level', () => {
  const goalB = { ...GOAL, id: 'g2', title: 'Visa application' };
  const goalC = { ...GOAL, id: 'g3', title: 'Grant application' };

  const out = renderActionReport([
    { goal: goalB, requirements: [req({ id: 'x' })], risk: { risk_level: 'tight' } },
    { goal: goalC, requirements: [req({ id: 'y' })], risk: { risk_level: 'critical' } },
    { goal: GOAL, requirements: [req({ id: 'z' })], risk: { risk_level: 'at_risk' } },
  ]);

  const idxCritical = out.lines.findIndex((l) => l.startsWith('Grant application —'));
  const idxAtRisk = out.lines.findIndex((l) => l.startsWith('Grad application — MIT —'));
  const idxTight = out.lines.findIndex((l) => l.startsWith('Visa application —'));
  assert.ok(idxCritical < idxAtRisk);
  assert.ok(idxAtRisk < idxTight);
});

test('action report: data.goals mirrors structure', () => {
  const reqs = [req({ id: 'a' })];
  const out = renderActionReport([
    { goal: GOAL, requirements: reqs, risk: { risk_level: 'at_risk' } },
  ]);
  assert.equal(out.data.goals.length, 1);
  assert.equal(out.data.goals[0].risk_level, 'at_risk');
  assert.equal(out.data.goals[0].outstanding.length, 1);
  assert.equal(out.data.goals[0].outstanding[0].requirement_id, 'a');
});

test('action report: skips goals with no requirements array', () => {
  const out = renderActionReport([
    { goal: GOAL, requirements: null, risk: { risk_level: 'ok' } },
    { goal: { ...GOAL, id: 'g2' }, requirements: [req({ id: 'x' })], risk: { risk_level: 'ok' } },
  ]);
  assert.equal(out.data.goals.length, 1);
  assert.equal(out.data.goals[0].goal_id, 'g2');
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('does not mutate inputs', () => {
  const reqs = [req({ id: 'a' })];
  const snapshot = JSON.stringify(reqs);
  renderGoalReport(GOAL, reqs);
  renderActionReport([{ goal: GOAL, requirements: reqs, risk: { risk_level: 'ok' } }]);
  assert.equal(JSON.stringify(reqs), snapshot);
});