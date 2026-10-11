-- Onward — add reminders_fired column to Goal.
--
-- Stores the kinds of scheduled reminders that have already fired for
-- this goal, as an array of short strings like:
--   {"seven_days_out", "two_days_out", "request_by:police-clearance-cert"}
--
-- For per-requirement reminders, the kind is suffixed with the
-- requirement id so each item has its own one-shot slot. Goal-level
-- moments ("seven_days_out", "due_today", etc.) use the bare kind.
--
-- The column starts empty. Existing rows get '{}' by default.
--
-- Resetting the schedule (for example, when the user sets a new
-- deadline for an overdue goal) is a matter of setting this back to
-- an empty array. No other state needs to be touched.

ALTER TABLE "Goal"
  ADD COLUMN IF NOT EXISTS reminders_fired text[] NOT NULL DEFAULT '{}';