import { serviceBillingSubscriptionResponseSchema } from "@living-cost-manager/shared";
import type { Mode, Subscription } from "./types";
export function validSubscription(value: unknown, mode: Mode, now: number): value is Subscription {
  const parsed = serviceBillingSubscriptionResponseSchema.safeParse(value);
  if (!parsed.success || !["mock", "sandbox", "live"].includes(mode)) return false;
  const s = parsed.data;
  if ((s.contractId === null) !== (s.planId === null) || (s.status === "free" && (s.contractId !== null || s.paidAccess))) return false;
  if (s.paidAccess && (s.contractId === null || !["active", "cancel_at_period_end"].includes(s.status) ||
    s.premiumScope !== "account-subscription-v1" || !s.paidThrough || Date.parse(s.paidThrough) <= now)) return false;
  return true;
}
