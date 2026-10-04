import { computeNextDueDate } from "@living-cost-manager/shared";
import { type FixedCost } from "./budget";

export type CostFilters = { query: string; method: string; review: string; sort: string };
export const emptyCostFilters: CostFilters = { query: "", method: "all", review: "all", sort: "original" };
export function filterCosts(items: FixedCost[], filters: CostFilters, now = new Date()) {
  const query = filters.query.trim().toLocaleLowerCase();
  const result = items.filter((item) => item.name.toLocaleLowerCase().includes(query)
    && (filters.method === "all" || item.paymentMethodId === filters.method)
    && (filters.review === "all" || (item.renewalStatus ?? "unreviewed") === filters.review));
  if (filters.sort === "amount") result.sort((a, b) => b.amount - a.amount);
  if (filters.sort === "due") result.sort((a, b) => (computeNextDueDate(a, now)?.getTime() ?? Infinity) - (computeNextDueDate(b, now)?.getTime() ?? Infinity));
  return result;
}
