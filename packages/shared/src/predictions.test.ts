import { describe, expect, test } from "vitest";
import {
  buildSavingsInsights,
  computeNextDueDate,
  findDuplicateSubscriptions,
  getDaysUntilDue,
  getUpcomingDues,
  monthlyEquivalent,
  simulateRemoval,
  type PredictableFixedCost
} from "./index.js";

function cost(partial: Partial<PredictableFixedCost> & { id: string }): PredictableFixedCost {
  return {
    name: partial.name ?? partial.id,
    categoryId: partial.categoryId ?? "other",
    amount: partial.amount ?? 10000,
    periodMonths: partial.periodMonths ?? 1,
    billingDay: partial.billingDay ?? 1,
    isEndOfMonth: partial.isEndOfMonth ?? false,
    ...partial
  };
}

// 기준일을 고정해 결정적으로 테스트한다(2026-05-15, 비윤년).
const FROM = new Date(2026, 4, 15); // month index 4 = May

describe("computeNextDueDate", () => {
  test("이번 달 billingDay 가 아직 안 지났으면 이번 달", () => {
    const due = computeNextDueDate({ billingDay: 25, isEndOfMonth: false }, FROM);
    expect([due.getFullYear(), due.getMonth(), due.getDate()]).toEqual([2026, 4, 25]);
  });

  test("이번 달 billingDay 가 지났으면 다음 달", () => {
    const due = computeNextDueDate({ billingDay: 10, isEndOfMonth: false }, FROM);
    expect([due.getFullYear(), due.getMonth(), due.getDate()]).toEqual([2026, 5, 10]);
  });

  test("오늘이 billingDay 면 오늘", () => {
    const due = computeNextDueDate({ billingDay: 15, isEndOfMonth: false }, FROM);
    expect(due.getDate()).toBe(15);
    expect(due.getMonth()).toBe(4);
  });

  test("isEndOfMonth 는 그 달 마지막 날", () => {
    const due = computeNextDueDate({ billingDay: 1, isEndOfMonth: true }, FROM);
    expect([due.getMonth(), due.getDate()]).toEqual([4, 31]); // 5월 31일
  });

  test("billingDay 가 그 달 일수를 넘으면 마지막 날로 클램프 (2월 31→28)", () => {
    const feb = new Date(2026, 1, 10); // 2026-02-10
    const due = computeNextDueDate({ billingDay: 31, isEndOfMonth: false }, feb);
    expect([due.getMonth(), due.getDate()]).toEqual([1, 28]); // 2월 28일
  });
});

describe("getDaysUntilDue", () => {
  test("10일 후", () => {
    expect(getDaysUntilDue({ billingDay: 25, isEndOfMonth: false }, FROM)).toBe(10);
  });
  test("오늘이면 0", () => {
    expect(getDaysUntilDue({ billingDay: 15, isEndOfMonth: false }, FROM)).toBe(0);
  });
});

describe("getUpcomingDues", () => {
  test("가까운 순 정렬", () => {
    const items = [
      cost({ id: "a", billingDay: 25 }),
      cost({ id: "b", billingDay: 16 }),
      cost({ id: "c", billingDay: 20 })
    ];
    const dues = getUpcomingDues(items, FROM);
    expect(dues.map((d) => d.item.id)).toEqual(["b", "c", "a"]);
  });

  test("withinDays 필터", () => {
    const items = [
      cost({ id: "soon", billingDay: 16 }), // 1일 후
      cost({ id: "far", billingDay: 10 }) // 다음 달 → 26일 후
    ];
    const dues = getUpcomingDues(items, FROM, 7);
    expect(dues.map((d) => d.item.id)).toEqual(["soon"]);
  });
});

describe("monthlyEquivalent / simulateRemoval", () => {
  test("주기로 나눈 월 환산", () => {
    expect(monthlyEquivalent({ amount: 30000, periodMonths: 3 })).toBe(10000);
    expect(monthlyEquivalent({ amount: 100, periodMonths: 0 })).toBe(0);
  });

  test("제거 시 월/연 절감", () => {
    const items = [cost({ id: "x", amount: 30000, periodMonths: 3 })];
    expect(simulateRemoval(items, "x")).toEqual({
      itemId: "x",
      monthlySavings: 10000,
      annualSavings: 120000
    });
  });

  test("없는 id 면 null", () => {
    expect(simulateRemoval([], "nope")).toBeNull();
  });
});

describe("findDuplicateSubscriptions", () => {
  test("정규화 후 같은 이름 2건 이상을 묶는다", () => {
    const items = [
      cost({ id: "n1", name: "넷플릭스", amount: 17000 }),
      cost({ id: "n2", name: " 넷플릭스 ", amount: 17000 }),
      cost({ id: "single", name: "월세" })
    ];
    const dups = findDuplicateSubscriptions(items);
    expect(dups).toHaveLength(1);
    expect(dups[0].items.map((i) => i.id).sort()).toEqual(["n1", "n2"]);
    expect(dups[0].monthlyTotal).toBe(34000);
  });

  test("중복 없으면 빈 배열", () => {
    expect(findDuplicateSubscriptions([cost({ id: "a", name: "A" })])).toEqual([]);
  });
});

describe("buildSavingsInsights", () => {
  test("중복 인사이트는 하나만 남긴 나머지 절감액", () => {
    const items = [
      cost({ id: "n1", name: "넷플릭스", amount: 17000, periodMonths: 1 }),
      cost({ id: "n2", name: "넷플릭스", amount: 17000, periodMonths: 1 })
    ];
    const insights = buildSavingsInsights(items);
    const dup = insights.find((i) => i.kind === "duplicate");
    expect(dup).toBeTruthy();
    expect(dup!.monthlySavings).toBe(17000); // 2건 중 1건 절감
  });

  test("중복 없으면 가장 큰 항목 인사이트", () => {
    const items = [
      cost({ id: "rent", name: "월세", amount: 650000 }),
      cost({ id: "phone", name: "통신", amount: 50000 })
    ];
    const insights = buildSavingsInsights(items);
    expect(insights).toHaveLength(1);
    expect(insights[0].kind).toBe("largest");
    expect(insights[0].items[0].id).toBe("rent");
    expect(insights[0].monthlySavings).toBe(650000);
  });

  test("빈 목록이면 인사이트 없음", () => {
    expect(buildSavingsInsights([])).toEqual([]);
  });
});
