CREATE TABLE "UserWorkspaceCoachingPreference" (
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "protectedItemsJson" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserWorkspaceCoachingPreference_pkey" PRIMARY KEY ("userId", "workspaceId"),
  CONSTRAINT "UserWorkspaceCoachingPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserWorkspaceCoachingPreference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserWorkspaceCoachingPreference_workspaceId_idx" ON "UserWorkspaceCoachingPreference"("workspaceId");
