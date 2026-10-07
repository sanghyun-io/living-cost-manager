import { computeNextDueDate } from "@living-cost-manager/shared";
import type { FixedCost } from "../lib/budget";

// Row status only. Instructions are shared by the table, not repeated per item.
export function getScheduleStatus(item: FixedCost, now = new Date()): string {
  if (!item.billingAnchorDate) return "납부일 미입력";
  if (!Number.isInteger(item.periodMonths)) return "일정 미계산 · 주기를 정수 개월로 설정하세요";
  const due = computeNextDueDate(item, now);
  return due
    ? `다음 ${due.getFullYear()}/${due.getMonth() + 1}/${due.getDate()}`
    : "일정 미확인 · 기준일과 주기를 확인하세요";
}
