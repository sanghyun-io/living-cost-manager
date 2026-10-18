import { describe, expect, test } from "vitest";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { buildReserveViews, annualCandidates } from "../app/lib/reserveMath";
import { createFixedCost, type FixedCost } from "../app/lib/budget";

function annual(id: string, name: string, amount: number, anchor: string | null, periodMonths = 12): FixedCost {
  return {
    ...createFixedCost({ id, name, categoryId: "other", paymentMethodId: "bank-transfer", paymentOptionId: "", amount, periodMonths, billingDay: 15 }),
    billingAnchorDate: anchor
  };
}

const today = "2026-10-19";

function planningWith(reserves: WorkspacePlanningData["reserves"]): WorkspacePlanningData {
  return { ...createDefaultWorkspacePlanningData(), reserves };
}

describe("reserveMath — 직접 기록 기준 · 명시 캘린더 근거", () => {
  test("기록된 목표 없음 = 현재 항목 금액 표시(서버 기록 아님 명시)", () => {
    const cost = annual("c1", "자동차세", 600000, "2026-01-15");
    const views = buildReserveViews(planningWith([
      { id: "reserve-c1", costId: "c1", savedAmount: 100000, targetAmount: null, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    expect(views[0].effectiveTarget).toBe(600000);
    expect(views[0].targetSource).toBe("item");
    expect(views[0].remaining).toBe(500000);
  });

  test("saved 0과 null(미기록)은 다른 진실이다", () => {
    const cost = annual("c1", "연간 결제", 120000, "2026-01-15");
    const views = buildReserveViews(planningWith([
      { id: "r1", costId: "c1", savedAmount: 0, targetAmount: 120000, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" },
      { id: "r2", costId: "missing", savedAmount: null, targetAmount: null, targetDueDate: null, recordedAt: null, costLabel: "기록 보관 항목" }
    ]), [cost], today);
    expect(views[0].saved).toBe(0);
    expect(views[0].percent).toBe(0);
    expect(views[0].remaining).toBe(120000);
    expect(views[1].saved).toBeNull();
    expect(views[1].percent).toBeNull();
    expect(views[1].remaining).toBeNull();
  });

  test("ceil(remaining/count): 남은 기간·남은 금액 기준으로 회당 필요액을 계산", () => {
    // 반기 항목(앵커 2026-05-01, period 6): 다음 납부 2026-11-01 → 마감(2027-01-05) 전까지 1회
    const cost = annual("h1", "반기 보험", 450001, "2026-05-01", 6);
    const views = buildReserveViews(planningWith([
      { id: "r", costId: "h1", savedAmount: 1, targetAmount: 900001, targetDueDate: "2027-01-05", recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    expect(views[0].contributionsLeft).toBe(1);
    expect(views[0].remaining).toBe(900000);
    expect(views[0].perContribution).toBe(900000);
    // 월 항목(앵커 매월 15일): 마감 2026-12-15까지 11/15, 12/15 = 2회 → ceil(7/2)=4
    const monthly = annual("m", "월 관리비", 5000, "2026-05-15", 1);
    const odd = buildReserveViews(planningWith([
      { id: "r2", costId: "m", savedAmount: 0, targetAmount: 7, targetDueDate: "2026-12-15", recordedAt: "2026-10-19T00:00:00Z" }
    ]), [monthly], today);
    expect(odd[0].contributionsLeft).toBe(2);
    expect(odd[0].perContribution).toBe(4);
  });

  test("납부일 미확인/과거/마감 후: 0으로 나누지 않고 0원 권유도 없다 — 남은 금액+확인 필요", () => {
    const cost = annual("c1", "연간 결제", 100000, "2026-01-15");
    const noDate = buildReserveViews(planningWith([
      { id: "r", costId: "c1", savedAmount: 40000, targetAmount: 100000, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    expect(noDate[0].perContribution).toBeNull();
    expect(noDate[0].contributionsLeft).toBeNull();
    expect(noDate[0].notice).toContain("납부일");
    expect(noDate[0].remaining).toBe(60000); // 남은 금액은 표시

    const past = buildReserveViews(planningWith([
      { id: "r", costId: "c1", savedAmount: 10000, targetAmount: 100000, targetDueDate: "2026-10-18", recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    expect(past[0].dueIsPast).toBe(true);
    expect(past[0].perContribution).toBeNull();
    expect(past[0].notice).toContain("지났");
    expect(past[0].remaining).toBe(90000);

    // 마감까지 확인된 주기가 없는 경우(항목 앵커가 먼 미래)
    const farFuture = annual("c2", "내년 결제", 50000, "2028-06-01");
    const none = buildReserveViews(planningWith([
      { id: "r2", costId: "c2", savedAmount: 0, targetAmount: 50000, targetDueDate: "2026-12-01", recordedAt: "2026-10-19T00:00:00Z" }
    ]), [farFuture], today);
    expect(none[0].perContribution).toBeNull();
    expect(none[0].notice).toContain("회당 필요액");
  });

  test("동일일 마감(today==due): 남은 기간 0 — division by zero 대신 이번 납부 대비 표시", () => {
    const cost = annual("c1", "연간 결제", 100000, "2025-10-19");
    const sameDay = buildReserveViews(planningWith([
      { id: "r", costId: "c1", savedAmount: 70000, targetAmount: 100000, targetDueDate: "2026-10-19", recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    // 마감일 자체는 '오늘 이후' 기간에서 제외 → 확인된 다음 주기(2027)는 마감 후 → count null
    expect(sameDay[0].perContribution).toBeNull();
    expect(sameDay[0].remaining).toBe(30000);
    expect(sameDay[0].dueIsPast).toBe(false);
    expect(sameDay[0].contributionsLeft).toBeNull();
  });

  test("진행률: 0 목표 안전, 초과 준비는 bar 100 clamp + 초과분 명시", () => {
    const cost = annual("c1", "연간 결제", 100000, "2026-01-15");
    const zeroTarget = buildReserveViews(planningWith([
      { id: "r", costId: "c1", savedAmount: 0, targetAmount: 0, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    expect(zeroTarget[0].percent).toBe(0);
    expect(zeroTarget[0].remaining).toBe(0);
    const over = buildReserveViews(planningWith([
      { id: "r", costId: "c1", savedAmount: 140000, targetAmount: 100000, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], today);
    expect(over[0].percent).toBe(100);
    expect(over[0].overFunded).toBe(40000);
    expect(over[0].remaining).toBe(0); // max(target-saved, 0)
  });

  test("orphan 준비금은 costLabel 라벨로 역사 기록을 유지, 재연결 전까지 보관", () => {
    const views = buildReserveViews(planningWith([
      { id: "r", costId: "gone", savedAmount: 20000, targetAmount: 120000, targetDueDate: "2027-01-15", recordedAt: "2026-10-19T00:00:00Z", costLabel: "자동차보험" }
    ]), [], today);
    expect(views[0].isOrphan).toBe(true);
    expect(views[0].label).toBe("자동차보험");
    expect(views[0].remaining).toBe(100000); // 목표 기록이 있으면 항목 없이 유효
  });

  test("윤년 2/29 마감일자 처리 및 연 이상 항목만 추가 후보", () => {
    const cost = annual("c1", "연간", 100, "2028-01-01");
    const leap = buildReserveViews(planningWith([
      { id: "r", costId: "c1", savedAmount: 0, targetAmount: 300, targetDueDate: "2028-02-29", recordedAt: "2026-10-19T00:00:00Z" }
    ]), [cost], "2028-02-27");
    expect(leap[0].dueDate).toBe("2028-02-29");
    const candidates = annualCandidates(
      planningWith([{ id: "r", costId: "used", savedAmount: null, targetAmount: null, targetDueDate: null, recordedAt: null }]),
      [annual("used", "이미 있음", 10, null), annual("free", "연간 후보", 200000, null, 12), annual("monthly", "월간", 5000, null, 1)]
    );
    expect(candidates.map(item => item.id)).toEqual(["free"]);
  });
});
