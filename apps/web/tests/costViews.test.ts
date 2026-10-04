import { expect, test } from "vitest";
import { createFixedCost } from "../app/lib/budget";
import { emptyCostFilters, filterCosts } from "../app/lib/costViews";
const make = (id: string, patch = {}) => createFixedCost({ id, name: id, amount: 100, periodMonths: 1, billingDay: 1, ...patch });
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
