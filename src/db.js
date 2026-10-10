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
// Goal
// ---------------------------------------------------------------------------

export async function createGoal({
  title,
  deadline,
  goalType = null,
  status = 'active',
}) {
  return unwrap(
    await supabase
      .from('Goal')
      .insert({
        title,
        deadline,
        goal_type: goalType,
        status,
      })
      .select()
      .single(),
    'createGoal'
  );
}

export async function getGoal(goalId) {
  return unwrap(
    await supabase.from('Goal').select('*').eq('id', goalId).maybeSingle(),
    'getGoal'
  );
}

export async function listGoals({ status = null } = {}) {
  let query = supabase
    .from('Goal')
    .select('*')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  return unwrap(await query, 'listGoals');
}

export async function updateGoal(goalId, patch) {
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

export async function deleteGoal(goalId) {
  return unwrap(
    await supabase.from('Goal').delete().eq('id', goalId),
    'deleteGoal'
  );
}

// ---------------------------------------------------------------------------
// Requirement
// ---------------------------------------------------------------------------

export async function createRequirement({
  goalId,
  label,
  kind,
  status = 'not_started',
  dependsOn = null,
  typicalTurnaroundDays = null,
  requestedAt = null,
  receivedAt = null,
  notes = null,
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
 * @param {string} goalId
 * @param {Array<{label: string, kind: string, status?: string,
 *   dependsOn?: string|null, typicalTurnaroundDays?: number|null,
 *   requestedAt?: string|null, receivedAt?: string|null, notes?: string|null}>} items
 * @returns {Promise<Array<object>>}
 */
export async function createRequirementsBatch(goalId, items) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const rows = items.map((it) => ({
    goal_id: goalId,
    label: it.label,
    kind: it.kind,
    status: it.status ?? 'not_started',
    depends_on: it.dependsOn ?? null,
    typical_turnaround_days: it.typicalTurnaroundDays ?? null,
    requested_at: it.requestedAt ?? null,
    received_at: it.receivedAt ?? null,
    notes: it.notes ?? null,
  }));

  const data = unwrap(
    await supabase
      .from('Requirement')
      .insert(rows)
      .select(),
    'createRequirementsBatch'
  );

  // Postgres returns rows in insertion order for a plain insert with
  // .select(), but we sort defensively by created_at to be safe when
  // multiple rows share the same timestamp.
  return sortByCreatedAtThenInputOrder(data, rows, items);
}

export async function getRequirement(requirementId) {
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
  return unwrap(
    await supabase
      .from('Requirement')
      .select('*')
      .eq('goal_id', goalId)
      .order('created_at', { ascending: true }),
    'listRequirementsForGoal'
  );
}

export async function updateRequirement(requirementId, patch) {
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

export async function deleteRequirement(requirementId) {
  return unwrap(
    await supabase.from('Requirement').delete().eq('id', requirementId),
    'deleteRequirement'
  );
}

// ---------------------------------------------------------------------------
// Event (append-only log)
// ---------------------------------------------------------------------------

export async function appendEvent({
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
 * Returns the inserted rows.
 *
 * @param {Array<{goalId: string, requirementId?: string|null,
 *   rawText?: string|null, interpretedChange?: object}>} events
 * @returns {Promise<Array<object>>}
 */
export async function appendEventsBatch(events) {
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
  return unwrap(
    await supabase
      .from('GoalTypeTemplate')
      .select('*')
      .eq('goal_type', goalType),
    'listGoalTypeTemplates'
  );
}

export async function listAllGoalTypeNames() {
  const rows = unwrap(
    await supabase.from('GoalTypeTemplate').select('goal_type'),
    'listAllGoalTypeNames'
  );
  return [...new Set(rows.map((r) => r.goal_type))];
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
// ---------------------------------------------------------------------------

const SESSION_ID = 'default';

export async function getSession() {
  const row = unwrap(
    await supabase
      .from('Session')
      .select('*')
      .eq('id', SESSION_ID)
      .maybeSingle(),
    'getSession'
  );

  if (row) return row;

  // Lazily create the single row on first use.
  return unwrap(
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
}

export async function saveSession({
  pendingConfirmation = null,
  pendingFlag = null,
  activeGoalId = null,
} = {}) {
  return unwrap(
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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sort a batch-inserted set of rows to match the input order. Postgres
 * usually returns rows in insertion order when using .select() after an
 * insert, but this is not guaranteed if the timestamp collides. We sort
 * by created_at first (stable for near-identical timestamps), then fall
 * back to preserving the input order by matching on the label.
 */
function sortByCreatedAtThenInputOrder(rows, rawRows, inputItems) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  // Build a preferred order index from the input by label + kind.
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