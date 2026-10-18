import { workspacePlanningDataSchema } from "@living-cost-manager/shared";
import type { Prisma } from "@prisma/client";

export class PlanningStorageUnavailableError extends Error {
  constructor() {
    super("Planning storage unavailable");
    this.name = "PlanningStorageUnavailableError";
  }
}

// Shared by both writers, without a planning<->snapshot service import cycle.
// Fail closed: never archive corrupt/future-version data as empty current state.
export function planningArchive(row: { revision: number; payloadJson: Prisma.JsonValue } | null) {
  if (!row) return {};
  if (!Number.isInteger(row.revision) || row.revision < 1 || row.revision > 2147483647) throw new PlanningStorageUnavailableError();
  const parsed = workspacePlanningDataSchema.safeParse(row.payloadJson);
  if (!parsed.success) throw new PlanningStorageUnavailableError();
  return { planning: { revision: row.revision, data: parsed.data } };
}
