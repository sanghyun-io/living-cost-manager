-- Additive personal UI theme on the existing User row (Owner-approved cloud sync of
-- the 11-UI theme selection across devices). TEXT id + SQL CHECK mirrors the
-- product-tour/renewalStatus precedent: a future id is another additive migration,
-- never an enum rewrite. Constant default backfills existing rows as 'jade' without
-- a table rewrite on PostgreSQL 11+; the column is harmless to older app binaries.
-- Application rollback MUST retain this column: dropping it would destroy stored
-- theme choices and break the new binary. Old apps ignore unknown columns.
-- CHECK is defense-in-depth; the API read path still falls back to 'jade' for any
-- legacy/corrupt value and never rewrites it on GET.
-- Bounded lock acquisition; migration runner must stop on failure, never silently retry.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "User"
  ADD COLUMN "uiTheme" TEXT NOT NULL DEFAULT 'jade',
  ADD CONSTRAINT "User_uiTheme_check" CHECK ("uiTheme" IN ('jade', 'aqua', 'violet', 'raspberry', 'tangerine'));
COMMIT;
