import { z } from "zod";
import { serviceBillingCatalogVersion, serviceBillingConsentVersions } from "@living-cost-manager/shared";
import type { Env } from "../env.js";

const version = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).refine(v => !/draft|pending|unknown|unverified|provisional/i.test(v));
const material = z.string().min(20).max(2000); // approved plain text, no HTML/PII/provider secrets
export const billingApprovalManifestSchema = z.strictObject({
  mode: z.enum(["sandbox", "live"]), status: z.literal("verified"), approvalReference: version,
  merchantId: version, storeId: version, channelId: version, channelKey: version,
  domain: z.literal("living-cost-manager.gamja.top"), catalogVersion: z.literal(serviceBillingCatalogVersion),
  configurationReference: version, launchReference: version, workerRegistrationReference: version,
  featureScope: z.enum(["account-subscription-v1"]), featureScopeVersion: version, policyVersion: version, sellerVersion: version,
  billingVersion: version, autoRenewVersion: version, taxTreatment: z.literal("inclusive"),
  materials: z.strictObject({ billing: material, autoRenew: material, features: material, policy: material, seller: material }),
  capabilities: z.strictObject({ issueInstrument: z.boolean(), charge: z.boolean(), renew: z.boolean(), cancel: z.boolean(), refund: z.boolean() }),
  refundPolicy: z.enum(["full_remaining_manual_v1"]).nullable(),
  workers: z.strictObject({ reconcile: z.boolean(), renew: z.boolean(), refunds: z.boolean() })
});
export type BillingApprovalManifest = z.infer<typeof billingApprovalManifestSchema>;
export function parseBillingConfiguration(env: Env) {
  let manifest: BillingApprovalManifest | null = null;
  let webhookSecrets: Buffer[] = [];
  try { const result = billingApprovalManifestSchema.safeParse(JSON.parse(env.SERVICE_BILLING_APPROVAL_MANIFEST ?? "null")); if (result.success) manifest = result.data; } catch { /* blocked */ }
  try {
    const values = z.array(z.string().regex(/^[A-Za-z0-9+/]{43}=$/)).min(1).max(2).parse(JSON.parse(env.PORTONE_LCM_WEBHOOK_SECRETS ?? "null"));
    webhookSecrets = values.map(v => Buffer.from(v, "base64"));
  } catch { /* blocked; no secret/material is logged */ }
  const mock = env.SERVICE_BILLING_MODE === "mock" && env.NODE_ENV !== "production" && env.SERVICE_BILLING_MOCK_ENABLED === "true";
  const crypto = !!env.SERVICE_BILLING_ENCRYPTION_KEY && Buffer.from(env.SERVICE_BILLING_ENCRYPTION_KEY, "base64").length === 32 && !!env.SERVICE_BILLING_KEY_VERSION;
  const blockers: string[] = [];
  if (!crypto) blockers.push("ENCRYPTION_CONFIGURATION_REQUIRED");
  if (env.SERVICE_BILLING_MODE === "mock") {
    if (!mock) blockers.push(env.NODE_ENV === "production" ? "MOCK_FORBIDDEN_IN_PRODUCTION" : "MOCK_CONFIGURATION_REQUIRED");
  } else {
    if (!manifest || manifest.mode !== (env.SERVICE_BILLING_MODE ?? "sandbox")) blockers.push("APPROVAL_MANIFEST_UNVERIFIED");
    if (!env.PORTONE_LCM_API_SECRET || !webhookSecrets.length) blockers.push("PROVIDER_SECRETS_REQUIRED");
    if (manifest && (!manifest.workers.reconcile || !manifest.capabilities.cancel)) blockers.push("RECONCILIATION_OR_CANCELLATION_NOT_READY");
  }
  const enabled = blockers.length === 0;
  const approvedVersions = manifest ? { featureScope: manifest.featureScopeVersion, policy: manifest.policyVersion,
    seller: manifest.sellerVersion, billing: manifest.billingVersion, autoRenew: manifest.autoRenewVersion } :
    { featureScope: "feature-draft-v1", policy: "policy-draft-v1", seller: "seller-draft-v1", ...serviceBillingConsentVersions };
  return { manifest, webhookSecrets, enabled, blockers, approvedVersions,
    capabilities: { issueInstrument: enabled && (mock || !!manifest?.capabilities.issueInstrument),
      charge: enabled && (mock || !!manifest?.capabilities.charge),
      renew: enabled && (mock || !!manifest?.capabilities.renew && !!manifest?.workers.renew),
      cancel: enabled && (mock || !!manifest?.capabilities.cancel),
      refund: enabled && (mock || !!manifest?.capabilities.refund && !!manifest?.workers.refunds && manifest?.refundPolicy === "full_remaining_manual_v1") } };
}
