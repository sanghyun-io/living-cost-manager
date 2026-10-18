import { describe, expect, test } from "vitest";
import type { FixedCost } from "../app/lib/budget";
import { buildPaydayTimeline, enumerateDueOccurrences } from "../app/lib/paydayTimeline";

function cost(id: string, amount: number, anchor: string | null, periodMonths = 1): FixedCost {
  return {
    id, name: id, categoryId: "other", paymentMethodId: "bank-transfer", paymentOptionId: "",
    amount, periodMonths, billingDay: 15, isEndOfMonth: false, billingAnchorDate: anchor
  } as FixedCost;
}

describe("paydayTimeline — 전체 발생 열거 & 급여 전후 분할", () => {
  test("한 달 남짓 창에서 월 항목이 2회 발생하면 2회 모두 센다(getUpcomingDues 1회와 달리)", () => {
    const items = [cost("a", 5000, "2026-10-01"), cost("b", 5000, "2026-10-15")];
    const shortWindow = enumerateDueOccurrences(items, "2026-10-01", "2026-10-31");
    expect(shortWindow.occurrences.map(o => `${o.item.id}@${o.date}`)).toEqual(["a@2026-10-01", "b@2026-10-15"]);
    // 30+일 창에서는 10/01 항목이 11/01 두 번째 발생도 갖는다.
    const longWindow = enumerateDueOccurrences([cost("a", 5000, "2026-10-01")], "2026-10-01", "2026-11-09");
    expect(longWindow.occurrences.map(o => o.date)).toEqual(["2026-10-01", "2026-11-01"]);
  });

  test("quarterly 항목은 창 내 1회, 실제 청구액 기준(월 환산 아님)", () => {
    const q = cost("q", 300000, "2026-10-15", 3);
    const { occurrences } = enumerateDueOccurrences([q], "2026-10-10", "2026-11-09");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].item.amount).toBe(300000);
  });

  test("일정 미확인은 separate count, fake 0 아님", () => {
    const items = [cost("known", 10000, "2026-10-12"), cost("u1", 20000, null), cost("u2", 5000, "bad-date")];
    const timeline = buildPaydayTimeline(items, "2026-10-10", "2026-11-09", 25);
    expect(timeline.unknownCount).toBe(2);
    expect(timeline.before.occurrenceCount).toBe(1);
    expect(timeline.before.total).toBe(10000);
  });

  test("급여일 전후 분할: 10/25 급여일 기준 10/15 청구는 '전', 11/01 청구는 '후'", () => {
    const items = [cost("before", 40000, "2026-10-15"), cost("after", 70000, "2026-11-01")];
    const timeline = buildPaydayTimeline(items, "2026-10-10", "2026-11-09", 25);
    expect(timeline.paydayDate).toBe("2026-10-25");
    expect(timeline.before.items.map(i => i.item.id)).toContain("before");
    expect(timeline.after.items.map(i => i.item.id)).toContain("after");
    expect(timeline.before.total).toBe(40000);
    expect(timeline.after.total).toBe(70000);
  });

  test("31일 급여일은 2월에 28/29일로 clamp", () => {
    // 창 2/1~3/1, 앵커 청구 없음, 급여일만 확인
    const timeline = buildPaydayTimeline([cost("x", 10, "2027-01-05")], "2027-02-01", "2027-03-01", 31);
    expect(timeline.paydayDate).toBe("2027-02-28");
    const leap = buildPaydayTimeline([cost("x", 10, "2028-01-05")], "2028-02-01", "2028-03-01", 31);
    expect(leap.paydayDate).toBe("2028-02-29");
  });

  test("individual-valid amounts whose sum exceeds the KRW domain flag overflow — never coerce to 0", () => {
    const bigA = cost("big-a", 1_500_000_000, "2026-10-10", 1);
    const bigB = cost("big-b", 1_600_000_000, "2026-10-20", 1);
    const timeline = buildPaydayTimeline([bigA, bigB], "2026-10-10", "2026-11-09", 25);
    expect(timeline.before.occurrenceCount).toBe(2); // 개별 발생은 유효
    expect(timeline.before.overflow).toBe(true);    // 합 3.1b > 원 단위 영역
    expect(timeline.before.total).toBeNull();
  });

  test("empty known group is honest 0; unknown-only keeps total honest", () => {
    const timeline = buildPaydayTimeline([cost("far", 5000, "2027-06-15")], "2026-10-10", "2026-11-09", 25);
    expect(timeline.before.occurrenceCount).toBe(0);
    expect(timeline.before.total).toBe(0);
    expect(timeline.before.overflow).toBe(false);
  });

  test("모두 미확인면 총액 null(정확 0 위장 금지)", () => {
    const timeline = buildPaydayTimeline([cost("u", 30000, null)], "2026-10-10", "2026-11-09", 25);
    expect(timeline.before.total).toBeNull();
    expect(timeline.unknownCount).toBe(1);
  });

  test("타임존 안정성: UTC/Pacific/KST 동일 결과(호스트 TZ 변환)", () => {
    const original = process.env.TZ;
    const results: string[] = [];
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Seoul"]) {
      process.env.TZ = zone;
      const timeline = buildPaydayTimeline([cost("k", 12000, "2026-10-15")], "2026-10-10", "2026-11-09", 25);
      results.push(JSON.stringify({ before: timeline.before.total, payday: timeline.paydayDate, date: timeline.before.items[0]?.date }));
    }
    process.env.TZ = original ?? "UTC";
    expect(new Set(results).size).toBe(1);
  });
});
