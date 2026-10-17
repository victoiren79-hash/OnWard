// Onward — Requirement status state machine.
//
// Pure functions. No I/O. No DB calls. No clock import.
// Timestamps are passed in by the caller.
//
// applyTransition returns a result object instead of throwing:
//   { ok: true, next: <new requirement> }
//   { ok: false, reason: string, nearestLegal: string|null,
//     currentStatus: string }

export const STATUSES = Object.freeze([
  'not_started',
  'in_progress',
  'waiting_on_other',
  'done',
]);

export const KINDS = Object.freeze(['self_action', 'external_dependency']);

// ---------------------------------------------------------------------------
// Kind normalization
//
// The LLM is not reliable about the exact spelling of "kind". It sends
// variants like "self", "self action", "Self-Action", "external",
// "third party", "dependency". This maps any of them to the two values
// the database accepts. Returns null when the input is unusable, so the
// caller can decide the fallback.
// ---------------------------------------------------------------------------

export function normalizeKind(raw) {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (k === 'self_action' ||
      ['self', 'me', 'task', 'own', 'self_task', 'my_action'].includes(k))
    return 'self_action';
  if (k === 'external_dependency' ||
      ['external', 'other', 'others', 'third_party', 'dependency',
       'external_dep', 'external_action'].includes(k)) return 'external_dependency';
  return null;
}

// ---------------------------------------------------------------------------
// Transition matrix
// ---------------------------------------------------------------------------

const TRANSITIONS = Object.freeze({
  self_action: Object.freeze({
    not_started: Object.freeze(['in_progress', 'done']),
    in_progress: Object.freeze(['not_started', 'done']),
    waiting_on_other: Object.freeze([]),
    done: Object.freeze(['in_progress']),
  }),

  external_dependency: Object.freeze({
    not_started: Object.freeze(['waiting_on_other']),
    in_progress: Object.freeze(['waiting_on_other']),
    waiting_on_other: Object.freeze(['done', 'in_progress']),
    done: Object.freeze(['waiting_on_other']),
  }),
});

// ---------------------------------------------------------------------------
// Validity checks
// ---------------------------------------------------------------------------

export function canTransition(kind, from, to) {
  if (!KINDS.includes(kind)) return false;
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  const allowed = TRANSITIONS[kind][from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function allowedNextStates(kind, from) {
  if (!KINDS.includes(kind)) return [];
  if (!STATUSES.includes(from)) return [];
  return [...TRANSITIONS[kind][from]];
}

// ---------------------------------------------------------------------------
// Transition application
// ---------------------------------------------------------------------------

export function applyTransition(requirement, to, opts = {}) {
  if (!requirement || typeof requirement !== 'object') {
    return fail('requirement is required', null, null);
  }
  const { id, kind, status: from } = requirement;

  if (!id) {
    return fail('requirement.id is required', null, null);
  }
  if (!KINDS.includes(kind)) {
    return fail(`unknown kind "${kind}"`, null, from ?? null, { kind });
  }
  if (!STATUSES.includes(from)) {
    return fail(`unknown current status "${from}"`, null, from ?? null, { from });
  }
  if (!STATUSES.includes(to)) {
    return fail(`unknown target status "${to}"`, null, from, { to });
  }

  if (from === to) {
    return fail(`no-op transition "${from}" -> "${to}"`, null, from, { to });
  }

  if (!canTransition(kind, from, to)) {
    const allowed = allowedNextStates(kind, from);
    const nearest = pickNearest(from, to, allowed);
    return fail(
      `illegal transition "${from}" -> "${to}" for kind "${kind}". ` +
        `Allowed next from "${from}": ${allowed.join(', ') || '(none)'}.`,
      nearest,
      from,
      { to, allowed }
    );
  }

  const at = coerceDate(opts.at) ?? new Date();

  let requestedAt = requirement.requested_at ?? null;
  let receivedAt = requirement.received_at ?? null;

  if (kind === 'external_dependency' && to === 'waiting_on_other') {
    requestedAt = coerceDate(opts.requestedAt) ?? requestedAt ?? at;
  }

  if (to === 'done') {
    if (kind === 'external_dependency') {
      const explicit = coerceDate(opts.receivedAt);
      receivedAt = explicit ?? receivedAt ?? at;
    } else {
      if (opts.receivedAt) {
        return fail(
          `received_at is not applicable to self_action item ${id}`,
          null,
          from
        );
      }
      receivedAt = receivedAt ?? at;
    }
  }

  if (to !== 'done' && from === 'done') {
    receivedAt = null;
  }

  const next = {
    ...requirement,
    status: to,
    requested_at: requestedAt,
    received_at: receivedAt,
  };

  if (opts.notes !== undefined) {
    next.notes = opts.notes;
  }

  return { ok: true, next };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function fail(reason, nearestLegal, currentStatus, details) {
  return {
    ok: false,
    reason,
    nearestLegal: nearestLegal ?? null,
    currentStatus: currentStatus ?? null,
    details: details ?? null,
  };
}

function pickNearest(from, proposed, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return null;
  if (allowed.includes(proposed)) return proposed;

  const ORDER = ['done', 'waiting_on_other', 'in_progress', 'not_started'];
  const proposedIdx = ORDER.indexOf(proposed);
  if (proposedIdx < 0) return allowed[0];

  const forward = proposed === 'done';
  const sorted = [...allowed].sort((a, b) => {
    const ai = ORDER.indexOf(a);
    const bi = ORDER.indexOf(b);
    return forward ? ai - bi : bi - ai;
  });
  return sorted[0] ?? null;
}

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