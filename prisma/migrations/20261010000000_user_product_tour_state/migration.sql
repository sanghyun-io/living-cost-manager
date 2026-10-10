-- Additive personal preference; intentionally no changes to existing tables.
CREATE TABLE "UserProductTourState" (
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserProductTourState_pkey" PRIMARY KEY ("userId", "version"),
    CONSTRAINT "UserProductTourState_version_check" CHECK ("version" >= 1),
    CONSTRAINT "UserProductTourState_status_check" CHECK ("status" IN ('completed', 'skipped')),
    CONSTRAINT "UserProductTourState_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
