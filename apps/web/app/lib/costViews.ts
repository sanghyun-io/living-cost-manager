import { computeNextDueDate } from "@living-cost-manager/shared";
import { type FixedCost } from "./budget";

export type CostFilters = { query: string; method: string; review: string; sort: string };
export const emptyCostFilters: CostFilters = { query: "", method: "all", review: "all", sort: "original" };
export function duplicateCost(item: FixedCost, id: string): FixedCost {
  return { ...item, id, name: item.name + " (복사)", renewalStatus: "unreviewed", potentialMonthlySavings: 0, confirmedMonthlySavings: 0 };
}
export function renewalQueue(items: FixedCost[], now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start); end.setDate(end.getDate() + 30);
  return items.filter((item) => {
    if (["cancel-planned", "change-review"].includes(item.renewalStatus ?? "")) return true;
    const due = computeNextDueDate(item, start);
    return (item.renewalStatus ?? "unreviewed") === "unreviewed" && !!due && due < end && item.amount > 0;
  });
}
export function filterCosts(items: FixedCost[], filters: CostFilters, now = new Date()) {
  const query = filters.query.trim().toLocaleLowerCase();
  const result = items.filter((item) => item.name.toLocaleLowerCase().includes(query)
    && (filters.method === "all" || item.paymentMethodId === filters.method)
    && (filters.review === "all" || (item.renewalStatus ?? "unreviewed") === filters.review));
  if (filters.sort === "amount") result.sort((a, b) => b.amount - a.amount);
  if (filters.sort === "due") result.sort((a, b) => (computeNextDueDate(a, now)?.getTime() ?? Infinity) - (computeNextDueDate(b, now)?.getTime() ?? Infinity));
  return result;
}
