-- Additive only. Application rollback MUST retain this table and its financial data.
-- Bounded lock acquisition; migration runner must stop on failure, never silently retry.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE "WorkspacePlanningState" (
    "workspaceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspacePlanningState_pkey" PRIMARY KEY ("workspaceId")
);
ALTER TABLE "WorkspacePlanningState" ADD CONSTRAINT "WorkspacePlanningState_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;
