// Onward — tests for RequirementService.
// Run with:  node --test src/services/requirementService.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUSES,
  KINDS,
  canTransition,
  allowedNextStates,
  applyTransition,
} from './requirementService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSelf(overrides = {}) {
  return {
    id: 'r-self-1',
    kind: 'self_action',
    status: 'not_started',
    label: 'Write statement of purpose',
    requested_at: null,
    received_at: null,
    notes: null,
    ...overrides,
  };
}

function makeExternal(overrides = {}) {
  return {
    id: 'r-ext-1',
    kind: 'external_dependency',
    status: 'not_started',
    label: 'Recommendation letter',
    requested_at: null,
    received_at: null,
    notes: null,
    ...overrides,
  };
}

const T0 = new Date('2026-03-01T12:00:00Z');
const T1 = new Date('2026-03-03T12:00:00Z');
const T2 = new Date('2026-03-10T12:00:00Z');

// ---------------------------------------------------------------------------
// canTransition — matrix
// ---------------------------------------------------------------------------

test('canTransition: self_action cannot enter waiting_on_other', () => {
  assert.equal(canTransition('self_action', 'not_started', 'waiting_on_other'), false);
  assert.equal(canTransition('self_action', 'in_progress', 'waiting_on_other'), false);
});

test('canTransition: external_dependency cannot skip waiting_on_other to done', () => {
  assert.equal(canTransition('external_dependency', 'not_started', 'done'), false);
  assert.equal(canTransition('external_dependency', 'in_progress', 'done'), false);
});

test('canTransition: external_dependency must go through waiting_on_other', () => {
  assert.equal(canTransition('external_dependency', 'not_started', 'waiting_on_other'), true);
  assert.equal(canTransition('external_dependency', 'in_progress', 'waiting_on_other'), true);
  assert.equal(canTransition('external_dependency', 'waiting_on_other', 'done'), true);
});

test('canTransition: rejects unknown kinds and statuses', () => {
  assert.equal(canTransition('bogus', 'not_started', 'in_progress'), false);
  assert.equal(canTransition('self_action', 'bogus', 'in_progress'), false);
  assert.equal(canTransition('self_action', 'not_started', 'bogus'), false);
});

test('allowedNextStates: self_action from not_started is [in_progress, done]', () => {
  const next = allowedNextStates('self_action', 'not_started');
  assert.deepEqual(next.sort(), ['done', 'in_progress']);
});

test('allowedNextStates: external_dependency from not_started is [waiting_on_other]', () => {
  assert.deepEqual(allowedNextStates('external_dependency', 'not_started'), [
    'waiting_on_other',
  ]);
});

// ---------------------------------------------------------------------------
// applyTransition — happy paths
// ---------------------------------------------------------------------------

test('applyTransition: self_action not_started → in_progress', () => {
  const next = applyTransition(makeSelf(), 'in_progress', { at: T0 });
  assert.equal(next.status, 'in_progress');
  assert.equal(next.requested_at, null);
  assert.equal(next.received_at, null);
});

test('applyTransition: self_action not_started → done sets received_at = at', () => {
  const next = applyTransition(makeSelf(), 'done', { at: T1 });
  assert.equal(next.status, 'done');
  assert.equal(next.received_at?.getTime(), T1.getTime());
});

test('applyTransition: external_dependency not_started → waiting_on_other sets requested_at', () => {
  const next = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(next.status, 'waiting_on_other');
  assert.equal(next.requested_at?.getTime(), T0.getTime());
  assert.equal(next.received_at, null);
});

test('applyTransition: external_dependency waiting_on_other → done sets received_at', () => {
  const waiting = makeExternal({
    status: 'waiting_on_other',
    requested_at: T0,
  });
  const next = applyTransition(waiting, 'done', { at: T2 });
  assert.equal(next.status, 'done');
  assert.equal(next.received_at?.getTime(), T2.getTime());
  assert.equal(next.requested_at?.getTime(), T0.getTime()); // unchanged
});

test('applyTransition: external_dependency waiting_on_other → in_progress clears the wait', () => {
  const waiting = makeExternal({
    status: 'waiting_on_other',
    requested_at: T0,
  });
  const next = applyTransition(waiting, 'in_progress', { at: T1 });
  assert.equal(next.status, 'in_progress');
  // requested_at is preserved (we did send the request, the wait was just cancelled)
  assert.equal(next.requested_at?.getTime(), T0.getTime());
  assert.equal(next.received_at, null);
});

test('applyTransition: reopening a done item clears received_at', () => {
  const done = makeExternal({
    status: 'done',
    requested_at: T0,
    received_at: T2,
  });
  const next = applyTransition(done, 'waiting_on_other', { at: T2 });
  assert.equal(next.status, 'waiting_on_other');
  assert.equal(next.received_at, null);
});

// ---------------------------------------------------------------------------
// applyTransition — illegal transitions are rejected
// ---------------------------------------------------------------------------

test('applyTransition: rejects waiting_on_other → done for self_action', () => {
  const self = makeSelf({ status: 'in_progress' });
  assert.throws(
    () => applyTransition(self, 'waiting_on_other', { at: T0 }),
    /illegal transition.*waiting_on_other.*self_action/
  );
});

test('applyTransition: rejects external_dependency not_started → done (must wait first)', () => {
  const ext = makeExternal();
  assert.throws(
    () => applyTransition(ext, 'done', { at: T0 }),
    /illegal transition.*not_started.*done.*external_dependency/
  );
});

test('applyTransition: rejects no-op transitions', () => {
  const ext = makeExternal({ status: 'waiting_on_other', requested_at: T0 });
  assert.throws(
    () => applyTransition(ext, 'waiting_on_other', { at: T1 }),
    /no-op transition/
  );
});

test('applyTransition: rejects unknown target status', () => {
  assert.throws(
    () => applyTransition(makeSelf(), 'banana', { at: T0 }),
    /unknown target status "banana"/
  );
});

test('applyTransition: rejects unknown current status', () => {
  const bogus = { ...makeSelf(), status: 'banana' };
  assert.throws(
    () => applyTransition(bogus, 'in_progress', { at: T0 }),
    /unknown current status "banana"/
  );
});

test('applyTransition: rejects unknown kind', () => {
  const bogus = { ...makeSelf(), kind: 'banana' };
  assert.throws(
    () => applyTransition(bogus, 'in_progress', { at: T0 }),
    /unknown kind "banana"/
  );
});

test('applyTransition: rejects missing requirement', () => {
  assert.throws(
    () => applyTransition(null, 'in_progress'),
    /requirement is required/
  );
});

test('applyTransition: rejects missing id', () => {
  const noId = { kind: 'self_action', status: 'not_started' };
  assert.throws(
    () => applyTransition(noId, 'in_progress'),
    /requirement\.id is required/
  );
});

test('applyTransition: rejects received_at on self_action → done', () => {
  assert.throws(
    () => applyTransition(makeSelf(), 'done', { at: T0, receivedAt: T1 }),
    /received_at is not applicable to self_action/
  );
});

// ---------------------------------------------------------------------------
// applyTransition — purity
// ---------------------------------------------------------------------------

test('applyTransition: does not mutate the input requirement', () => {
  const input = makeExternal();
  const snapshot = JSON.stringify(input);
  applyTransition(input, 'waiting_on_other', { at: T0 });
  assert.equal(JSON.stringify(input), snapshot);
});

test('applyTransition: returned dates are independent copies', () => {
  const next = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  next.requested_at.setFullYear(1999);
  const again = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(again.requested_at.getFullYear(), 2026);
});

// ---------------------------------------------------------------------------
// Metadata sanity
// ---------------------------------------------------------------------------

test('STATUSES and KINDS are frozen and complete', () => {
  assert.ok(Object.isFrozen(STATUSES));
  assert.deepEqual(STATUSES, ['not_started', 'in_progress', 'waiting_on_other', 'done']);
  assert.ok(Object.isFrozen(KINDS));
  assert.deepEqual(KINDS, ['self_action', 'external_dependency']);
});