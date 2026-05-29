// 공유 요약 — 예산 요약을 SNS/메신저로 보낼 수 있는 텍스트로 만든다.
// 외부 의존 0 순수 함수. web 의 BudgetSummary 에 결합하지 않도록 최소 입력만 받는다.

export type ShareSummaryInput = {
  monthlyIncome: number;
  monthlyExpense: number; // 월 환산 고정비 합계
  topCategoryLabel?: string;
  topCategoryAmount?: number;
};

/** 수입 대비 고정비 비율(%). 수입 0 이면 null. 소수 1자리. */
export function expenseRatioPercent(
  input: Pick<ShareSummaryInput, "monthlyIncome" | "monthlyExpense">
): number | null {
  if (input.monthlyIncome <= 0) {
    return null;
  }
  return Math.round((input.monthlyExpense / input.monthlyIncome) * 1000) / 10;
}

/**
 * 공유용 한국어 요약 텍스트. 절대 수입액은 노출하지 않고 비율로만 보여
 * 과도한 정보 공유를 피한다(고정비 절대액 + 비율 + Top 카테고리).
 */
export function buildShareSummary(input: ShareSummaryInput): string {
  const lines: string[] = [];
  lines.push("📊 내 고정비 요약");
  lines.push(`월 고정비 ${Math.max(0, Math.round(input.monthlyExpense)).toLocaleString("ko-KR")}원`);

  const ratio = expenseRatioPercent(input);
  if (ratio !== null) {
    lines.push(`수입 대비 ${ratio}%`);
  }

  if (
    input.topCategoryLabel &&
    typeof input.topCategoryAmount === "number" &&
    input.topCategoryAmount > 0
  ) {
    lines.push(
      `가장 큰 항목: ${input.topCategoryLabel} ${Math.round(input.topCategoryAmount).toLocaleString("ko-KR")}원`
    );
  }

  lines.push("— Living Cost Manager");
  return lines.join("\n");
}
