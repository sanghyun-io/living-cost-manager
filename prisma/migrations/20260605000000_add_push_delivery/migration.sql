-- Push delivery history for de-duplicating reminder pushes. Additive: new table
-- only, no change to existing tables. dedupeKey is the target date (one bundled
-- push per user per day); (userId, dedupeKey) is unique so re-running the batch
-- on the same day sends at most once.
CREATE TABLE "PushDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PushDelivery_userId_idx" ON "PushDelivery"("userId");

CREATE UNIQUE INDEX "PushDelivery_userId_dedupeKey_key" ON "PushDelivery"("userId", "dedupeKey");

ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
