import { z } from "zod";

const MAX_INT = 2147483647;
export const planningDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return value.slice(0, 4) !== "0000" && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const timestamp = z.iso.datetime({ offset: true });
const amount = z.number().int().min(0).max(MAX_INT).nullable();
const id = z.string().trim().min(1).max(200);
export const planningWeekSchema = z.object({
  weekStart: planningDateSchema,
  budgetAmount: amount,
  spentAmount: amount,
  recordedAt: timestamp.nullable()
}).strict().refine(value => (value.spentAmount === null) === (value.recordedAt === null), "Actual spending requires recordedAt (zero is recorded)");
export const planningReserveSchema = z.object({
  id,
  costId: id,
  savedAmount: amount,
  targetAmount: amount,
  targetDueDate: planningDateSchema.nullable(),
  recordedAt: timestamp.nullable(),
  costLabel: z.string().max(120).optional()
}).strict().refine(value => (value.savedAmount === null && value.targetAmount === null && value.targetDueDate === null) || value.recordedAt !== null,
  "Recorded reserve values require recordedAt");
export const workspacePlanningDataSchema = z.object({
  schemaVersion: z.literal(1),
  paydayDay: z.number().int().min(1).max(31).nullable(),
  // ISO weekday: Monday=1 ... Sunday=7. Default Monday; never locale-dependent.
  weekStartDay: z.number().int().min(1).max(7),
  weeks: z.array(planningWeekSchema).max(520),
  reserves: z.array(planningReserveSchema).max(1000)
}).strict().superRefine((value, ctx) => {
  for (const [field, keys] of [
    ["weeks", value.weeks.map(week => week.weekStart)],
    ["reserves", value.reserves.map(reserve => reserve.id)],
    ["reserves", value.reserves.map(reserve => reserve.costId)]
  ] as const) {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: [field], message: "Duplicate planning key" });
  }
  for (const [index, week] of value.weeks.entries()) {
    const day = new Date(`${week.weekStart}T00:00:00.000Z`).getUTCDay() || 7;
    if (day !== value.weekStartDay) ctx.addIssue({ code: "custom", path: ["weeks", index, "weekStart"], message: "Week start must match weekStartDay" });
  }
});
export const putWorkspacePlanningSchema = z.object({
  expectedRevision: z.number().int().min(0).max(MAX_INT - 1),
  expectedSnapshotVersion: z.number().int().min(0).max(MAX_INT),
  data: workspacePlanningDataSchema
}).strict();
export const workspacePlanningSchema = z.object({
  workspaceId: id,
  revision: z.number().int().min(0).max(MAX_INT),
  currentSnapshotVersion: z.number().int().min(0).max(MAX_INT),
  data: workspacePlanningDataSchema
}).strict();
export type WorkspacePlanningData = z.infer<typeof workspacePlanningDataSchema>;
export type WorkspacePlanning = z.infer<typeof workspacePlanningSchema>;
export type PutWorkspacePlanning = z.infer<typeof putWorkspacePlanningSchema>;
export function createDefaultWorkspacePlanningData(): WorkspacePlanningData {
  return { schemaVersion: 1, paydayDay: null, weekStartDay: 1, weeks: [], reserves: [] };
}
/** Inclusive calendar period; UTC arithmetic avoids DST/local timezone shifts. */
export function planningWeekEnd(weekStart: string): string {
  const valid = planningDateSchema.parse(weekStart);
  const date = new Date(`${valid}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return planningDateSchema.parse(date.toISOString().slice(0, 10));
}
