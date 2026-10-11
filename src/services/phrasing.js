// Onward — natural-language phrasing over deterministic data.
//
// Five functions:
//   - phraseSuggestion(goal, essentials, helpful, opts)  → { text, items_mentioned }
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
// ---------------------------------------------------------------------------

export async function phraseSuggestion(goal, essentials, helpful, opts = {}) {
  const essentialsList = Array.isArray(essentials) ? essentials : [];
  const helpfulList = Array.isArray(helpful) ? helpful : [];

  if (essentialsList.length === 0 && helpfulList.length === 0) {
    const text = await phraseEmptySuggestion(goal, opts);
    return { text, items_mentioned: [] };
  }

  const systemPrompt = [
    'You are Onward, an assistant for deadline-bound goals. The user just',
    'told you about a new goal. You are writing the message that comes',
    'right after the acknowledgement.',
    '',
    'Your job: help the user think of what this goal needs, without',
    'sounding like a form. You are a calm, competent person who has seen',
    'this kind of goal before. You notice things. You ask about them once',
    'and move on.',
    '',
    'You are given:',
    '  - The goal title, goal type, and deadline.',
    '  - ESSENTIALS: items that MUST appear in your message. Every one of',
    '    them. These are the items without which the goal cannot succeed.',
    '  - HELPFUL: a pool of items that matter for SOME versions of this',
    '    goal. Pick ZERO, ONE, or TWO of them — whichever fit the goal as',
    '    described. Do not pick all of them. Do not pick arbitrarily. Pick',
    '    the ones a thoughtful person would raise given the specific goal.',
    '  - Optionally, what the user originally said when creating the goal.',
    '',
    'RULES FOR THE PROSE:',
    '- Write ONE short message, 2 to 4 sentences.',
    '- You MUST name every item in ESSENTIALS. Do not skip any. Do not',
    '  rename them. Use their labels verbatim.',
    '- Weave the essentials in naturally. Do not write a bulleted list.',
    '- If helpful items are worth raising, mention one or two. Use their',
    '  labels verbatim.',
    '- Do NOT invent items not in ESSENTIALS or HELPFUL.',
    '- Vary your opening. Do not always start with "Got it" or "For this',
    '  goal". Rotate between: a factual note, a question, a mild',
    '  observation, a concrete next step.',
    '',
    '- ENDING. The ONLY two things you may invite the user to do are:',
    '    1. Tell you which of the named items they already have.',
    '    2. Say yes to adding the named items to their checklist.',
    '  Your closing question must map cleanly onto one of those two.',
    '  Good endings:',
    '    "Which of those do you already have?"',
    '    "Want me to add those to your checklist?"',
    '    "Tell me what you already have and I\'ll fill in the rest."',
    '  Bad endings — never write anything like these:',
    '    "Would you like me to outline a timeline?"',
    '    "Do you want help planning the next steps?"',
    '    "Shall I map out a schedule?"',
    '    "Want me to draft a plan?"',
    '  The system cannot plan, outline, schedule, or draft. Do not',
    '  promise capabilities it does not have.',
    '',
    '- Do not use em-dashes. Do not use exclamation marks.',
    '- Keep the tone warm but not effusive.',
    '',
    'RULES FOR items_mentioned:',
    '- This array must contain EVERY item label that appears anywhere in',
    '  the prose you write. Every one.',
    '- If you mention it in the prose, it must be in items_mentioned. If',
    '  you do not mention it in the prose, it must NOT be in',
    '  items_mentioned.',
    '- The essentials are always named, so they are always in the list.',
    '- If you named a helpful item in the prose, that helpful item must',
    '  also be in the list.',
    '- Use the labels verbatim from the input. Do not paraphrase.',
    '',
    'Return a JSON object with this exact shape:',
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
    'HELPFUL (pick 0-2 to mention; if mentioned, add to items_mentioned):',
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

function fallbackSuggestionResult(goal, essentials, helpful) {
  const parts = [];
  const mentioned = [];

  if (essentials.length > 0) {
    const labels = essentials.map((e) => e.label).join(', ');
    parts.push(`The essentials for this one are ${labels}.`);
    for (const e of essentials) mentioned.push(e.label);
  }
  if (helpful.length > 0) {
    const pick = helpful[0];
    parts.push(`You might also want ${pick.label}.`);
    mentioned.push(pick.label);
  }
  if (parts.length === 0) {
    parts.push(`Nothing else obvious to add. Anything you want me to track?`);
  } else {
    parts.push(`Tell me which of those you already have, or add anything else.`);
  }

  return { text: parts.join(' '), items_mentioned: mentioned };
}

// ---------------------------------------------------------------------------
// phraseEmptySuggestion
// ---------------------------------------------------------------------------

async function phraseEmptySuggestion(goal, opts = {}) {
  const systemPrompt = [
    'You are Onward. The user just told you about a goal that already has',
    'all the usual items. Nothing is missing.',
    '',
    'Write ONE short sentence that:',
    '  - acknowledges the goal is set up',
    '  - invites the user to add anything they think of',
    '  - varies its phrasing — do not use the same opening every time',
    '',
    'Return plain text only. No JSON, no quotes.',
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
// The caller passes the moment kind that fired so the message can lead
// with the right framing: a request_by leads with "you need to send the
// request by <date>", a seven_days_out leads with "one week left", and
// so on.
//
// Throws on LLM failure so the caller can fall back to the deterministic
// composer.
// ---------------------------------------------------------------------------

export async function phraseProactiveMessage(facts, momentKind = null) {
  if (!facts || typeof facts !== 'object') {
    throw new Error('[onward/phrasing] phraseProactiveMessage: facts must be an object');
  }

  const rootKind = momentKind ? String(momentKind).split(':')[0] : null;

  const framing = buildFramingForKind(rootKind);

  const systemPrompt = [
    'You are Onward, writing a short status note about a goal with a',
    'deadline. The user is busy. Read the facts and write them back in',
    'plain, natural language — as a person would, not as a form.',
    '',
    'You are given:',
    '  - moment_kind: what triggered this note. It is one of:',
    '      on_creation     — the goal was just created.',
    '      request_by      — it is time to request one or more external',
    '                        items that have a long turnaround, so they',
    '                        arrive before the deadline.',
    '      seven_days_out  — the deadline is one week away.',
    '      two_days_out    — the deadline is two days away.',
    '      due_today       — the deadline is today.',
    '      overdue         — the deadline has passed.',
    '  - goal: title, deadline, days_until_deadline, risk_level.',
    '  - done: items the user already has or has completed.',
    '  - waiting: items waiting on someone else, with depends_on and',
    '    requested_at where present.',
    '  - in_progress: items the user is actively working on.',
    '  - not_started: items on the goal that have not been started.',
    '  - overdue: items past their expected turnaround, with days_overdue.',
    '  - critical_path: items the timeline is currently waiting on, with',
    '    remaining_days.',
    '  - request_by_items: items the request_by moment is about. Only',
    '    present when moment_kind is request_by. Each has a label, the',
    '    turnaround in days, and the date by which the request needs to',
    '    go out.',
    '',
    'FRAMING FOR THIS MOMENT:',
    framing,
    '',
    'RULES:',
    '- Write 2 to 4 short paragraphs separated by blank lines.',
    '- Paragraph 1: name the goal and when it is due, then set the frame',
    '  based on the moment above. Follow the FRAMING FOR THIS MOMENT',
    '  section closely.',
    '- Paragraph 2: say what the user already has, then what is still',
    '  pending. Name EVERY item from done, waiting, in_progress, and',
    '  not_started. Use the labels verbatim.',
    '- For waiting items, say who it is waiting on and, when requested_at',
    '  is present, when it was requested. Write it the way a person would:',
    '  "you sent the request on Nov 1", not "requested_at: 2026-11-01".',
    '- For items with typical_turnaround_days, mention the turnaround only',
    '  if it is relevant to the deadline or to the request_by framing.',
    '- CLOSING LINE. Never reassure the user when work remains.',
    '    * If done is the only non-empty group — every item is done —',
    '      the closing may say the goal is set, or nothing is outstanding.',
    '    * If ANY of waiting, in_progress, or not_started has entries,',
    '      do NOT say "on track", "looks good", "steady pace", "you\'re',
    '      set", "nothing to worry about", or any other phrase that',
    '      implies the goal is fine. Instead, close with a short factual',
    '      note: name what is still pending, or state the deadline.',
    '      Tone is factual, not encouraging.',
    '    * Never write a closing line that contradicts the body above.',
    '- Vary your openings. Do not always start with "Heads up" or',
    '  "Quick note". Rotate.',
    '- Vary the sentence structure for the done group:',
    '    "You\'ve got X and Y ready." / "X and Y are done." /',
    '    "You\'re set on X and Y."',
    '- Vary how you say the pending group.',
    '- Second person throughout. No bullet points. No numbered lists. No',
    '  status labels like "waiting_on_other" or "in_progress". Use plain',
    '  English: "you\'re waiting on" / "you haven\'t started" /',
    '  "you\'re working on".',
    '- Do NOT mention any item that is not in the facts.',
    '- Do NOT offer to do anything. Do NOT say "want me to". The note is',
    '  informational. The user will act on it if they want to.',
    '- Keep it under 110 words.',
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
    },
    null,
    2
  );

  const text = await callLLMText(systemPrompt, userMessage, { temperature: 0.7 });
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('[onward/phrasing] phraseProactiveMessage: empty response');
  }
  return text.trim();
}

function buildFramingForKind(rootKind) {
  const lines = [];
  switch (rootKind) {
    case 'on_creation':
      lines.push('  The goal was just created. Open by acknowledging it and');
      lines.push('  naming what it will need. Keep it short; the user is');
      lines.push('  just getting started.');
      break;
    case 'request_by':
      lines.push('  This is a REQUEST-BY reminder. The items below take a long');
      lines.push('  time to arrive from someone else, and if the request does');
      lines.push('  not go out soon, they will not arrive before the deadline.');
      lines.push('  Lead with that. Say which items need to be requested and');
      lines.push('  when. Use a phrase like "you should send the request for');
      lines.push('  X by <date>". Do NOT use "today" unless the request-by');
      lines.push('  date is today or already past.');
      break;
    case 'seven_days_out':
      lines.push('  One week remains. State that plainly and name what is');
      lines.push('  still to be done.');
      break;
    case 'two_days_out':
      lines.push('  Two days remain. The tone should be more urgent but');
      lines.push('  still factual. Name what is left.');
      break;
    case 'due_today':
      lines.push('  The deadline is today. Say so plainly. Name what is');
      lines.push('  still outstanding. No reassurance.');
      break;
    case 'overdue':
      lines.push('  The deadline has passed. State how many days ago. Name');
      lines.push('  what is still outstanding. End by noting that the user');
      lines.push('  can say "extend to <new date>" to set a new deadline, or');
      lines.push('  "continue" to leave it as is.');
      break;
    default:
      lines.push('  No special framing. Write a plain status note.');
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