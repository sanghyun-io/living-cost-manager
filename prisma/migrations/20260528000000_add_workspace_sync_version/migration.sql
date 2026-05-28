-- Optimistic locking for workspace snapshot sync.
-- syncVersion increments on each successful snapshot replacement; clients send
-- the version they last read so concurrent overwrites can be rejected (409).
-- Existing rows start at 0.
ALTER TABLE "Workspace" ADD COLUMN "syncVersion" INTEGER NOT NULL DEFAULT 0;
