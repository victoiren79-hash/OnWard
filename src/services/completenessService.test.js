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

test('applyTransition: self_action not_started -> in_progress', () => {
  const result = applyTransition(makeSelf(), 'in_progress', { at: T0 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'in_progress');
  assert.equal(result.next.requested_at, null);
  assert.equal(result.next.received_at, null);
});

test('applyTransition: self_action not_started -> done sets received_at = at', () => {
  const result = applyTransition(makeSelf(), 'done', { at: T1 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'done');
  assert.equal(result.next.received_at?.getTime(), T1.getTime());
});

test('applyTransition: external not_started -> waiting_on_other sets requested_at', () => {
  const result = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'waiting_on_other');
  assert.equal(result.next.requested_at?.getTime(), T0.getTime());
  assert.equal(result.next.received_at, null);
});

test('applyTransition: external waiting_on_other -> done sets received_at', () => {
  const waiting = makeExternal({
    status: 'waiting_on_other',
    requested_at: T0,
  });
  const result = applyTransition(waiting, 'done', { at: T2 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'done');
  assert.equal(result.next.received_at?.getTime(), T2.getTime());
  assert.equal(result.next.requested_at?.getTime(), T0.getTime());
});

test('applyTransition: external waiting_on_other -> in_progress clears the wait', () => {
  const waiting = makeExternal({
    status: 'waiting_on_other',
    requested_at: T0,
  });
  const result = applyTransition(waiting, 'in_progress', { at: T1 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'in_progress');
  assert.equal(result.next.requested_at?.getTime(), T0.getTime());
  assert.equal(result.next.received_at, null);
});

test('applyTransition: reopening a done item clears received_at', () => {
  const done = makeExternal({
    status: 'done',
    requested_at: T0,
    received_at: T2,
  });
  const result = applyTransition(done, 'waiting_on_other', { at: T2 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'waiting_on_other');
  assert.equal(result.next.received_at, null);
});

// ---------------------------------------------------------------------------
// applyTransition — illegal transitions now return, not throw
// ---------------------------------------------------------------------------

test('applyTransition: waiting_on_other -> done for self_action returns failure', () => {
  const self = makeSelf({ status: 'in_progress' });
  const result = applyTransition(self, 'waiting_on_other', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /illegal transition/);
  assert.equal(result.currentStatus, 'in_progress');
});

test('applyTransition: external not_started -> done returns failure with nearest', () => {
  const ext = makeExternal();
  const result = applyTransition(ext, 'done', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /illegal transition/);
  // Nearest legal for external not_started is waiting_on_other.
  assert.equal(result.nearestLegal, 'waiting_on_other');
});

test('applyTransition: no-op returns failure', () => {
  const ext = makeExternal({ status: 'waiting_on_other', requested_at: T0 });
  const result = applyTransition(ext, 'waiting_on_other', { at: T1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no-op/);
});

test('applyTransition: unknown target status returns failure', () => {
  const result = applyTransition(makeSelf(), 'banana', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown target status/);
});

test('applyTransition: unknown current status returns failure', () => {
  const bogus = { ...makeSelf(), status: 'banana' };
  const result = applyTransition(bogus, 'in_progress', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown current status/);
});

test('applyTransition: unknown kind returns failure', () => {
  const bogus = { ...makeSelf(), kind: 'banana' };
  const result = applyTransition(bogus, 'in_progress', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown kind/);
});

test('applyTransition: missing requirement returns failure', () => {
  const result = applyTransition(null, 'in_progress');
  assert.equal(result.ok, false);
  assert.match(result.reason, /requirement is required/);
});

test('applyTransition: missing id returns failure', () => {
  const noId = { kind: 'self_action', status: 'not_started' };
  const result = applyTransition(noId, 'in_progress');
  assert.equal(result.ok, false);
  assert.match(result.reason, /requirement\.id is required/);
});

test('applyTransition: received_at on self_action -> done returns failure', () => {
  const result = applyTransition(makeSelf(), 'done', {
    at: T0,
    receivedAt: T1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /received_at is not applicable to self_action/);
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
  const r1 = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(r1.ok, true);
  r1.next.requested_at.setFullYear(1999);

  const r2 = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(r2.ok, true);
  assert.equal(r2.next.requested_at.getFullYear(), 2026);
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