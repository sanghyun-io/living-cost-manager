import type { Prisma } from "@prisma/client";
import type { Env } from "../env.js";
import { parseBillingConfiguration } from "./service-billing-config.js";

export class PaidFeatureUnavailableError extends Error {
  readonly statusCode = 403;
  constructor(readonly code: "FREE_WORKSPACE_LIMIT" | "FEATURE_NOT_AVAILABLE") {
    super(code);
  }
}

/** Production decisions use trusted startup configuration and persisted LIVE
 * coverage, never a body/header/SDK callback or sandbox payment. No schema or
 * signup cut-off: existing memberships and financial data remain untouched. */
export class PaidFeaturePolicy {
  constructor(private readonly env?: Env, private readonly testAccess = false) {
    if (testAccess && env?.NODE_ENV !== "test") throw new Error("Paid feature override restricted to tests");
  }

  async hasPaidAccess(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    if (this.testAccess) return true;
    if (this.env?.SERVICE_PAID_FEATURES_PUBLISHED !== "true" || this.env.SERVICE_BILLING_MODE !== "live") return false;
    const config = parseBillingConfiguration(this.env);
    const manifest = config.manifest;
    if (!config.enabled || !manifest || !config.capabilities.issueInstrument || !config.capabilities.charge || !config.capabilities.renew) return false;
    const now = new Date();
    const coverage = await tx.servicePaidPeriod.findFirst({ where: {
      environment: "live",
      startsAt: { lte: now }, accessEndsAt: { gt: now },
      contract: { userId, provider: "portone", storeId: manifest.storeId, environment: "live" },
      attempt: { status: "paid", reviewRequired: false, provider: "portone", storeId: manifest.storeId, environment: "live",
        quote: { premiumScope: manifest.featureScope, featureScopeVersion: manifest.featureScopeVersion,
          channelId: manifest.channelId, catalogVersion: manifest.catalogVersion } }
    }, select: { id: true } });
    return !!coverage;
  }

  async assertCanCreateWorkspace(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    // Same first lock as account deletion and billing. READ COMMITTED count
    // runs after acquisition, so concurrent creates see the winner's commit.
    const users = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!users.length) throw Object.assign(new Error("Invalid token"), { statusCode: 401 });
    const owned = await tx.workspaceMember.count({ where: { userId, role: "owner" } });
    if (owned >= 1 && !await this.hasPaidAccess(tx, userId)) throw new PaidFeatureUnavailableError("FREE_WORKSPACE_LIMIT");
  }

  async assertCanAggregate(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    if (!await this.hasPaidAccess(tx, userId)) throw new PaidFeatureUnavailableError("FEATURE_NOT_AVAILABLE");
  }
}

export const freePublicFeaturePolicy = new PaidFeaturePolicy();
