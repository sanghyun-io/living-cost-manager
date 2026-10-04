import { expect, test } from "vitest";
import { createFixedCost } from "../app/lib/budget";
import { duplicateCost, emptyCostFilters, filterCosts, renewalQueue } from "../app/lib/costViews";
const make = (id: string, patch = {}) => createFixedCost({ id, name: id, amount: 100, periodMonths: 1, billingDay: 1, ...patch });
test("renewal queue follows review transitions without changing billed amounts or savings", () => {
  const item = make("due", { billingAnchorDate: "2026-10-06" });
  const now = new Date(2026, 9, 5);
  expect(renewalQueue([item, make("unknown")], now)).toEqual([item]);
  for (const renewalStatus of ["keep", "completed"] as const) expect(renewalQueue([{ ...item, renewalStatus }], now)).toEqual([]);
  for (const renewalStatus of ["cancel-planned", "change-review"] as const) {
    const planned = { ...item, renewalStatus, billingAnchorDate: null, potentialMonthlySavings: 50 };
    expect(renewalQueue([planned], now)).toEqual([planned]);
    expect(planned.amount).toBe(100); expect(planned.confirmedMonthlySavings).toBe(0);
  }
});
test("duplicate preserves billing but resets all review savings without mutating original", () => {
  const original = make("original", { renewalStatus: "completed", confirmedMonthlySavings: 900, potentialMonthlySavings: 300, billingAnchorDate: "2024-02-29", isEndOfMonth: true });
  const before = structuredClone(original);
  const copy = duplicateCost(original, "new-id");
  expect(copy).toEqual({ ...original, id: "new-id", name: "original (복사)", renewalStatus: "unreviewed", confirmedMonthlySavings: 0, potentialMonthlySavings: 0 });
  expect(original).toEqual(before);
});
test("combined name, method, review filtering and reset preserve source", () => {
  const items = [make("Alpha", { renewalStatus: "keep" }), make("Beta"), make("ALPHA 2", { paymentMethodId: "credit-card" })];
  expect(filterCosts(items, { ...emptyCostFilters, query: " alpha ", method: "bank-transfer", review: "keep" }).map(x => x.id)).toEqual(["Alpha"]);
  expect(filterCosts(items, { ...emptyCostFilters, query: "missing" })).toEqual([]);
  expect(filterCosts(items, emptyCostFilters)).toEqual(items);
});
test("due sort places unknown and fractional schedules last; amount uses actual charge", () => {
  const items = [make("unknown"), make("later", { billingAnchorDate: "2026-10-20", amount: 1200, periodMonths: 12 }), make("first", { billingAnchorDate: "2026-10-06" }), make("fraction", { billingAnchorDate: "2026-10-05", periodMonths: 0.5 })];
  expect(filterCosts(items, { ...emptyCostFilters, sort: "due" }, new Date(2026, 9, 5)).map(x => x.id)).toEqual(["first", "later", "unknown", "fraction"]);
  expect(filterCosts(items, { ...emptyCostFilters, sort: "amount" })[0].id).toBe("later");
  expect(items[0].id).toBe("unknown");
});
