import { describe, expect, test } from "vitest";
import { billingFieldsSchema, buildThirtyDayDueSummary, computeNextDueDate, getUpcomingDues, summarizeRenewalSavings } from "./index.js";

const cost = { id: "x", name: "Annual", categoryId: "other", amount: 120000, billingDay: 1,
  isEndOfMonth: false, periodMonths: 12, billingAnchorDate: "2024-02-29" };

describe("anchored billing", () => {
  test("annual leap day clamps without drifting across cycles", () => {
    expect(computeNextDueDate(cost, new Date(2025, 0, 1))).toEqual(new Date(2025, 1, 28));
    expect(computeNextDueDate(cost, new Date(2028, 0, 1))).toEqual(new Date(2028, 1, 29));
  });
  test("quarterly month phase, future anchors, and inclusive due day", () => {
    const quarterly = { ...cost, periodMonths: 3, billingAnchorDate: "2026-01-31" };
    expect(computeNextDueDate(quarterly, new Date(2026, 1, 1))).toEqual(new Date(2026, 3, 30));
    expect(computeNextDueDate(quarterly, new Date(2025, 0, 1))).toEqual(new Date(2026, 0, 31));
    expect(computeNextDueDate(quarterly, new Date(2026, 3, 30))).toEqual(new Date(2026, 3, 30));
  });
  test("unknown and fractional schedules never create dues", () => {
    const items = [{ ...cost, billingAnchorDate: null }, { ...cost, periodMonths: 0.5 }];
    expect(getUpcomingDues(items, new Date(2026, 1, 27))).toEqual([]);
    expect(buildThirtyDayDueSummary(items, new Date(2026, 1, 27)).unknownCount).toBe(2);
  });
  test("30 day window counts full charges including two monthly occurrences, excludes day 30", () => {
    const monthly = { ...cost, amount: 100, periodMonths: 1, billingAnchorDate: "2026-01-01" };
    const summary = buildThirtyDayDueSummary([monthly, cost], new Date(2026, 1, 1));
    expect(summary.total).toBe(120200);
    expect(summary.monthlyNormalized).toBe(10100);
    expect(summary.dues).toHaveLength(3);
    expect(buildThirtyDayDueSummary([{ ...monthly, billingAnchorDate: "2026-03-03" }], new Date(2026, 1, 1)).total).toBe(0);
  });
  test("strict date and savings validation", () => {
    expect(billingFieldsSchema.safeParse({ billingAnchorDate: "2026-02-29" }).success).toBe(false);
    expect(billingFieldsSchema.safeParse({ renewalStatus: "cancel-planned", confirmedMonthlySavings: 10 }).success).toBe(false);
    expect(summarizeRenewalSavings([
      { renewalStatus: "cancel-planned", potentialMonthlySavings: 100 },
      { renewalStatus: "completed", potentialMonthlySavings: 100, confirmedMonthlySavings: 40 },
      { renewalStatus: "keep", potentialMonthlySavings: 500 }
    ])).toEqual({ potential: 100, confirmed: 40 });
  });
});
