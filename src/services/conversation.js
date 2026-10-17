// Onward — conversation helpers.
//
// Everything that makes Onward sound and behave like a person lives here:
//
//   - classifyReply / classifySmallTalk   forgiving yes/no and greeting detection
//   - friendlyDate                        "tomorrow", "Friday", "Oct 23"
//   - pick / joinWithAnd                  small voice helpers
//   - suggestRequirements                 ONE LLM call that suggests what is
//                                         missing for any number of goals, typed
//                                         or not (no template needed)
//   - resolveDeadlinesReply               reads a reply like "Friday, and the
//                                         bill is tonight" against a list of
//                                         goals that were missing a date
//   - phraseAnswer                        turns report data into something you
//                                         would say out loud
//
// None of these write to the database.

import { callLLM, callLLMText } from '../llm.js';
import { normalizeLabel } from './completenessService.js';

// ---------------------------------------------------------------------------
// Small voice helpers
// ---------------------------------------------------------------------------

export function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

export function joinWithAnd(items) {
  const list = (items ?? []).filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Forgiving yes / no / greeting / thanks detection
//
// The old fast path only matched a handful of exact strings, so "yes please",
// "yeah do it" or "sounds good" fell through to the LLM. This version looks at
// every word: a reply counts as yes (or no) only when ALL its words are
// yes-ish (or no-ish) and it is short. "yes but change the date" is neither,
// and goes to the interpreter like any other message.
// ---------------------------------------------------------------------------

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[^a-z0-9\u00e0-\u00ff'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const YES_STRONG = new Set([
  'yes', 'y', 'yeah', 'yep', 'yup', 'yea', 'ya', 'yah', 'ok', 'okay', 'k', 'kk',
  'sure', 'absolutely', 'definitely', 'confirm', 'confirmed', 'perfect', 'fine',
  'alright', 'correct', 'exactly', 'go', 'do', 'sounds', 'works', 'right',
  'cool', 'great', 'please', 'pls', 'affirmative', 'course', 'totally',
  'oui', 'ouais', 'ouaip', "d'accord", 'dac', 'volontiers', 'vas-y', 'allez-y',
  'carrément', 'parfait', 'bien',
]);
const YES_FILLER = new Set([
  'please', 'pls', 'thanks', 'thank', 'you', 'thx', 'it', 'that', 'this', 'them',
  'those', 'all', 'do', 'go', 'ahead', 'for', 'me', 'sounds', 'good', 'great',
  'works', 'let', "let's", 'lets', 'now', 'then', 'and', 'of', 'course', 'sure',
  'i', 'think', 'so', 'yes', 'yeah', 'yep', 'ok', 'okay', 'right', 'the', 'one',
  'sûr', 'sur', 'merci', 'y', 'bien', 'allez', 'vas', 'on', 'fait',
  'la', 'le', 'les', 'ça', 'ca', 'marche', 'totally', 'absolutely',
]);

const NO_STRONG = new Set([
  'no', 'n', 'nope', 'nah', 'never', 'cancel', 'stop', "don't", 'dont', 'non',
  'nan', 'nevermind', 'negative', 'wait', 'leave', 'forget', 'nvm',
]);
const NO_FILLER = new Set([
  'no', 'nope', 'nah', 'please', 'pls', 'thanks', 'thank', 'you', 'thx', 'it',
  'that', 'this', 'them', 'mind', 'never', 'leave', 'as', 'is', 'not', 'now',
  'actually', 'i', "don't", 'dont', 'want', 'to', 'cancel', 'stop', 'keep',
  'forget', 'wait', 'nevermind', 'nvm', 'merci', 'non', 'nan', 'laisse',
  'tomber', 'pas', 'the', 'one', 'so', 'just', 'its', "it's", 'fine',
]);

/**
 * @returns {'yes' | 'no' | null}
 */
export function classifyReply(text) {
  const t = tokens(text);
  if (t.length === 0 || t.length > 7) return null;

  const allYes = t.every((w) => YES_FILLER.has(w) || YES_STRONG.has(w));
  const hasStrongYes = t.some((w) => YES_STRONG.has(w) && w !== 'please' && w !== 'pls');
  const allNo = t.every((w) => NO_FILLER.has(w) || NO_STRONG.has(w));
  const hasStrongNo = t.some((w) => NO_STRONG.has(w));

  // "no, don't" style replies are no; "yes" beats shared fillers like "fine".
  if (allNo && hasStrongNo) return 'no';
  if (allYes && hasStrongYes) return 'yes';
  return null;
}

const GREETING_STRONG = new Set([
  'hi', 'hello', 'hey', 'yo', 'hola', 'hiya', 'sup', 'bonjour', 'salut',
  'morning', 'afternoon', 'evening', 'bonsoir', 'howdy',
]);
const GREETING_FILLER = new Set([
  'there', 'good', 'onward', 'again', 'everyone', 'how', 'are', 'you', 'doing',
  'whats', "what's", 'up', 'ça', 'va', 'ca',
]);
const THANKS_STRONG = new Set([
  'thanks', 'thank', 'thx', 'ty', 'merci', 'cheers', 'appreciate', 'tysm',
]);
const THANKS_FILLER = new Set([
  'you', 'so', 'much', 'a', 'lot', 'it', 'very', 'that', 'great', 'awesome',
  'perfect', 'nice', 'cool', 'helps', 'helpful', 'beaucoup', 'really', 'for',
  'the', 'help', 'all',
]);

/**
 * @returns {'greeting' | 'thanks' | null}
 */
export function classifySmallTalk(text) {
  const t = tokens(text);
  if (t.length === 0 || t.length > 6) return null;
  if (
    t.some((w) => GREETING_STRONG.has(w)) &&
    t.every((w) => GREETING_STRONG.has(w) || GREETING_FILLER.has(w))
  ) {
    return 'greeting';
  }
  if (
    t.some((w) => THANKS_STRONG.has(w)) &&
    t.every((w) => THANKS_STRONG.has(w) || THANKS_FILLER.has(w))
  ) {
    return 'thanks';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shiftByUserOffset(d) {
  const offsetMinutes = Number(process.env.USER_UTC_OFFSET_MINUTES ?? 0);
  const offset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
  return new Date(d.getTime() + offset * 60 * 1000);
}

function isoDay(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toIsoDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : isoDay(value);
  }
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function isoDatePlusDays(today, days) {
  const base = shiftByUserOffset(today instanceof Date ? today : new Date());
  return isoDay(new Date(base.getTime() + days * 24 * 60 * 60 * 1000));
}

/**
 * "today", "tomorrow", "Friday", "next Friday", "Oct 23".
 * `deadline` is a YYYY-MM-DD string or a Date.
 */
export function friendlyDate(deadline, today = new Date(), time = null) {
  const base = friendlyDay(deadline, today);
  if (!time || base === 'soon') return base;
  const iso = toIsoDay(deadline);
  const [y, m, d] = iso.split('-').map(Number);
  const t = shiftByUserOffset(today instanceof Date ? today : new Date());
  const diff = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / 86400000
  );
  return diff >= 0 ? `${base} at ${formatTime(time)}` : base;
}

function friendlyDay(deadline, today = new Date()) {
  const iso = toIsoDay(deadline);
  if (!iso) return 'soon';
  const [y, m, d] = iso.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const t = shiftByUserOffset(today instanceof Date ? today : new Date());
  const base = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const diff = Math.round((target - base) / 86400000);
  const weekday = WEEKDAYS[new Date(target).getUTCDay()];

  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff < -1) return `${Math.abs(diff)} days ago`;
  if (diff <= 6) return weekday;
  if (diff <= 13) return `next ${weekday}`;
  const sameYear = y === t.getUTCFullYear();
  return sameYear ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

// ---------------------------------------------------------------------------
// Dates and times the LLM hands back
// ---------------------------------------------------------------------------

export function formatTime(hhmm) {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  const mins = m[2];
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mins === '00' ? `${h12} ${suffix}` : `${h12}:${mins} ${suffix}`;
}

/**
 * Accepts "2026-10-19", "2026-10-19T09:00", "2026-10-19 09:00:00", with or
 * without a zone suffix. Returns { date, time } with either possibly null.
 * Midnight is treated as "no time given".
 */
export function parseWhen(value) {
  if (typeof value !== 'string') return { date: null, time: null };
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]+(\d{1,2}):(\d{2}))?/);
  if (!m) return { date: null, time: null };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (Number.isNaN(new Date(date).getTime())) return { date: null, time: null };
  let time = null;
  if (m[4] != null) {
    const h = Number(m[4]);
    if (h < 24 && Number(m[5]) < 60) time = `${String(h).padStart(2, '0')}:${m[5]}`;
  }
  if (time === '00:00') time = null;
  return { date, time };
}

export function validTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const t = `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  return t === '00:00' ? null : t;
}

/** A week-plus calendar so the model never has to do weekday arithmetic. */
export function calendarTable(today = new Date(), days = 21) {
  const base = shiftByUserOffset(today instanceof Date ? today : new Date());
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
    const tag = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    out.push(`${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${isoDay(d)}${tag}`);
  }
  return out.join('\n');
}

// Times are kept as one tagged line inside the existing text columns
// (Goal.context, Requirement.notes), so no schema change is needed.
export function readTimeTag(text) {
  const m = String(text ?? '').match(/^due_time:\s*(\d{2}:\d{2})\s*$/m);
  return m ? m[1] : null;
}

export function writeTimeTag(text, time) {
  const base = String(text ?? '')
    .split('\n')
    .filter((l) => !/^due_time:/.test(l.trim()))
    .join('\n')
    .replace(/\n+$/, '');
  if (!time) return base || null;
  return base ? `${base}\ndue_time: ${time}` : `due_time: ${time}`;
}

// ---------------------------------------------------------------------------
// Matching what the user said to what is on their list
// ---------------------------------------------------------------------------

const LABEL_STOP = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'to', 'for', 'of', 'and', 'or', 'with',
  'on', 'in', 'at', 'up', 'out', 'that', 'this', 'it', 'task', 'item', 'one',
  'new', 'some', 'i', 'we', 'just', 'also', 'its', 'is', 'as',
]);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function labelTokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u00e0-\u00ff\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LABEL_STOP.has(w))
    .map(stem);
}

export function labelOverlap(a, b) {
  const A = new Set(labelTokens(a));
  const B = new Set(labelTokens(b));
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const denom = Math.max(1, Math.min(A.size, B.size));
  return { shared, ratio: shared / denom };
}

/**
 * Best match for what the user said among items ({label}). Returns
 * { item, shared, ratio, tied: [items] } or null when nothing shares a word.
 */
export function bestLabelMatch(said, items) {
  const scored = (items ?? [])
    .map((it) => ({ it, ...labelOverlap(said, it.label) }))
    .filter((x) => x.shared >= 1)
    .sort((a, b) => b.shared - a.shared || b.ratio - a.ratio);
  if (scored.length === 0) return null;
  const top = scored[0];
  const tied = scored
    .filter((x) => x.shared === top.shared && x.ratio === top.ratio)
    .map((x) => x.it);
  return { item: top.it, shared: top.shared, ratio: top.ratio, tied };
}

// The model sometimes writes markdown even when told not to. This is read
// aloud, so strip it.
export function sanitizeSpoken(text) {
  return String(text ?? '')
    .replace(/\u2011/g, '-')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*\u2022]\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// suggestRequirements
//
// One call for any number of goals. Works for goals with no template at all
// (groceries, a bill, a school run, a hackathon), and folds in the template's
// essentials when there are some.
//
// entries: [{ goal, existing: [req], essentials: [{label, kind}],
//             helpful: [{label, kind}] }]
// opts:    { userText?, today?, askAtEnd? (default true) }
//
// Returns { text, per_goal: [{ goal_id, items: [{label, kind}] }] }.
// `items` only contains things that are actually mentioned in `text`, so what
// the user hears is exactly what "yes, add them" will add.
// ---------------------------------------------------------------------------

export async function suggestRequirements(entries, opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e?.goal?.id);
  if (list.length === 0) return { text: '', per_goal: [] };

  const today = opts.today instanceof Date ? opts.today : new Date();
  const askAtEnd = opts.askAtEnd !== false;

  const system = [
    'You are Onward, an assistant that helps busy people not miss deadlines.',
    'The user just set up one or more goals. For each goal, think about what',
    'someone doing exactly this usually needs and usually forgets. Pay most',
    'attention to things that depend on other people (a signature, a letter,',
    'an approval, a delivery, a reply) and things with lead time.',
    '',
    'RULES FOR SUGGESTIONS',
    '- Suggest only things that are genuinely useful for THAT goal.',
    '- A trivial goal (buy milk, pay a bill) may need zero or one suggestion.',
    '  Never pad. Returning nothing for a goal is fine.',
    '- At most 4 per goal. Short noun phrases, the way a person would say them.',
    '- Do not repeat anything in "already has".',
    '- Items under MUST INCLUDE must be suggested with exactly that label.',
    '- Items under CANDIDATES are optional; use one or two only if they fit.',
    '- kind is "external_dependency" only when another person or institution',
    '  has to produce, sign or send it. Otherwise "self_action".',
    '',
    'RULES FOR "text" (what you say out loud)',
    '- Sound like a sharp, friendly human assistant. Contractions. Short',
    '  sentences. No bullet points, no headers, no em-dashes.',
    '- 2 to 4 sentences in total across ALL goals. Group by goal in natural',
    '  speech ("For the visa, you will probably need ..."). Skip goals with no',
    '  suggestions.',
    '- Mention every suggested item by its exact label.',
    askAtEnd
      ? '- End with one short, easy question, like "Want me to add those?". Vary it.'
      : '- Do NOT end with a question; another question follows right after. You may end with "I can add those too."',
    '- Do not promise things you cannot do (planning, scheduling, drafting).',
    '- Only mention goals that appear in the data. Never mention any other goal.',
    '',
    'Return ONLY this JSON object:',
    '{ "text": string,',
    '  "per_goal": [ { "goal_id": string, "items": [ { "label": string, "kind": "self_action" | "external_dependency" } ] } ] }',
    'Use the goal ids exactly as given. No prose outside the JSON.',
  ].join('\n');

  const lines = [];
  const t = shiftByUserOffset(today);
  lines.push(`Today is ${WEEKDAYS[t.getUTCDay()]}, ${isoDay(t)}.`);
  lines.push('Only talk about the goals listed below. Other goals the user may have');
  lines.push('mentioned are already handled; do not mention them.');
  lines.push('');
  for (const e of list) {
    const g = e.goal;
    lines.push(`GOAL goal_id=${g.id} title=${JSON.stringify(g.title)} due=${friendlyDate(g.deadline, today)}${g.goal_type ? ` type=${g.goal_type}` : ''}`);
    const have = (e.existing ?? []).map((r) => r.label);
    lines.push(`  already has: ${have.length ? have.map((l) => JSON.stringify(l)).join(', ') : '(nothing yet)'}`);
    const must = (e.essentials ?? []).map((x) => x.label);
    lines.push(`  MUST INCLUDE: ${must.length ? must.map((l) => JSON.stringify(l)).join(', ') : '(none)'}`);
    const cand = (e.helpful ?? []).map((x) => x.label);
    lines.push(`  CANDIDATES: ${cand.length ? cand.map((l) => JSON.stringify(l)).join(', ') : '(none)'}`);
  }

  const raw = await callLLM(system, lines.join('\n'), { temperature: 0.5, maxTokens: 3000 });

  const byId = new Map(list.map((e) => [e.goal.id, e]));
  const perGoal = [];
  let text = typeof raw?.text === 'string' ? raw.text.trim() : '';

  for (const pg of Array.isArray(raw?.per_goal) ? raw.per_goal : []) {
    const entry = byId.get(pg?.goal_id);
    if (!entry) continue;
    const existingKeys = new Set((entry.existing ?? []).map((r) => normalizeLabel(r.label)));
    const seen = new Set();
    const items = [];
    for (const it of Array.isArray(pg.items) ? pg.items : []) {
      if (!it || typeof it.label !== 'string') continue;
      const label = it.label.trim();
      if (!label || label.length > 60) continue;
      const key = normalizeLabel(label);
      if (existingKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      items.push({
        label,
        kind: it.kind === 'external_dependency' ? 'external_dependency' : 'self_action',
      });
      if (items.length >= 4 + (entry.essentials?.length ?? 0)) break;
    }
    perGoal.push({ goal_id: pg.goal_id, items });
  }

  // Keep only what the user will actually hear, and make sure essentials are
  // always spoken.
  const lower = text.toLowerCase();
  const missedEssentials = [];
  for (const pg of perGoal) {
    const entry = byId.get(pg.goal_id);
    const essentialKeys = new Set((entry.essentials ?? []).map((x) => normalizeLabel(x.label)));
    const present = new Set(pg.items.map((i) => normalizeLabel(i.label)));

    for (const ess of entry.essentials ?? []) {
      if (!present.has(normalizeLabel(ess.label))) {
        pg.items.push({ label: ess.label, kind: ess.kind === 'external_dependency' ? 'external_dependency' : 'self_action' });
      }
    }

    pg.items = pg.items.filter((it) => {
      if (lower.includes(it.label.toLowerCase())) return true;
      if (essentialKeys.has(normalizeLabel(it.label))) {
        missedEssentials.push(it.label);
        return true;
      }
      return false;
    });
  }

  const anyItems = perGoal.some((pg) => pg.items.length > 0);
  if (!anyItems) return { text: '', per_goal: perGoal };

  if (!text) {
    const bits = perGoal
      .filter((pg) => pg.items.length > 0)
      .map((pg) => {
        const title = byId.get(pg.goal_id).goal.title;
        return `For ${title}, you'll probably want ${joinWithAnd(pg.items.map((i) => i.label))}.`;
      });
    text = bits.join(' ') + (askAtEnd ? ' Want me to add those?' : '');
  } else if (missedEssentials.length > 0) {
    text = text.replace(/\s*$/, '') + ` ${joinWithAnd(missedEssentials)} usually matter here too.`;
  }

  return { text, per_goal: perGoal };
}

// ---------------------------------------------------------------------------
// resolveDeadlinesReply
//
// Several goals were created without a date and the user was asked. Their
// reply can be anything: "Friday", "groceries today and the bill by the 20th",
// "all by Friday", "no rush on the groceries", "yes add them, and Friday".
//
// partials: [{ title, ... }]   (position = index)
//
// Returns { answers: [{ index, deadline | null, no_deadline }],
//           accepts_suggestions: true | false | null,
//           unrelated: boolean }
// ---------------------------------------------------------------------------

export async function resolveDeadlinesReply(text, partials, today = new Date()) {
  const t = shiftByUserOffset(today instanceof Date ? today : new Date());
  const todayLine =
    `Today is ${WEEKDAYS[t.getUTCDay()]}, ${isoDay(t)}.\nCalendar:\n${calendarTable(today)}`;

  const system = [
    'The user was asked when some goals are due. Read their reply and say',
    'which goal gets which date.',
    '',
    'Return ONLY this JSON object:',
    '{ "answers": [ { "index": number, "deadline": "YYYY-MM-DD" | null, "no_deadline": boolean } ],',
    '  "accepts_suggestions": true | false | null,',
    '  "unrelated": boolean }',
    '',
    'RULES',
    '- Resolve relative dates against today: "tonight" is today, "tomorrow",',
    '  "Friday" is the coming Friday, "end of the week" is Friday, "this',
    '  weekend" is Sunday, "in 3 days" is three days from today, "the 20th"',
    '  is the next 20th. Pick the most natural date for vague phrases.',
    '- One date for everything ("all by Friday", "same for all") means one',
    '  answer per goal with that date.',
    '- Match goals by meaning, not exact words ("the bill", "groceries", "the',
    '  first one", "the other one").',
    '- "no deadline", "whenever", "no rush", "doesn\'t matter" for a goal:',
    '  no_deadline true and deadline null.',
    '- Never invent a date. If the reply gives no date for a goal, leave that',
    '  goal out of "answers".',
    '- accepts_suggestions: true if the user says yes to adding suggested items',
    '  ("yes add them"), false if they decline, otherwise null.',
    '- unrelated: true ONLY if the reply is about something else entirely (a',
    '  new request, a question about other goals) and contains no date or',
    '  answer for these goals.',
    'The user may write in English or French, informally, with typos.',
  ].join('\n');

  const user = [
    todayLine,
    'Goals waiting for a date:',
    ...partials.map((p, i) => `  ${i}: ${JSON.stringify(p.title)}`),
    '',
    `User's reply: ${text}`,
  ].join('\n');

  const raw = await callLLM(system, user, { temperature: 0, maxTokens: 2000 });

  const answers = [];
  const used = new Set();
  for (const a of Array.isArray(raw?.answers) ? raw.answers : []) {
    const index = Number(a?.index);
    if (!Number.isInteger(index) || index < 0 || index >= partials.length) continue;
    if (used.has(index)) continue;
    const deadline =
      typeof a.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.deadline) &&
      !Number.isNaN(new Date(a.deadline).getTime())
        ? a.deadline
        : null;
    const noDeadline = a.no_deadline === true && !deadline;
    if (!deadline && !noDeadline) continue;
    used.add(index);
    answers.push({ index, deadline, no_deadline: noDeadline });
  }

  return {
    answers,
    accepts_suggestions:
      raw?.accepts_suggestions === true ? true : raw?.accepts_suggestions === false ? false : null,
    unrelated: raw?.unrelated === true,
  };
}

// ---------------------------------------------------------------------------
// phraseAnswer
//
// Turns structured report data into something you would say out loud.
// Throws on LLM failure; the caller falls back to the plain report lines.
// ---------------------------------------------------------------------------

export async function phraseAnswer({ kind, question, today, data }) {
  const when = today instanceof Date ? today : new Date();
  const t = shiftByUserOffset(when);

  const system = [
    'You are Onward, a voice assistant for busy people. Answer the question',
    'using ONLY the data given. Say it the way a sharp, friendly human',
    'assistant would say it out loud.',
    '',
    'STYLE',
    '- Contractions, short sentences, plain words. No bullets, no glyphs, no',
    '  headers, no status codes like waiting_on_other, no em-dashes.',
    '- Say dates the natural way: "tomorrow", "Friday", "October 23", never',
    '  2026-10-23. Include a time ("at 9 AM") when the data has one.',
    '- Plain sentences only. No asterisks, no dashes as bullets, no headers.',
    '- Lead with whatever is most urgent or most at risk, then the rest.',
    '- Answer what was asked. If they asked what is left, list what is left. If',
    '  they asked about risk, talk about risk. Do not recite everything.',
    '- Mention every goal that has something outstanding, grouped by goal. Use',
    '  goal titles and item labels as given.',
    '- Under about 110 words unless there are many goals. It will be read aloud.',
    '- If something is overdue or at risk, say so plainly and, when it is an',
    '  item waiting on someone, you may offer once to draft a follow-up.',
    '- If everything is done or nothing is outstanding, say so briefly and',
    '  warmly.',
    '- Never invent items, dates or people.',
    '',
    'Return plain text only.',
  ].join('\n');

  const user = [
    `Today is ${WEEKDAYS[t.getUTCDay()]}, ${isoDay(t)}.`,
    `Kind of question: ${kind}`,
    question ? `What the user asked: ${JSON.stringify(String(question).slice(0, 400))}` : null,
    '',
    'Data:',
    JSON.stringify(data, null, 1),
  ]
    .filter((x) => x !== null)
    .join('\n');

  const text = await callLLMText(system, user, { temperature: 0.5, maxTokens: 1200 });
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('[onward/conversation] phraseAnswer: empty response');
  }
  return sanitizeSpoken(text);
}