-- Add "말일(end-of-month)" billing flag to payment cards and fixed costs.
-- Existing rows default to false (numeric billingDay semantics unchanged).
ALTER TABLE "PaymentCard" ADD COLUMN "isEndOfMonth" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FixedCost" ADD COLUMN "isEndOfMonth" BOOLEAN NOT NULL DEFAULT false;
