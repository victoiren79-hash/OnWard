// Onward — MCP server over Streamable HTTP, plus a minimal frontend host.
//
// Endpoints:
//   GET  /                     → serves index.html (at project root)
//   POST /mcp                  → MCP JSON-RPC
//   POST /demo/advance         → demo/test aid: advance the in-process clock
//   POST /demo/reset           → demo/test aid: reset the clock to real time
//   GET  /demo/clock-state     → demo/test aid: read the clock without changing it
//   GET  /demo/pending-flag    → demo/test aid: return the session's pending flag (validated)

import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { handleStatement, reevaluateAllGoals, getValidatedPendingFlag } from './orchestrator.js';
import {
  listGoals,
  getGoal,
  getRequirement,
  listRequirementsForGoal,
  listEventsForGoal,
  deleteGoal,
  deleteRequirement,
  getSession,
} from './db.js';
import { getSendFollowupTool } from './services/actionExecutor.js';
import { readTimeTag, writeTimeTag } from './services/conversation.js';

// ---------------------------------------------------------------------------
// send_followup tool
// ---------------------------------------------------------------------------

const sendFollowup = getSendFollowupTool();

// ---------------------------------------------------------------------------
// Tool handler registration
// ---------------------------------------------------------------------------

function registerToolHandlers(srv) {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'report_statement',
        description:
          'Send a user statement to Onward. Handles goal creation, progress ' +
          'updates, queries, confirmations, and deletions.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: "The user's message, verbatim." },
          },
          required: ['text'],
        },
      },
      {
        name: 'list_goals',
        description: 'List goals, optionally filtered by status.',
        inputSchema: {
          type: 'object',
          properties: {
            status_filter: {
              type: 'string',
              enum: ['active', 'completed', 'abandoned'],
            },
          },
        },
      },
      {
        name: 'get_goal',
        description: 'Get one goal with its requirements and recent event history.',
        inputSchema: {
          type: 'object',
          properties: {
            goal_id: { type: 'string' },
            event_limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
          required: ['goal_id'],
        },
      },
      {
        name: 'delete_goal',
        description:
          'Delete a goal and all its requirements. Destructive — the chat ' +
          'path already confirms before deleting; this tool exists for ' +
          'programmatic clients that take responsibility for confirmation.',
        inputSchema: {
          type: 'object',
          properties: { goal_id: { type: 'string' } },
          required: ['goal_id'],
        },
      },
      {
        name: 'delete_requirement',
        description:
          'Delete a single requirement from its goal. Destructive.',
        inputSchema: {
          type: 'object',
          properties: { requirement_id: { type: 'string' } },
          required: ['requirement_id'],
        },
      },
      sendFollowup.definition,
    ],
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      switch (name) {
        case 'report_statement':   return await toolReportStatement(args);
        case 'list_goals':         return await toolListGoals(args);
        case 'get_goal':           return await toolGetGoal(args);
        case 'delete_goal':        return await toolDeleteGoal(args);
        case 'delete_requirement': return await toolDeleteRequirement(args);
        case 'send_followup':      return await sendFollowup.handler(args);
        default:
          return toolError(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return toolError(e.message ?? String(e), e.code);
    }
  });
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolReportStatement(args) {
  const text = args.text;
  if (typeof text !== 'string' || !text.trim()) {
    return toolError('report_statement: "text" is required and must be a non-empty string');
  }
  const response = await handleStatement(text);
  return toolOk(response);
}

async function toolListGoals(args) {
  const status = args.status_filter;
  if (status && !['active', 'completed', 'abandoned'].includes(status)) {
    return toolError('list_goals: "status_filter" must be active, completed, or abandoned');
  }
  const goals = await listGoals({ status: status ?? null });
  return toolOk({
    count: goals.length,
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      deadline: g.deadline,
      deadline_time: readTimeTag(g.context),
      goal_type: g.goal_type,
      status: g.status,
      created_at: g.created_at,
      updated_at: g.updated_at,
    })),
  });
}

async function toolGetGoal(args) {
  const goalId = args.goal_id;
  if (typeof goalId !== 'string' || !goalId.trim()) {
    return toolError('get_goal: "goal_id" is required');
  }
  const limit = Number.isInteger(args.event_limit) ? args.event_limit : 50;

  const goal = await getGoal(goalId);
  if (!goal) return toolError(`get_goal: no goal with id ${goalId}`);

  const [requirements, events] = await Promise.all([
    listRequirementsForGoal(goalId),
    listEventsForGoal(goalId, { limit }),
  ]);

  return toolOk({
    goal: {
      id: goal.id,
      title: goal.title,
      deadline: goal.deadline,
      deadline_time: readTimeTag(goal.context),
      context: writeTimeTag(goal.context ?? null, null),
      goal_type: goal.goal_type,
      status: goal.status,
      created_at: goal.created_at,
      updated_at: goal.updated_at,
    },
    requirements: requirements.map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      status: r.status,
      depends_on: r.depends_on,
      typical_turnaround_days: r.typical_turnaround_days,
      requested_at: r.requested_at,
      received_at: r.received_at,
      due_at: r.due_at,
      due_time: readTimeTag(r.notes),
      expected_at: r.expected_at,
      linked_requirement_id: r.linked_requirement_id,
      notes: writeTimeTag(r.notes ?? null, null),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    events: events.map((e) => ({
      id: e.id,
      requirement_id: e.requirement_id,
      raw_text: e.raw_text,
      interpreted_change: e.interpreted_change,
      timestamp: e.timestamp,
    })),
    event_limit: limit,
  });
}

async function toolDeleteGoal(args) {
  const id = args.goal_id;
  if (typeof id !== 'string' || !id.trim()) {
    return toolError('delete_goal: "goal_id" is required');
  }
  const goal = await getGoal(id);
  if (!goal) return toolError(`delete_goal: no goal with id ${id}`);
  await deleteGoal(id);
  return toolOk({ ok: true, deleted_goal_id: id, title: goal.title });
}

async function toolDeleteRequirement(args) {
  const id = args.requirement_id;
  if (typeof id !== 'string' || !id.trim()) {
    return toolError('delete_requirement: "requirement_id" is required');
  }
  const req = await getRequirement(id);
  if (!req) return toolError(`delete_requirement: no requirement with id ${id}`);
  await deleteRequirement(id);
  return toolOk({ ok: true, deleted_requirement_id: id, label: req.label });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function toolOk(payload) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function toolError(message, code) {
  const body = { error: message };
  if (code) body.code = code;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

async function serveIndex(res) {
  try {
    const html = await fs.readFile(path.join(process.cwd(), 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(
      'Could not load index.html: ' + e.message +
      '\n\nCreate index.html at the project root (next to package.json).'
    );
  }
}

// ---------------------------------------------------------------------------
// Demo clock: advance and reset
// ---------------------------------------------------------------------------

async function handleDemoAdvance(req, res) {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    try {
      const { days } = JSON.parse(body || '{}');
      const n = Number(days);
      if (!Number.isFinite(n)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '"days" must be a finite number' }));
        return;
      }

      const {
        advanceByCumulative,
        now,
        isSimulated,
        simulatedOffsetDays,
      } = await import('./services/clock.js');

      advanceByCumulative(n);

      let evalResult = { checked: 0, flagged: 0, proactive_message: null };
      try {
        evalResult = await reevaluateAllGoals();
      } catch (e) {
        console.error('[onward] reevaluateAllGoals failed during advance:', e);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        advanced_by_days: n,
        now: now().toISOString(),
        simulated: isSimulated(),
        offset_days: simulatedOffsetDays(),
        risk_checked: evalResult.checked,
        risk_flagged: evalResult.flagged,
        proactive_message: evalResult.proactive_message ?? null,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

async function handleDemoReset(res) {
  try {
    const { resetClock, now, isSimulated } = await import('./services/clock.js');
    resetClock();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      now: now().toISOString(),
      simulated: isSimulated(),
    }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleDemoPendingFlag(res) {
  try {
    // Validated, not a raw cache read: a flag left over from before someone
    // cleared the database directly would otherwise keep pointing at a
    // goal that no longer exists. See getValidatedPendingFlag's comment.
    const flag = await getValidatedPendingFlag();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pending_flag: flag }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// Read-only clock status: lets the frontend re-sync the "Clock: ..." display
// after a page refresh WITHOUT mutating the clock. The clock's simulated
// cursor lives only in this process's memory (see services/clock.js) — a
// browser refresh doesn't touch it, but until now there was no way for the
// page to ask "what's the clock actually at?" without calling /demo/advance
// (which moves it) or /demo/reset (which resets it). If the frontend was
// calling either of those just to initialize its display, that would
// explain the clock silently jumping back to real time on every refresh.
async function handleDemoClockState(res) {
  try {
    const { now, isSimulated, simulatedOffsetDays } = await import('./services/clock.js');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      now: now().toISOString(),
      simulated: isSimulated(),
      offset_days: simulatedOffsetDays(),
    }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------

async function handleMcpRequest(req, res) {
  const requestServer = new Server(
    { name: 'onward', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  registerToolHandlers(requestServer);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    requestServer.close().catch(() => {});
  });

  await requestServer.connect(transport);
  await transport.handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);

const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return serveIndex(res);
  }

  if (req.method === 'POST' && req.url === '/demo/advance') {
    return handleDemoAdvance(req, res);
  }

  if (req.method === 'POST' && req.url === '/demo/reset') {
    return handleDemoReset(res);
  }

  if (req.method === 'GET' && req.url === '/demo/pending-flag') {
    return handleDemoPendingFlag(res);
  }

  if (req.method === 'GET' && req.url === '/demo/clock-state') {
    return handleDemoClockState(res);
  }

  if (req.url && req.url.startsWith('/mcp')) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed; use POST /mcp' }));
      return;
    }
    try {
      await handleMcpRequest(req, res);
    } catch (e) {
      console.error('[onward] MCP request error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message ?? 'internal error' }));
      }
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

httpServer.listen(PORT, () => {
  console.error(`[onward] listening on http://localhost:${PORT}`);
  console.error(`[onward]   frontend:  http://localhost:${PORT}/`);
  console.error(`[onward]   MCP:       http://localhost:${PORT}/mcp`);
  console.error(`[onward]   demo:      POST http://localhost:${PORT}/demo/advance`);
  console.error(`[onward]   demo:      POST http://localhost:${PORT}/demo/reset`);
  console.error(`[onward]   demo:      GET  http://localhost:${PORT}/demo/pending-flag`);
  console.error(`[onward]   demo:      GET  http://localhost:${PORT}/demo/clock-state`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`[onward] received ${sig}, shutting down`);
    httpServer.close(() => process.exit(0));
  });
}