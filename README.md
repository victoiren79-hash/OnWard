# Onward

**The assistant that remembers what you have to get done — before it's too late.**

Built for the **Build, Ship, Shape: Amazon Developer Hackathon** — **Alexa+ track**.

---

## What it is

Most things worth doing depend on someone else. A school needs a birth certificate. An employer needs a reference. A landlord needs proof of income. A visa office needs a police clearance.

Each of these is a small piece of a bigger deadline. The hardest part isn't doing the work — it's remembering that the work exists, knowing what it needs, and staying ahead of the pieces that depend on other people. Those are the ones that quietly sink you: a form you could have filled out in an afternoon, except you found out three days before the deadline that you also needed a medical exam that takes two weeks.

Onward is a personal assistant for exactly this. You tell it what you're trying to get done and when. It figures out what that kind of goal usually needs, keeps track of what you've done and what's still outstanding, watches the timeline, and reminds you when something is about to become a problem — with enough time to do something about it.

It handles one specific shape of thing: **a deadline, a list of requirements, and at least one requirement that depends on another person or institution responding.** That shape covers more of life than you'd think — grad school and visa applications, school enrollment, lease renewals, taxes, grant proposals, job references, permission slips.

---

## What it does

- **Knows what your goal actually needs.** You don't have to remember the full checklist — Onward already knows what a visa application or a grad school application typically requires, and asks which of those you already have.
- **Tracks every item individually.** Not "some things left to do" — the actual list, each with a real state: done, waiting on someone, not started.
- **Watches the clock.** If a police clearance takes three weeks and you have two weeks left, that's a problem, and Onward says so now — not after it's too late to matter.
- **Speaks up on its own.** When a reminder moment arrives, it surfaces a status update unprompted: what's done, what's still outstanding, what needs attention today.
- **Understands natural language.** "I sent the request yesterday." "The transcript came in." "I got the birth certificate and the police clearance." It figures out which items you mean and updates them — including several at once.
- **Doesn't give up at the deadline.** If a deadline passes with things still outstanding, it asks whether to keep going or set a new one, and resets the reminder schedule around it.

---

## Why this fits the Alexa+ track

The hackathon's own rubric calls a basic MCP wrapper or single-turn Q&A bot "obvious," and calls out **context-aware add-ons that maintain state across sessions** as the creative bar. Onward is built around exactly that: a goal's state — what's done, what's waiting on someone, what's at risk — persists across every conversation and gets reasoned over continuously, not answered fresh each time.

---

## Architecture

- **MCP server** — Streamable HTTP transport, spec 2025-11-25+, built with the official `@modelcontextprotocol/sdk`. Exposes tools (`report_statement`, `list_goals`, `get_goal`, delete and follow-up tools) that a real Alexa+ MCP integration or the included web frontend both call the same way.
- **Web frontend** — a chat interface plus a live checklist panel, built per the hackathon's explicit allowance for a simulated Alexa+ experience ("no specific framework or SDK required" for that path). Every status report is itemized, never a vague summary, so the system's claims are always checkable at a glance.
- **LLM** — [Groq API](https://console.groq.com), used for natural-language extraction, status-update interpretation, and conversational phrasing. Deterministic logic (risk calculation, state transitions, completeness checks) is kept separate from the LLM layer on purpose — the LLM reads and writes language, the backend owns every fact and every number.
- **Storage** — Supabase (Postgres).

### Deterministic vs. LLM — the dividing line

| Concern | Owner |
|---|---|
| Parsing free text → structured intent | LLM |
| Which requirements a goal type typically needs | Deterministic (seeded template) |
| Matching an update to the right item | LLM proposes, deterministic confirms |
| Status transitions & validity | Deterministic (state machine) |
| Risk math (slack, critical path, thresholds) | Deterministic |
| Deciding *when* to proactively flag | Deterministic (threshold crossing) |
| Phrasing a flag or report in natural language | LLM, strictly rendering only data it was given |
| Drafting a follow-up message | LLM |
| Sending a follow-up | MCP tool, user-confirmed, never automatic |

---

## Setup

### Prerequisites

- Node.js 18+
- A [Supabase](https://supabase.com) project
- A [Groq API](https://console.groq.com) key

### Environment variables

Create a `.env` file at the project root (never commit this — see `.gitignore`):

```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
GROQ_API_KEY=your_api_key
GROQ_REASONING_EFFORT=medium
PORT=3000
```

A `.env.example` with the same placeholder keys is committed for reference.

### Install and run

```bash
npm install
node src/seed.js      # seeds the goal-type templates (run once)
node src/server.js
```

The server starts three things:

- `http://localhost:3000/` — the web frontend
- `http://localhost:3000/mcp` — the MCP endpoint (Streamable HTTP, JSON-RPC)
- `POST /demo/advance` and `POST /demo/reset` — demo/test aids for simulating time passing, so proactive risk flagging can be demonstrated without waiting in real time

### Database schema

Run the SQL in `schema.sql` (or the project's Supabase SQL Editor) to create the `Goal`, `Requirement`, `Event`, `GoalTypeTemplate`, `RiskAssessment`, and `Session` tables before running the seed script.

---

## Alexa+ integration path

This submission takes the hackathon's **simulated Alexa+ experience** path: the MCP server is fully spec-compliant (Streamable HTTP, real tool definitions) and the included web frontend calls it exactly the way a real Alexa+ MCP client would, satisfying the rule that this path requires "no specific framework or SDK" while still including the simulation's full source. Real registration into Alexa+ itself goes through Amazon's MCP Toolkit, which is currently limited to selected partners.

---

## Submission details

- **Track:** Alexa+
- **Hackathon:** Build, Ship, Shape: Amazon Developer Hackathon (Devpost)
- **Repo:** public, MIT licensed