-- Migration: 001_add_campaigns_updated_at
-- Adds the missing updated_at column to the campaigns table and installs a
-- trigger that keeps it current on every UPDATE.
--
-- This migration is fully idempotent: it uses IF NOT EXISTS guards and
-- CREATE OR REPLACE for the trigger function, so it is safe to run multiple
-- times against the same database.
--
-- How to run (one-off, from the Railway shell or a one-off job):
--   psql $DATABASE_URL -f apps/backend-api/migrations/001_add_campaigns_updated_at.sql
--
-- Or via npm from the backend-api service root:
--   node -e "require('./src/db/migrate.js')"
-- (the main migrate.js already contains the ALTER TABLE statement)

-- 1. Add the column if it does not already exist.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- 2. Back-fill any existing rows that have a NULL value (safe no-op if the
--    column was just created, since DEFAULT NOW() already populated them).
UPDATE campaigns
  SET updated_at = created_at
  WHERE updated_at IS NULL;

-- 3. Create (or replace) the trigger function that stamps updated_at on every
--    row modification.
CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- 4. Attach the trigger to the campaigns table (drop first so the statement is
--    idempotent across repeated runs).
DROP TRIGGER IF EXISTS campaigns_set_updated_at ON campaigns;

CREATE TRIGGER campaigns_set_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
