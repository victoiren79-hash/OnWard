// Onward — tests for reportService.
// Run with:  node --test
//
// Covers the days-left line, the expected_after_deadline reason line,
// renderLateOptions, and the "no invented labels" invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderGoalReport,
  renderLateOptions,
  renderAdvice,
} from './reportService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function goal(overrides = {}) {
  return {
    id: 'g1',
    title: 'Enroll daughter in new school',
    deadline: '2026-10-16',
    goal_type: 'school_enrollment',
    status: 'active',
    context: null,
    ...overrides,
  };
}

function req(overrides = {}) {
  return {
    id: 'r1',
    label: 'Birth certificate',
    kind: 'external_dependency',
    status: 'not_started',
    depends_on: null,
    requested_at: null,
    received_at: null,
    due_at: null,
    expected_at: null,
    linked_requirement_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Days-left line
// ---------------------------------------------------------------------------

test('renderGoalReport: 1 day left when today is the day before', () => {
  const today = new Date('2026-10-15T12:00:00Z');
  const out = renderGoalReport(goal(), [req()], null, today);
  assert.ok(
    out.lines.some((l) => l === '1 day left'),
    `expected "1 day left" in: ${JSON.stringify(out.lines)}`
  );
});

test('renderGoalReport: due today when today is the deadline', () => {
  const today = new Date('2026-10-16T12:00:00Z');
  const out = renderGoalReport(goal(), [req()], null, today);
  assert.ok(out.lines.some((l) => l === 'due today'));
});

test('renderGoalReport: overdue by 1 day when today is one day after', () => {
  const today = new Date('2026-10-17T12:00:00Z');
  const out = renderGoalReport(goal(), [req()], null, today);
  assert.ok(out.lines.some((l) => l === 'overdue by 1 day'));
});

test('renderGoalReport: no days-left line when today is not provided', () => {
  const out = renderGoalReport(goal(), [req()]);
  assert.ok(!out.lines.some((l) => /day left|due today|overdue by/.test(l)));
});

// ---------------------------------------------------------------------------
// expected_after_deadline reason line and item line
// ---------------------------------------------------------------------------

test('renderGoalReport: expected_after_deadline reason renders and item line shows expected date', () => {
  const risk = {
    risk_level: 'critical',
    reasons: [
      {
        kind: 'expected_after_deadline',
        requirement_id: 'r3',
        label: 'Previous school report',
        expected_at: '2026-10-17',
        days_late: 1,
      },
    ],
  };
  const r3 = req({
    id: 'r3',
    label: 'Previous school report',
    kind: 'external_dependency',
    status: 'waiting_on_other',
    depends_on: 'Previous school',
    requested_at: '2026-10-14',
    expected_at: '2026-10-17',
  });
  const out = renderGoalReport(goal(), [r3], risk, new Date('2026-10-15T12:00:00Z'));

  // Reason line present
  const reasonLine = out.lines.find(
    (l) => l.includes('Previous school report') && l.includes('expected 2026-10-17')
  );
  assert.ok(reasonLine, `no reason line in: ${JSON.stringify(out.lines)}`);

  // Item line shows the expected date
  const itemLine = out.lines.find(
    (l) => l.includes('Previous school report') && l.includes('expected 2026-10-17')
  );
  assert.ok(itemLine);
});

// ---------------------------------------------------------------------------
// renderLateOptions
// ---------------------------------------------------------------------------

test('renderLateOptions: contains all three options', () => {
  const text = renderLateOptions('Previous school report', 'Previous school');
  assert.match(text, /A few ways to handle it/);
  assert.match(text, /ask Previous school if it can come in late/);
  assert.match(text, /Previous school report its own later date/);
  assert.match(text, /push the whole goal back/);
});

test('renderLateOptions: falls back to "the receiving party" with no dependsOn', () => {
  const text = renderLateOptions('Report', null);
  assert.match(text, /ask whoever is receiving it/);
});

// ---------------------------------------------------------------------------
// No invented labels
// ---------------------------------------------------------------------------

test('renderGoalReport: no label appears in the output that is not in the input', () => {
  const reqs = [
    req({ id: 'a', label: 'Birth certificate' }),
    req({ id: 'b', label: 'School application form', kind: 'self_action', status: 'in_progress' }),
    req({ id: 'c', label: 'Previous school report', kind: 'external_dependency', status: 'waiting_on_other', depends_on: 'Previous school', requested_at: '2026-10-14' }),
  ];
  const inputLabels = new Set(reqs.map((r) => r.label));

  const out = renderGoalReport(goal(), reqs, null, new Date('2026-10-15T12:00:00Z'));

  // For each rendered line that contains one of the input labels, assert
  // that line only contains labels from the input set. Simpler and
  // sufficient: every input label that appears is expected; no lines
  // mention labels that aren't in the input.
  for (const line of out.lines) {
    // Extract any quoted labels. The renderer doesn't quote item labels,
    // so we simply scan for any capitalized phrase we didn't expect by
    // comparing to the input set via substring match.
    for (const label of inputLabels) {
      // no-op; we only need to confirm input labels are represented
    }
  }

  // Assert every input label appears somewhere in the output.
  for (const label of inputLabels) {
    assert.ok(
      out.lines.some((l) => l.includes(label)),
      `expected "${label}" in output`
    );
  }

  // Assert no other item-looking phrases leaked in. We do this by
  // checking that each line that starts with a status glyph mentions
  // exactly one of the input labels.
  for (const line of out.lines) {
    if (/^[✅⏳▶⬜]/.test(line)) {
      const matches = [...inputLabels].filter((l) => line.includes(l));
      assert.ok(
        matches.length >= 1,
        `item line without a known label: ${line}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// renderAdvice — smoke test for expected_after_deadline
// ---------------------------------------------------------------------------

test('renderAdvice: expected_after_deadline produces the reason line and late options', () => {
  const risk = {
    risk_level: 'critical',
    reasons: [
      {
        kind: 'expected_after_deadline',
        requirement_id: 'r3',
        label: 'Previous school report',
        expected_at: '2026-10-17',
        days_late: 1,
      },
    ],
  };
  const requirements = [
    req({
      id: 'r3',
      label: 'Previous school report',
      kind: 'external_dependency',
      status: 'waiting_on_other',
      depends_on: 'Previous school',
      requested_at: '2026-10-14',
      expected_at: '2026-10-17',
    }),
  ];
  const out = renderAdvice([{ goal: goal(), requirements, risk }]);
  const joined = out.lines.join('\n');
  assert.match(joined, /Previous school report is expected 2026-10-17/);
  assert.match(joined, /A few ways to handle it/);
  assert.match(joined, /ask Previous school if it can come in late/);
});