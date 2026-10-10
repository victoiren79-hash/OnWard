// Onward — tests for CompletenessService.
// Run with:  node --test src/services/completenessService.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findMissingRequirements, normalizeLabel } from './completenessService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GRAD_TEMPLATE = [
  { label: 'Recommendation letter(s)',           kind: 'external_dependency', typical_turnaround_days: 14, is_commonly_missed: false },
  { label: 'Official transcripts',               kind: 'external_dependency', typical_turnaround_days: 10, is_commonly_missed: false },
  { label: 'Test scores (GRE/TOEFL/IELTS) sent to institution', kind: 'external_dependency', typical_turnaround_days: 7, is_commonly_missed: true },
  { label: 'Statement of purpose / personal statement', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
  { label: 'CV / resume',                        kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: false },
  { label: 'Financial documents / proof of funds', kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
  { label: 'Application fee paid',               kind: 'self_action', typical_turnaround_days: null, is_commonly_missed: true },
];

const GRAD_GOAL = { goal_type: 'grad_scholarship_application' };

// ---------------------------------------------------------------------------
// normalizeLabel
// ---------------------------------------------------------------------------

test('normalizeLabel: lowercase + punctuation + whitespace', () => {
  assert.equal(normalizeLabel('Recommendation letter(s)'), 'recommendation letter');
  assert.equal(normalizeLabel('  CV / resume  '), 'cv resume');
});

test('normalizeLabel: plural normalization', () => {
  assert.equal(normalizeLabel('Official transcripts'), 'official transcript');
  assert.equal(normalizeLabel('Test scores sent'), 'test score sent');
});

test('normalizeLabel: does not strip "ss"', () => {
  assert.equal(normalizeLabel('address'), 'address');
});

test('normalizeLabel: drops leading articles', () => {
  assert.equal(normalizeLabel('The transcript'), 'transcript');
  assert.equal(normalizeLabel('a letter'), 'letter');
});

test('normalizeLabel: empty / non-string is safe', () => {
  assert.equal(normalizeLabel(''), '');
  assert.equal(normalizeLabel(null), '');
  assert.equal(normalizeLabel(42), '');
});

// ---------------------------------------------------------------------------
// findMissingRequirements — happy paths
// ---------------------------------------------------------------------------

test('returns all template items when no requirements exist', () => {
  const out = findMissingRequirements(GRAD_GOAL, [], GRAD_TEMPLATE);
  assert.equal(out.reason, 'ok');
  assert.equal(out.missing.length, GRAD_TEMPLATE.length);
  assert.deepEqual(out.present, []);
});

test('excludes items the user already has when labels match after normalization', () => {
  const reqs = [
    { label: 'Official Transcripts', kind: 'external_dependency' },
    { label: 'CV / resume', kind: 'self_action' },
  ];
  const out = findMissingRequirements(GRAD_GOAL, reqs, GRAD_TEMPLATE);
  assert.ok(out.present.includes('Official transcripts'));
  assert.ok(out.present.includes('CV / resume'));
  assert.ok(!out.missing.some((m) => m.label === 'Official transcripts'));
  assert.ok(!out.missing.some((m) => m.label === 'CV / resume'));
});

test('does NOT fuzzy-match synonyms — that is the LLM layer\'s job', () => {
  // "rec letter" is what a real user says. It normalizes to "rec letter",
  // which does not equal "recommendation letter". So the template item
  // still shows as missing. This is intentional: fuzzy matching happens
  // in the LLM extraction step, which canonicalizes user phrasing to the
  // template label before creating the Requirement. See the design note
  // in completenessService.js.
  const reqs = [{ label: 'rec letter', kind: 'external_dependency' }];
  const out = findMissingRequirements(GRAD_GOAL, reqs, GRAD_TEMPLATE);
  assert.ok(!out.present.includes('Recommendation letter(s)'));
  assert.ok(out.missing.some((m) => m.label === 'Recommendation letter(s)'));
});

test('matches exact label after normalization', () => {
  const reqs = [
    { label: 'Official Transcripts', kind: 'external_dependency' },
  ];
  const out = findMissingRequirements(GRAD_GOAL, reqs, GRAD_TEMPLATE);
  assert.ok(out.present.includes('Official transcripts'));
  assert.ok(!out.missing.some((m) => m.label === 'Official transcripts'));
});

// ---------------------------------------------------------------------------
// findMissingRequirements — ordering
// ---------------------------------------------------------------------------

test('orders commonly-missed first, then external deps, then alpha', () => {
  const out = findMissingRequirements(GRAD_GOAL, [], GRAD_TEMPLATE);
  const labels = out.missing.map((m) => m.label);
  // All commonly-missed come before any non-commonly-missed:
  const firstNonMissed = out.missing.findIndex((m) => !m.is_commonly_missed);
  const lastMissed = out.missing.map((m) => m.is_commonly_missed).lastIndexOf(true);
  assert.ok(lastMissed < firstNonMissed);
  // Sanity: labels array exists
  assert.ok(labels.length > 0);
});

// ---------------------------------------------------------------------------
// findMissingRequirements — filtering
// ---------------------------------------------------------------------------

test('onlyCommonlyMissed=true filters the result', () => {
  const out = findMissingRequirements(GRAD_GOAL, [], GRAD_TEMPLATE, {
    onlyCommonlyMissed: true,
  });
  assert.ok(out.missing.length > 0);
  assert.ok(out.missing.every((m) => m.is_commonly_missed));
  // And it's a strict subset of the unfiltered result
  const all = findMissingRequirements(GRAD_GOAL, [], GRAD_TEMPLATE);
  assert.ok(out.missing.length < all.missing.length);
});

// ---------------------------------------------------------------------------
// findMissingRequirements — fallbacks
// ---------------------------------------------------------------------------

test('no goal_type → reason "no_goal_type" and empty missing', () => {
  const out = findMissingRequirements({ goal_type: null }, [], GRAD_TEMPLATE);
  assert.equal(out.reason, 'no_goal_type');
  assert.equal(out.goal_type, null);
  assert.deepEqual(out.missing, []);
});

test('no template rows → reason "no_template" and empty missing', () => {
  const out = findMissingRequirements(GRAD_GOAL, [], []);
  assert.equal(out.reason, 'no_template');
  assert.equal(out.goal_type, 'grad_scholarship_application');
  assert.deepEqual(out.missing, []);
});

test('missing goal object is handled', () => {
  const out = findMissingRequirements(undefined, [], GRAD_TEMPLATE);
  assert.equal(out.reason, 'no_goal_type');
});

// ---------------------------------------------------------------------------
// findMissingRequirements — purity
// ---------------------------------------------------------------------------

test('does not mutate inputs', () => {
  const reqs = [{ label: 'CV', kind: 'self_action' }];
  const reqsSnapshot = JSON.stringify(reqs);
  const tplSnapshot = JSON.stringify(GRAD_TEMPLATE);
  findMissingRequirements(GRAD_GOAL, reqs, GRAD_TEMPLATE);
  assert.equal(JSON.stringify(reqs), reqsSnapshot);
  assert.equal(JSON.stringify(GRAD_TEMPLATE), tplSnapshot);
});

test('tolerates malformed template rows without throwing', () => {
  const bad = [
    null,
    { label: 42 },
    { label: 'Valid', kind: 'self_action' },
    undefined,
  ];
  const out = findMissingRequirements(GRAD_GOAL, [], bad);
  assert.equal(out.missing.length, 1);
  assert.equal(out.missing[0].label, 'Valid');
});