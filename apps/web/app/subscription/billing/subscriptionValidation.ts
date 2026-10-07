import type { Mode, Subscription } from "./types";

// Provisional explicit wire values, NOT a case-insensitive normalization.
const statuses = new Set(["free", "draft", "pending", "active", "payment_failed", "ending", "expired", "closed"]);
const providerStatuses = new Set(["unconfirmed", "requested", "pending", "confirmed", "failed", "not_applicable"]);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
export function isoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v)) return false;
  const time = Date.parse(v);
  return Number.isFinite(time) && new Date(time).toISOString() === (v.includes(".") ? v : v.replace("Z", ".000Z"));
}
export function validSubscription(value: unknown, mode: Mode, now: number): value is Subscription {
  if (!value || typeof value !== "object" || !["mock", "sandbox", "live"].includes(mode)) return false;
  const s = value as Subscription;
  const free = s.contractId === null && s.planId === null && s.paidAccess === false;
  if (!(s.status === null ? free : typeof s.status === "string" && statuses.has(s.status)) ||
    !(s.contractId === null || nonempty(s.contractId)) || !(s.planId === null || ["monthly", "annual"].includes(s.planId)) ||
    (s.contractId === null) !== (s.planId === null) || (s.status === "free" && !free) ||
    (s.contractId === null && ![null, "free", "draft", "pending"].includes(s.status)) ||
    typeof s.paidAccess !== "boolean" || s.existingFreeAccess !== true ||
    typeof s.cancelAtPeriodEnd !== "boolean" || typeof s.renewalStopped !== "boolean" ||
    typeof s.providerCancellationStatus !== "string" || !providerStatuses.has(s.providerCancellationStatus) ||
    !(s.paidThrough === null || isoTimestamp(s.paidThrough)) || !(s.nextChargeAt === null || isoTimestamp(s.nextChargeAt)) ||
    (s.currency !== undefined && s.currency !== "KRW") || (s.mode !== undefined && s.mode !== mode)) return false;
  if (s.cancellationProof !== undefined && (!s.cancellationProof ||
    typeof s.cancellationProof.allChargePathsStopped !== "boolean" || typeof s.cancellationProof.inFlightResolved !== "boolean")) return false;
  // Scope is display metadata only, never a gate for existing free features.
  if (s.premiumScope !== undefined && (!s.premiumScope || !nonempty(s.premiumScope.version) ||
    !Array.isArray(s.premiumScope.features) || !s.premiumScope.features.every(nonempty))) return false;
  if (s.paidAccess && (!nonempty(s.contractId) || !["active", "ending"].includes(s.status ?? "") ||
    !isoTimestamp(s.paidThrough) || Date.parse(s.paidThrough) <= now ||
    (s.nextChargeAt !== null && (Date.parse(s.nextChargeAt) < now || Date.parse(s.nextChargeAt) < Date.parse(s.paidThrough))))) return false;
  return true;
}
