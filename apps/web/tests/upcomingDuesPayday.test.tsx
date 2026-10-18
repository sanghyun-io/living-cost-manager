// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, test } from "vitest";
import { UpcomingDues } from "../app/components/UpcomingDues";
import { createFixedCost, type FixedCost } from "../app/lib/budget";
import { buildHomePlan } from "../app/lib/homePlan";

const asOf = new Date("2026-10-09T15:00:00Z"); // October 10 in Korea.
const beforeCost: FixedCost = { ...createFixedCost({ id: "b", name: "10월 청구", amount: 40000, periodMonths: 1, billingDay: 15 }), billingAnchorDate: "2026-10-15" };
const afterCost: FixedCost = { ...createFixedCost({ id: "a", name: "11월 청구", amount: 70000, periodMonths: 1, billingDay: 1 }), billingAnchorDate: "2026-11-01" };
const unknownCost: FixedCost = { ...createFixedCost({ id: "u", name: "미확인 항목", amount: 9000, periodMonths: 1, billingDay: 20 }), billingAnchorDate: null };

function render(items: FixedCost[], paydayDay: number | null) {
  return renderToStaticMarkup(
    <MantineProvider>
      <UpcomingDues fixedCosts={items} asOf={asOf} plan={buildHomePlan(items, 0, asOf)} paydayDay={paydayDay} />
    </MantineProvider>
  );
}

describe("UpcomingDues 급여 주기 분할(재사용, 4번째 패널 아님)", () => {
  test("급여일 미설정 시 기존 첫 화면 표시와 동일(분할 블록 없음)", () => {
    const html = render([beforeCost], null);
    expect(html).not.toContain("급여 전");
    expect(html).toContain("다음 30일 예정 청구");
  });

  test("급여일 설정 시 전후 그룹이 정확한 날짜 라벨과 확인된 청구 합계만 갖는다", () => {
    const html = render([beforeCost, afterCost], 25);
    expect(html).toContain("급여 전");
    expect(html).toContain("급여 후");
    expect(html).toContain("10/25");
    expect(html).toContain("₩40,000");
    expect(html).toContain("₩70,000");
    // 실제 청구액 기준(월 환산 위장 없음) — 이 사례들은 1회라 동일하지만 라벨은 예정 청구.
    expect(html).not.toContain("실입금");
  });

  test("미확인 항목은 그룹 합계에 들어가지 않고 별도 건수로만", () => {
    const html = render([unknownCost], 25);
    expect(html).toContain("일정 미확인");
    expect(html).not.toMatch(/급여 전[\s\S]*₩9,000/);
  });

  test("분할은 '버틸 수 있는가'의 답이 아니라는 정직 라벨", () => {
    const html = render([beforeCost], 25);
    expect(html).toContain("실제 입금 보장·잔액 예측이 아닙니다");
  });
});
