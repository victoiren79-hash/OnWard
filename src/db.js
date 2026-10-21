import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    '[onward] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Internal helper: unwrap a Supabase response or throw.
// ---------------------------------------------------------------------------

function unwrap({ data, error }, context) {
  if (error) {
    const message = `[onward/db] ${context}: ${error.message}`;
    const err = new Error(message);
    err.cause = error;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Read cache
//
// Every read here is a round trip to a remote Supabase project, and one turn
// makes several of them. Reads are cached in memory and kept current by the
// writes in this module. A short TTL covers edits made outside the process
// (e.g. in the Supabase dashboard).
// ---------------------------------------------------------------------------

const READ_TTL_MS = 30_000;
const TEMPLATE_TTL_MS = 5 * 60_000;

const readCache = new Map();

function clone(v) {
  return v === undefined || v === null ? v : structuredClone(v);
}

async function cached(key, ttlMs, loader) {
  const hit = readCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return clone(hit.value);
  const value = await loader();
  readCache.set(key, { at: Date.now(), value: clone(value) });
  return value;
}

function bust() {
  readCache.clear();
}

// Cache layout
//   goals:<status|all>   list of goals
//   goal:<id>            one goal
//   reqs:<goalId>        every requirement of one goal
// Writes update these entries in place (write-through), so the next turn
// reads from memory instead of paying for another round trip.

function fresh(entry) {
  return entry && Date.now() - entry.at < READ_TTL_MS;
}

function dropKeys(prefix) {
  for (const key of [...readCache.keys()]) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

function mutateReqList(goalId, fn) {
  const e = readCache.get(`reqs:${goalId}`);
  if (fresh(e)) e.value = fn(e.value);
}

function patchCachedRequirement(id, partial) {
  if (!partial) return;
  for (const [key, e] of readCache) {
    if (key.startsWith('reqs:') && Array.isArray(e.value) && e.value.some((r) => r && r.id === id)) {
      e.value = e.value.map((r) => (r && r.id === id ? { ...r, ...partial } : r));
    }
  }
}

function removeCachedRequirements(ids) {
  const drop = new Set(ids);
  for (const [key, e] of readCache) {
    if (key.startsWith('reqs:') && Array.isArray(e.value)) {
      e.value = e.value.filter((r) => !(r && drop.has(r.id)));
    }
  }
}

function patchCachedGoal(id, partial) {
  if (!partial) return;
  const g = readCache.get(`goal:${id}`);
  if (g && g.value) g.value = { ...g.value, ...partial };
  for (const [key, e] of readCache) {
    if (key.startsWith('goals:') && Array.isArray(e.value)) {
      e.value = e.value.map((x) => (x && x.id === id ? { ...x, ...partial } : x));
    }
  }
}

// Writes that nothing waits on (audit log, session bookkeeping) run in the
// background, in order. Reads of the same data call flushQueue() first.
let writeQueue = Promise.resolve();

function queueWrite(label, fn) {
  writeQueue = writeQueue
    .then(fn)
    .catch((e) => console.warn(`[onward/db] background ${label} failed:`, e.message));
  return writeQueue;
}

function flushQueue() {
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Inline sanitizers for requirement rows.
//
// These are duplicated deliberately from services/requirementService.js and
// services/updateInterpreter.js so that db.js stays free of service imports.
// If the allowed values ever change, change them here too.
// ---------------------------------------------------------------------------

const ALLOWED_KINDS = ['self_action', 'external_dependency'];
const ALLOWED_STATUSES = ['not_started', 'in_progress', 'waiting_on_other', 'done'];

function sanitizeKind(raw) {
  if (ALLOWED_KINDS.includes(raw)) return raw;
  console.warn('[onward/db] bad kind', raw);
  return 'self_action';
}

function sanitizeStatus(raw, fallback = 'not_started') {
  if (ALLOWED_STATUSES.includes(raw)) return raw;
  return fallback;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

async function createGoalRaw({
  title,
  deadline,
  goalType = null,
  status = 'active',
  context = null,
}) {
  return unwrap(
    await supabase
      .from('Goal')
      .insert({
        title,
        deadline,
        goal_type: goalType,
        status,
        context,
      })
      .select()
      .single(),
    'createGoal'
  );
}

export async function getGoal(goalId) {
  return cached(`goal:${goalId}`, READ_TTL_MS, async () => {
    return unwrap(
      await supabase.from('Goal').select('*').eq('id', goalId).maybeSingle(),
      'getGoal'
    );
  });
}

export async function listGoals({ status = null } = {}) {
  return cached(`goals:${status ?? 'all'}`, READ_TTL_MS, async () => {
    let query = supabase
      .from('Goal')
      .select('*')
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    return unwrap(await query, 'listGoals');
  });
}

async function updateGoalRaw(goalId, patch) {
  return unwrap(
    await supabase
      .from('Goal')
      .update(patch)
      .eq('id', goalId)
      .select()
      .single(),
    'updateGoal'
  );
}

async function deleteGoalRaw(goalId) {
  return unwrap(
    await supabase.from('Goal').delete().eq('id', goalId),
    'deleteGoal'
  );
}

// ---------------------------------------------------------------------------
// Requirement
// ---------------------------------------------------------------------------

async function createRequirementRaw({
  goalId,
  label,
  kind,
  status = 'not_started',
  dependsOn = null,
  typicalTurnaroundDays = null,
  requestedAt = null,
  receivedAt = null,
  notes = null,
  dueAt = null,
  expectedAt = null,
  linkedRequirementId = null,
}) {
  return unwrap(
    await supabase
      .from('Requirement')
      .insert({
        goal_id: goalId,
        label,
        kind,
        status,
        depends_on: dependsOn,
        typical_turnaround_days: typicalTurnaroundDays,
        requested_at: requestedAt,
        received_at: receivedAt,
        notes,
        due_at: dueAt,
        expected_at: expectedAt,
        linked_requirement_id: linkedRequirementId,
      })
      .select()
      .single(),
    'createRequirement'
  );
}

/**
 * Batch version of createRequirement. Inserts all rows in one round trip.
 * Returns the inserted rows in the same order as the input array.
 *
 * Sanitizes kind and status inline before building rows, so a bad value
 * from the LLM or a service never reaches the database constraint.
 */
async function createRequirementsBatchRaw(goalId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const rows = items.map((it) => ({
    goal_id: goalId,
    label: it.label,
    kind: sanitizeKind(it.kind),
    status: sanitizeStatus(it.status, 'not_started'),
    depends_on: it.dependsOn ?? null,
    typical_turnaround_days: it.typicalTurnaroundDays ?? null,
    requested_at: it.requestedAt ?? null,
    received_at: it.receivedAt ?? null,
    notes: it.notes ?? null,
    due_at: it.dueAt ?? null,
    expected_at: it.expectedAt ?? null,
    linked_requirement_id: it.linkedRequirementId ?? null,
  }));

  const data = unwrap(
    await supabase
      .from('Requirement')
      .insert(rows)
      .select(),
    'createRequirementsBatch'
  );

  return sortByCreatedAtThenInputOrder(data, rows, items);
}

export async function getRequirement(requirementId) {
  for (const [key, e] of readCache) {
    if (key.startsWith('reqs:') && fresh(e) && Array.isArray(e.value)) {
      const hit = e.value.find((r) => r && r.id === requirementId);
      if (hit) return clone(hit);
    }
  }
  return unwrap(
    await supabase
      .from('Requirement')
      .select('*')
      .eq('id', requirementId)
      .maybeSingle(),
    'getRequirement'
  );
}

export async function listRequirementsForGoal(goalId) {
  const hit = readCache.get(`reqs:${goalId}`);
  if (fresh(hit)) return clone(hit.value);
  const rows = unwrap(
    await supabase
      .from('Requirement')
      .select('*')
      .eq('goal_id', goalId)
      .order('created_at', { ascending: true }),
    'listRequirementsForGoal'
  );
  readCache.set(`reqs:${goalId}`, { at: Date.now(), value: clone(rows) });
  return rows;
}

/**
 * Batch version of listRequirementsForGoal. Goals already in the cache are
 * served from memory; the rest are fetched in one query.
 * Returns [] for an empty input without touching the database.
 */
export async function listRequirementsForGoals(goalIds) {
  if (!Array.isArray(goalIds) || goalIds.length === 0) return [];

  const out = [];
  const missing = [];
  for (const id of goalIds) {
    const hit = readCache.get(`reqs:${id}`);
    if (fresh(hit)) out.push(...hit.value);
    else missing.push(id);
  }

  if (missing.length > 0) {
    const rows = unwrap(
      await supabase
        .from('Requirement')
        .select('*')
        .in('goal_id', missing)
        .order('created_at', { ascending: true }),
      'listRequirementsForGoals'
    );
    const byGoal = new Map(missing.map((id) => [id, []]));
    for (const r of rows) {
      if (!byGoal.has(r.goal_id)) byGoal.set(r.goal_id, []);
      byGoal.get(r.goal_id).push(r);
    }
    for (const [id, list] of byGoal) {
      readCache.set(`reqs:${id}`, { at: Date.now(), value: clone(list) });
    }
    out.push(...rows);
  }

  out.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return clone(out);
}

async function updateRequirementRaw(requirementId, patch) {
  return unwrap(
    await supabase
      .from('Requirement')
      .update(patch)
      .eq('id', requirementId)
      .select()
      .single(),
    'updateRequirement'
  );
}

async function deleteRequirementsRaw(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return unwrap(
    await supabase.from('Requirement').delete().in('id', ids),
    'deleteRequirements'
  );
}

async function deleteRequirementRaw(requirementId) {
  return unwrap(
    await supabase.from('Requirement').delete().eq('id', requirementId),
    'deleteRequirement'
  );
}

// ---------------------------------------------------------------------------
// Event (append-only log)
// ---------------------------------------------------------------------------

async function appendEventRaw({
  goalId,
  requirementId = null,
  rawText = null,
  interpretedChange = {},
}) {
  return unwrap(
    await supabase
      .from('Event')
      .insert({
        goal_id: goalId,
        requirement_id: requirementId,
        raw_text: rawText,
        interpreted_change: interpretedChange,
      })
      .select()
      .single(),
    'appendEvent'
  );
}

/**
 * Batch version of appendEvent. Inserts all rows in one round trip.
 */
async function appendEventsBatchRaw(events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const rows = events.map((e) => ({
    goal_id: e.goalId,
    requirement_id: e.requirementId ?? null,
    raw_text: e.rawText ?? null,
    interpreted_change: e.interpretedChange ?? {},
  }));

  return unwrap(
    await supabase
      .from('Event')
      .insert(rows)
      .select(),
    'appendEventsBatch'
  );
}

export async function listEventsForGoal(goalId, { limit = 100 } = {}) {
  await flushQueue();
  return unwrap(
    await supabase
      .from('Event')
      .select('*')
      .eq('goal_id', goalId)
      .order('timestamp', { ascending: false })
      .limit(limit),
    'listEventsForGoal'
  );
}

export async function listEventsForRequirement(requirementId) {
  await flushQueue();
  return unwrap(
    await supabase
      .from('Event')
      .select('*')
      .eq('requirement_id', requirementId)
      .order('timestamp', { ascending: false }),
    'listEventsForRequirement'
  );
}

// ---------------------------------------------------------------------------
// GoalTypeTemplate
// ---------------------------------------------------------------------------

export async function createGoalTypeTemplate({
  goalType,
  label,
  kind,
  typicalTurnaroundDays = null,
  isCommonlyMissed = false,
}) {
  return unwrap(
    await supabase
      .from('GoalTypeTemplate')
      .insert({
        goal_type: goalType,
        label,
        kind,
        typical_turnaround_days: typicalTurnaroundDays,
        is_commonly_missed: isCommonlyMissed,
      })
      .select()
      .single(),
    'createGoalTypeTemplate'
  );
}

export async function listGoalTypeTemplates(goalType) {
  return cached(`tpl:${goalType}`, TEMPLATE_TTL_MS, async () => {
    return unwrap(
      await supabase
        .from('GoalTypeTemplate')
        .select('*')
        .eq('goal_type', goalType),
      'listGoalTypeTemplates'
    );
  });
}

export async function listAllGoalTypeNames() {
  return cached('tplNames', TEMPLATE_TTL_MS, async () => {
    const rows = unwrap(
      await supabase.from('GoalTypeTemplate').select('goal_type'),
      'listAllGoalTypeNames'
    );
    return [...new Set(rows.map((r) => r.goal_type))];
  });
}

// ---------------------------------------------------------------------------
// RiskAssessment (cache of derived state; never a source of truth)
// ---------------------------------------------------------------------------

export async function recordRiskAssessment({
  goalId,
  riskLevel,
  reasons = [],
}) {
  return unwrap(
    await supabase
      .from('RiskAssessment')
      .insert({
        goal_id: goalId,
        risk_level: riskLevel,
        reasons,
      })
      .select()
      .single(),
    'recordRiskAssessment'
  );
}

export async function getLatestRiskAssessment(goalId) {
  return unwrap(
    await supabase
      .from('RiskAssessment')
      .select('*')
      .eq('goal_id', goalId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    'getLatestRiskAssessment'
  );
}

export async function listRiskAssessmentsForGoal(goalId, { limit = 50 } = {}) {
  return unwrap(
    await supabase
      .from('RiskAssessment')
      .select('*')
      .eq('goal_id', goalId)
      .order('computed_at', { ascending: false })
      .limit(limit),
    'listRiskAssessmentsForGoal'
  );
}

// ---------------------------------------------------------------------------
// Session (single-row table for state that must survive process restarts)
//
// The session is read on every conversational turn and written on most.
// We cache it in module memory so the DB is touched once per process
// instead of once per turn. saveSession writes through to both the DB
// and the cache, and short-circuits the write entirely when the three
// conversational fields are unchanged.
//
// recent_turns is a separate column that appendTurn owns. saveSession
// never writes it, so it can't be clobbered by a pending-state update.
// ---------------------------------------------------------------------------

const SESSION_ID = 'default';

let sessionCache = null;

export async function getSession() {
  if (sessionCache) return sessionCache;

  const row = unwrap(
    await supabase
      .from('Session')
      .select('*')
      .eq('id', SESSION_ID)
      .maybeSingle(),
    'getSession'
  );

  if (row) {
    sessionCache = row;
    return row;
  }

  // Lazily create the single row on first use.
  const created = unwrap(
    await supabase
      .from('Session')
      .insert({
        id: SESSION_ID,
        pending_confirmation: null,
        pending_flag: null,
        active_goal_id: null,
      })
      .select()
      .single(),
    'getSession:create'
  );
  sessionCache = created;
  return created;
}

export async function saveSession({
  pendingConfirmation = null,
  pendingFlag = null,
  activeGoalId = null,
} = {}) {
  // Short-circuit: if the three conversational fields are identical to
  // what we already have cached, there is nothing to write.
  if (sessionCache) {
    const cachedPC = JSON.stringify(sessionCache.pending_confirmation ?? null);
    const cachedPF = JSON.stringify(sessionCache.pending_flag ?? null);
    const cachedAG = sessionCache.active_goal_id ?? null;

    const nextPC = JSON.stringify(pendingConfirmation ?? null);
    const nextPF = JSON.stringify(pendingFlag ?? null);
    const nextAG = activeGoalId ?? null;

    if (cachedPC === nextPC && cachedPF === nextPF && cachedAG === nextAG) {
      return sessionCache;
    }
  }

  // Warm cache: update it now and write to the database in the background.
  // Nothing in the reply depends on this write landing first.
  if (sessionCache) {
    const optimistic = {
      ...sessionCache,
      pending_confirmation: pendingConfirmation,
      pending_flag: pendingFlag,
      active_goal_id: activeGoalId,
      updated_at: new Date().toISOString(),
    };
    sessionCache = optimistic;
    queueWrite('saveSession', async () =>
      unwrap(
        await supabase
          .from('Session')
          .upsert(
            {
              id: SESSION_ID,
              pending_confirmation: pendingConfirmation,
              pending_flag: pendingFlag,
              active_goal_id: activeGoalId,
              updated_at: optimistic.updated_at,
            },
            { onConflict: 'id' }
          )
          .select()
          .single(),
        'saveSession'
      )
    );
    return optimistic;
  }

  const updated = unwrap(
    await supabase
      .from('Session')
      .upsert(
        {
          id: SESSION_ID,
          pending_confirmation: pendingConfirmation,
          pending_flag: pendingFlag,
          active_goal_id: activeGoalId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .select()
      .single(),
    'saveSession'
  );
  sessionCache = updated;
  return updated;
}

/**
 * Append one exchange to Session.recent_turns.
 *
 * Keeps the last 10 messages. Each content is cut to 400 characters.
 * User and assistant text are stored as separate entries, in order.
 *
 * The cache is updated first, then the DB write is fired for just this
 * column. If the write fails, the local cache is still consistent and
 * the caller keeps working — logging is the caller's job.
 */
export async function appendTurn(userText, assistantText) {
  // Make sure the cache is warm.
  if (!sessionCache) {
    await getSession();
  }
  if (!sessionCache) return null;

  const existing = Array.isArray(sessionCache.recent_turns)
    ? sessionCache.recent_turns
    : [];

  const now = Date.now();
  const entries = [];
  if (typeof userText === 'string' && userText.length > 0) {
    entries.push({ role: 'user', content: userText.slice(0, 400) });
  }
  if (typeof assistantText === 'string' && assistantText.length > 0) {
    entries.push({ role: 'assistant', content: assistantText.slice(0, 400) });
  }
  if (entries.length === 0) return sessionCache;

  // Attach a timestamp so ordering survives round-tripping through JSON.
  const stamped = entries.map((e, i) => ({ ...e, ts: now + i }));

  const merged = [...existing, ...stamped].slice(-10);

  // Update the cache before the write.
  sessionCache = { ...sessionCache, recent_turns: merged };

  try {
    await supabase
      .from('Session')
      .update({ recent_turns: merged })
      .eq('id', SESSION_ID);
  } catch (e) {
    console.warn('[onward/db] appendTurn write failed:', e.message);
  }

  return sessionCache;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sort a batch-inserted set of rows to match the input order. Postgres
 * usually returns rows in insertion order when using .select() after an
 * insert, but this is not guaranteed if the timestamp collides.
 */
function sortByCreatedAtThenInputOrder(rows, rawRows, inputItems) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const orderKey = (label, kind) => `${label}::${kind}`;
  const preferred = new Map();
  inputItems.forEach((it, idx) => {
    if (!preferred.has(orderKey(it.label, it.kind))) {
      preferred.set(orderKey(it.label, it.kind), idx);
    }
  });

  return [...rows].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    const ia = preferred.get(orderKey(a.label, a.kind)) ?? Number.MAX_SAFE_INTEGER;
    const ib = preferred.get(orderKey(b.label, b.kind)) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
}
export async function createGoal(...args) {
  try {
    const row = await createGoalRaw(...args);
    readCache.set(`goal:${row.id}`, { at: Date.now(), value: clone(row) });
    readCache.set(`reqs:${row.id}`, { at: Date.now(), value: [] });
    for (const [key, e] of readCache) {
      if (!key.startsWith('goals:') || !Array.isArray(e.value)) continue;
      if (key === 'goals:all' || key === `goals:${row.status}`) e.value = [clone(row), ...e.value];
    }
    return row;
  } catch (e) {
    bust();
    throw e;
  }
}

export async function updateGoal(goalId, patch) {
  patchCachedGoal(goalId, patch);
  try {
    const row = await updateGoalRaw(goalId, patch);
    const { status, ...rest } = row ?? {};
    if (patch && 'status' in patch) {
      // The goal may have moved between status lists. Refetch the lists only.
      dropKeys('goals:');
      patchCachedGoal(goalId, row);
    } else {
      patchCachedGoal(goalId, rest);
    }
    return row;
  } catch (e) {
    bust();
    throw e;
  }
}

export async function deleteGoal(goalId) {
  try {
    const r = await deleteGoalRaw(goalId);
    readCache.delete(`goal:${goalId}`);
    readCache.delete(`reqs:${goalId}`);
    for (const [key, e] of readCache) {
      if (key.startsWith('goals:') && Array.isArray(e.value)) {
        e.value = e.value.filter((g) => !(g && g.id === goalId));
      }
    }
    return r;
  } catch (e) {
    bust();
    throw e;
  }
}

export async function createRequirement(...args) {
  try {
    const row = await createRequirementRaw(...args);
    if (row && row.goal_id) mutateReqList(row.goal_id, (list) => [...list, clone(row)]);
    return row;
  } catch (e) {
    bust();
    throw e;
  }
}

export async function createRequirementsBatch(...args) {
  try {
    const rows = await createRequirementsBatchRaw(...args);
    for (const row of rows) {
      if (row && row.goal_id) mutateReqList(row.goal_id, (list) => [...list, clone(row)]);
    }
    return rows;
  } catch (e) {
    bust();
    throw e;
  }
}

export async function updateRequirement(requirementId, patch) {
  const moves = patch && 'goal_id' in patch;
  if (moves) dropKeys('reqs:');
  else patchCachedRequirement(requirementId, patch);
  try {
    const row = await updateRequirementRaw(requirementId, patch);
    if (moves) {
      dropKeys('reqs:');
    } else {
      const { goal_id, ...rest } = row ?? {};
      patchCachedRequirement(requirementId, rest);
    }
    return row;
  } catch (e) {
    bust();
    throw e;
  }
}

export async function deleteRequirement(requirementId) {
  try {
    const r = await deleteRequirementRaw(requirementId);
    removeCachedRequirements([requirementId]);
    return r;
  } catch (e) {
    bust();
    throw e;
  }
}

// One query for many requirements (used when deleting a whole goal).
export async function deleteRequirements(ids) {
  try {
    const r = await deleteRequirementsRaw(ids);
    removeCachedRequirements(ids);
    return r;
  } catch (e) {
    bust();
    throw e;
  }
}

export function appendEvent(args) {
  queueWrite('appendEvent', () => appendEventRaw(args));
  return Promise.resolve(null);
}

export function appendEventsBatch(events) {
  if (!Array.isArray(events) || events.length === 0) return Promise.resolve([]);
  queueWrite('appendEventsBatch', () => appendEventsBatchRaw(events));
  return Promise.resolve([]);
}