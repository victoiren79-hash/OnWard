// Onward — tests for completenessService.
// Run with:  node --test
//
// findMissingRequirements diffs a goal's current requirements against
// the GoalTypeTemplate rows for its type. Label matching goes through
// normalizeLabel so case, punctuation, whitespace, and simple plurals
// don't create false misses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findMissingRequirements,
  normalizeLabel,
} from './completenessService.js';

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
    ...overrides,
  };
}

function req(label, overrides = {}) {
  return {
    id: overrides.id ?? `r-${label.toLowerCase().replace(/\s+/g, '-')}`,
    label,
    kind: overrides.kind ?? 'self_action',
    status: overrides.status ?? 'not_started',
    ...overrides,
  };
}

function templateRow(label, overrides = {}) {
  return {
    label,
    kind: overrides.kind ?? 'self_action',
    typical_turnaround_days: overrides.typical_turnaround_days ?? null,
    is_commonly_missed: overrides.is_commonly_missed ?? false,
    priority: overrides.priority ?? 'helpful',
  };
}

// ---------------------------------------------------------------------------
// The spec's explicit ask
// ---------------------------------------------------------------------------

test('findMissingRequirements returns an essential template item that is not present', () => {
  const templates = [
    templateRow('Birth certificate', {
      kind: 'external_dependency',
      is_commonly_missed: true,
      priority: 'essential',
    }),
    templateRow('Immunization / vaccination records', {
      kind: 'external_dependency',
      is_commonly_missed: true,
      priority: 'essential',
    }),
  ];
  const present = [req('Birth certificate', { kind: 'external_dependency' })];

  const out = findMissingRequirements(goal(), present, templates);

  assert.equal(out.reason, 'ok');
  assert.equal(out.goal_type, 'school_enrollment');
  assert.equal(out.missing.length, 1);
  assert.equal(out.missing[0].label, 'Immunization / vaccination records');
  assert.equal(out.missing[0].priority, 'essential');
  assert.deepEqual(out.present, ['Birth certificate']);
});

// ---------------------------------------------------------------------------
// Reason cases
// ---------------------------------------------------------------------------

test('findMissingRequirements: no goal_type -> empty result with reason "no_goal_type"', () => {
  const out = findMissingRequirements(goal({ goal_type: null }), [], []);
  assert.equal(out.reason, 'no_goal_type');
  assert.equal(out.goal_type, null);
  assert.deepEqual(out.missing, []);
});

test('findMissingRequirements: no template rows -> reason "no_template"', () => {
  const out = findMissingRequirements(goal(), [], []);
  assert.equal(out.reason, 'no_template');
  assert.equal(out.goal_type, 'school_enrollment');
  assert.deepEqual(out.missing, []);
});

test('findMissingRequirements: all present -> reason "ok", missing is empty', () => {
  const templates = [templateRow('Birth certificate')];
  const present = [req('Birth certificate')];
  const out = findMissingRequirements(goal(), present, templates);
  assert.equal(out.reason, 'ok');
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.present, ['Birth certificate']);
});

// ---------------------------------------------------------------------------
// Label normalization — case, punctuation, plural, articles
// ---------------------------------------------------------------------------

test('findMissingRequirements: case-insensitive match', () => {
  const templates = [templateRow('Birth Certificate')];
  const present = [req('birth certificate')];
  const out = findMissingRequirements(goal(), present, templates);
  assert.deepEqual(out.missing, []);
});

test('findMissingRequirements: trailing punctuation is ignored', () => {
  const templates = [templateRow('Immunization records')];
  const present = [req('Immunization records!')];
  const out = findMissingRequirements(goal(), present, templates);
  assert.deepEqual(out.missing, []);
});

test('findMissingRequirements: slash and extra whitespace are ignored', () => {
  const templates = [templateRow('Immunization vaccination records')];
  const present = [req('Immunization / vaccination records')];
  const out = findMissingRequirements(goal(), present, templates);
  assert.deepEqual(out.missing, []);
});

test('findMissingRequirements: plural "s" is normalized', () => {
  const templates = [templateRow('Recommendation letter(s)')];
  const present = [req('Recommendation letters')];
  const out = findMissingRequirements(goal(), present, templates);
  assert.deepEqual(out.missing, []);
});

test('findMissingRequirements: leading article is dropped', () => {
  const templates = [templateRow('Birth certificate')];
  const present = [req('The Birth Certificate')];
  const out = findMissingRequirements(goal(), present, templates);
  assert.deepEqual(out.missing, []);
});

// ---------------------------------------------------------------------------
// Ordering — essential first, then commonly-missed, then external, then alpha
// ---------------------------------------------------------------------------

test('findMissingRequirements: essentials sort before helpful items', () => {
  const templates = [
    templateRow('Extra photo', { priority: 'helpful' }),
    templateRow('Birth certificate', { priority: 'essential' }),
  ];
  const out = findMissingRequirements(goal(), [], templates);
  assert.equal(out.missing[0].label, 'Birth certificate');
  assert.equal(out.missing[1].label, 'Extra photo');
});

test('findMissingRequirements: commonly-missed sorts before not', () => {
  const templates = [
    templateRow('A something', { priority: 'essential', is_commonly_missed: false }),
    templateRow('Z something', { priority: 'essential', is_commonly_missed: true }),
  ];
  const out = findMissingRequirements(goal(), [], templates);
  assert.equal(out.missing[0].label, 'Z something');
});

test('findMissingRequirements: externals sort before self actions', () => {
  const templates = [
    templateRow('Self task', { priority: 'essential', kind: 'self_action' }),
    templateRow('External task', { priority: 'essential', kind: 'external_dependency' }),
  ];
  const out = findMissingRequirements(goal(), [], templates);
  assert.equal(out.missing[0].label, 'External task');
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test('findMissingRequirements: onlyEssentials drops helpful items', () => {
  const templates = [
    templateRow('A', { priority: 'essential' }),
    templateRow('B', { priority: 'helpful' }),
  ];
  const out = findMissingRequirements(goal(), [], templates, { onlyEssentials: true });
  assert.deepEqual(out.missing.map((m) => m.label), ['A']);
});

test('findMissingRequirements: onlyHelpful drops essentials', () => {
  const templates = [
    templateRow('A', { priority: 'essential' }),
    templateRow('B', { priority: 'helpful' }),
  ];
  const out = findMissingRequirements(goal(), [], templates, { onlyHelpful: true });
  assert.deepEqual(out.missing.map((m) => m.label), ['B']);
});

test('findMissingRequirements: onlyCommonlyMissed drops the rest', () => {
  const templates = [
    templateRow('A', { is_commonly_missed: true }),
    templateRow('B', { is_commonly_missed: false }),
  ];
  const out = findMissingRequirements(goal(), [], templates, { onlyCommonlyMissed: true });
  assert.deepEqual(out.missing.map((m) => m.label), ['A']);
});

// ---------------------------------------------------------------------------
// normalizeLabel direct tests
// ---------------------------------------------------------------------------

test('normalizeLabel: lowercases and strips punctuation', () => {
  assert.equal(normalizeLabel('Birth Certificate!'), 'birth certificate');
});

test('normalizeLabel: strips parenthesized plural markers', () => {
  assert.equal(normalizeLabel('Recommendation letter(s)'), 'recommendation letter');
});

test('normalizeLabel: drops leading article', () => {
  assert.equal(normalizeLabel('The Birth Certificate'), 'birth certificate');
  assert.equal(normalizeLabel('A recommendation letter'), 'recommendation letter');
  assert.equal(normalizeLabel('An immunization record'), 'immunization record');
});

test('normalizeLabel: non-string returns empty string', () => {
  assert.equal(normalizeLabel(null), '');
  assert.equal(normalizeLabel(42), '');
  assert.equal(normalizeLabel(undefined), '');
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('findMissingRequirements does not mutate its inputs', () => {
  const templates = [templateRow('Birth certificate'), templateRow('Extra photo')];
  const present = [req('Birth certificate')];
  const snapshotT = JSON.stringify(templates);
  const snapshotP = JSON.stringify(present);
  findMissingRequirements(goal(), present, templates);
  assert.equal(JSON.stringify(templates), snapshotT);
  assert.equal(JSON.stringify(present), snapshotP);
});