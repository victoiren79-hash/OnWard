// Onward — itemized report rendering.
//
// Pure functions. No I/O. No LLM. No clock.
// Every line emitted here is a direct rendering of an input field.
// If a claim cannot be traced to an input, it is not written.
//
// Defensive dedup: if the caller passes duplicate requirements (same id)
// or duplicate goals (same id), we render each once.

const STATUS_GLYPH = Object.freeze({
  done: '✅',
  waiting_on_other: '⏳',
  in_progress: '▶',
  not_started: '⬜',
});

const STATUS_LABEL = Object.freeze({
  done: 'done',
  waiting_on_other: 'waiting on someone',
  in_progress: 'in progress',
  not_started: 'not started',
});

const RISK_LABEL = Object.freeze({
  ok: 'on track',
  tight: 'tight',
  at_risk: 'at risk',
  critical: 'critical',
});

// ---------------------------------------------------------------------------
// renderGoalReport
// ---------------------------------------------------------------------------

export function renderGoalReport(goal, requirements, risk = null, today = null) {
  if (!goal || !goal.id) {
    throw new Error('[onward/report] renderGoalReport: goal with id is required');
  }
  const reqs = dedupeRequirements(Array.isArray(requirements) ? requirements : []);

  const lines = [];

  lines.push(`${goal.title ?? '(untitled goal)'} — deadline ${formatDate(goal.deadline)}`);
  const daysLeft = daysLeftLine(goal.deadline, today);
  if (daysLeft) lines.push(daysLeft);
  if (risk) {
    lines.push(`Risk: ${RISK_LABEL[risk.risk_level] ?? risk.risk_level}`);
    for (const reason of risk.reasons ?? []) {
      const line = renderReason(reason);
      if (line) lines.push(`  • ${line}`);
    }
  }
  lines.push('');

  if (reqs.length === 0) {
    lines.push('No requirements recorded yet.');
    return {
      lines,
      data: { goal_id: goal.id, items: [], risk_level: risk?.risk_level ?? null },
    };
  }

  const sorted = [...reqs].sort(compareForDisplay);

  const items = [];
  for (const r of sorted) {
    const glyph = STATUS_GLYPH[r.status] ?? '?';
    const label = STATUS_LABEL[r.status] ?? r.status;
    let line = `${glyph} ${r.label} — ${label}`;

    if (r.status === 'waiting_on_other') {
      const who = r.depends_on ? ` (${r.depends_on})` : '';
      const since = r.requested_at ? `, requested ${formatDate(r.requested_at)}` : '';
      const expected = r.expected_at ? `, expected ${formatDate(r.expected_at)}` : '';
      line += `${who}${since}${expected}`;
    } else if (r.status === 'done' && r.received_at) {
      line += ` (${formatDate(r.received_at)})`;
    } else if (r.due_at) {
      line += ` — due ${formatDate(r.due_at)}`;
    }

    lines.push(line);
    items.push({
      requirement_id: r.id,
      label: r.label,
      kind: r.kind,
      status: r.status,
      status_label: label,
      depends_on: r.depends_on ?? null,
      requested_at: r.requested_at ?? null,
      received_at: r.received_at ?? null,
      due_at: r.due_at ?? null,
      expected_at: r.expected_at ?? null,
    });
  }

  // Summary line — omit zero counts.
  const summary = renderSummaryLine(reqs);
  if (summary) {
    lines.push('');
    lines.push(summary);
  }

  return {
    lines,
    data: {
      goal_id: goal.id,
      title: goal.title ?? null,
      deadline: goal.deadline ?? null,
      risk_level: risk?.risk_level ?? null,
      items,
    },
  };
}

// ---------------------------------------------------------------------------
// renderRiskReport
// ---------------------------------------------------------------------------

export function renderRiskReport(entries) {
  const list = Array.isArray(entries) ? entries : [];

  // Dedupe goals by id.
  const seenGoals = new Set();
  const uniqueEntries = list.filter((e) => {
    if (!e || !e.goal?.id) return false;
    if (seenGoals.has(e.goal.id)) return false;
    seenGoals.add(e.goal.id);
    return true;
  });

  const flagged = uniqueEntries.filter(
    (e) =>
      e.risk &&
      (e.risk.risk_level === 'at_risk' || e.risk.risk_level === 'critical')
  );

  const lines = [];
  if (flagged.length === 0) {
    lines.push('Nothing is at risk right now.');
    return { lines, data: { at_risk: [] } };
  }

  const atRisk = [];
  for (const { goal, risk } of flagged) {
    lines.push(`${goal.title ?? '(untitled goal)'} — ${RISK_LABEL[risk.risk_level] ?? risk.risk_level}`);
    lines.push(`Deadline ${formatDate(goal.deadline)}, slack ${risk.slack_days} days.`);

    for (const reason of risk.reasons ?? []) {
      const line = renderReason(reason);
      if (line) lines.push(`  • ${line}`);
    }

    lines.push('');
    atRisk.push({
      goal_id: goal.id,
      title: goal.title ?? null,
      risk_level: risk.risk_level,
      slack_days: risk.slack_days,
      critical_path_days: risk.critical_path_days,
      reasons: risk.reasons ?? [],
    });
  }

  if (lines[lines.length - 1] === '') lines.pop();

  return { lines, data: { at_risk: atRisk } };
}

// ---------------------------------------------------------------------------
// renderActionReport
// ---------------------------------------------------------------------------

export function renderActionReport(entries, today = null) {
  const list = Array.isArray(entries) ? entries : [];

  const seenGoals = new Set();
  const ranked = list
    .filter((e) => e && e.goal && Array.isArray(e.requirements))
    .filter((e) => {
      if (seenGoals.has(e.goal.id)) return false;
      seenGoals.add(e.goal.id);
      return true;
    })
    .map((e) => {
      const outstanding = dedupeRequirements(
        e.requirements.filter((r) => r && r.status !== 'done')
      );
      return { ...e, outstanding };
    })
    .filter((e) => e.outstanding.length > 0)
    .sort((a, b) => rankLevel(b.risk?.risk_level) - rankLevel(a.risk?.risk_level));

  const lines = [];
  const data = { goals: [] };

  if (ranked.length === 0) {
    lines.push('Nothing outstanding right now.');
    return { lines, data };
  }

  for (const entry of ranked) {
    const { goal, outstanding, risk } = entry;
    lines.push(`${goal.title ?? '(untitled goal)'} — deadline ${formatDate(goal.deadline)}`);
    const daysLeft = daysLeftLine(goal.deadline, today);
    if (daysLeft) lines.push(daysLeft);
    if (risk) {
      lines.push(`Risk: ${RISK_LABEL[risk.risk_level] ?? risk.risk_level}`);
      for (const reason of risk.reasons ?? []) {
        const line = renderReason(reason);
        if (line) lines.push(`  • ${line}`);
      }
    }

    const priorityIds = collectPriorityIds(risk);
    const sorted = [...outstanding].sort((a, b) =>
      compareActionPriority(a, b, priorityIds)
    );

    const items = [];
    for (const r of sorted) {
      const glyph = STATUS_GLYPH[r.status] ?? '?';
      let line = `${glyph} ${r.label}`;
      if (r.status === 'waiting_on_other') {
        const who = r.depends_on ? ` — with ${r.depends_on}` : '';
        const since = r.requested_at ? ` since ${formatDate(r.requested_at)}` : '';
        const expected = r.expected_at ? `, expected ${formatDate(r.expected_at)}` : '';
        line += `${who}${since}${expected}`;
      } else if (r.status === 'in_progress') {
        line += ' — in progress';
      }
      if (r.due_at) line += ` — due ${formatDate(r.due_at)}`;
      lines.push(`  ${line}`);
      items.push({
        requirement_id: r.id,
        label: r.label,
        kind: r.kind,
        status: r.status,
        depends_on: r.depends_on ?? null,
        requested_at: r.requested_at ?? null,
        due_at: r.due_at ?? null,
        expected_at: r.expected_at ?? null,
      });
    }

    lines.push('');
    data.goals.push({
      goal_id: goal.id,
      title: goal.title ?? null,
      deadline: goal.deadline ?? null,
      risk_level: risk?.risk_level ?? null,
      outstanding: items,
    });
  }

  if (lines[lines.length - 1] === '') lines.pop();

  return { lines, data };
}

// ---------------------------------------------------------------------------
// renderLateOptions
// ---------------------------------------------------------------------------

/**
 * One spoken sentence listing the ways to handle an item that cannot
 * arrive before its deadline.
 */
export function renderLateOptions(label, dependsOn) {
  const who = dependsOn && String(dependsOn).trim() ? dependsOn : 'whoever is receiving it';
  return (
    `A few ways to handle it: ask ${who} if it can come in late, ` +
    `give ${label} its own later date and keep the goal deadline for everything else, ` +
    `or push the whole goal back. Which sounds best?`
  );
}

// ---------------------------------------------------------------------------
// renderAdvice
// ---------------------------------------------------------------------------

/**
 * Per goal: for each expected_after_deadline reason print its
 * renderReason line followed by renderLateOptions; for each
 * past_turnaround print its line plus a nudge to draft a follow-up.
 * If the goal has neither, print a short reassuring line.
 */
export function renderAdvice(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set();
  const unique = list.filter((e) => {
    if (!e || !e.goal?.id) return false;
    if (seen.has(e.goal.id)) return false;
    seen.add(e.goal.id);
    return true;
  });

  const lines = [];
  const data = { advice: [] };

  if (unique.length === 0) {
    lines.push('Nothing to advise on right now.');
    return { lines, data };
  }

  for (const entry of unique) {
    const { goal, risk } = entry;
    const reasons = risk?.reasons ?? [];
    const lateReasons = reasons.filter((r) => r.kind === 'expected_after_deadline');
    const overdueReasons = reasons.filter((r) => r.kind === 'past_turnaround');

    if (lateReasons.length === 0 && overdueReasons.length === 0) {
      lines.push(`Nothing is blocking "${goal.title ?? '(untitled goal)'}" right now.`);
      lines.push('');
      continue;
    }

    lines.push(`${goal.title ?? '(untitled goal)'} — deadline ${formatDate(goal.deadline)}`);
    lines.push('');

    for (const r of lateReasons) {
      const line = renderReason(r);
      if (line) lines.push(line);
      const dependsOn = lookupDependsOn(entry.requirements, r.requirement_id);
      lines.push(renderLateOptions(r.label, dependsOn));
      lines.push('');
    }

    for (const r of overdueReasons) {
      const line = renderReason(r);
      if (line) lines.push(line);
      lines.push(`Say "draft a follow-up" and I'll write one.`);
      lines.push('');
    }

    data.advice.push({
      goal_id: goal.id,
      title: goal.title ?? null,
      late: lateReasons.map((r) => ({ requirement_id: r.requirement_id, label: r.label })),
      overdue: overdueReasons.map((r) => ({ requirement_id: r.requirement_id, label: r.label })),
    });
  }

  if (lines[lines.length - 1] === '') lines.pop();

  return { lines, data };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function daysLeftLine(deadline, today) {
  if (!deadline || !today) return null;
  const d = coerceDate(deadline);
  const t = coerceDate(today);
  if (!d || !t) return null;

  const n = calDay(d) - calDay(t);
  if (n > 1) return `${n} days left`;
  if (n === 1) return '1 day left';
  if (n === 0) return 'due today';
  const over = Math.abs(n);
  return `overdue by ${over} day${over === 1 ? '' : 's'}`;
}

function calDay(d) {
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000
  );
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

function dedupeRequirements(reqs) {
  const seen = new Set();
  const out = [];
  for (const r of reqs) {
    if (!r || !r.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function renderReason(reason) {
  if (!reason || typeof reason !== 'object') return null;

  switch (reason.kind) {
    case 'deadline_passed':
      return `Deadline passed ${reason.days_over} day${plural(reason.days_over)} ago.`;

    case 'past_turnaround':
      return `${reason.label} is ${reason.days_overdue} day${plural(
        reason.days_overdue
      )} past its expected turnaround.`;

    case 'expected_after_deadline':
      return `${reason.label} is expected ${reason.expected_at}, ${reason.days_late} day${plural(
        reason.days_late
      )} after its deadline.`;

    case 'task_overdue':
      return `"${reason.label}" was due ${reason.days_over} day${plural(reason.days_over)} ago.`;

    case 'critical_path_driver':
      return `${reason.label} still needs ~${reason.remaining_days} day${plural(
        reason.remaining_days
      )} — this is what the timeline is waiting on.`;

    case 'self_actions_outstanding':
      return `${reason.count} of your own item${plural(reason.count)} still open: ${reason.labels.join(
        ', '
      )}.`;

    case 'no_external_deps':
      return null;

    default:
      return `${reason.kind}`;
  }
}

function renderSummaryLine(reqs) {
  const counts = { done: 0, waiting_on_other: 0, in_progress: 0, not_started: 0 };
  for (const r of reqs) {
    if (r && counts[r.status] != null) counts[r.status] += 1;
  }
  const parts = [];
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.waiting_on_other > 0) parts.push(`${counts.waiting_on_other} waiting`);
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} in progress`);
  if (counts.not_started > 0) parts.push(`${counts.not_started} not started`);
  return parts.join(', ');
}

function compareForDisplay(a, b) {
  const ad = a.status === 'done' ? 1 : 0;
  const bd = b.status === 'done' ? 1 : 0;
  if (ad !== bd) return ad - bd;
  const ae = a.kind === 'external_dependency' ? 0 : 1;
  const be = b.kind === 'external_dependency' ? 0 : 1;
  if (ae !== be) return ae - be;
  return String(a.label).localeCompare(String(b.label));
}

/**
 * Risk-aware priority order for action reports.
 *
 * Items whose id appears in a past_turnaround or expected_after_deadline
 * reason sort first. Then:
 *   1. external not_started
 *   2. external waiting_on_other
 *   3. self tasks by due_at ascending (items without due_at last)
 *   4. in_progress
 *   5. not_started
 * Alphabetical for ties.
 */
function compareActionPriority(a, b, priorityIds) {
  const ap = priorityIds.has(a.id) ? 0 : 1;
  const bp = priorityIds.has(b.id) ? 0 : 1;
  if (ap !== bp) return ap - bp;

  const ao = actionBucket(a);
  const bo = actionBucket(b);
  if (ao !== bo) return ao - bo;

  // Within the self-task-by-due_at bucket, sort by due_at ascending,
  // items without due_at last, then alphabetical.
  if (ao === 2) {
    const ad = a.due_at ? coerceDate(a.due_at) : null;
    const bd = b.due_at ? coerceDate(b.due_at) : null;
    const am = ad ? ad.getTime() : Number.MAX_SAFE_INTEGER;
    const bm = bd ? bd.getTime() : Number.MAX_SAFE_INTEGER;
    if (am !== bm) return am - bm;
  }

  return String(a.label).localeCompare(String(b.label));
}

function actionBucket(r) {
  if (r.kind === 'external_dependency') {
    if (r.status === 'not_started') return 0;
    if (r.status === 'waiting_on_other') return 1;
    return 1;
  }
  // self_action
  if (r.due_at) return 2;
  if (r.status === 'in_progress') return 3;
  return 4;
}

function collectPriorityIds(risk) {
  const set = new Set();
  for (const r of risk?.reasons ?? []) {
    if (r.kind === 'past_turnaround' || r.kind === 'expected_after_deadline') {
      if (r.requirement_id) set.add(r.requirement_id);
    }
  }
  return set;
}

function lookupDependsOn(requirements, requirementId) {
  if (!Array.isArray(requirements)) return null;
  const hit = requirements.find((r) => r && r.id === requirementId);
  return hit?.depends_on ?? null;
}

function rankLevel(level) {
  return { ok: 0, tight: 1, at_risk: 2, critical: 3 }[level] ?? -1;
}

function formatDate(d) {
  if (!d) return '(no date)';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '(invalid date)';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function plural(n) {
  return Number(n) === 1 ? '' : 's';
}