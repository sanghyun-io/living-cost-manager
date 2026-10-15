import { describe, expect, test } from "vitest";
import { getActiveProtectedFixedCostIds, putCoachingPreferencesSchema } from "./coachingPreferences.js";
import { buildSavingsInsights, buildInsuranceCheck, buildThirtyDayDueSummary, monthlyEquivalent, type PredictableFixedCost } from "./predictions.js";
import { buildShareSummary } from "./shareSummary.js";
import { workspaceSnapshotSchema } from "./snapshot.js";
import { templateBlueprintSchema, TEMPLATE_SCENARIOS } from "./templates.js";

const item = (id: string, amount = 10000, categoryId = "subscription"): PredictableFixedCost => ({
  id, name: "동일 구독", categoryId, amount, periodMonths: 1, billingDay: 15,
  isEndOfMonth: false, billingAnchorDate: "2026-01-15"
});
describe("private coaching protections", () => {
  test("snapshot/export projection and public templates never acquire private coaching fields", () => {
    const privateFields = { protectedItems: [{ fixedCostId: "private-id", reason: "personal" }], coachingPreferences: { revision: 5 } };
    const snapshot = { workspaceId: "workspace", syncVersion: 0, monthlyIncome: 1000000, categories: [], cards: [], fixedCosts: [] };
    expect(workspaceSnapshotSchema.parse({ ...snapshot, ...privateFields })).toEqual(snapshot);
    const summary = { monthlyIncome: 1000000, monthlyExpense: 10000 };
    expect(buildShareSummary({ ...summary, ...privateFields })).toBe(buildShareSummary(summary));
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], ...privateFields }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], items: [{ ...TEMPLATE_SCENARIOS[0].items[0], ...privateFields }] }).success).toBe(false);
  });
  test("optional enum reason, strict bounded unique IDs and revision", () => {
    const valid = { schemaVersion: 1, expectedRevision: 0, protectedItems: [{ fixedCostId: "a" }] };
    expect(putCoachingPreferencesSchema.safeParse(valid).success).toBe(true);
    for (const body of [
      { ...valid, userId: "other" }, { ...valid, expectedRevision: -1 },
      { ...valid, protectedItems: [{ fixedCostId: "a", reason: "private text" }] },
      { ...valid, protectedItems: [{ fixedCostId: "a", deferDate: "2026-12-01" }] },
      { ...valid, protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "a" }] },
      { ...valid, protectedItems: Array.from({ length: 1001 }, (_, i) => ({ fixedCostId: String(i) })) }
    ]) expect(putCoachingPreferencesSchema.safeParse(body).success).toBe(false);
  });
  test("all protected means no savings recommendations, but full ledger and dues survive", () => {
    const items = [item("a"), item("b", 20000), item("c", 30000, "insurance")];
    const before = structuredClone(items);
    const options = { protectedFixedCostIds: items.map(i => i.id) };
    const due = buildThirtyDayDueSummary(items, new Date(2026, 9, 1));
    expect(buildSavingsInsights(items, options)).toEqual([]);
    expect(buildInsuranceCheck(items, 100000, options)).toMatchObject({ monthlyInsuranceTotal: 30000, ratioOfIncome: .3, isHigh: true, canSuggestReview: false, reviewItemIds: [] });
    expect(items).toEqual(before);
    expect(buildThirtyDayDueSummary(items, new Date(2026, 9, 1))).toEqual(due);
    expect(due.total).toBe(60000);
    expect(items.reduce((s, i) => s + monthlyEquivalent(i), 0)).toBe(60000);
  });
  test("filter before duplicate grouping, title selection and amount calculation", () => {
    const items = [item("protected", 999999), item("a", 10000), item("b", 5000)];
    const insights = buildSavingsInsights(items, { protectedFixedCostIds: new Set(["protected", "unknown"]) });
    expect(insights.find(i => i.kind === "duplicate")).toMatchObject({ monthlySavings: 5000, actionableItemIds: ["b"] });
    expect(insights.every(i => i.items.every(i => i.id !== "protected"))).toBe(true);
    expect(buildSavingsInsights(items.slice(0, 2), { protectedFixedCostIds: ["protected"] }).some(i => i.kind === "duplicate")).toBe(false);
  });
  test("insurance facts unchanged; mixed review is scoped to unprotected IDs", () => {
    const items = [item("a", 30000, "insurance"), item("b", 20000, "insurance")];
    const result = buildInsuranceCheck(items, 100000, { protectedFixedCostIds: ["a"] });
    expect(result).toEqual({ monthlyInsuranceTotal: 50000, ratioOfIncome: .5, isHigh: true, canSuggestReview: true, reviewItemIds: ["b"] });
    expect(buildInsuranceCheck(items, 1000000, { protectedFixedCostIds: ["a"] }).canSuggestReview).toBe(false);
  });
  test("stable ID protection survives amount/income changes; orphans retained but intersected", () => {
    const preferences = { protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "deleted" }] };
    const items = [item("a", 9999999)];
    const ids = getActiveProtectedFixedCostIds(preferences, items);
    expect([...ids]).toEqual(["a"]);
    expect(preferences.protectedItems).toHaveLength(2);
    expect(buildSavingsInsights(items, { protectedFixedCostIds: ids })).toEqual([]);
    expect(buildSavingsInsights(items, { protectedFixedCostIds: ["unknown"] })).toEqual(buildSavingsInsights(items));
    expect(buildSavingsInsights([item("h", 10000, "housing"), item("i", 20000, "insurance")]).filter(i => i.kind === "largest")).toEqual([]);
  });
});
