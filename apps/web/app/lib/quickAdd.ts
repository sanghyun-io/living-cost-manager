import { parseFixedCostInput } from "@living-cost-manager/shared";
export function previewQuickAdd(text: string) {
  const parsed = parseFixedCostInput(text);
  const periodMonths = parsed.periodMonths ?? 1;
  const valid = !!parsed.name && parsed.amount !== undefined && Number.isFinite(parsed.amount)
    && parsed.amount >= 0 && parsed.amount <= 2147483647 && periodMonths > 0 && periodMonths <= 120;
  return { ...parsed, periodMonths, valid, defaultPeriod: parsed.periodMonths === undefined };
}
