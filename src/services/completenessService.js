// Onward — deterministic completeness check.
//
// Given a goal, its current requirements, and the GoalTypeTemplate rows
// for that goal's type, return the template items that are not yet present.
//
// Pure functions. No I/O. No LLM. No clock.
//
// Matching is by normalized label — case/punctuation/whitespace-insensitive,
// with a small set of obvious plural normalizations. Anything fuzzier than
// that is deliberately out of scope for this service; the LLM layer is
// responsible for proposing a match upstream by inserting a requirement
// that will normalize identically.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute which template items are missing from a goal's requirements.
 *
 * @param {object} goal
 *   Must have { goal_type } (may be null). Other fields ignored.
 *
 * @param {Array<object>} requirements
 *   Current requirements for the goal. Each must have { label, kind }.
 *   Other fields ignored.
 *
 * @param {Array<object>} templateRows
 *   Rows from GoalTypeTemplate for goal.goal_type. Each must have
 *   { label, kind, typical_turnaround_days, is_commonly_missed }.
 *   If the caller hasn't fetched them, pass [] and the service returns
 *   a `no_template` result.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.onlyCommonlyMissed=false]
 *   If true, filter the result to items where is_commonly_missed === true.
 *
 * @returns {{
 *   missing: Array<{
 *     label: string,
 *     kind: 'self_action' | 'external_dependency',
 *     typical_turnaround_days: number | null,
 *     is_commonly_missed: boolean
 *   }>,
 *   present: string[],          // labels from requirements that matched a template row
 *   reason: 'ok' | 'no_goal_type' | 'no_template',
 *   goal_type: string | null
 * }}
 */
export function findMissingRequirements(
  goal,
  requirements,
  templateRows,
  opts = {}
) {
  const goalType = goal?.goal_type ?? null;

  // --- Fallback cases -----------------------------------------------------
  if (!goalType) {
    return result([], [], 'no_goal_type', null);
  }
  if (!Array.isArray(templateRows) || templateRows.length === 0) {
    return result([], [], 'no_template', goalType);
  }

  // --- Build the set of normalized labels the user already has -----------
  const reqs = Array.isArray(requirements) ? requirements : [];
  const presentKeys = new Set();
  for (const r of reqs) {
    if (r && typeof r.label === 'string') {
      presentKeys.add(normalizeLabel(r.label));
    }
  }

  // --- Diff ---------------------------------------------------------------
  const missing = [];
  const present = [];

  for (const t of templateRows) {
    if (!t || typeof t.label !== 'string') continue;
    const key = normalizeLabel(t.label);
    if (presentKeys.has(key)) {
      present.push(t.label);
    } else {
      missing.push({
        label: t.label,
        kind: t.kind,
        typical_turnaround_days: t.typical_turnaround_days ?? null,
        is_commonly_missed: Boolean(t.is_commonly_missed),
      });
    }
  }

  // --- Order: commonly-missed first, then external deps, then alpha ------
  missing.sort(compareMissing);

  const filtered =
    opts.onlyCommonlyMissed === true
      ? missing.filter((m) => m.is_commonly_missed)
      : missing;

  return result(filtered, present, 'ok', goalType);
}

// ---------------------------------------------------------------------------
// Label normalization (deterministic, small, documented)
//
// Steps:
//   1. Lowercase.
//   2. Replace any non-alphanumeric character with a space.
//   3. Collapse runs of whitespace to a single space; trim.
//   4. Drop a small set of trailing plural markers when the remainder is
//      at least 3 chars. This catches "letter(s)" / "letters" / "letter",
//      "scores" / "score", etc. It is deliberately conservative — it will
//      not merge genuinely distinct labels.
//   5. Strip a small set of leading articles ("a", "the") — rare, but cheap.
//
// The whole point is that this stays small and readable. If it grows
// beyond what you can eyeball in 15 seconds, it's a signal that fuzzy
// matching belongs in the LLM layer, not here.
// ---------------------------------------------------------------------------

export function normalizeLabel(label) {
  if (typeof label !== 'string') return '';
  let s = label.toLowerCase();

  // Strip parenthesized plural markers: "letter(s)" -> "letter"
  s = s.replace(/\(s\)/g, '');

  // Non-alphanumeric -> space
  s = s.replace(/[^a-z0-9]+/g, ' ');

  // Collapse + trim
  s = s.replace(/\s+/g, ' ').trim();

  // Drop leading article
  s = s.replace(/^(a|an|the)\s+/, '');

  // Plural normalization: drop a trailing 's' if the word is long enough.
  // Apply per-word so "test scores sent" -> "test score sent".
  s = s
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');

  return s;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function compareMissing(a, b) {
  // commonly-missed first
  if (a.is_commonly_missed !== b.is_commonly_missed) {
    return a.is_commonly_missed ? -1 : 1;
  }
  // external deps next (they carry real turnaround risk)
  if (a.kind !== b.kind) {
    return a.kind === 'external_dependency' ? -1 : 1;
  }
  // alphabetical
  return a.label.localeCompare(b.label);
}

function result(missing, present, reason, goalType) {
  return { missing, present, reason, goal_type: goalType };
}