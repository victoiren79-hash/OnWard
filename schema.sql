-- Onward — schema migration.
--
-- Run this in the Supabase SQL editor before pasting any JavaScript.
-- It is idempotent: every statement uses IF NOT EXISTS, so running it
-- twice is safe.
--
-- Column additions here match the constraints confirmed in Step 1
-- (Recon). If any constraint in your database differs from what the
-- spec expects, adjust the code in later steps to match the database,
-- not the other way round.

-- ---------------------------------------------------------------------------
-- Requirement: per-item dates and cross-item links
-- ---------------------------------------------------------------------------

alter table "Requirement" add column if not exists due_at timestamptz;
alter table "Requirement" add column if not exists expected_at timestamptz;
alter table "Requirement" add column if not exists linked_requirement_id uuid
  references "Requirement"(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Goal: free-text context and reminder bookkeeping
-- ---------------------------------------------------------------------------

alter table "Goal" add column if not exists context text;
alter table "Goal" add column if not exists reminders_fired jsonb not null
  default '[]'::jsonb;

-- If reminders_fired already exists with a different type (for example
-- text[] from add_reminders_fired.sql), leave it alone and delete the
-- line above. The orchestrator reads it through `?? []` and writes it
-- back as an array, so either type works at runtime, but mixing types
-- across environments is a footgun.

-- ---------------------------------------------------------------------------
-- Session: recent conversation turns, kept on the single session row
--
-- This replaces the per-turn loadRecentHistory walk, which loaded every
-- goal and then queried the Event table once per goal. Ten short turns
-- live here, so the interpreter can see what was just said without any
-- extra round trips.
-- ---------------------------------------------------------------------------

alter table "Session" add column if not exists recent_turns jsonb not null
  default '[]'::jsonb;