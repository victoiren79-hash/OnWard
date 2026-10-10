// Onward — deterministic completeness check.
//
// Given a goal, its current requirements, and the GoalTypeTemplate rows
// for that goal's type, return the template items that are not yet present.
//
// Pure functions. No I/O. No LLM. No clock.
//
// Matching is by normalized label — case/punctuation/whitespace-insensitive,
// with a small set of obvious plural normalizations.
//
// Optional filters:
//   onlyCommonlyMissed — return only rows where is_commonly_missed is true
//   onlyEssentials     — return only rows where priority is 'essential'
//   onlyHelpful        — return only rows where priority is 'helpful'
//
// Callers can combine filters but only one of onlyEssentials / onlyHelpful
// makes sense at a time.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute which template items are missing from a goal's requirements.
 *
 * @param {object} goal
 * @param {Array<object>} requirements
 * @param {Array<object>} templateRows — rows from GoalTypeTemplate for the
 *   goal's type. Each must have { label, kind, typical_turnaround_days,
 *   is_commonly_missed, priority }.
 * @param {object} [opts]
 * @param {boolean} [opts.onlyCommonlyMissed=false]
 * @param {boolean} [opts.onlyEssentials=false]
 * @param {boolean} [opts.onlyHelpful=false]
 * @returns {{
 *   missing: Array<{
 *     label: string,
 *     kind: 'self_action' | 'external_dependency',
 *     typical_turnaround_days: number | null,
 *     is_commonly_missed: boolean,
 *     priority: 'essential' | 'helpful'
 *   }>,
 *   present: string[],
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
        priority: t.priority === 'essential' ? 'essential' : 'helpful',
      });
    }
  }

  // --- Order: essential first, then commonly-missed, then external, then alpha
  missing.sort(compareMissing);

  let filtered = missing;

  if (opts.onlyCommonlyMissed === true) {
    filtered = filtered.filter((m) => m.is_commonly_missed);
  }
  if (opts.onlyEssentials === true) {
    filtered = filtered.filter((m) => m.priority === 'essential');
  }
  if (opts.onlyHelpful === true) {
    filtered = filtered.filter((m) => m.priority === 'helpful');
  }

  return result(filtered, present, 'ok', goalType);
}

// ---------------------------------------------------------------------------
// Label normalization
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
  // Skip a small exception list where the trailing s is part of the word.
  const KEEP_S = new Set(['status', 'process', 'access', 'address', 'business', 'witness']);
  s = s
    .split(' ')
    .map((w) => {
      if (KEEP_S.has(w)) return w;
      return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    })
    .join(' ');

  return s;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function compareMissing(a, b) {
  // essential first
  const ap = a.priority === 'essential' ? 0 : 1;
  const bp = b.priority === 'essential' ? 0 : 1;
  if (ap !== bp) return ap - bp;

  // then commonly-missed
  if (a.is_commonly_missed !== b.is_commonly_missed) {
    return a.is_commonly_missed ? -1 : 1;
  }
  // then external deps
  if (a.kind !== b.kind) {
    return a.kind === 'external_dependency' ? -1 : 1;
  }
  // alphabetical
  return a.label.localeCompare(b.label);
}

function result(missing, present, reason, goalType) {
  return { missing, present, reason, goal_type: goalType };
}