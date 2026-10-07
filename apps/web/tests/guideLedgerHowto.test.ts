import { describe, expect, test } from "vitest";
import { aggregateWorkspacesRequestSchema, kstThirtyDayWindow, summarizeWorkspaceBudget, sumWorkspaceBudgets } from "@living-cost-manager/shared";
import { guides } from "../app/guide/content";

const guide = guides.find(({ slug }) => slug === "backup-and-sync")!;
const section = guide.sections.find(({ title }) => title === "목적별 가계부 만들고 선택한 비용만 합산하기")!;
const text = section.paragraphs.join(" ");
const steps = section.steps!.join(" ");

describe("public multi-ledger how-to", () => {
  test("existing guide listing exposes purpose-specific, server-saved read-only aggregation", () => {
    expect(guide.title).toContain("가계부 선택·합산");
    expect(guide.description).toContain("서버 저장본");
    expect(guide.description).toContain("읽기 전용");
    expect(text).toContain("‘독립생활’과 ‘구독점검’");
    expect(text).toContain("최대 20개");
    expect(text).toContain("브라우저의 미동기화 편집은 포함되지 않습니다");
    expect(text).toContain("수동 업로드한 뒤 합산을 다시 조회");
  });

  test("creation and explicit selection match existing control labels and permissions", () => {
    expect(text).toContain("새 가계부 생성은 이메일 확인 후");
    expect(text).toContain("이름 변경은 이메일 확인을 마친 소유자만");
    expect(text).toContain("현재 가계부는 자동으로 바뀌지 않습니다");
    expect(steps).toContain("‘새 가계부’");
    expect(steps).toContain("‘현재 가계부’에서 새 가계부를 직접 선택");
    expect(steps).toContain("실제 금액과 월 수입");
    expect(steps).toContain("‘선택한 가계부 합산 조회’");
    expect(steps).toContain("‘합산 보기’를 끄고");
    expect(text).toContain("자동으로 전체 가계부를 선택하거나 업로드하지 않습니다");
  });

  test("duplicate ledger IDs are distinct from duplicate expenses and income is excluded", () => {
    expect(text).toContain("원화(KRW) 비용만 합산");
    expect(text).toContain("수입·잔액·절감률은 합산하지 않습니다");
    expect(text).toContain("같은 가계부 ID는 한 번만 계산");
    expect(aggregateWorkspacesRequestSchema.parse({ workspaceIds: ["a", "b", "a"] }).workspaceIds).toEqual(["a", "b"]);
    expect(text).toContain("같은 실제 지출을 두 가계부에 넣으면 두 번");
    expect(text).toContain("이름·금액이 같아도 중복 제거하지 않으므로");
    const cost = { amount: 10000, periodMonths: 1, isEndOfMonth: false };
    const snapshot = summarizeWorkspaceBudget(3000000, [cost], new Date("2026-10-07T00:00:00Z"));
    const totals = sumWorkspaceBudgets([snapshot, snapshot]);
    expect(totals.monthlyNormalizedExpense).toBe(20000);
    expect(totals).not.toHaveProperty("monthlyIncome");
  });

  test("illustrative monthly and full annual charges agree with the shared calculation", () => {
    const asOf = new Date("2026-10-06T16:00:00Z"); // Already October 7 in KST.
    const a = summarizeWorkspaceBudget(0, [{ amount: 10000, periodMonths: 1, billingAnchorDate: "2026-10-10", isEndOfMonth: false }], asOf);
    const b = summarizeWorkspaceBudget(0, [{ amount: 120000, periodMonths: 12, billingAnchorDate: "2026-10-20", isEndOfMonth: false }], asOf);
    const totals = sumWorkspaceBudgets([a, b]);
    expect(totals.monthlyNormalizedExpense).toBe(20000);
    expect(b.thirtyDayDue).toBe(120000);
    expect(totals.thirtyDayDue).toBe(130000);
    expect(text).toContain("월환산 합계 20,000원");
    expect(text).toContain("월환산 10,000원이 아닌 120,000원");
    expect(text).toContain("결제 완료액이나 실제 청구 검증 결과가 아닙니다");
  });

  test("KST exclusive end and unknown schedules are not presented as zero verified payments", () => {
    const asOf = new Date("2026-10-06T16:00:00Z");
    expect(kstThirtyDayWindow(asOf)).toMatchObject({ fromDate: "2026-10-07", untilDateExclusive: "2026-11-06" });
    const endDateCost = summarizeWorkspaceBudget(0, [{ amount: 120000, periodMonths: 12, billingAnchorDate: "2026-11-06", isEndOfMonth: false }], asOf);
    expect(endDateCost.thirtyDayDue).toBe(0);
    const unknown = summarizeWorkspaceBudget(0, [{ amount: 10000, periodMonths: 1, isEndOfMonth: false }], asOf);
    expect(sumWorkspaceBudgets([unknown])).toMatchObject({ thirtyDayDue: null, unknownScheduleCount: 1 });
    const mixed = sumWorkspaceBudgets([endDateCost, unknown]);
    expect(mixed).toMatchObject({ thirtyDayDue: 0, unknownScheduleCount: 1, knownScheduleCount: 1 });
    expect(text).toContain("한국 시간 오늘부터 30일 뒤 날짜 전까지");
    expect(text).toContain("마지막 날짜는 제외");
    expect(text).toContain("일정 미확인 항목은 예정액에서 제외하고 개수를 표시");
    expect(text).toContain("0원이 아닌 ‘일정 미확인’");
  });
});
