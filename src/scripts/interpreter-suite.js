// Onward — offline interpreter acceptance suite.
//
// Runs 35 real phrasing cases against interpretTurn with a fixed state
// and a fixed clock. No database. No clock import. The only external
// dependency is the LLM, which is what we're testing.
//
// Usage (from the project root):
//   node .\src\scripts\interpreter-suite.js
//
// Output: one line per case, then a summary with pass count and timings.
// A case passes when the returned action list contains the expected tool
// with the expected args, and none of the forbidden tools appear.
//
// NOTE ON THROTTLING
// The Groq free tier limits tokens per minute (TPM) aggressively. The
// interpreter prompt is large, so back-to-back runs trip 429s. A small
// delay between cases gives the token bucket time to refill. Set
// GROQ_MODEL=openai/gpt-oss-20b in .env to reduce token usage; the
// smaller model has more headroom on the free tier.

import 'dotenv/config';
import { interpretTurn } from '../services/updateInterpreter.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const BETWEEN_CASES_MS = 1500;

// ---------------------------------------------------------------------------
// Fixed state
// ---------------------------------------------------------------------------

const TODAY = new Date('2026-10-15T12:00:00Z');

const FIXED_STATE = {
  goals: [
    {
      id: 'g1',
      title: 'Enroll daughter in new school',
      deadline: '2026-10-16',
      goal_type: 'school_enrollment',
      status: 'active',
      context: null,
      requirements: [
        {
          id: 'r1',
          label: 'Birth certificate',
          kind: 'external_dependency',
          status: 'done',
          depends_on: null,
          requested_at: null,
          received_at: '2026-10-10T12:00:00Z',
          due_at: null,
          expected_at: null,
          linked_requirement_id: null,
        },
        {
          id: 'r2',
          label: 'School application form',
          kind: 'self_action',
          status: 'not_started',
          depends_on: null,
          requested_at: null,
          received_at: null,
          due_at: null,
          expected_at: null,
          linked_requirement_id: null,
        },
        {
          id: 'r3',
          label: 'Previous school report',
          kind: 'external_dependency',
          status: 'waiting_on_other',
          depends_on: 'Previous school',
          requested_at: '2026-10-14T12:00:00Z',
          received_at: null,
          due_at: null,
          expected_at: null,
          linked_requirement_id: null,
        },
        {
          id: 'r4',
          label: 'Vaccination record',
          kind: 'external_dependency',
          status: 'not_started',
          depends_on: null,
          requested_at: null,
          received_at: null,
          due_at: null,
          expected_at: null,
          linked_requirement_id: null,
        },
        {
          id: 'r5',
          label: 'Passport photo',
          kind: 'self_action',
          status: 'not_started',
          depends_on: null,
          requested_at: null,
          received_at: null,
          due_at: null,
          expected_at: null,
          linked_requirement_id: null,
        },
      ],
    },
  ],
};

const TWO_GOAL_STATE = {
  goals: [
    FIXED_STATE.goals[0],
    {
      id: 'g2',
      title: 'Renew passport',
      deadline: '2026-12-05',
      goal_type: null,
      status: 'active',
      context: null,
      requirements: [
        {
          id: 'r6',
          label: 'Passport photo',
          kind: 'self_action',
          status: 'not_started',
          depends_on: null,
          requested_at: null,
          received_at: null,
          due_at: null,
          expected_at: null,
          linked_requirement_id: null,
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Cases
//
// expect.tool: a single tool name, or an array of acceptable tool names.
// expect.args: a predicate.
//   - If expect.tool is a single name: predicate receives the matched
//     action's .args object.
//   - If expect.tool is an array: predicate receives the whole actions
//     array (so cross-action checks are possible).
// expect.forbidden: array of tool names that must not appear.
// ---------------------------------------------------------------------------

const CASES = [
  {
    id: 1,
    phrase: 'I finished the application form',
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) => a.requirement_id === 'r2' && a.new_status === 'done',
    },
  },
  {
    id: 2,
    phrase: 'form done',
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) => a.requirement_id === 'r2' && a.new_status === 'done',
    },
  },
  {
    id: 3,
    phrase: 'I filled the form and took the passport photo',
    state: FIXED_STATE,
    expect: {
      tool: ['update_items', 'update_item'],
      args: (actions) => {
        const doneIds = new Set();
        for (const act of actions) {
          if (act.tool === 'update_items' && Array.isArray(act.args.updates)) {
            for (const u of act.args.updates) {
              if (u.new_status === 'done') doneIds.add(u.requirement_id);
            }
          }
          if (act.tool === 'update_item') {
            if (act.args.new_status === 'done') doneIds.add(act.args.requirement_id);
          }
        }
        return doneIds.has('r2') && doneIds.has('r5');
      },
    },
  },
  {
    id: 4,
    phrase: 'got the report from the previous school',
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) => a.requirement_id === 'r3' && a.new_status === 'done',
    },
  },
  {
    id: 5,
    phrase: 'I asked the clinic for the vaccination record',
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) =>
        a.requirement_id === 'r4' &&
        a.new_status === 'waiting_on_other' &&
        typeof a.depends_on === 'string' &&
        /clinic/i.test(a.depends_on),
    },
  },
  {
    id: 6,
    phrase: 'the school says the report takes 5 days',
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) => a.requirement_id === 'r3' && Number(a.turnaround_days) === 5,
    },
  },
  {
    id: 7,
    phrase: "the report can't come before Saturday",
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) => a.requirement_id === 'r3' && a.expected_at === '2026-10-17',
    },
  },
  {
    id: 8,
    phrase: "what's left?",
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => ['left', 'next'].includes(a.kind),
    },
  },
  {
    id: 9,
    phrase: 'how much time do I have?',
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => ['time', 'left', 'next'].includes(a.kind),
    },
  },
  {
    id: 10,
    phrase: 'am I going to make it?',
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => ['at_risk', 'time'].includes(a.kind),
    },
  },
  {
    id: 11,
    phrase: 'what should I do first?',
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => ['next', 'time'].includes(a.kind),
    },
  },
  {
    id: 12,
    phrase: 'what am I missing?',
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => a.kind === 'missing',
    },
  },
  {
    id: 13,
    phrase: 'what can I do about the report?',
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => a.kind === 'advice',
    },
  },
  {
    id: 14,
    phrase: 'remove the passport photo',
    state: FIXED_STATE,
    expect: {
      tool: 'delete_item',
      args: (a) => a.requirement_id === 'r5',
    },
  },
  {
    id: 15,
    phrase: 'I need a recommendation letter too',
    state: FIXED_STATE,
    expect: {
      tool: 'add_items',
      args: (a) =>
        Array.isArray(a.items) &&
        a.items.some((it) => /recommendation/i.test(it.label ?? '')),
    },
  },
  {
    id: 16,
    phrase: 'add proof of residence and a utility bill',
    state: FIXED_STATE,
    expect: {
      tool: 'add_items',
      args: (a) => Array.isArray(a.items) && a.items.length === 2,
    },
  },
  {
    id: 17,
    phrase: 'remind me tomorrow to call the school',
    state: FIXED_STATE,
    expect: {
      tool: 'add_items',
      args: (a) =>
        Array.isArray(a.items) &&
        a.items.some(
          (it) => it.kind === 'self_action' && it.due_at === '2026-10-16'
        ),
    },
  },
  {
    id: 18,
    phrase: "remind me tomorrow to check on the report if it hasn't come",
    state: FIXED_STATE,
    expect: {
      tool: 'add_items',
      args: (a) =>
        Array.isArray(a.items) &&
        a.items.some(
          (it) => it.due_at === '2026-10-16' && it.linked_requirement_id === 'r3'
        ),
    },
  },
  {
    id: 19,
    phrase: 'move the deadline to the 20th',
    state: FIXED_STATE,
    expect: {
      tool: 'set_new_deadline',
      args: (a) => a.new_deadline === '2026-10-20',
    },
  },
  {
    id: 20,
    phrase: "we're done, close this goal",
    state: FIXED_STATE,
    expect: {
      tool: 'complete_goal',
      args: (a) => a.goal_id === 'g1',
      forbidden: ['delete_goal'],
    },
  },
  {
    id: 21,
    phrase: 'delete the whole goal',
    state: FIXED_STATE,
    expect: {
      tool: 'delete_goal',
      args: (a) => a.goal_id === 'g1',
    },
  },
  {
    id: 22,
    phrase: 'draft a follow-up to the previous school',
    state: FIXED_STATE,
    expect: {
      tool: 'draft_followup',
      args: (a) => a.requirement_id === 'r3',
    },
  },
  {
    id: 23,
    phrase: 'I need to renew my passport by December 5',
    state: FIXED_STATE,
    expect: {
      tool: 'create_goal',
      args: (a) => a.deadline === '2026-12-05',
    },
  },
  {
    id: 24,
    phrase: 'yes',
    state: FIXED_STATE,
    expect: {
      tool: 'ask_user',
      forbidden: [
        'delete_goal',
        'delete_item',
        'delete_goal_confirmed',
        'delete_item_confirmed',
        'complete_goal',
      ],
    },
  },
  {
    id: 25,
    phrase: 'hello',
    state: FIXED_STATE,
    expect: {
      tool: 'ask_user',
    },
  },
  {
    id: 26,
    phrase: 'remove the photo and add a utility bill',
    state: FIXED_STATE,
    expect: {
      tool: ['delete_item', 'add_items'],
      args: (actions) => {
        const hasDelete = actions.some(
          (act) => act.tool === 'delete_item' && act.args.requirement_id === 'r5'
        );
        const hasAdd = actions.some(
          (act) =>
            act.tool === 'add_items' &&
            Array.isArray(act.args.items) &&
            act.args.items.some((it) => /utility/i.test(it.label ?? ''))
        );
        return hasDelete && hasAdd;
      },
    },
  },
  {
    id: 27,
    phrase: "form is done and I'm waiting on the clinic for the vaccine record",
    state: FIXED_STATE,
    expect: {
      tool: ['update_items', 'update_item'],
      args: (actions) => {
        const r2Done = actions.some(
          (act) =>
            (act.tool === 'update_item' &&
              act.args.requirement_id === 'r2' &&
              act.args.new_status === 'done') ||
            (act.tool === 'update_items' &&
              Array.isArray(act.args.updates) &&
              act.args.updates.some(
                (u) => u.requirement_id === 'r2' && u.new_status === 'done'
              ))
        );
        const r4Waiting = actions.some(
          (act) =>
            (act.tool === 'update_item' &&
              act.args.requirement_id === 'r4' &&
              act.args.new_status === 'waiting_on_other') ||
            (act.tool === 'update_items' &&
              Array.isArray(act.args.updates) &&
              act.args.updates.some(
                (u) =>
                  u.requirement_id === 'r4' &&
                  u.new_status === 'waiting_on_other'
              ))
        );
        return r2Done && r4Waiting;
      },
    },
  },
  {
    id: 28,
    phrase: "j'ai terminé le formulaire",
    state: FIXED_STATE,
    expect: {
      tool: 'update_item',
      args: (a) => a.requirement_id === 'r2' && a.new_status === 'done',
    },
  },
  {
    id: 29,
    phrase: 'il reste quoi à faire ?',
    state: FIXED_STATE,
    expect: {
      tool: 'query',
      args: (a) => ['left', 'next'].includes(a.kind),
    },
  },
  {
    id: 30,
    phrase: 'Coral Academy of Science',
    state: FIXED_STATE,
    pendingContext: {
      kind: 'ask_user',
      question: 'Which school is she going to?',
    },
    expect: {
      tool: 'note_context',
      forbidden: ['add_items', 'create_goal'],
    },
  },
  {
    id: 31,
    phrase: 'yes',
    state: FIXED_STATE,
    pendingContext: {
      kind: 'yes_no',
      question: 'Really delete "Passport photo"?',
      on_yes: {
        tool: 'delete_item_confirmed',
        args: { requirement_id: 'r5' },
      },
    },
    expect: {
      tool: 'delete_item_confirmed',
      args: (a) => a.requirement_id === 'r5',
    },
  },
  {
    id: 32,
    phrase: 'no wait, keep it',
    state: FIXED_STATE,
    pendingContext: {
      kind: 'yes_no',
      question: 'Really delete "Passport photo"?',
      on_yes: {
        tool: 'delete_item_confirmed',
        args: { requirement_id: 'r5' },
      },
    },
    expect: {
      tool: 'ask_user',
      forbidden: [
        'delete_item_confirmed',
        'delete_goal_confirmed',
        'delete_item',
        'delete_goal',
      ],
    },
  },
  {
    id: 33,
    phrase: 'mark the school goal as completed but keep the report as its own task',
    state: FIXED_STATE,
    expect: {
      tool: 'complete_goal',
      args: (a) =>
        a.goal_id === 'g1' &&
        Array.isArray(a.spin_off) &&
        a.spin_off.includes('r3'),
    },
  },
  {
    id: 34,
    phrase: 'I took the passport photo',
    state: TWO_GOAL_STATE,
    expect: {
      tool: 'ask_user',
    },
  },
  {
    id: 35,
    phrase: "what's left?",
    state: TWO_GOAL_STATE,
    expect: {
      tool: 'query',
      args: (a) => a.kind === 'left' || a.kind === 'next' || a.kind === 'list',
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check whether a set of returned actions satisfies a case's expectation.
 *
 *   - tool: single name or array of acceptable names.
 *   - args: predicate.
 *       * single-name tool: predicate receives the matched action's .args
 *       * list tool: predicate receives the whole actions array
 *   - forbidden: array of tool names that must not appear.
 */
function casePasses(actions, expect) {
  if (!Array.isArray(actions) || actions.length === 0) return false;

  // Tool presence.
  if (Array.isArray(expect.tool)) {
    if (!expect.tool.some((t) => actions.some((a) => a.tool === t))) return false;
  } else {
    if (!actions.some((a) => a.tool === expect.tool)) return false;
  }

  // Args predicate.
  if (typeof expect.args === 'function') {
    let argsOk = false;
    if (Array.isArray(expect.tool)) {
      // Cross-action predicate: pass the whole actions array.
      try {
        argsOk = expect.args(actions) === true;
      } catch {
        argsOk = false;
      }
    } else {
      // Single-tool predicate: try against each matching action's .args.
      const candidates = actions.filter((a) => a.tool === expect.tool);
      for (const c of candidates) {
        try {
          if (expect.args(c.args ?? {}) === true) {
            argsOk = true;
            break;
          }
        } catch {
          // try next
        }
      }
    }
    if (!argsOk) return false;
  }

  // Forbidden tools.
  if (Array.isArray(expect.forbidden)) {
    for (const a of actions) {
      if (expect.forbidden.includes(a.tool)) return false;
    }
  }

  return true;
}

function shortArgs(a) {
  if (!a || typeof a !== 'object') return '';
  const out = {};
  const keys = [
    'question',
    'requirement_id',
    'goal_id',
    'new_status',
    'new_deadline',
    'expected_at',
    'due_at',
    'turnaround_days',
    'depends_on',
    'kind',
  ];
  for (const k of keys) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  if (Array.isArray(a.items)) out.items = a.items.map((it) => it.label ?? '?');
  if (Array.isArray(a.updates)) out.updates = a.updates.length;
  if (Array.isArray(a.spin_off)) out.spin_off = a.spin_off;
  if (a.__retryable) out.__retryable = true;
  return JSON.stringify(out);
}

function summarize(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '(none)';
  return actions.map((a) => `${a.tool}(${shortArgs(a.args)})`).join(', ');
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

async function main() {
  const results = [];
  const timings = [];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const t0 = Date.now();
    let actions = [];
    let error = null;
    try {
      const out = await interpretTurn({
        userText: c.phrase,
        state: c.state,
        history: [],
        today: TODAY,
        pendingContext: c.pendingContext ?? null,
        pendingFlag: null,
      });
      actions = Array.isArray(out) ? out : [out];
    } catch (e) {
      error = e;
    }
    const ms = Date.now() - t0;
    timings.push(ms);

    if (error) {
      console.log(
        `FAIL  [${c.id}] "${c.phrase}"  ${summarize(actions)}  ${ms}ms  (error: ${error.message})`
      );
      results.push({ ok: false });
    } else {
      const ok = casePasses(actions, c.expect);
      const verdict = ok ? 'PASS' : 'FAIL';
      console.log(
        `${verdict}  [${c.id}] "${c.phrase}"  ${summarize(actions)}  ${ms}ms`
      );
      results.push({ ok });
    }

    if (i < CASES.length - 1) {
      await sleep(BETWEEN_CASES_MS);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const total = CASES.length;
  const med = median(timings);
  const slowest = timings.length === 0 ? 0 : Math.max(...timings);

  console.log('');
  console.log(`passed ${passed}/${total}, median ${med}ms, slowest ${slowest}ms`);
}

main().catch((e) => {
  console.error('interpreter-suite failed:', e);
  process.exit(1);
});