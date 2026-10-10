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

export function renderGoalReport(goal, requirements, risk = null) {
  if (!goal || !goal.id) {
    throw new Error('[onward/report] renderGoalReport: goal with id is required');
  }
  const reqs = dedupeRequirements(Array.isArray(requirements) ? requirements : []);

  const lines = [];

  lines.push(`${goal.title ?? '(untitled goal)'} — deadline ${formatDate(goal.deadline)}`);
  if (risk) {
    lines.push(`Risk: ${RISK_LABEL[risk.risk_level] ?? risk.risk_level}`);
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
      line += `${who}${since}`;
    } else if (r.status === 'done' && r.received_at) {
      line += ` (${formatDate(r.received_at)})`;
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
    });
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

export function renderActionReport(entries) {
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
    if (risk) {
      lines.push(`Risk: ${RISK_LABEL[risk.risk_level] ?? risk.risk_level}`);
    }

    const sorted = [...outstanding].sort(compareActionPriority);

    const items = [];
    for (const r of sorted) {
      const glyph = STATUS_GLYPH[r.status] ?? '?';
      let line = `${glyph} ${r.label}`;
      if (r.status === 'waiting_on_other') {
        const who = r.depends_on ? ` — with ${r.depends_on}` : '';
        const since = r.requested_at ? ` since ${formatDate(r.requested_at)}` : '';
        line += `${who}${since}`;
      } else if (r.status === 'in_progress') {
        line += ' — in progress';
      }
      lines.push(`  ${line}`);
      items.push({
        requirement_id: r.id,
        label: r.label,
        kind: r.kind,
        status: r.status,
        depends_on: r.depends_on ?? null,
        requested_at: r.requested_at ?? null,
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
// Internals
// ---------------------------------------------------------------------------

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

function compareForDisplay(a, b) {
  const ad = a.status === 'done' ? 1 : 0;
  const bd = b.status === 'done' ? 1 : 0;
  if (ad !== bd) return ad - bd;
  const ae = a.kind === 'external_dependency' ? 0 : 1;
  const be = b.kind === 'external_dependency' ? 0 : 1;
  if (ae !== be) return ae - be;
  return String(a.label).localeCompare(String(b.label));
}

function compareActionPriority(a, b) {
  const order = { waiting_on_other: 0, in_progress: 1, not_started: 2, done: 3 };
  const ao = order[a.status] ?? 99;
  const bo = order[b.status] ?? 99;
  if (ao !== bo) return ao - bo;
  return String(a.label).localeCompare(String(b.label));
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