// Onward — Requirement status state machine.
//
// Pure functions. No I/O. No DB calls. No clock import.
// Timestamps are passed in by the caller.
//
// The caller is expected to:
//   1. Load the requirement.
//   2. Call applyTransition(req, to, { at, ... }) — this may throw.
//   3. Persist the returned requirement via db.updateRequirement().
//   4. Append an Event via db.appendEvent().
//
// This module only handles step 2. It decides what the new requirement
// object should look like and rejects illegal transitions.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATUSES = Object.freeze([
  'not_started',
  'in_progress',
  'waiting_on_other',
  'done',
]);

export const KINDS = Object.freeze(['self_action', 'external_dependency']);

// ---------------------------------------------------------------------------
// Transition matrix
//
// Keyed by `kind`, then by `from`, listing the legal `to` states.
// Anything not listed is illegal and will throw.
// ---------------------------------------------------------------------------

const TRANSITIONS = Object.freeze({
  // A self_action item is produced by the user. It never "waits on
  // someone else", so `waiting_on_other` is not reachable for it.
  self_action: Object.freeze({
    not_started: Object.freeze(['in_progress', 'done']),
    in_progress: Object.freeze(['not_started', 'done']),
    waiting_on_other: Object.freeze([]), // unreachable for self_action
    done: Object.freeze(['in_progress']), // reopen if the user corrects themselves
  }),

  // An external_dependency item is produced by another party. It must
  // pass through `waiting_on_other` before `done`, because `done`
  // requires a received_at timestamp that only makes sense after a wait.
  external_dependency: Object.freeze({
    not_started: Object.freeze(['waiting_on_other']),
    in_progress: Object.freeze(['waiting_on_other']),
    waiting_on_other: Object.freeze(['done', 'in_progress']), // 'in_progress' = wait was cancelled
    done: Object.freeze(['waiting_on_other']), // reopen if it turns out not received
  }),
});

// ---------------------------------------------------------------------------
// Validity checks (exported so callers can pre-flight without try/catch)
// ---------------------------------------------------------------------------

/**
 * Is `to` a legal next state from `from`, given the item's kind?
 * @param {'self_action' | 'external_dependency'} kind
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(kind, from, to) {
  if (!KINDS.includes(kind)) return false;
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  const allowed = TRANSITIONS[kind][from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * List all legal next states from `from`, given the item's kind.
 * Useful for error messages and for the LLM prompt in a later phase.
 * @param {'self_action' | 'external_dependency'} kind
 * @param {string} from
 * @returns {string[]}
 */
export function allowedNextStates(kind, from) {
  if (!KINDS.includes(kind)) return [];
  if (!STATUSES.includes(from)) return [];
  return [...TRANSITIONS[kind][from]];
}

// ---------------------------------------------------------------------------
// Transition application
// ---------------------------------------------------------------------------

/**
 * Apply a status transition and return a NEW requirement object.
 * Never mutates the input. Throws on any illegal transition.
 *
 * @param {object} requirement — must have { id, kind, status, ... }
 * @param {string} to — target status
 * @param {object} [opts]
 * @param {Date}   [opts.at]           — timestamp of the transition (default: new Date())
 * @param {string} [opts.notes]        — optional notes to set/overwrite
 * @param {Date}   [opts.receivedAt]   — required explicitly for some paths; usually inferred
 * @param {Date}   [opts.requestedAt]  — optional override; usually inferred
 * @returns {object} new requirement
 */
export function applyTransition(requirement, to, opts = {}) {
  // --- Validate the requirement itself ------------------------------------
  if (!requirement || typeof requirement !== 'object') {
    throw new Error('[onward/requirement] applyTransition: requirement is required');
  }
  const { id, kind, status: from } = requirement;

  if (!id) {
    throw new Error('[onward/requirement] applyTransition: requirement.id is required');
  }
  if (!KINDS.includes(kind)) {
    throw new Error(
      `[onward/requirement] applyTransition: unknown kind "${kind}" on requirement ${id}`
    );
  }
  if (!STATUSES.includes(from)) {
    throw new Error(
      `[onward/requirement] applyTransition: unknown current status "${from}" on requirement ${id}`
    );
  }
  if (!STATUSES.includes(to)) {
    throw new Error(
      `[onward/requirement] applyTransition: unknown target status "${to}" on requirement ${id}`
    );
  }

  // --- Reject no-ops ------------------------------------------------------
  if (from === to) {
    throw new Error(
      `[onward/requirement] applyTransition: no-op transition "${from}" → "${to}" on requirement ${id}`
    );
  }

  // --- Enforce the matrix -------------------------------------------------
  if (!canTransition(kind, from, to)) {
    const allowed = allowedNextStates(kind, from);
    const allowedText = allowed.length ? allowed.join(', ') : '(none)';
    throw new Error(
      `[onward/requirement] applyTransition: illegal transition ` +
        `"${from}" → "${to}" for kind "${kind}" on requirement ${id}. ` +
        `Allowed next from "${from}": ${allowedText}.`
    );
  }

  // --- Resolve timestamps -------------------------------------------------
  const at = coerceDate(opts.at) ?? new Date();

  // Determine requested_at / received_at based on the transition.
  let requestedAt = requirement.requested_at ?? null;
  let receivedAt = requirement.received_at ?? null;

  if (kind === 'external_dependency' && to === 'waiting_on_other') {
    // Entering a wait: stamp when the request went out (only if not already set).
    requestedAt = coerceDate(opts.requestedAt) ?? requestedAt ?? at;
  }

  if (to === 'done') {
    if (kind === 'external_dependency') {
      // External items must have a received_at.
      const explicit = coerceDate(opts.receivedAt);
      receivedAt = explicit ?? receivedAt ?? at;
      if (!receivedAt) {
        // Defensive: can't happen given the fallback above, but keep it explicit.
        throw new Error(
          `[onward/requirement] applyTransition: "→ done" for external item ${id} requires received_at`
        );
      }
    } else {
      // self_action: received_at is meaningless. Reject if caller tried to set it.
      if (opts.receivedAt) {
        throw new Error(
          `[onward/requirement] applyTransition: received_at is not applicable to ` +
            `self_action item ${id}`
        );
      }
      // A self_action "done" may still record a completion timestamp in received_at
      // for reporting symmetry — we set it to `at` so reports can show "completed on".
      // (If you'd rather leave it null for self_action, change the next line to `receivedAt = null;`.)
      receivedAt = receivedAt ?? at;
    }
  }

  if (to !== 'done' && from === 'done') {
    // Reopening: clear the completion stamp so reports don't show stale data.
    receivedAt = null;
  }

  // --- Build the new object ----------------------------------------------
  const next = {
    ...requirement,
    status: to,
    requested_at: requestedAt,
    received_at: receivedAt,
  };

  if (opts.notes !== undefined) {
    next.notes = opts.notes;
  }

  return next;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function coerceDate(input) {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : new Date(input.getTime());
  }
  if (typeof input === 'string' || typeof input === 'number') {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}