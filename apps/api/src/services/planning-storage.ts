import { workspacePlanningDataSchema } from "@living-cost-manager/shared";
import type { Prisma } from "@prisma/client";

// Shared by both writers, without a planning<->snapshot service import cycle.
// Fail closed: never archive corrupt/future-version data as empty current state.
export function planningArchive(row: { revision: number; payloadJson: Prisma.JsonValue } | null) {
  if (!row) return {};
  if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2147483647) throw new Error("Invalid stored planning revision");
  const parsed = workspacePlanningDataSchema.safeParse(row.payloadJson);
  if (!parsed.success) throw new Error("Invalid stored planning data");
  return { planning: { revision: row.revision, data: parsed.data } };
}
