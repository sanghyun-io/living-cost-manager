import { z } from "zod";

// Private coaching intent, not a ledger field. No free text or implicit expiry.
export const coachingProtectionReasonSchema = z.enum(["essential", "contract", "personal"]);
export const protectedCoachingItemSchema = z.object({
  fixedCostId: z.string().min(1).max(200),
  reason: coachingProtectionReasonSchema.optional()
}).strict();
export const protectedCoachingItemsSchema = z.array(protectedCoachingItemSchema).max(1000)
  .refine(items => new Set(items.map(item => item.fixedCostId)).size === items.length, "Duplicate fixedCostId");
export const coachingPreferencesSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().min(0).max(2147483647),
  protectedItems: protectedCoachingItemsSchema
}).strict();
export const putCoachingPreferencesSchema = z.object({
  schemaVersion: z.literal(1),
  expectedRevision: z.number().int().min(0).max(2147483646),
  protectedItems: protectedCoachingItemsSchema
}).strict();
export type CoachingPreferences = z.infer<typeof coachingPreferencesSchema>;
export type PutCoachingPreferences = z.infer<typeof putCoachingPreferencesSchema>;
export type ProtectedCoachingItem = z.infer<typeof protectedCoachingItemSchema>;
export type CoachingProtectionOptions = { protectedFixedCostIds?: ReadonlySet<string> | readonly string[] };

/** Intersect at consumption time; orphaned IDs remain stored without silent revision changes. */
export function getActiveProtectedFixedCostIds(
  preferences: Pick<CoachingPreferences, "protectedItems">,
  items: readonly { id: string }[]
): ReadonlySet<string> {
  const current = new Set(items.map(item => item.id));
  return new Set(preferences.protectedItems.filter(item => current.has(item.fixedCostId)).map(item => item.fixedCostId));
}
