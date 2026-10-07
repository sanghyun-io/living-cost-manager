import type { WorkspaceFinancialSummary } from "./workspace.js";

const DAY = 86400000;
type AggregateCost = {
  amount: number;
  periodMonths: number;
  billingAnchorDate?: string | null;
  isEndOfMonth: boolean;
};

function validUtcCalendarDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** KST has a fixed UTC+09 offset. UTC calendar arithmetic intentionally avoids
 * process/browser TZ, DST and local-midnight parsing. Window is [today,+30). */
export function kstThirtyDayWindow(asOf: Date) {
  if (!Number.isFinite(asOf.getTime())) throw new RangeError("Invalid reference instant");
  const fromDate = new Date(asOf.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  return { fromDate, untilDateExclusive: new Date(start + 30 * DAY).toISOString().slice(0, 10), start, end: start + 30 * DAY };
}

/** Original anchor day is sticky across month clamps (Jan31 -> Feb28 -> Mar31).
 * Fractional/zero periods still contribute monthly budgets where possible,
 * but cannot provide exact calendar schedules and are counted as unknown. */
export function summarizeWorkspaceBudget(
  monthlyIncome: number, costs: readonly AggregateCost[], asOf: Date
): WorkspaceFinancialSummary {
  const { start, end } = kstThirtyDayWindow(asOf);
  const today = new Date(start);
  let monthly = 0, due = 0, known = 0, unknown = 0, occurrences = 0;
  for (const cost of costs) {
    if (cost.periodMonths > 0) monthly += cost.amount / cost.periodMonths;
    if (cost.amount <= 0) continue;
    if (!validUtcCalendarDate(cost.billingAnchorDate) ||
        !Number.isInteger(cost.periodMonths) || cost.periodMonths < 1 || cost.periodMonths > 120) {
      unknown++;
      continue;
    }
    known++;
    const [year, month, day] = cost.billingAnchorDate!.split("-").map(Number);
    const elapsed = (today.getUTCFullYear() - year) * 12 + today.getUTCMonth() - (month - 1);
    let step = Math.max(0, Math.floor(elapsed / cost.periodMonths));
    // At most two charges can lie in 30 days for integral month recurrence.
    for (;;) {
      const date = new Date(Date.UTC(year, month - 1 + step * cost.periodMonths, 1));
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(cost.isEndOfMonth ? last : Math.min(day, last));
      const stamp = date.getTime();
      if (stamp >= end) break;
      if (stamp >= start) { due += cost.amount; occurrences++; }
      step++;
    }
  }
  return { monthlyIncome, monthlyNormalizedExpense: monthly, fixedCostCount: costs.length,
    knownScheduleCount: known, unknownScheduleCount: unknown, dueOccurrenceCount: occurrences,
    thirtyDayDue: known === 0 && unknown > 0 ? null : due };
}

/** Do not round per item or ledger: the client rounds the final display only. */
export function sumWorkspaceBudgets(summaries: readonly WorkspaceFinancialSummary[]): WorkspaceFinancialSummary {
  const totals: WorkspaceFinancialSummary = { monthlyIncome: 0, monthlyNormalizedExpense: 0, fixedCostCount: 0,
    knownScheduleCount: 0, unknownScheduleCount: 0, dueOccurrenceCount: 0, thirtyDayDue: 0 };
  for (const summary of summaries) {
    totals.monthlyIncome += summary.monthlyIncome;
    totals.monthlyNormalizedExpense += summary.monthlyNormalizedExpense;
    totals.fixedCostCount += summary.fixedCostCount;
    totals.knownScheduleCount += summary.knownScheduleCount;
    totals.unknownScheduleCount += summary.unknownScheduleCount;
    totals.dueOccurrenceCount += summary.dueOccurrenceCount;
    totals.thirtyDayDue! += summary.thirtyDayDue ?? 0;
  }
  if (totals.knownScheduleCount === 0 && totals.unknownScheduleCount > 0) totals.thirtyDayDue = null;
  return totals;
}
