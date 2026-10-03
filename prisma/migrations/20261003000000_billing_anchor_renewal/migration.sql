-- Deliberately no anchor backfill: legacy schedules are unknown.
ALTER TABLE "FixedCost"
  ADD COLUMN "billingAnchorDate" TEXT,
  ADD COLUMN "renewalStatus" TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN "potentialMonthlySavings" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "confirmedMonthlySavings" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FixedCost"
  ADD CONSTRAINT "FixedCost_renewalStatus_check" CHECK ("renewalStatus" IN ('unreviewed', 'keep', 'cancel-planned', 'change-review', 'completed')),
  ADD CONSTRAINT "FixedCost_savings_check" CHECK ("potentialMonthlySavings" >= 0 AND "confirmedMonthlySavings" >= 0 AND ("renewalStatus" = 'completed' OR "confirmedMonthlySavings" = 0));
