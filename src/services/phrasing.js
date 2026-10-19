// Onward — natural-language phrasing over deterministic data.
//
// Exports:
//   - phraseSuggestion(goal, essentials, helpful, opts)  → { text, items_mentioned }
//   - phraseBatchSuggestion(entries, opts)               → { text, per_goal }
//   - phraseCompletenessQuestion(missingItems)           → retained for
//                                                          compatibility
//   - phraseReport(reportData)                           → prose over a
//                                                          report
//   - phraseProactiveMessage(facts, momentKind)          → the reminder message
//
// None writes to the database. None invents facts.

import { callLLM, callLLMText } from '../llm.js';

// ---------------------------------------------------------------------------
// phraseSuggestion
//
// A single goal was just created. Write the message that comes right
// after. It should read like a competent colleague, not a form.
// ---------------------------------------------------------------------------

export async function phraseSuggestion(goal, essentials, helpful, opts = {}) {
  const essentialsList = Array.isArray(essentials) ? essentials : [];
  const helpfulList = Array.isArray(helpful) ? helpful : [];

  if (essentialsList.length === 0 && helpfulList.length === 0) {
    const text = await phraseEmptySuggestion(goal, opts);
    return { text, items_mentioned: [] };
  }

  const systemPrompt = [
    'You are Onward. The user just told you about a new goal.',
    '',
    'You are a calm, competent colleague who has seen this kind of goal',
    'before. You notice things. You raise them once, briefly, then stop.',
    '',
    'You are given:',
    '  - The goal title, goal type, and deadline.',
    '  - ESSENTIALS: items that MUST appear in your message, all of them.',
    '    Use their labels verbatim.',
    '  - HELPFUL: a pool of items that matter for SOME versions of this',
    '    goal. Pick at most one to raise. Do not raise two unless they are',
    '    obviously both needed. Do not raise any if none fit.',
    '  - Optionally, what the user originally said.',
    '',
    'Write one short paragraph, 2 to 3 sentences. Then one closing',
    'question or invitation, on its own line.',
    '',
    'RULES:',
    '- Name every ESSENTIAL item, verbatim, woven into a sentence. Do not',
    '  use bullet points.',
    '- Mention at most one HELPFUL item, and only if it fits this specific',
    '  goal. If you mention it, its label must appear in items_mentioned.',
    '- Do not invent items.',
    '- Do not use em-dashes or exclamation marks.',
    '- Do not promise capabilities you do not have. You cannot plan,',
    '  schedule, outline, or draft. Do not offer to.',
    '- Do not open with "Got it", "For this goal", "Noted", or "Understood".',
    '  Open with an observation, a question, or a concrete next step.',
    '- The closing must invite exactly one of:',
    '    (a) telling you which of the named items the user already has,',
    '    (b) saying yes to adding the named items to the checklist.',
    '  Pick whichever fits the tone you wrote. Vary between runs.',
    '',
    'Write 40 to 80 words of prose in "text". No bullets. No headers.',
    '',
    'RULES FOR items_mentioned:',
    '- It contains EXACTLY the item labels that appear in your prose, one',
    '  entry per label, verbatim from the input. Every essential is always',
    '  in here because every essential appears in the prose.',
    '- If a helpful item appears in the prose, it is in here too.',
    '- If you did not mention a helpful item, it is NOT in here.',
    '',
    'Return ONLY this JSON object:',
    '{',
    '  "text": string,',
    '  "items_mentioned": [ string ]',
    '}',
    '',
    'No prose outside the JSON. No code fences.',
  ].join('\n');

  const parts = [
    `Goal: ${JSON.stringify(goal.title ?? '')}`,
    goal.goal_type ? `Goal type: ${goal.goal_type}` : null,
    goal.deadline ? `Deadline: ${isoDate(goal.deadline)}` : null,
    opts.daysUntilDeadline != null
      ? `Days until deadline: ${opts.daysUntilDeadline}`
      : null,
    opts.userStatedGoal
      ? `Original user message: ${JSON.stringify(opts.userStatedGoal)}`
      : null,
    '',
    'ESSENTIALS (must all appear in prose and in items_mentioned):',
    essentialsList.length > 0
      ? essentialsList.map((e) => `  - ${e.label} (${e.kind})`).join('\n')
      : '  (none)',
    '',
    'HELPFUL (raise at most one; if named, add to items_mentioned):',
    helpfulList.length > 0
      ? helpfulList.map((h) => `  - ${h.label} (${h.kind})`).join('\n')
      : '  (none)',
  ].filter(Boolean);

  const userMessage = parts.join('\n');

  let raw;
  try {
    raw = await callLLM(systemPrompt, userMessage, { temperature: 0.7 });
  } catch (e) {
    console.warn('[onward/phrasing] phraseSuggestion LLM call failed:', e.message);
    return fallbackSuggestionResult(goal, essentialsList, helpfulList);
  }

  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) {
    return fallbackSuggestionResult(goal, essentialsList, helpfulList);
  }

  const text = raw.text.trim();

  const modelMentioned = Array.isArray(raw.items_mentioned)
    ? raw.items_mentioned.filter((x) => typeof x === 'string' && x.trim())
    : [];

  const allLabels = [
    ...essentialsList.map((e) => e.label),
    ...helpfulList.map((h) => h.label),
  ];
  const validLabels = new Set(allLabels);

  const finalMentioned = [];
  const seen = new Set();

  for (const m of modelMentioned) {
    if (validLabels.has(m) && !seen.has(m)) {
      finalMentioned.push(m);
      seen.add(m);
    }
  }

  const textLower = text.toLowerCase();
  for (const label of allLabels) {
    if (seen.has(label)) continue;
    if (textLower.includes(label.toLowerCase())) {
      finalMentioned.push(label);
      seen.add(label);
    }
  }

  for (const e of essentialsList) {
    if (!seen.has(e.label)) {
      finalMentioned.push(e.label);
      seen.add(e.label);
    }
  }

  return { text, items_mentioned: finalMentioned };
}

// ---------------------------------------------------------------------------
// phraseBatchSuggestion
//
// Several goals were created in one turn. Write ONE warm intro paragraph
// plus one short line per goal. The result should read like a person
// handing back a plan, not a system printing receipts.
//
// entries: [ { goal, essentials: [...], helpful: [...] }, ... ]
// opts:    { userStatedGoal?, daysUntilByGoal? }
//
// Returns: { text: string, per_goal: [ { goal_id, line, items_mentioned } ] }
// ---------------------------------------------------------------------------

export async function phraseBatchSuggestion(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return { text: '', per_goal: [] };
  }

  // If there's only one, defer to the single-goal writer for a cleaner
  // prompt.
  if (list.length === 1) {
    const e = list[0];
    const single = await phraseSuggestion(e.goal, e.essentials, e.helpful, {
      userStatedGoal: opts.userStatedGoal,
      daysUntilDeadline: e.daysUntilDeadline,
    });
    return {
      text: single.text,
      per_goal: [
        {
          goal_id: e.goal?.id ?? null,
          line: single.text,
          items_mentioned: single.items_mentioned,
        },
      ],
    };
  }

  const systemPrompt = [
    'You are Onward. The user just described several goals in one message.',
    'You are going to hand them back in a single, calm reply.',
    '',
    'Read all the goals. Find the shape of their day or week. Then write:',
    '',
    '  1. One opening paragraph. 1 to 2 sentences. It sets the frame: how',
    '     many things, and what unites or separates them (different days,',
    '     different kinds of urgency, one is quick and one is long).',
    '     No "Got it". No "Here you go". No bullets in the opening.',
    '',
    '  2. One short line per goal. Each line names the goal, its deadline',
    '     in plain words ("tomorrow", "today", "in five days"), and the',
    '     essentials for that goal, woven into a sentence. If a helpful',
    '     item fits, raise ONE. Do not use bullet points or numbers.',
    '     Keep each line to one sentence, under 40 words.',
    '',
    'RULES:',
    '- Do not use em-dashes or exclamation marks.',
    '- Do not promise capabilities you do not have.',
    '- Do not offer to plan, schedule, or outline.',
    '- Use item labels verbatim from the input.',
    '- Do not mention any item that is not in the input for that goal.',
    '- Second person throughout.',
    '- Vary your opening. Do not always start with "Three things" or',
    '  "Alright". Sometimes start with an observation about the shape.',
    '',
    'Return ONLY this JSON object:',
    '{',
    '  "text": string,',
    '  "per_goal": [',
    '    {',
    '      "goal_id": string,',
    '      "line": string,',
    '      "items_mentioned": [ string ]',
    '    }',
    '  ]',
    '}',
    '',
    'One entry in per_goal, in the same order as the goals below. Every',
    'essential item for that goal must appear in its "line" and in its',
    '"items_mentioned". No prose outside the JSON.',
  ].join('\n');

  const goalBlocks = list.map((e, i) => {
    const essentials = Array.isArray(e.essentials) ? e.essentials : [];
    const helpful = Array.isArray(e.helpful) ? e.helpful : [];
    const lines = [
      `Goal ${i + 1}:`,
      `  id: ${e.goal?.id ?? '(unknown)'}`,
      `  title: ${JSON.stringify(e.goal?.title ?? '')}`,
      e.goal?.goal_type ? `  goal_type: ${e.goal.goal_type}` : null,
      e.goal?.deadline ? `  deadline: ${isoDate(e.goal.deadline)}` : null,
      e.daysUntilDeadline != null
        ? `  days_until_deadline: ${e.daysUntilDeadline}`
        : null,
      '  ESSENTIALS (must appear verbatim in this goal\'s line):',
      essentials.length > 0
        ? essentials.map((x) => `    - ${x.label} (${x.kind})`).join('\n')
        : '    (none)',
      '  HELPFUL (raise at most one):',
      helpful.length > 0
        ? helpful.map((x) => `    - ${x.label} (${x.kind})`).join('\n')
        : '    (none)',
    ].filter(Boolean);
    return lines.join('\n');
  });

  const userMessage = [
    opts.userStatedGoal
      ? `Original user message:\n${JSON.stringify(opts.userStatedGoal)}`
      : null,
    '',
    'Goals, in order:',
    '',
    goalBlocks.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n');

  let raw;
  try {
    raw = await callLLM(systemPrompt, userMessage, { temperature: 0.7 });
  } catch (e) {
    console.warn('[onward/phrasing] phraseBatchSuggestion LLM call failed:', e.message);
    return fallbackBatchSuggestionResult(list);
  }

  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) {
    return fallbackBatchSuggestionResult(list);
  }

  const text = raw.text.trim();
  const perGoalRaw = Array.isArray(raw.per_goal) ? raw.per_goal : [];
  const byGoalId = new Map();
  for (const entry of perGoalRaw) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.goal_id !== 'string') continue;
    if (typeof entry.line !== 'string' || !entry.line.trim()) continue;
    if (!byGoalId.has(entry.goal_id)) {
      byGoalId.set(entry.goal_id, {
        line: entry.line.trim(),
        items_mentioned: Array.isArray(entry.items_mentioned)
          ? entry.items_mentioned.filter((x) => typeof x === 'string' && x.trim())
          : [],
      });
    }
  }

  const perGoal = list.map((e) => {
    const goalId = e.goal?.id ?? null;
    const found = goalId ? byGoalId.get(goalId) : null;
    if (found) {
      // Sanitize mentioned to the valid set for this goal.
      const valid = new Set([
        ...(e.essentials ?? []).map((x) => x.label),
        ...(e.helpful ?? []).map((x) => x.label),
      ]);
      const seen = new Set();
      const mentioned = [];
      for (const m of found.items_mentioned) {
        if (valid.has(m) && !seen.has(m)) { mentioned.push(m); seen.add(m); }
      }
      const lineLower = found.line.toLowerCase();
      for (const label of valid) {
        if (seen.has(label)) continue;
        if (lineLower.includes(label.toLowerCase())) {
          mentioned.push(label);
          seen.add(label);
        }
      }
      for (const ess of e.essentials ?? []) {
        if (!seen.has(ess.label)) { mentioned.push(ess.label); seen.add(ess.label); }
      }
      return { goal_id: goalId, line: found.line, items_mentioned: mentioned };
    }
    return fallbackSingleLineEntry(e);
  });

  return { text, per_goal: perGoal };
}

function fallbackSingleLineEntry(e) {
  const essentials = Array.isArray(e.essentials) ? e.essentials : [];
  const helpful = Array.isArray(e.helpful) ? e.helpful : [];
  const title = e.goal?.title ?? 'this goal';
  const deadline = e.goal?.deadline ? shortDeadline(e.goal.deadline) : '';
  const items = essentials.map((x) => x.label);
  const mentioned = [...items];

  let line = `${title}${deadline ? `, due ${deadline}` : ''}.`;
  if (items.length > 0) {
    line += ` You'll need ${joinWithAnd(items)}.`;
  } else if (helpful.length > 0) {
    line += ` Might be worth adding ${helpful[0].label}.`;
    mentioned.push(helpful[0].label);
  } else {
    line += ` Nothing standard to add.`;
  }

  return { goal_id: e.goal?.id ?? null, line, items_mentioned: mentioned };
}

function fallbackBatchSuggestionResult(list) {
  const goalLines = list.map(fallbackSingleLineEntry);
  const count = list.length;
  const intro = count === 1
    ? 'One thing, then.'
    : count === 2
      ? 'Two things, then.'
      : count === 3
        ? 'Three things, then.'
        : `A few things, then.`;

  return {
    text: intro,
    per_goal: goalLines,
  };
}

function shortDeadline(deadline) {
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const a = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const b = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = Math.round((b - a) / (24 * 60 * 60 * 1000));
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n > 1 && n <= 7) return `in ${n} days`;
  return `on ${isoDate(deadline)}`;
}

function joinWithAnd(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')}, and ${last}`;
}

// ---------------------------------------------------------------------------
// fallbackSuggestionResult — used only if the LLM fails for phraseSuggestion
// ---------------------------------------------------------------------------

function fallbackSuggestionResult(goal, essentials, helpful) {
  const mentioned = [];
  const bits = [];

  if (essentials.length > 0) {
    const items = essentials.map((e) => e.label);
    bits.push(`The usual essentials here are ${joinWithAnd(items)}.`);
    for (const label of items) mentioned.push(label);
  }
  if (helpful.length > 0 && essentials.length === 0) {
    const pick = helpful[0];
    bits.push(`You might also want ${pick.label}.`);
    mentioned.push(pick.label);
  }

  if (bits.length === 0) {
    bits.push(`Nothing standard I'd add here.`);
  }

  bits.push(`Tell me which of those you already have, or add anything else.`);

  return { text: bits.join(' '), items_mentioned: mentioned };
}

// ---------------------------------------------------------------------------
// phraseEmptySuggestion — nothing standard is missing
// ---------------------------------------------------------------------------

async function phraseEmptySuggestion(goal, opts = {}) {
  const systemPrompt = [
    'You are Onward. The user just told you about a goal that has all',
    'the usual items already.',
    '',
    'Write ONE short sentence that:',
    '  - acknowledges the goal is set up, without sounding canned',
    '  - invites the user to add anything they think of',
    '  - varies its phrasing between runs',
    '',
    'Do not use em-dashes or exclamation marks. Do not promise to plan,',
    'schedule, or draft. Return plain text only.',
  ].join('\n');

  const userMessage = [
    `Goal: ${JSON.stringify(goal.title ?? '')}`,
    goal.deadline ? `Deadline: ${isoDate(goal.deadline)}` : null,
    opts.daysUntilDeadline != null
      ? `Days until deadline: ${opts.daysUntilDeadline}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const text = await callLLMText(systemPrompt, userMessage, { temperature: 0.7 });
  return text.trim();
}

// ---------------------------------------------------------------------------
// phraseCompletenessQuestion
// ---------------------------------------------------------------------------

export async function phraseCompletenessQuestion(missingItems) {
  if (!Array.isArray(missingItems)) {
    throw new Error('[onward/phrasing] missingItems must be an array');
  }
  if (missingItems.length === 0) return null;

  const labels = missingItems.map((m) => m.label).filter(Boolean);
  if (labels.length === 0) return null;

  const systemPrompt = [
    'You phrase a short, natural clarifying question for a user who is',
    'setting up a goal. You are given a list of requirement labels the',
    'system thinks might be missing, and you write ONE question that asks',
    'the user about them.',
    '',
    'Rules:',
    '- Write a single question, in plain conversational English.',
    '- You may only mention items from the list. Do NOT invent items.',
    '- Do not number the items. Do not use a bullet list. Flow them into',
    '  a sentence.',
    '- If the list has more than 3 items, still name every one.',
    '- Do not add greetings, preamble, or sign-off. Just the question.',
    '- Keep it under 60 words.',
    '- Vary the opening — do not always start with "Do you have".',
    '',
    'Return ONLY the question as plain text.',
  ].join('\n');

  const userMessage = `Missing items:\n${labels.map((l) => `- ${l}`).join('\n')}`;
  const text = await callLLMText(systemPrompt, userMessage, { temperature: 0.4 });
  return text.trim();
}

// ---------------------------------------------------------------------------
// phraseReport
// ---------------------------------------------------------------------------

export async function phraseReport(reportData) {
  if (!reportData || typeof reportData !== 'object') {
    throw new Error('[onward/phrasing] reportData must be an object');
  }

  const { items, idToLabel } = collectItems(reportData);
  if (items.length === 0) {
    return 'Nothing to report yet.';
  }

  const systemPrompt = [
    'You rewrite a structured status report into a short, natural message',
    'for a user.',
    '',
    'You will be given a list of items, each with an id and a label, and',
    'additional structured facts about them.',
    '',
    'Rules:',
    '- You may ONLY reference items whose id appears in the list below.',
    '- Do NOT invent, rename, or paraphrase item labels. Use them verbatim.',
    '- Do NOT add items that are not in the list.',
    '- Do not summarize away items. Every item must appear in your output.',
    '- Plain conversational English. No bullet lists, no headers, no',
    '  numbering.',
    '- No greeting, no preamble, no sign-off. Keep it concise.',
    '',
    'After your prose, return a JSON object with this exact shape:',
    '{',
    '  "prose": string,',
    '  "referenced_ids": string[]',
    '}',
    '',
    'Return ONLY the JSON object. No prose outside it, no code fences.',
  ].join('\n');

  const userMessage =
    `Items:\n` +
    items
      .map((i) => `- id: ${i.id}\n  label: ${JSON.stringify(i.label)}\n  facts: ${JSON.stringify(i.facts)}`)
      .join('\n') +
    `\n\nReport context:\n${JSON.stringify(reportData, null, 2)}`;

  const raw = await callLLM(systemPrompt, userMessage, { temperature: 0.3 });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('output is not a JSON object', raw);
  }
  if (typeof raw.prose !== 'string' || !raw.prose.trim()) {
    throw invalid('"prose" must be a non-empty string', raw.prose);
  }
  if (!Array.isArray(raw.referenced_ids)) {
    throw invalid('"referenced_ids" must be an array', raw.referenced_ids);
  }

  for (const id of raw.referenced_ids) {
    if (typeof id !== 'string' || !idToLabel.has(id)) {
      throw invalid(`referenced id ${JSON.stringify(id)} is not in the input item list`, id);
    }
  }

  const dropped = items.filter((i) => !raw.referenced_ids.includes(i.id));
  if (dropped.length > 0) {
    throw invalid(
      `the report dropped ${dropped.length} item(s): ${dropped.map((d) => d.id).join(', ')}`,
      raw.referenced_ids
    );
  }

  return raw.prose.trim();
}

// ---------------------------------------------------------------------------
// phraseProactiveMessage
//
// The reminder message. Facts are computed deterministically upstream.
// The caller passes the moment kind that fired.
//
// Throws on LLM failure so the caller can fall back to the deterministic
// composer.
// ---------------------------------------------------------------------------

export async function phraseProactiveMessage(facts, momentKind = null, opts = {}) {
  if (!facts || typeof facts !== 'object') {
    throw new Error('[onward/phrasing] phraseProactiveMessage: facts must be an object');
  }

  const rootKind = momentKind ? String(momentKind).split(':')[0] : null;
  const framing = buildFramingForKind(rootKind);

  const systemPrompt = [
    'You are Onward. You text a busy person one quick heads-up about',
    'something with a deadline. Picture them glancing at their phone',
    'mid-task (cooking, driving, at work) — they read this in two',
    'seconds, not study it.',
    '',
    'You are given:',
    '  - moment_kind: what triggered this note.',
    '  - goal: title, deadline, days_until_deadline, risk_level.',
    '  - done: items the user has.',
    '  - waiting: items waiting on someone else.',
    '  - in_progress: items the user is working on.',
    '  - not_started: items on the goal not yet started.',
    '  - overdue: items past their expected turnaround.',
    '  - critical_path: items the timeline is waiting on.',
    '  - request_by_items: only when the moment is request_by.',
    '',
    'WHAT THIS MOMENT IS ABOUT:',
    framing,
    '',
    'RULES:',
    '- ONE short message. ONE paragraph, two sentences at most. No line',
    '  breaks, no headers like "Heads up", no colons introducing a list.',
    '- Lead with the single thing the user needs to know or do right',
    '  now — not every pending item, just the one (or two, max) that',
    '  matters for this moment.',
    '- Talk the way a sharp friend would text it, not the way a status',
    '  report would summarize it. Never say a goal "is at risk because"',
    '  — just say plainly what is going on and what to do.',
    '  Bad: "The scholarship application is at risk because the test',
    '  scores are still pending." Good: "Test scores for the',
    '  scholarship app are cutting it close — worth requesting today."',
    '- If an item label is long or technical (e.g. has an acronym or a',
    '  parenthetical), refer to it by its plain-English gist instead of',
    '  repeating the whole label. Say "your test scores", not the full',
    '  official label with every acronym and institution name attached.',
    '- Never reuse the wording from WHAT THIS MOMENT IS ABOVE verbatim —',
    '  it is background for you, not a sentence to output.',
    '- Do not use em-dashes, exclamation marks, or semicolons.',
    '- Do not reassure when work remains. Do not say "on track",',
    '  "looks good", "steady pace", "you\'re set", or "nothing to',
    '  worry about" if anything is outstanding.',
    '- Second person. No bullet points, no numbered lists, no status',
    '  labels like "waiting_on_other". Plain, spoken English.',
    '- Do not offer to do anything. Do not say "want me to". This is a',
    '  heads-up, not an offer.',
    '- Under 35 words total.',
    '',
    'Return plain text only. No JSON, no quotes, no preamble.',
  ].join('\n');

  const userMessage = JSON.stringify(
    {
      moment_kind: rootKind,
      goal: facts.goal,
      done: facts.done,
      waiting: facts.waiting,
      in_progress: facts.in_progress,
      not_started: facts.not_started,
      overdue: facts.overdue,
      critical_path: facts.critical_path,
      request_by_items: facts.request_by_items ?? undefined,
      due_tasks: facts.due_tasks ?? undefined,
    },
    null,
    2
  );

  const text = await callLLMText(systemPrompt, userMessage, {
    temperature: 0.7,
    reasoningEffort: 'low',
    signal: opts.signal,
  });
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('[onward/phrasing] phraseProactiveMessage: empty response');
  }
  return text.trim();
}

function buildFramingForKind(rootKind) {
  const lines = [];
  switch (rootKind) {
    case 'on_creation':
      lines.push('  You just started tracking this goal. One friendly line —');
      lines.push('  confirm it and, if there is something worth getting ahead');
      lines.push('  of, nudge toward it.');
      break;
    case 'request_by':
      lines.push('  Something that depends on another person needs to go out');
      lines.push('  soon, or the timeline gets tight. The point: ask for it now');
      lines.push('  rather than later. Name the item in plain words and the');
      lines.push('  rough timing, not a formal "request by" date if you can');
      lines.push('  help it.');
      break;
    case 'seven_days_out':
      lines.push('  About a week left. Mention that casually, then the one');
      lines.push('  thing most worth doing next.');
      break;
    case 'two_days_out':
      lines.push('  Two days left — this one should feel a bit more urgent');
      lines.push('  than a routine check-in. Say what still needs doing.');
      break;
    case 'due_today':
      lines.push('  It is due today. Say that plainly, then the one thing');
      lines.push('  still outstanding. No cheerleading.');
      break;
    case 'overdue':
      lines.push('  The deadline already passed. Say how long ago in passing');
      lines.push('  (e.g. "a couple days"), name what is still outstanding, and');
      lines.push('  mention they can say "extend to <date>" if they need a new');
      lines.push('  deadline.');
      break;
    case 'task_due':
      lines.push('  A task they said they would do is due today. Just name it');
      lines.push('  as a quick reminder, one sentence.');
      break;
    default:
      lines.push('  Nothing special about the timing — just a quick, plain');
      lines.push('  status note.');
      break;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function collectItems(reportData) {
  const items = [];
  const seen = new Set();

  const push = (id, label, facts) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push({ id, label, facts });
  };

  if (Array.isArray(reportData.items)) {
    for (const it of reportData.items) {
      push(it.requirement_id, it.label, {
        status: it.status,
        status_label: it.status_label,
        depends_on: it.depends_on,
        requested_at: it.requested_at,
        received_at: it.received_at,
      });
    }
  }

  if (Array.isArray(reportData.at_risk)) {
    for (const g of reportData.at_risk) {
      for (const r of g.reasons ?? []) {
        if (r.requirement_id) {
          push(r.requirement_id, r.label, {
            reason_kind: r.kind,
            days_overdue: r.days_overdue,
            remaining_days: r.remaining_days,
          });
        }
      }
    }
  }

  if (Array.isArray(reportData.goals)) {
    for (const g of reportData.goals) {
      for (const o of g.outstanding ?? []) {
        push(o.requirement_id, o.label, {
          status: o.status,
          depends_on: o.depends_on,
          requested_at: o.requested_at,
        });
      }
    }
  }

  if (Array.isArray(reportData.reports)) {
    for (const r of reportData.reports) {
      for (const it of r.items ?? []) {
        push(it.requirement_id, it.label, {
          status: it.status,
          status_label: it.status_label,
          depends_on: it.depends_on,
          requested_at: it.requested_at,
          received_at: it.received_at,
        });
      }
    }
  }

  const idToLabel = new Map(items.map((i) => [i.id, i.label]));
  return { items, idToLabel };
}

function invalid(what, got) {
  const err = new Error(
    `[onward/phrasing] Invalid LLM output: ${what}. Got: ${JSON.stringify(got)}`
  );
  err.code = 'PHRASING_INVALID';
  return err;
}

function isoDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}