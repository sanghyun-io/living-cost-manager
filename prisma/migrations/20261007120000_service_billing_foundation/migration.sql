-- CreateTable
CREATE TABLE "ServiceSubscriptionContract" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subjectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "planId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "originalAnchor" TIMESTAMP(3),
    "nextCycle" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "renewalStopped" BOOLEAN NOT NULL DEFAULT false,
    "providerCancellationStatus" TEXT NOT NULL DEFAULT 'none',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceSubscriptionContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceBillingQuote" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "periodMonths" INTEGER NOT NULL,
    "billingVersion" TEXT NOT NULL,
    "autoRenewVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceBillingQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceBillingInstrument" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "issuanceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "ciphertext" BYTEA,
    "nonce" BYTEA,
    "authTag" BYTEA,
    "keyVersion" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceBillingInstrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePaymentAttempt" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "paymentId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestBinding" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "billingVersion" TEXT NOT NULL,
    "autoRenewVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "dispatchAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "fence" INTEGER NOT NULL DEFAULT 0,
    "lookupCount" INTEGER NOT NULL DEFAULT 0,
    "nextLookupAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePaidPeriod" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "environment" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "accessEndsAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePaidPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceBillingEventReceipt" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "attemptId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "fence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServiceBillingEventReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceRefundRecord" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestAmount" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "providerCancelId" TEXT,
    "verifiedAmount" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceRefundRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceSubscriptionContract_userId_key" ON "ServiceSubscriptionContract"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceSubscriptionContract_subjectId_key" ON "ServiceSubscriptionContract"("subjectId");

-- CreateIndex
CREATE INDEX "ServiceSubscriptionContract_status_renewalStopped_idx" ON "ServiceSubscriptionContract"("status", "renewalStopped");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceSubscriptionContract_id_provider_storeId_environment_key" ON "ServiceSubscriptionContract"("id", "provider", "storeId", "environment");

-- CreateIndex
CREATE INDEX "ServiceBillingQuote_contractId_expiresAt_idx" ON "ServiceBillingQuote"("contractId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBillingInstrument_quoteId_key" ON "ServiceBillingInstrument"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBillingInstrument_issuanceId_key" ON "ServiceBillingInstrument"("issuanceId");

-- CreateIndex
CREATE INDEX "ServiceBillingInstrument_contractId_status_idx" ON "ServiceBillingInstrument"("contractId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePaymentAttempt_quoteId_key" ON "ServicePaymentAttempt"("quoteId");

-- CreateIndex
CREATE INDEX "ServicePaymentAttempt_status_nextLookupAt_leaseUntil_idx" ON "ServicePaymentAttempt"("status", "nextLookupAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePaymentAttempt_provider_storeId_environment_paymentI_key" ON "ServicePaymentAttempt"("provider", "storeId", "environment", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePaymentAttempt_contractId_cycle_key" ON "ServicePaymentAttempt"("contractId", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePaymentAttempt_contractId_idempotencyKey_key" ON "ServicePaymentAttempt"("contractId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePaidPeriod_attemptId_key" ON "ServicePaidPeriod"("attemptId");

-- CreateIndex
CREATE INDEX "ServicePaidPeriod_contractId_startsAt_endsAt_idx" ON "ServicePaidPeriod"("contractId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePaidPeriod_contractId_cycle_key" ON "ServicePaidPeriod"("contractId", "cycle");

-- CreateIndex
CREATE INDEX "ServiceBillingEventReceipt_status_nextRetryAt_leaseUntil_idx" ON "ServiceBillingEventReceipt"("status", "nextRetryAt", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceBillingEventReceipt_provider_storeId_environment_eve_key" ON "ServiceBillingEventReceipt"("provider", "storeId", "environment", "eventId");
CREATE INDEX "ServiceBillingEventReceipt_attemptId_status_idx" ON "ServiceBillingEventReceipt"("attemptId", "status");

-- CreateIndex
CREATE INDEX "ServiceRefundRecord_status_createdAt_idx" ON "ServiceRefundRecord"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRefundRecord_attemptId_idempotencyKey_key" ON "ServiceRefundRecord"("attemptId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRefundRecord_provider_storeId_environment_providerCa_key" ON "ServiceRefundRecord"("provider", "storeId", "environment", "providerCancelId");

-- AddForeignKey
ALTER TABLE "ServiceSubscriptionContract" ADD CONSTRAINT "ServiceSubscriptionContract_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBillingQuote" ADD CONSTRAINT "ServiceBillingQuote_contractId_provider_storeId_environmen_fkey" FOREIGN KEY ("contractId", "provider", "storeId", "environment") REFERENCES "ServiceSubscriptionContract"("id", "provider", "storeId", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBillingInstrument" ADD CONSTRAINT "ServiceBillingInstrument_contractId_provider_storeId_envir_fkey" FOREIGN KEY ("contractId", "provider", "storeId", "environment") REFERENCES "ServiceSubscriptionContract"("id", "provider", "storeId", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBillingInstrument" ADD CONSTRAINT "ServiceBillingInstrument_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "ServiceBillingQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePaymentAttempt" ADD CONSTRAINT "ServicePaymentAttempt_contractId_provider_storeId_environm_fkey" FOREIGN KEY ("contractId", "provider", "storeId", "environment") REFERENCES "ServiceSubscriptionContract"("id", "provider", "storeId", "environment") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePaymentAttempt" ADD CONSTRAINT "ServicePaymentAttempt_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "ServiceBillingQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePaymentAttempt" ADD CONSTRAINT "ServicePaymentAttempt_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "ServiceBillingInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePaidPeriod" ADD CONSTRAINT "ServicePaidPeriod_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ServicePaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePaidPeriod" ADD CONSTRAINT "ServicePaidPeriod_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "ServiceSubscriptionContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceBillingEventReceipt" ADD CONSTRAINT "ServiceBillingEventReceipt_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ServicePaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceRefundRecord" ADD CONSTRAINT "ServiceRefundRecord_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ServicePaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Local draft only: production application requires specific migration approval.
ALTER TABLE "ServiceSubscriptionContract" ADD CONSTRAINT "service_contract_bounds" CHECK (
  "environment" IN ('mock','sandbox','live') AND "nextCycle" >= 0 AND "version" >= 0);
ALTER TABLE "ServiceBillingQuote" ADD CONSTRAINT "service_quote_bounds" CHECK (
  "totalAmount" > 0 AND "currency" = 'KRW' AND "periodMonths" IN (1,12) AND "expiresAt" > "createdAt");
ALTER TABLE "ServicePaymentAttempt" ADD CONSTRAINT "service_attempt_bounds" CHECK (
  "totalAmount" > 0 AND "currency" = 'KRW' AND "cycle" >= 0 AND length("paymentId") <= 40 AND "fence" >= 0 AND "lookupCount" >= 0);
ALTER TABLE "ServiceBillingInstrument" ADD CONSTRAINT "service_instrument_envelope" CHECK (
  ("ciphertext" IS NULL AND "nonce" IS NULL AND "authTag" IS NULL AND "keyVersion" IS NULL AND "status" <> 'verified') OR
  ("ciphertext" IS NOT NULL AND "nonce" IS NOT NULL AND "authTag" IS NOT NULL AND octet_length("nonce") = 12 AND octet_length("authTag") = 16 AND "keyVersion" IS NOT NULL));
ALTER TABLE "ServicePaidPeriod" ADD CONSTRAINT "service_period_bounds" CHECK (
  "cycle" >= 0 AND "endsAt" > "startsAt" AND "accessEndsAt" >= "startsAt" AND "accessEndsAt" <= "endsAt");
ALTER TABLE "ServiceRefundRecord" ADD CONSTRAINT "service_refund_bounds" CHECK (
  "requestAmount" > 0 AND ("verifiedAmount" IS NULL OR ("verifiedAmount" > 0 AND "verifiedAmount" <= "requestAmount")));
ALTER TABLE "ServiceBillingEventReceipt" ADD CONSTRAINT "service_event_bounds" CHECK ("retryCount" >= 0 AND "fence" >= 0);

-- Financial identity/scope/consent must not be rewritten during reconciliation.
CREATE FUNCTION "lcm_service_billing_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[];
BEGIN
  IF TG_TABLE_NAME = 'ServiceBillingQuote' THEN mutable := ARRAY['consumedAt'];
  ELSIF TG_TABLE_NAME = 'ServicePaymentAttempt' THEN mutable := ARRAY['status','dispatchAt','leaseOwner','leaseUntil','fence','lookupCount','nextLookupAt','paidAt','reviewRequired'];
  ELSIF TG_TABLE_NAME = 'ServicePaidPeriod' THEN mutable := ARRAY['accessEndsAt'];
  ELSIF TG_TABLE_NAME = 'ServiceRefundRecord' THEN mutable := ARRAY['status','providerCancelId','verifiedAmount','verifiedAt','approvalOperationId','approvalPolicyVersion','leaseOwner','leaseUntil','fence','lookupCount','nextLookupAt'];
  ELSIF TG_TABLE_NAME = 'ServiceBillingInstrument' THEN mutable := ARRAY['status','ciphertext','nonce','authTag','keyVersion','verifiedAt','revokedAt','version','leaseOwner','leaseUntil'];
  ELSE mutable := ARRAY['attemptId','processedAt','status','retryCount','nextRetryAt','leaseOwner','leaseUntil','fence'];
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'Immutable service billing record' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'ServiceBillingQuote' AND (to_jsonb(OLD)->>'consumedAt') IS NOT NULL AND (to_jsonb(NEW)->>'consumedAt') IS DISTINCT FROM (to_jsonb(OLD)->>'consumedAt') THEN
    RAISE EXCEPTION 'Consumed quote cannot be reset' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'ServicePaymentAttempt' THEN
    IF ((to_jsonb(OLD)->>'status') IN ('paid','refunded') AND (to_jsonb(NEW)->>'status') NOT IN ('paid','refunded')) OR
      ((to_jsonb(OLD)->>'status') = 'refunded' AND (to_jsonb(NEW)->>'status') <> 'refunded') OR
      ((to_jsonb(OLD)->>'dispatchAt') IS NOT NULL AND (to_jsonb(NEW)->>'dispatchAt') IS DISTINCT FROM (to_jsonb(OLD)->>'dispatchAt')) OR
      ((to_jsonb(OLD)->>'paidAt') IS NOT NULL AND (to_jsonb(NEW)->>'paidAt') IS DISTINCT FROM (to_jsonb(OLD)->>'paidAt')) OR
      ((to_jsonb(NEW)->>'fence')::int < (to_jsonb(OLD)->>'fence')::int) THEN
      RAISE EXCEPTION 'Service payment cannot be downgraded or redispatched' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "service_quote_immutable" BEFORE UPDATE ON "ServiceBillingQuote" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_immutable"();
CREATE TRIGGER "service_attempt_immutable" BEFORE UPDATE ON "ServicePaymentAttempt" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_immutable"();
CREATE TRIGGER "service_period_immutable" BEFORE UPDATE ON "ServicePaidPeriod" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_immutable"();
CREATE TRIGGER "service_refund_immutable" BEFORE UPDATE ON "ServiceRefundRecord" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_immutable"();
CREATE TRIGGER "service_instrument_immutable" BEFORE UPDATE ON "ServiceBillingInstrument" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_immutable"();
CREATE TRIGGER "service_event_immutable" BEFORE UPDATE ON "ServiceBillingEventReceipt" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_immutable"();

CREATE FUNCTION "lcm_service_billing_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "ServicePaymentAttempt"; q "ServiceBillingQuote"; i "ServiceBillingInstrument";
BEGIN
  IF TG_TABLE_NAME = 'ServiceBillingInstrument' THEN
    SELECT * INTO STRICT q FROM "ServiceBillingQuote" WHERE "id" = NEW."quoteId";
    IF (NEW."contractId",NEW."provider",NEW."storeId",NEW."environment") IS DISTINCT FROM (q."contractId",q."provider",q."storeId",q."environment") THEN
      RAISE EXCEPTION 'Instrument scope mismatch' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'ServicePaymentAttempt' THEN
    SELECT * INTO STRICT q FROM "ServiceBillingQuote" WHERE "id" = NEW."quoteId";
    SELECT * INTO STRICT i FROM "ServiceBillingInstrument" WHERE "id" = NEW."instrumentId";
    IF (NEW."contractId",NEW."provider",NEW."storeId",NEW."environment",NEW."totalAmount",NEW."currency",NEW."billingVersion",NEW."autoRenewVersion")
       IS DISTINCT FROM (q."contractId",q."provider",q."storeId",q."environment",q."totalAmount",q."currency",q."billingVersion",q."autoRenewVersion") OR
       (NEW."contractId",NEW."provider",NEW."storeId",NEW."environment") IS DISTINCT FROM (i."contractId",i."provider",i."storeId",i."environment") THEN
      RAISE EXCEPTION 'Attempt scope mismatch' USING ERRCODE = '23514'; END IF;
  ELSE
    IF NEW."attemptId" IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO STRICT a FROM "ServicePaymentAttempt" WHERE "id" = NEW."attemptId";
    IF TG_TABLE_NAME = 'ServicePaidPeriod' THEN
      PERFORM 1 FROM "ServiceSubscriptionContract" WHERE "id" = NEW."contractId" FOR UPDATE;
      IF (NEW."contractId",NEW."cycle",NEW."environment") IS DISTINCT FROM (a."contractId",a."cycle",a."environment") OR EXISTS (
        SELECT 1 FROM "ServicePaidPeriod" p WHERE p."contractId" = NEW."contractId" AND p."id" <> NEW."id"
        AND p."startsAt" < NEW."endsAt" AND p."endsAt" > NEW."startsAt") THEN
        RAISE EXCEPTION 'Period scope mismatch or overlap' USING ERRCODE = '23514'; END IF;
    ELSE
      IF (NEW."provider",NEW."storeId",NEW."environment") IS DISTINCT FROM (a."provider",a."storeId",a."environment") THEN
        RAISE EXCEPTION 'Financial scope mismatch' USING ERRCODE = '23514'; END IF;
      IF TG_TABLE_NAME = 'ServiceRefundRecord' THEN
        PERFORM 1 FROM "ServiceSubscriptionContract" WHERE "id" = a."contractId" FOR UPDATE;
        IF NEW."requestAmount" > a."totalAmount" OR
          NEW."requestAmount" + COALESCE((SELECT sum(r."requestAmount") FROM "ServiceRefundRecord" r
            WHERE r."attemptId" = a."id" AND r."id" <> NEW."id" AND r."status" <> 'rejected'),0) > a."totalAmount" THEN
          RAISE EXCEPTION 'Refund exceeds payment' USING ERRCODE = '23514'; END IF;
      ELSIF NEW."paymentId" <> a."paymentId" THEN
        RAISE EXCEPTION 'Event payment mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "service_instrument_binding" BEFORE INSERT OR UPDATE ON "ServiceBillingInstrument" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_binding"();
CREATE TRIGGER "service_attempt_binding" BEFORE INSERT OR UPDATE ON "ServicePaymentAttempt" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_binding"();
CREATE TRIGGER "service_period_binding" BEFORE INSERT OR UPDATE ON "ServicePaidPeriod" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_binding"();
CREATE TRIGGER "service_refund_binding" BEFORE INSERT OR UPDATE ON "ServiceRefundRecord" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_binding"();
CREATE TRIGGER "service_event_binding" BEFORE INSERT OR UPDATE ON "ServiceBillingEventReceipt" FOR EACH ROW EXECUTE FUNCTION "lcm_service_billing_binding"();

CREATE FUNCTION "lcm_service_contract_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id",NEW."subjectId",NEW."provider",NEW."storeId",NEW."environment",NEW."createdAt")
    IS DISTINCT FROM (OLD."id",OLD."subjectId",OLD."provider",OLD."storeId",OLD."environment",OLD."createdAt") OR
    (NEW."userId" IS DISTINCT FROM OLD."userId" AND NEW."userId" IS NOT NULL) OR
    (OLD."originalAnchor" IS NOT NULL AND NEW."originalAnchor" IS DISTINCT FROM OLD."originalAnchor") OR
    NEW."nextCycle" < OLD."nextCycle" THEN
    RAISE EXCEPTION 'Immutable service billing subject/anchor' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "service_contract_identity" BEFORE UPDATE ON "ServiceSubscriptionContract" FOR EACH ROW EXECUTE FUNCTION "lcm_service_contract_identity"();

-- Phase two amendment of an UNAPPLIED production draft; new tables only.
ALTER TABLE "ServiceSubscriptionContract" ADD COLUMN "cancellationVerifiedVersion" INTEGER,
  ADD COLUMN "renewalReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ServiceSubscriptionContract" ADD CONSTRAINT "service_cancellation_verified_version" CHECK (
  "cancellationVerifiedVersion" IS NULL OR ("cancellationVerifiedVersion" >= 0 AND "cancellationVerifiedVersion" <= "version"));
ALTER TABLE "ServiceBillingQuote" ADD COLUMN "featureScopeVersion" TEXT NOT NULL DEFAULT 'feature-draft-v1',
  ADD COLUMN "policyVersion" TEXT NOT NULL DEFAULT 'policy-draft-v1', ADD COLUMN "sellerVersion" TEXT NOT NULL DEFAULT 'seller-draft-v1',
  ADD COLUMN "premiumScope" TEXT NOT NULL DEFAULT 'provisional', ADD COLUMN "materialsSnapshot" JSONB;
ALTER TABLE "ServiceBillingInstrument" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseOwner" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3);
ALTER TABLE "ServicePaymentAttempt" ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ServiceRefundRecord" ADD COLUMN "approvalOperationId" TEXT, ADD COLUMN "approvalPolicyVersion" TEXT,
  ADD COLUMN "leaseOwner" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3), ADD COLUMN "fence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lookupCount" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "nextLookupAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "ServiceRefundRecord_approvalOperationId_key" ON "ServiceRefundRecord"("approvalOperationId");
CREATE FUNCTION "lcm_service_refund_approval_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."approvalOperationId" IS NOT NULL AND (OLD."approvalOperationId",OLD."approvalPolicyVersion") IS DISTINCT FROM (NEW."approvalOperationId",NEW."approvalPolicyVersion")) THEN
    RAISE EXCEPTION 'Immutable refund approval' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "service_refund_approval_immutable" BEFORE UPDATE ON "ServiceRefundRecord" FOR EACH ROW EXECUTE FUNCTION "lcm_service_refund_approval_immutable"();
ALTER TABLE "ServiceRefundRecord" ADD CONSTRAINT "service_refund_approval_pair" CHECK (
  ("approvalOperationId" IS NULL AND "approvalPolicyVersion" IS NULL) OR
  ("approvalOperationId" IS NOT NULL AND "approvalPolicyVersion" IS NOT NULL AND length("approvalOperationId") BETWEEN 16 AND 128));
ALTER TABLE "ServiceBillingInstrument" ADD CONSTRAINT "service_instrument_lease_bounds" CHECK (
  "version" >= 0 AND (("leaseOwner" IS NULL AND "leaseUntil" IS NULL) OR ("leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL)));
ALTER TABLE "ServiceRefundRecord" ADD CONSTRAINT "service_refund_lease_bounds" CHECK (
  "fence" >= 0 AND "lookupCount" BETWEEN 0 AND 8 AND
  (("leaseOwner" IS NULL AND "leaseUntil" IS NULL) OR ("leaseOwner" IS NOT NULL AND "leaseUntil" IS NOT NULL)));
