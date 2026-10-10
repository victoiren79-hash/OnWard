// Onward — action execution (draft follow-up, send follow-up).
//
// Two exports:
//   - executeAction(requirementId, actionType) → service
//   - getSendFollowupTool()                    → { definition, handler } for MCP
//
// Real sending is gated behind ENABLE_REAL_SEND=true. Without it, all sends
// go to a sandbox that logs what *would* have been sent and returns a mock
// receipt. Every action — sandboxed or real — is appended to the Event table.
//
// Follow-ups do NOT change a Requirement's status. Sending a reminder does not
// move an item from waiting_on_other to anything else. It is recorded in
// `notes` and in the Event log. This keeps the state machine clean.

import 'dotenv/config';

import { callLLMText } from '../llm.js';
import {
  getRequirement,
  updateRequirement,
  appendEvent,
  getGoal,
} from '../db.js';
import { now } from './clock.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const ACTION_TYPES = Object.freeze(['draft_followup', 'send_followup']);

function realSendEnabled() {
  const v = (process.env.ENABLE_REAL_SEND ?? '').toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

// ---------------------------------------------------------------------------
// Public: executeAction
// ---------------------------------------------------------------------------

/**
 * Execute an action against a requirement.
 *
 * @param {string} requirementId
 * @param {'draft_followup' | 'send_followup'} actionType
 * @param {object} [opts]
 * @param {string} [opts.tone]
 * @param {string} [opts.draft] — optional pre-written draft to send instead
 *                                of generating a new one via the LLM.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   action_type: string,
 *   requirement_id: string,
 *   draft: string,
 *   sent: boolean,
 *   sandboxed: boolean,
 *   receipt: object | null,
 *   reason?: string
 * }>}
 */
export async function executeAction(requirementId, actionType, opts = {}) {
  if (typeof requirementId !== 'string' || !requirementId.trim()) {
    throw new Error('[onward/action] requirementId is required');
  }
  if (!ACTION_TYPES.includes(actionType)) {
    throw new Error(
      `[onward/action] unknown actionType "${actionType}"; expected one of ${ACTION_TYPES.join(', ')}`
    );
  }

  const req = await getRequirement(requirementId);
  if (!req) {
    return actionError(requirementId, actionType, `no requirement with id ${requirementId}`);
  }

  const goal = await getGoal(req.goal_id);
  if (!goal) {
    return actionError(requirementId, actionType, `parent goal ${req.goal_id} not found`);
  }

  if (req.kind !== 'external_dependency') {
    return actionError(
      requirementId,
      actionType,
      `"${actionType}" is only valid for external_dependency items, not "${req.kind}"`
    );
  }
  if (!req.requested_at) {
    return actionError(
      requirementId,
      actionType,
      `cannot follow up: this item has no requested_at timestamp — it hasn't been sent yet`
    );
  }

  // Draft (or accept a caller-provided one).
  const draft =
    typeof opts.draft === 'string' && opts.draft.trim()
      ? opts.draft.trim()
      : await draftFollowup(req, goal, opts);

  // Send (or sandbox).
  let sent = false;
  let sandboxed = false;
  let receipt = null;

  if (actionType === 'send_followup') {
    if (realSendEnabled()) {
      const result = await realSend(req, goal, draft);
      if (!result.ok) {
        await appendEvent({
          goalId: goal.id,
          requirementId: req.id,
          rawText: null,
          interpretedChange: {
            type: 'action_failed',
            action_type: actionType,
            draft,
            error: result.error,
          },
        });
        return actionError(requirementId, actionType, result.error, draft);
      }
      sent = true;
      receipt = result.receipt ?? null;
    } else {
      sandboxed = true;
      receipt = sandboxSend(req, goal, draft);
    }
  }

  // Record on the requirement's notes.
  const at = now();
  const noteLine = `Follow-up ${
    actionType === 'send_followup'
      ? (sandboxed ? '(sandbox) sent' : 'sent')
      : 'drafted'
  } on ${isoDate(at)}`;
  const updatedNotes = req.notes ? `${req.notes}\n${noteLine}` : noteLine;
  await updateRequirement(req.id, { notes: updatedNotes });

  // Append event.
  await appendEvent({
    goalId: goal.id,
    requirementId: req.id,
    rawText: null,
    interpretedChange: {
      type:
        actionType === 'send_followup'
          ? sandboxed
            ? 'action_sandboxed'
            : 'action_sent'
          : 'action_drafted',
      action_type: actionType,
      draft,
      sandboxed,
      receipt,
    },
  });

  return {
    ok: true,
    action_type: actionType,
    requirement_id: req.id,
    draft,
    sent,
    sandboxed,
    receipt,
  };
}

// ---------------------------------------------------------------------------
// Public: MCP tool
// ---------------------------------------------------------------------------

/**
 * Returns the MCP tool definition and its handler. Kept next to the service
 * so they stay in sync.
 *
 * @returns {{ definition: object, handler: (args: object) => Promise<object> }}
 */
export function getSendFollowupTool() {
  const definition = {
    name: 'send_followup',
    description:
      'Draft and optionally send a follow-up message for an outstanding ' +
      'external dependency. In sandbox mode (default), nothing is actually ' +
      'sent — the draft is returned and logged. Set ENABLE_REAL_SEND=true ' +
      'to enable real sending.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement_id: {
          type: 'string',
          description: 'UUID of the requirement to follow up on.',
        },
        action_type: {
          type: 'string',
          enum: ['draft_followup', 'send_followup'],
          description:
            'draft_followup returns the message without sending. ' +
            'send_followup sends it (or sandboxes, depending on ENABLE_REAL_SEND).',
        },
        tone: {
          type: 'string',
          description: 'Optional tone hint, e.g. "polite", "brief", "warm".',
        },
      },
      required: ['requirement_id', 'action_type'],
    },
  };

  const handler = async (args = {}) => {
    const requirementId = args.requirement_id;
    const actionType = args.action_type;

    if (typeof requirementId !== 'string' || !requirementId.trim()) {
      return toolError('send_followup: "requirement_id" is required');
    }
    if (!ACTION_TYPES.includes(actionType)) {
      return toolError(
        `send_followup: "action_type" must be one of ${ACTION_TYPES.join(', ')}`
      );
    }

    const result = await executeAction(requirementId, actionType, {
      tone: typeof args.tone === 'string' ? args.tone : undefined,
    });

    if (!result.ok) {
      return toolError(`send_followup: ${result.reason}`, result.draft);
    }
    return toolOk(result);
  };

  return { definition, handler };
}

// ---------------------------------------------------------------------------
// Drafting (LLM)
// ---------------------------------------------------------------------------

async function draftFollowup(req, goal, opts = {}) {
  const at = now();
  const requested = req.requested_at ? new Date(req.requested_at) : null;
  const daysSinceRequest = requested
    ? Math.max(0, Math.round((at.getTime() - requested.getTime()) / (24 * 60 * 60 * 1000)))
    : null;

  const systemPrompt = `
You write a short, polite follow-up message on behalf of the user, asking a
third party about a requested item.

You are given:
  - The item being requested (e.g. "Recommendation letter").
  - Who it was requested from, if known (e.g. "Prof. Lee, registrar").
  - The goal it supports (title and deadline), if known.
  - How many days ago it was requested.
  - Optionally, a tone hint.

Rules:
- Write a single short message, 3 to 6 sentences.
- Do NOT invent facts. Do not claim the deadline is different, do not name
  people who weren't named, do not describe previous conversations that
  weren't mentioned.
- Be specific about the item and the deadline. Ask when it might be ready.
- Match the tone hint if given; otherwise be warm and polite.
- No subject line, no greeting block, no sign-off with a name — just the
  body of the message.
- Return plain text only. No JSON, no quotes around it.

Return ONLY the message body.
`.trim();

  const facts = [
    `Item: ${req.label}`,
    req.depends_on ? `Requested from: ${req.depends_on}` : null,
    goal?.title ? `For goal: ${goal.title}` : null,
    goal?.deadline ? `Goal deadline: ${isoDate(goal.deadline)}` : null,
    daysSinceRequest != null
      ? `Requested ${daysSinceRequest} day${daysSinceRequest === 1 ? '' : 's'} ago`
      : null,
    opts.tone ? `Tone: ${opts.tone}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const text = await callLLMText(systemPrompt, facts, { temperature: 0.5 });
  return text.trim();
}

// ---------------------------------------------------------------------------
// Sending — real and sandbox
// ---------------------------------------------------------------------------

/**
 * Real send. Currently a stub: refuses to send because no provider is wired.
 * To wire a provider:
 *   1. Add the provider SDK / HTTP call.
 *   2. Replace the body of this function.
 *   3. Keep the return shape: { ok, receipt?, error? }.
 */
async function realSend(req, goal, draft) {
  if (!req.depends_on) {
    return {
      ok: false,
      error: 'cannot send: requirement has no "depends_on" recipient recorded',
    };
  }
  return {
    ok: false,
    error:
      'real send is enabled but no provider is wired up. ' +
      'Configure a provider inside realSend() in actionExecutor.js.',
  };
}

function sandboxSend(req, goal, draft) {
  const at = now();
  return {
    provider: 'sandbox',
    to: req.depends_on ?? '(unknown recipient)',
    subject: `Follow-up: ${req.label}`,
    body: draft,
    would_send_at: at.toISOString(),
    message_id: `sandbox-${req.id.slice(0, 8)}-${at.getTime()}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionError(requirementId, actionType, reason, draft = null) {
  return {
    ok: false,
    action_type: actionType,
    requirement_id: requirementId,
    draft: draft ?? '',
    sent: false,
    sandboxed: false,
    receipt: null,
    reason,
  };
}

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

function toolError(message, draft = null) {
  const body = { error: message };
  if (draft) body.draft = draft;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  };
}

function isoDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}