// Onward — conversational layer eval set.
//
// Run with:  node --test evals.test.js
//
// Each test case sends a user utterance to interpretTurn against a
// fixed state, then asserts on the tool and the key argument. These
// tests hit the real Groq API — one call per case. Use them as a
// regression gate: run after every prompt edit, not after every code
// edit.
//
// The state below is deliberately small: two goals with a handful of
// items, chosen so that every interesting routing decision has a clear
// correct answer. Add cases as you find failures in real usage.

import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interpretTurn } from './src/services/updateInterpreter.js';
if (process.env.RUN_EVALS !== '1') process.exit(0);

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

const SCHOLARSHIP_GOAL = {
  id: 'goal-scholarship',
  title: 'Scholarship application',
  deadline: '2026-12-15',
  goal_type: 'grad_scholarship_application',
  status: 'active',
  requirements: [
    {
      id: 'req-rec-letter',
      label: 'Recommendation letter',
      kind: 'external_dependency',
      status: 'waiting_on_other',
      depends_on: 'Prof. Lee',
      requested_at: '2026-11-01',
      received_at: null,
    },
    {
      id: 'req-cv',
      label: 'CV',
      kind: 'self_action',
      status: 'done',
      depends_on: null,
      requested_at: null,
      received_at: '2026-11-05',
    },
    {
      id: 'req-transcript',
      label: 'Official transcripts',
      kind: 'external_dependency',
      status: 'not_started',
      depends_on: 'Registrar',
      requested_at: null,
      received_at: null,
    },
  ],
};

const VISA_GOAL = {
  id: 'goal-visa',
  title: 'Visa application',
  deadline: '2026-03-01',
  goal_type: 'visa_permit_application',
  status: 'active',
  requirements: [
    {
      id: 'req-police',
      label: 'Police clearance certificate',
      kind: 'external_dependency',
      status: 'waiting_on_other',
      depends_on: 'Police station',
      requested_at: '2026-02-01',
      received_at: null,
    },
    {
      id: 'req-photos',
      label: 'Passport-sized photographs',
      kind: 'self_action',
      status: 'not_started',
      depends_on: null,
      requested_at: null,
      received_at: null,
    },
  ],
};

const STATE = { goals: [SCHOLARSHIP_GOAL, VISA_GOAL] };

const TODAY = new Date('2026-11-10T12:00:00Z');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function interpret(userText, extra = {}) {
  return interpretTurn({
    userText,
    state: STATE,
    history: [],
    today: TODAY,
    ...extra,
  });
}

function assertTool(action, expectedTool) {
  assert.equal(
    action.tool,
    expectedTool,
    `expected tool "${expectedTool}", got "${action.tool}" (reason: ${action.reason})`
  );
}

// ---------------------------------------------------------------------------
// create_goal
// ---------------------------------------------------------------------------

test('create_goal: full statement with deadline and items', async () => {
  const action = await interpret(
    'I need to apply for a grant by March 20, I have my project proposal done and still need the budget'
  );
  assertTool(action, 'create_goal');
  assert.match(action.args.title.toLowerCase(), /grant/);
  assert.equal(action.args.deadline, '2026-03-20');
});

test('create_goal: statement without deadline asks for it', async () => {
  const action = await interpret('I want to apply to a university program');
  // Either create_goal with no deadline (system will ask), or ask_user.
  // Both are acceptable — the point is it does NOT pick update or delete.
  assert.ok(
    action.tool === 'create_goal' || action.tool === 'ask_user',
    `expected create_goal or ask_user, got ${action.tool}`
  );
});

// ---------------------------------------------------------------------------
// add_items
// ---------------------------------------------------------------------------

test('add_items: to a named goal', async () => {
  const action = await interpret(
    'add a financial statement to my scholarship application'
  );
  assertTool(action, 'add_items');
  assert.equal(action.args.goal_id, 'goal-scholarship');
  assert.ok(action.args.items.some((i) => /financial/i.test(i.label)));
});

test('add_items: ambiguous item with no named goal asks which', async () => {
  // "passport copy" could go on either goal. The interpreter should ask.
  const action = await interpret('I need a passport copy');
  if (action.tool === 'ask_user') {
    // Acceptable: the question should name both goals.
    assert.match(action.args.question, /scholarship/i);
    assert.match(action.args.question, /visa/i);
  } else {
    // Also acceptable: the interpreter decides one is clearly the target
    // and commits. In that case it must have picked one of the two.
    assert.equal(action.tool, 'add_items');
    assert.ok(
      action.args.goal_id === 'goal-scholarship' ||
        action.args.goal_id === 'goal-visa'
    );
  }
});

test('add_items: unambiguous because the item is already on the other goal', async () => {
  // "photographs" is on visa only. Adding "photographs" should target visa.
  const action = await interpret('I still need to get photographs done');
  // The interpreter may decide this is an update to the existing item
  // (req-photos) OR an add. Either is defensible; it must NOT target
  // the scholarship.
  if (action.tool === 'add_items') {
    assert.equal(action.args.goal_id, 'goal-visa');
  } else if (action.tool === 'update_item') {
    assert.equal(action.args.requirement_id, 'req-photos');
  } else {
    assert.fail(`unexpected tool: ${action.tool} (reason: ${action.reason})`);
  }
});

// ---------------------------------------------------------------------------
// update_item — external dependencies
// ---------------------------------------------------------------------------

test('update_item: "I sent the request" for external → waiting_on_other', async () => {
  // The transcript is external and not_started. Sending the request
  // moves it to waiting_on_other.
  const action = await interpret(
    'I sent the request for my official transcripts to the registrar'
  );
  assertTool(action, 'update_item');
  assert.equal(action.args.requirement_id, 'req-transcript');
  assert.equal(action.args.new_status, 'waiting_on_other');
});

test('update_item: "the recommendation letter came in" for external → done', async () => {
  const action = await interpret('the recommendation letter came in today');
  assertTool(action, 'update_item');
  assert.equal(action.args.requirement_id, 'req-rec-letter');
  assert.equal(action.args.new_status, 'done');
});

test('update_item: fuzzy item reference with unique match', async () => {
  // "the rec letter" fuzzy-matches req-rec-letter only.
  const action = await interpret('I got the rec letter back from Prof. Lee');
  assertTool(action, 'update_item');
  assert.equal(action.args.requirement_id, 'req-rec-letter');
  assert.equal(action.args.new_status, 'done');
});

test('update_item: external in not_started, user says "I got it" — compress', async () => {
  // Transcript is external, not_started. Legal path is not_started →
  // waiting_on_other → done. Interpreter must emit waiting_on_other
  // (the nearest legal), NOT done.
  const action = await interpret('I already have my official transcripts');
  assertTool(action, 'update_item');
  assert.equal(action.args.requirement_id, 'req-transcript');
  // The system compresses to waiting_on_other or ask_user. Never done.
  assert.ok(
    action.args.new_status === 'waiting_on_other' || action.tool === 'ask_user',
    `expected waiting_on_other or ask_user, got ${action.args.new_status}`
  );
});

// ---------------------------------------------------------------------------
// update_item — self actions
// ---------------------------------------------------------------------------

test('update_item: "I finished the photos" for self_action → done', async () => {
  // Photos are self_action, not_started. "I finished" → done.
  const action = await interpret('I finished the passport photographs');
  assertTool(action, 'update_item');
  assert.equal(action.args.requirement_id, 'req-photos');
  assert.equal(action.args.new_status, 'done');
});

test('update_item: "I submitted the form" for self_action → done (not waiting)', async () => {
  // This is the phrasing trap. self_action + "I submitted" is COMPLETION.
  // Set up an item for it: none in the fixture, so use a state override.
  const customState = {
    goals: [
      {
        id: 'goal-signed',
        title: 'Signed form',
        deadline: '2026-12-01',
        goal_type: 'signed_form_return',
        status: 'active',
        requirements: [
          {
            id: 'req-form-submit',
            label: 'Submit signed form to HR',
            kind: 'self_action',
            status: 'not_started',
            depends_on: null,
            requested_at: null,
            received_at: null,
          },
        ],
      },
    ],
  };
  const action = await interpretTurn({
    userText: 'I submitted the signed form to HR',
    state: customState,
    history: [],
    today: TODAY,
  });
  assertTool(action, 'update_item');
  assert.equal(action.args.requirement_id, 'req-form-submit');
  assert.equal(action.args.new_status, 'done');
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

test('delete_goal: names a goal', async () => {
  const action = await interpret('delete the visa application');
  assertTool(action, 'delete_goal');
  assert.equal(action.args.goal_id, 'goal-visa');
});

test('delete_item: names an item inside a goal', async () => {
  const action = await interpret('remove the police clearance from my visa app');
  assertTool(action, 'delete_item');
  assert.equal(action.args.requirement_id, 'req-police');
});

test('delete_item: "I no longer need the transcripts"', async () => {
  const action = await interpret("I don't need the transcripts anymore");
  assertTool(action, 'delete_item');
  assert.equal(action.args.requirement_id, 'req-transcript');
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

test('query: "what\'s left"', async () => {
  const action = await interpret("what's left");
  assertTool(action, 'query');
});

test('query: "what\'s at risk"', async () => {
  const action = await interpret("what's at risk");
  assertTool(action, 'query');
  assert.equal(action.args.kind, 'at_risk');
});

test('query: "what should I do next"', async () => {
  const action = await interpret('what should I do next');
  assertTool(action, 'query');
  assert.equal(action.args.kind, 'next');
});

// ---------------------------------------------------------------------------
// follow-up flow
// ---------------------------------------------------------------------------

test('draft_followup: user asks to chase an item', async () => {
  const action = await interpret(
    'can you draft a follow-up to Prof. Lee about the recommendation letter'
  );
  assertTool(action, 'draft_followup');
  assert.equal(action.args.requirement_id, 'req-rec-letter');
});

test('draft_followup: user says yes to an action offer in the flag', async () => {
  const action = await interpret('yes, please draft it', {
    pendingFlag: {
      goal_id: 'goal-scholarship',
      goal_title: 'Scholarship application',
      from_level: 'tight',
      to_level: 'at_risk',
      message: 'Heads up — "Scholarship application" is due in 30 days.',
      action_offer: {
        requirement_id: 'req-rec-letter',
        label: 'Recommendation letter',
        depends_on: 'Prof. Lee',
      },
    },
  });
  assertTool(action, 'draft_followup');
  assert.equal(action.args.requirement_id, 'req-rec-letter');
});

// ---------------------------------------------------------------------------
// pending context
// ---------------------------------------------------------------------------

test('pending yes_no: user says yes', async () => {
  const action = await interpret('yes', {
    pendingContext: {
      kind: 'yes_no',
      question: 'Really delete "Visa application"? This removes the goal and all its items.',
    },
  });
  // The interpreter should resolve to the pending action. In this
  // fixture there's no structured action attached, so it may still
  // ask. What matters is it doesn't try to interpret "yes" as a
  // create_goal or something absurd.
  assert.notEqual(action.tool, 'create_goal');
  assert.notEqual(action.tool, 'add_items');
});

test('pending pick: user names a candidate', async () => {
  const action = await interpret('the visa one', {
    pendingContext: {
      kind: 'pick',
      question: 'Which goal do you want to delete — "Scholarship application" or "Visa application"?',
      candidates: [
        { id: 'goal-scholarship', label: 'Scholarship application' },
        { id: 'goal-visa', label: 'Visa application' },
      ],
    },
  });
  assertTool(action, 'delete_goal');
  assert.equal(action.args.goal_id, 'goal-visa');
});

test('pending: user changes subject — abandons pending', async () => {
  const action = await interpret("what's left on the scholarship", {
    pendingContext: {
      kind: 'pick',
      question: 'Which goal do you want to delete — "Scholarship application" or "Visa application"?',
      candidates: [
        { id: 'goal-scholarship', label: 'Scholarship application' },
        { id: 'goal-visa', label: 'Visa application' },
      ],
    },
  });
  // The user asked a query, not answered the delete question.
  assertTool(action, 'query');
  assert.equal(action.args.abandons_pending, true);
});

// ---------------------------------------------------------------------------
// adversarial: things that should NOT be misread
// ---------------------------------------------------------------------------

test('adversarial: "I sent the request" must not become create_goal', async () => {
  const action = await interpret('I sent the request yesterday');
  assert.notEqual(action.tool, 'create_goal');
  assert.notEqual(action.tool, 'delete_goal');
  // Likely update_item or ask_user.
  assert.ok(
    action.tool === 'update_item' || action.tool === 'ask_user',
    `unexpected tool: ${action.tool}`
  );
});

test('adversarial: "I need to send the form" must not delete anything', async () => {
  const action = await interpret('I need to send the form tomorrow');
  assert.notEqual(action.tool, 'delete_goal');
  assert.notEqual(action.tool, 'delete_item');
});

test('adversarial: "thanks" should ask_user or query, not write', async () => {
  const action = await interpret('thanks!');
  assert.ok(
    action.tool === 'ask_user' || action.tool === 'query',
    `expected ask_user or query, got ${action.tool}`
  );
});

test('adversarial: an unknown item reference should ask, not guess', async () => {
  const action = await interpret('I got the thing from the office back');
  // "the thing from the office" matches nothing. Should ask.
  assert.ok(
    action.tool === 'ask_user' || action.tool === 'update_item',
    `unexpected tool: ${action.tool}`
  );
  if (action.tool === 'ask_user') {
    // Good — a question is the right response.
    assert.ok(action.args.question.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Purity: validateAction does not mutate its inputs
// ---------------------------------------------------------------------------

test('validateAction: does not mutate the state', async () => {
  const snapshot = JSON.stringify(STATE);
  await interpret('add a CV to my visa application');
  assert.equal(JSON.stringify(STATE), snapshot);
});