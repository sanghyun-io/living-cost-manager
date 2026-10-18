import { expect, test } from "vitest";
import { createDefaultWorkspacePlanningData, planningDateSchema, planningWeekEnd, putWorkspacePlanningSchema, workspacePlanningDataSchema } from "./planning.js";

const date = "2026-10-18";
const at = "2026-10-18T12:00:00.000Z";
const week = { weekStart: date, budgetAmount: 0, spentAmount: null, recordedAt: null };
const reserve = { id: "r", costId: "orphan", savedAmount: 0, targetAmount: null, targetDueDate: null, recordedAt: at };
test("new empty planning defaults to ISO Monday and accepts a Monday week without remapping Sunday history", () => {
  const data = createDefaultWorkspacePlanningData();
  expect(data).toEqual({ schemaVersion: 1, paydayDay: null, weekStartDay: 1, weeks: [], reserves: [] });
  expect(workspacePlanningDataSchema.parse({ ...data, weeks: [{ ...week, weekStart: "2026-10-19" }] }).weeks[0]?.weekStart).toBe("2026-10-19");
  expect(workspacePlanningDataSchema.safeParse({ ...data, weeks: [week] }).success).toBe(false);
  expect(workspacePlanningDataSchema.parse({ ...data, weekStartDay: 7, weeks: [week] }).weeks[0]?.weekStart).toBe(date);
});
test("default planning is explicit and fresh; zero budget, unknown actual, recorded zero remain distinct", () => {
  const data = { ...createDefaultWorkspacePlanningData(), weekStartDay: 7 };
  expect(workspacePlanningDataSchema.parse(data)).toEqual(data);
  data.weeks.push(week);
  expect(createDefaultWorkspacePlanningData().weeks).toEqual([]);
  for (const spentAmount of [null, 0, 2147483647]) {
    expect(workspacePlanningDataSchema.parse({ ...data, weeks: [{ ...week, spentAmount, recordedAt: spentAmount === null ? null : at }] }).weeks[0]?.spentAmount).toBe(spentAmount);
  }
});
test.each(["2026-02-29", "2026-02-30", "2024-04-31", "0000-01-01", "2026-13-01", "2026-1-01", "2026-10-18T00:00:00Z"])("rejects non-real calendar date %s", value => {
  expect(planningDateSchema.safeParse(value).success).toBe(false);
});
test("UTC week boundaries handle leap days, year changes and explicit ISO weekday", () => {
  expect(planningWeekEnd("2024-02-25")).toBe("2024-03-02");
  expect(planningWeekEnd("2026-12-27")).toBe("2027-01-02");
  expect(workspacePlanningDataSchema.safeParse({ ...createDefaultWorkspacePlanningData(), weekStartDay: 1, weeks: [week] }).success).toBe(false);
});
test("strict version, nested fields, uniqueness, timestamps, bounds and actual pairing", () => {
  const data = { ...createDefaultWorkspacePlanningData(), weekStartDay: 7 };
  const invalid = [
    { ...data, schemaVersion: 2 }, { ...data, unknown: true }, { ...data, paydayDay: 0 }, { ...data, paydayDay: 32 }, { ...data, weekStartDay: 0 },
    { ...data, weeks: [{ ...week, extra: true }] }, { ...data, weeks: [week, week] },
    ...[-1, 0.5, NaN, Infinity, 2147483648].map(budgetAmount => ({ ...data, weeks: [{ ...week, budgetAmount }] })),
    { ...data, weeks: [{ ...week, spentAmount: 0 }] }, { ...data, weeks: [{ ...week, recordedAt: at }] },
    { ...data, weeks: [{ ...week, spentAmount: 0, recordedAt: date }] },
    { ...data, reserves: [reserve, { ...reserve, id: "r2" }] }, { ...data, reserves: [reserve, { ...reserve, costId: "other" }] },
    { ...data, reserves: [{ ...reserve, savedAmount: 1, recordedAt: null }] },
    { ...data, reserves: [{ ...reserve, targetAmount: 0, savedAmount: null, recordedAt: null }] },
    { ...data, reserves: [{ ...reserve, costId: "" }] }, { ...data, reserves: [{ ...reserve, costLabel: "a".repeat(121) }] },
    { ...data, reserves: Array.from({ length: 1001 }, (_, i) => ({ ...reserve, id: String(i), costId: String(i) })) }
  ];
  for (const value of invalid) expect(workspacePlanningDataSchema.safeParse(value).success, JSON.stringify(value).slice(0, 200)).toBe(false);
  expect(workspacePlanningDataSchema.parse({ ...data, reserves: [reserve] }).reserves[0]?.savedAmount).toBe(0);
});
test("520 weeks allowed without auto expiry; 521 rejected; strict CAS envelopes", () => {
  const data = { ...createDefaultWorkspacePlanningData(), weekStartDay: 7 };
  const start = new Date("2016-01-03T00:00:00Z");
  const weeks = Array.from({ length: 521 }, (_, index) => ({ ...week, weekStart: new Date(start.getTime() + index * 7 * 86400000).toISOString().slice(0, 10) }));
  expect(workspacePlanningDataSchema.parse({ ...data, weeks: weeks.slice(0, 520) }).weeks).toHaveLength(520);
  expect(workspacePlanningDataSchema.safeParse({ ...data, weeks }).success).toBe(false);
  const put = { expectedRevision: 0, expectedSnapshotVersion: 0, data };
  expect(putWorkspacePlanningSchema.parse(put)).toEqual(put);
  for (const value of [{ ...put, expectedRevision: 2147483647 }, { ...put, expectedSnapshotVersion: -1 }, { ...put, revision: 0 }]) expect(putWorkspacePlanningSchema.safeParse(value).success).toBe(false);
});
