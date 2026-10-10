-- Onward — add priority column to GoalTypeTemplate.
--
-- 'essential' means: always surface this item on goal creation if it's
-- missing, regardless of context. The user cannot get a viable version
-- of the goal without it.
--
-- 'helpful' means: surface context-dependently. It matters for some
-- versions of the goal, not all, and the assistant decides based on
-- deadline proximity, what the user already said, and the specific
-- phrasing of the goal.

ALTER TABLE "GoalTypeTemplate"
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'helpful';

-- Add the check constraint only if it doesn't already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'GoalTypeTemplate_priority_check'
  ) THEN
    ALTER TABLE "GoalTypeTemplate"
      ADD CONSTRAINT "GoalTypeTemplate_priority_check"
      CHECK (priority IN ('essential', 'helpful'));
  END IF;
END $$;

-- Index helps listGoalTypeTemplates if we ever filter by priority in
-- the query. Cheap to have, harmless if unused.
CREATE INDEX IF NOT EXISTS "GoalTypeTemplate_goal_type_priority_idx"
  ON "GoalTypeTemplate" (goal_type, priority);