import { computeNextDueDate } from "@living-cost-manager/shared";
import type { FixedCost } from "./budget";
export function scheduleHelp(item: FixedCost, now = new Date()) {
  if (!item.billingAnchorDate) return "다음 납부일 미확인: 실제 청구 기준 납부일을 입력하세요. 카드 결제일과는 별개입니다.";
  if (!Number.isInteger(item.periodMonths)) return "다음 납부일 미확인: 소수 개월은 달력 일정으로 계산하지 않습니다. 실제 청구 주기를 정수 개월로 설정하세요. 월 환산은 유지됩니다.";
  const due = computeNextDueDate(item, now);
  return due ? `다음 ${due.getFullYear()}/${due.getMonth() + 1}/${due.getDate()} · ${item.isEndOfMonth ? "매 청구월 말일 적용" : "해당 날짜가 없는 달에는 그 달 말일 적용"}` : "다음 납부일 미확인: 기준일과 주기를 확인하세요.";
}
