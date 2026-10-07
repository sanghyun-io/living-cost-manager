import { describe, expect, test } from "vitest";
import { buildThirtyDayDueSummary } from "../src/predictions.js";
import { createWorkspaceRequestSchema, aggregateWorkspacesRequestSchema } from "../src/workspace.js";
import { kstThirtyDayWindow, summarizeWorkspaceBudget, sumWorkspaceBudgets } from "../src/workspaceAggregation.js";

const cost = (anchor: string | null, periodMonths = 1, amount = 100) => ({
  amount, periodMonths, billingAnchorDate: anchor, isEndOfMonth: false,
  id: "cost", name: "Cost", categoryId: "other", billingDay: 31,
});
describe("KST ledger aggregation", () => {
  test("same KST window/charges in UTC, Seoul and Los Angeles across midnight", () => {
    const previous = process.env.TZ;
    try {
      const results = ["UTC", "Asia/Seoul", "America/Los_Angeles"].map(tz => {
        process.env.TZ = tz;
        const asOf = new Date("2026-10-06T15:01:00Z");
        return { window: kstThirtyDayWindow(asOf), summary: summarizeWorkspaceBudget(500, [cost("2026-10-07"), cost("2026-11-06")], asOf) };
      });
      expect(results[0]).toEqual(results[1]);
      expect(results[1]).toEqual(results[2]);
      expect(results[0].window.fromDate).toBe("2026-10-07");
      expect(results[0].window.untilDateExclusive).toBe("2026-11-06");
      expect(results[0].summary.thirtyDayDue).toBe(100);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  test("sticky monthly anchor clamps leap February then recovers March31; repeated charges", () => {
    expect(summarizeWorkspaceBudget(0, [cost("2024-01-31")], new Date("2024-02-29T00:00:00Z")).thirtyDayDue).toBe(100);
    expect(summarizeWorkspaceBudget(0, [cost("2024-01-31")], new Date("2024-03-01T00:00:00Z")).thirtyDayDue).toBe(0);
    expect(summarizeWorkspaceBudget(0, [cost("2025-01-31")], new Date("2025-01-31T00:00:00Z")).dueOccurrenceCount).toBe(2);
  });
  test("quarterly, annual, end-of-month and unknown fractional/zero/missing dates", () => {
    const summary = summarizeWorkspaceBudget(0, [cost("2026-01-31", 3, 300), cost("2025-04-30", 12, 1200),
      { ...cost("2026-01-10"), isEndOfMonth: true }, cost(null), cost("2026-01-01", 0.5), cost(null, 0)], new Date("2026-04-01T00:00:00Z"));
    expect(summary).toMatchObject({ knownScheduleCount: 3, unknownScheduleCount: 3, thirtyDayDue: 1600, dueOccurrenceCount: 3 });
    expect(summarizeWorkspaceBudget(0, [cost(null)], new Date()).thirtyDayDue).toBeNull();
    expect(summarizeWorkspaceBudget(0, [cost(null, 1, 0)], new Date()).thirtyDayDue).toBe(0);
    expect(sumWorkspaceBudgets([summarizeWorkspaceBudget(0, [cost(null)], new Date())]).thirtyDayDue).toBeNull();
  });
  test("known actual schedule matches single-ledger prediction on the same KST calendar day", () => {
    const previous = process.env.TZ; process.env.TZ = "Asia/Seoul";
    try {
      const items = [cost("2024-01-31"), cost("2024-01-31", 3, 300), cost("2024-02-29", 12, 1200), cost(null)];
      const from = new Date("2026-02-27T15:01:00Z");
      const existing = buildThirtyDayDueSummary(items, from);
      const summary = summarizeWorkspaceBudget(500, items, from);
      expect(summary.thirtyDayDue).toBe(existing.total);
      expect(summary.unknownScheduleCount).toBe(existing.unknownCount);
      expect(summary.dueOccurrenceCount).toBe(existing.dues.length);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  test("monthly normalized values round only at final display, not per item or ledger", () => {
    const summary = summarizeWorkspaceBudget(0, [cost(null, 3, 1)], new Date());
    expect(sumWorkspaceBudgets([summary, summary, summary]).monthlyNormalizedExpense).toBe(1);
  });
  test("income stays ledger-local: totals omit it rather than double-counting a repeated salary", () => {
    const summary = summarizeWorkspaceBudget(3000000, [cost(null)], new Date());
    expect(summary.monthlyIncome).toBe(3000000);
    expect(sumWorkspaceBudgets([summary, summary])).not.toHaveProperty("monthlyIncome");
    expect(sumWorkspaceBudgets([])).not.toHaveProperty("monthlyIncome");
  });
  test("invalid rollover dates are unknown and future anchors never back-project payments", () => {
    const from = new Date("2026-02-01T00:00:00Z");
    expect(summarizeWorkspaceBudget(0, [cost("2026-02-30")], from)).toMatchObject({ unknownScheduleCount: 1, thirtyDayDue: null });
    expect(summarizeWorkspaceBudget(0, [cost("2027-01-01", 12)], from)).toMatchObject({ knownScheduleCount: 1, thirtyDayDue: 0 });
  });
  test("payloads bound, deduplicate and reject ownership/identity overrides", () => {
    expect(aggregateWorkspacesRequestSchema.parse({ workspaceIds: ["a", "a"] }).workspaceIds).toEqual(["a"]);
    expect(aggregateWorkspacesRequestSchema.safeParse({ workspaceIds: [] }).success).toBe(false);
    expect(aggregateWorkspacesRequestSchema.safeParse({ workspaceIds: Array(21).fill("a") }).success).toBe(false);
    expect(createWorkspaceRequestSchema.safeParse({ name: "Test", ownerId: "attacker" }).success).toBe(false);
    expect(createWorkspaceRequestSchema.parse({ name: " Test " }).name).toBe("Test");
    expect(createWorkspaceRequestSchema.safeParse({ name: "Test", initialBudget: { fixedCosts: [{ ...cost(null), workspaceId: "victim" }] } }).success).toBe(false);
  });
});
