// Onward — natural-language phrasing over deterministic data.
//
// Two functions:
//   - phraseCompletenessQuestion(missingItems) → a clarifying question
//   - phraseReport(reportData)                 → prose, without adding items
//
// Neither writes to the database. Neither invents facts.

import { callLLM, callLLMText } from '../llm.js';

// ---------------------------------------------------------------------------
// phraseCompletenessQuestion
// ---------------------------------------------------------------------------

/**
 * Turn a completenessService result into a natural clarifying question.
 *
 * @param {Array<{label: string, kind: string, is_commonly_missed: boolean}>} missingItems
 *   The `missing` array from completenessService.findMissingRequirements.
 *
 * @returns {Promise<string|null>}
 *   A single question string, or null if missingItems is empty.
 */
export async function phraseCompletenessQuestion(missingItems) {
  if (!Array.isArray(missingItems)) {
    throw new Error('[onward/phrasing] missingItems must be an array');
  }
  if (missingItems.length === 0) return null;

  const labels = missingItems.map((m) => m.label).filter(Boolean);
  if (labels.length === 0) return null;

  const systemPrompt = `
You phrase a short, natural clarifying question for a user who is setting up
a goal. You are given a list of requirement labels that the system thinks
might be missing, and you write ONE question that asks the user about them.

Rules:
- Write a single question, in plain conversational English.
- You may only mention items from the list. Do NOT invent items.
- Do not number the items. Do not use a bullet list. Flow them into a sentence.
- If the list has more than 3 items, still name every one — do not summarize.
- Do not add greetings, preamble, or sign-off. Just the question.
- Keep it under 60 words.

Return ONLY the question as plain text. No JSON, no quotes around it.
`.trim();

  const userMessage = `Missing items:\n${labels.map((l) => `- ${l}`).join('\n')}`;

  const text = await callLLMText(systemPrompt, userMessage, { temperature: 0.3 });
  return text.trim();
}

// ---------------------------------------------------------------------------
// phraseReport
// ---------------------------------------------------------------------------

/**
 * Turn reportService output into natural prose, without adding any item
 * not present in the data.
 *
 * @param {object} reportData
 *   The `data` field returned by any of the reportService functions.
 *
 * @returns {Promise<string>} A prose rendering.
 */
export async function phraseReport(reportData) {
  if (!reportData || typeof reportData !== 'object') {
    throw new Error('[onward/phrasing] reportData must be an object');
  }

  const { items, idToLabel } = collectItems(reportData);
  if (items.length === 0) {
    return 'Nothing to report yet.';
  }

  const systemPrompt = `
You rewrite a structured status report into a short, natural message for a user.

You will be given a list of items, each with an id and a label, and additional
structured facts about them.

Rules:
- You may ONLY reference items whose id appears in the list below.
- Do NOT invent, rename, or paraphrase item labels. Use them verbatim.
- Do NOT add items that aren't in the list, even if they seem obvious.
- Do not summarize away items. Every item must appear in your output.
- Plain conversational English. No bullet lists, no headers, no numbering.
- No greeting, no preamble, no sign-off. Keep it concise.

After your prose, return a JSON object with this exact shape:
{
  "prose": string,           // the natural-language message
  "referenced_ids": string[] // every item id you mentioned, in order
}

Return ONLY the JSON object. No prose outside it, no code fences.
`.trim();

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

  // No invented items: every referenced id must be in the input.
  for (const id of raw.referenced_ids) {
    if (typeof id !== 'string' || !idToLabel.has(id)) {
      throw invalid(`referenced id ${JSON.stringify(id)} is not in the input item list`, id);
    }
  }

  // No dropped items: every input item must be referenced.
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
// Internals
// ---------------------------------------------------------------------------

/**
 * Walk a reportData object and collect every requirement entry it contains.
 * Handles the three report shapes we currently produce.
 */
function collectItems(reportData) {
  const items = [];
  const seen = new Set();

  const push = (id, label, facts) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    items.push({ id, label, facts });
  };

  // Shape 1: renderGoalReport.data
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

  // Shape 2: renderRiskReport.data
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

  // Shape 3: renderActionReport.data
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