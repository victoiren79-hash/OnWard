// Onward — tests for normalizeKind and the requirement state machine.
// Run with:  node --test
//
// Focus per the spec: normalizeKind maps the variants the LLM produces
// onto the two values the database accepts, and returns null for
// anything it cannot classify.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeKind,
  STATUSES,
  KINDS,
  canTransition,
  allowedNextStates,
  applyTransition,
} from './requirementService.js';

// ---------------------------------------------------------------------------
// normalizeKind — self_action variants
// ---------------------------------------------------------------------------

test('normalizeKind: "self" -> self_action', () => {
  assert.equal(normalizeKind('self'), 'self_action');
});

test('normalizeKind: "Self Action" -> self_action', () => {
  assert.equal(normalizeKind('Self Action'), 'self_action');
});

test('normalizeKind: "task" -> self_action', () => {
  assert.equal(normalizeKind('task'), 'self_action');
});

test('normalizeKind: "self_action" -> self_action (exact)', () => {
  assert.equal(normalizeKind('self_action'), 'self_action');
});

test('normalizeKind: "Self-Action" -> self_action (hyphen)', () => {
  assert.equal(normalizeKind('Self-Action'), 'self_action');
});

test('normalizeKind: "SELF  ACTION" -> self_action (case + whitespace)', () => {
  assert.equal(normalizeKind('SELF  ACTION'), 'self_action');
});

test('normalizeKind: other self synonyms', () => {
  for (const s of ['me', 'own', 'self_task', 'my_action']) {
    assert.equal(normalizeKind(s), 'self_action', `expected ${s} -> self_action`);
  }
});

// ---------------------------------------------------------------------------
// normalizeKind — external_dependency variants
// ---------------------------------------------------------------------------

test('normalizeKind: "external" -> external_dependency', () => {
  assert.equal(normalizeKind('external'), 'external_dependency');
});

test('normalizeKind: "External-Dependency" -> external_dependency', () => {
  assert.equal(normalizeKind('External-Dependency'), 'external_dependency');
});

test('normalizeKind: "third party" -> external_dependency', () => {
  assert.equal(normalizeKind('third party'), 'external_dependency');
});

test('normalizeKind: "external_dependency" -> external_dependency (exact)', () => {
  assert.equal(normalizeKind('external_dependency'), 'external_dependency');
});

test('normalizeKind: other external synonyms', () => {
  for (const s of ['other', 'others', 'third_party', 'dependency', 'external_dep', 'external_action']) {
    assert.equal(normalizeKind(s), 'external_dependency', `expected ${s} -> external_dependency`);
  }
});

// ---------------------------------------------------------------------------
// normalizeKind — invalid input
// ---------------------------------------------------------------------------

test('normalizeKind: "document" -> null', () => {
  assert.equal(normalizeKind('document'), null);
});

test('normalizeKind: "" -> null', () => {
  assert.equal(normalizeKind(''), null);
});

test('normalizeKind: null -> null', () => {
  assert.equal(normalizeKind(null), null);
});

test('normalizeKind: 42 -> null (non-string)', () => {
  assert.equal(normalizeKind(42), null);
});

test('normalizeKind: undefined -> null', () => {
  assert.equal(normalizeKind(undefined), null);
});

test('normalizeKind: object -> null', () => {
  assert.equal(normalizeKind({}), null);
});

test('normalizeKind: array -> null', () => {
  assert.equal(normalizeKind(['self']), null);
});

test('normalizeKind: whitespace-only string -> null', () => {
  assert.equal(normalizeKind('   '), null);
});

// ---------------------------------------------------------------------------
// Metadata sanity
// ---------------------------------------------------------------------------

test('STATUSES is frozen and complete', () => {
  assert.ok(Object.isFrozen(STATUSES));
  assert.deepEqual(STATUSES, ['not_started', 'in_progress', 'waiting_on_other', 'done']);
});

test('KINDS is frozen and complete', () => {
  assert.ok(Object.isFrozen(KINDS));
  assert.deepEqual(KINDS, ['self_action', 'external_dependency']);
});

// ---------------------------------------------------------------------------
// canTransition — matrix
// ---------------------------------------------------------------------------

test('canTransition: self_action cannot enter waiting_on_other', () => {
  assert.equal(canTransition('self_action', 'not_started', 'waiting_on_other'), false);
  assert.equal(canTransition('self_action', 'in_progress', 'waiting_on_other'), false);
});

test('canTransition: external_dependency can go straight to done (item arrived without a logged request)', () => {
  assert.equal(canTransition('external_dependency', 'not_started', 'done'), true);
  assert.equal(canTransition('external_dependency', 'in_progress', 'done'), true);
});

test('canTransition: external_dependency can enter waiting_on_other and leave it for done', () => {
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

test('allowedNextStates: external_dependency from not_started is [waiting_on_other, done]', () => {
  assert.deepEqual(allowedNextStates('external_dependency', 'not_started').sort(), [
    'done',
    'waiting_on_other',
  ]);
});

// ---------------------------------------------------------------------------
// applyTransition — happy paths
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
  const waiting = makeExternal({ status: 'waiting_on_other', requested_at: T0 });
  const result = applyTransition(waiting, 'done', { at: T2 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'done');
  assert.equal(result.next.received_at?.getTime(), T2.getTime());
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
// applyTransition — illegal transitions return { ok: false } (do not throw)
// ---------------------------------------------------------------------------

test('applyTransition: rejects waiting_on_other for self_action with ok:false', () => {
  const self = makeSelf({ status: 'in_progress' });
  const result = applyTransition(self, 'waiting_on_other', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /illegal transition/);
});

test('applyTransition: external not_started -> done sets received_at and leaves requested_at empty', () => {
  const ext = makeExternal();
  const result = applyTransition(ext, 'done', { at: T0 });
  assert.equal(result.ok, true);
  assert.equal(result.next.status, 'done');
  assert.equal(result.next.received_at?.getTime(), T0.getTime());
  assert.equal(result.next.requested_at, null);
});

test('applyTransition: rejects external not_started -> in_progress with ok:false', () => {
  const ext = makeExternal();
  const result = applyTransition(ext, 'in_progress', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /illegal transition/);
});

test('applyTransition: no-op returns ok:false', () => {
  const ext = makeExternal({ status: 'waiting_on_other', requested_at: T0 });
  const result = applyTransition(ext, 'waiting_on_other', { at: T1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no-op/);
});

test('applyTransition: unknown target status returns ok:false', () => {
  const result = applyTransition(makeSelf(), 'banana', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown target status/);
});

test('applyTransition: unknown current status returns ok:false', () => {
  const bogus = { ...makeSelf(), status: 'banana' };
  const result = applyTransition(bogus, 'in_progress', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown current status/);
});

test('applyTransition: unknown kind returns ok:false', () => {
  const bogus = { ...makeSelf(), kind: 'banana' };
  const result = applyTransition(bogus, 'in_progress', { at: T0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown kind/);
});

test('applyTransition: missing requirement returns ok:false', () => {
  const result = applyTransition(null, 'in_progress');
  assert.equal(result.ok, false);
  assert.match(result.reason, /requirement is required/);
});

test('applyTransition: missing id returns ok:false', () => {
  const noId = { kind: 'self_action', status: 'not_started' };
  const result = applyTransition(noId, 'in_progress');
  assert.equal(result.ok, false);
  assert.match(result.reason, /requirement\.id is required/);
});

test('applyTransition: received_at on self_action -> done returns ok:false', () => {
  const result = applyTransition(makeSelf(), 'done', {
    at: T0,
    receivedAt: T1,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /received_at is not applicable to self_action/);
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('applyTransition does not mutate the input requirement', () => {
  const input = makeExternal();
  const snapshot = JSON.stringify(input);
  applyTransition(input, 'waiting_on_other', { at: T0 });
  assert.equal(JSON.stringify(input), snapshot);
});

test('applyTransition returned dates are independent copies', () => {
  const r1 = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(r1.ok, true);
  r1.next.requested_at.setFullYear(1999);
  const r2 = applyTransition(makeExternal(), 'waiting_on_other', { at: T0 });
  assert.equal(r2.ok, true);
  assert.equal(r2.next.requested_at.getFullYear(), 2026);
});