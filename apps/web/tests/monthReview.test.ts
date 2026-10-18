import { describe, expect, test } from "vitest";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import {
  applicablePatches,
  baselineMatches,
  captureBaseline,
  monthWindowFor,
  simulateScenario,
  summarizePlanVsRecord,
  weeksForWindow
} from "../app/lib/monthReview";
import { createFixedCost, type FixedCost } from "../app/lib/budget";

const asOf = new Date("2026-10-30T06:00:00Z"); // KST 10/30
const cost = (id: string, amount: number, periodMonths = 1): FixedCost =>
  createFixedCost({ id, name: "항목 " + id, categoryId: "other", paymentMethodId: "bank-transfer", paymentOptionId: "", amount, periodMonths, billingDay: 15 });

describe("monthReview — 기간기록기준(안분 없음)", () => {
  test("월 창은 KST 오늘 기준; 다음 달 창도 정확하다", () => {
    const oct = monthWindowFor(asOf, 0)!;
    expect(oct.from).toBe("2026-10-01");
    expect(oct.toInclusive).toBe("2026-10-31");
    const nov = monthWindowFor(asOf, 1)!;
    expect(nov.from).toBe("2026-11-01");
    expect(nov.toInclusive).toBe("2026-11-30");
    const feb = monthWindowFor(new Date("2028-02-10T06:00:00Z"))!;
    expect(feb.toInclusive).toBe("2028-02-29");
  });

  test("경계 주는 월 합계에서 제외되고 straddling 으로 그대로 표시(일할 안분 금지)", () => {
    const weeks: WorkspacePlanningData["weeks"] = [
      { weekStart: "2026-10-05", budgetAmount: 100000, spentAmount: 90000, recordedAt: "2026-10-11T00:00:00Z" }, // 완전 내주
      { weekStart: "2026-10-26", budgetAmount: 100000, spentAmount: 60000, recordedAt: "2026-11-01T00:00:00Z" }  // 11/1 경계
    ];
    const coverage = weeksForWindow(weeks, monthWindowFor(asOf)!);
    expect(coverage.inside.map(w => w.weekStart)).toEqual(["2026-10-05"]);
    expect(coverage.straddling.map(w => w.weekStart)).toEqual(["2026-10-26"]);
    const record = summarizePlanVsRecord(coverage);
    expect(record.planned).toBe(100000); // 경계 주 계획은 합산 안 함
    expect(record.recorded).toBe(90000);
    expect(record.hasRecords).toBe(true);
  });

  test("사용액 기록이 없으면 plan-vs-plan(실적 비교 없음) — 0원 실적 위장 금지", () => {
    const weeks: WorkspacePlanningData["weeks"] = [
      { weekStart: "2026-10-05", budgetAmount: 100000, spentAmount: null, recordedAt: null }
    ];
    const record = summarizePlanVsRecord(weeksForWindow(weeks, monthWindowFor(asOf)!));
    expect(record.hasRecords).toBe(false);
    expect(record.recorded).toBeNull();
    expect(record.difference).toBeNull();
    expect(record.planned).toBe(100000);
  });

  test("기록 0원은 실적임(difference 계산 참여)", () => {
    const weeks: WorkspacePlanningData["weeks"] = [
      { weekStart: "2026-10-05", budgetAmount: 100000, spentAmount: 0, recordedAt: "2026-10-11T00:00:00Z" }
    ];
    const record = summarizePlanVsRecord(weeksForWindow(weeks, monthWindowFor(asOf)!));
    expect(record.hasRecords).toBe(true);
    expect(record.recorded).toBe(0);
    expect(record.difference).toBe(100000);
  });
});

describe("monthReview — what-if 순수 초안", () => {
  const fixedCosts = [cost("net", 17000), cost("ins", 90000, 12)];
  const income = 3_000_000;

  test("simulate 는 원본 배열/객체를 변경하지 않고 순수 결과를 반환한다", () => {
    const snapshot = JSON.stringify(fixedCosts);
    const result = simulateScenario(
      { newIncome: 2_500_000, costs: [{ costId: "net", newAmount: 20000 }], oneOff: 300000 },
      fixedCosts,
      income
    );
    expect(JSON.stringify(fixedCosts)).toBe(snapshot);
    expect(result.scenarioExpense).not.toBe(result.baselineExpense);
    expect(result.baselineExpense).toBe(24500); // 17000 + round(90000/12)
    expect(result.scenarioExpense).toBe(27500); // 20000 + 7500 — 일회성 300000은 미포함
    expect(result.expenseDelta).toBe(3000); // 17000→20000
    expect(result.oneOff).toBe(300000);
    expect(result.scenarioBalance).toBe(2_500_000 - 27_500);
    expect(result.baselineBalance).toBe(3_000_000 - 24_500);
    expect(result.hasChanges).toBe(true);
  });

  test("수입 0/미입력 시 잔여 비교는 null(수입 없는 추측 총액 금지), 계획 대비 계획만", () => {
    const result = simulateScenario({ newIncome: 0, costs: [], oneOff: 0 }, fixedCosts, income);
    expect(result.scenarioBalance).toBeNull();
    const noBaselineIncome = simulateScenario({ newIncome: null, costs: [], oneOff: 0 }, fixedCosts, 0);
    expect(noBaselineIncome.baselineBalance).toBeNull();
    expect(noBaselineIncome.hasChanges).toBe(false);
  });

  test("삭제된 항목의 가정은 invalid 표시 + 적용 대상에서 제외(유령 쓰기 없음)", () => {
    const draft = { newIncome: null, costs: [{ costId: "gone", newAmount: 5000 }, { costId: "net", newAmount: 20000 }], oneOff: 0 };
    const result = simulateScenario(draft, fixedCosts, income);
    expect(result.invalidCostIds).toEqual(["gone"]);
    const patches = applicablePatches(draft, fixedCosts);
    expect(patches.costs.map(p => p.costId)).toEqual(["net"]);
    expect(patches.newIncome).toBeNull();
  });

  test("baseline fingerprint: 스코프/수입/금액 변경 감지, 순서 재배열은 동일", () => {
    const a = captureBaseline("s", fixedCosts, income);
    const b = captureBaseline("s", [...fixedCosts].reverse(), income);
    expect(baselineMatches(b, a)).toBe(true);
    expect(baselineMatches(captureBaseline("s", [cost("net", 17001), cost("ins", 90000, 12)], income), a)).toBe(false);
    expect(baselineMatches(captureBaseline("other-scope", fixedCosts, income), a)).toBe(false);
  });

  test("일회성만 있으면 적용 시 재발 패치 없음(빈 배치)", () => {
    const patches = applicablePatches({ newIncome: null, costs: [], oneOff: 150000 }, fixedCosts);
    expect(patches.costs.length).toBe(0);
    expect(patches.newIncome).toBeNull();
  });
});
