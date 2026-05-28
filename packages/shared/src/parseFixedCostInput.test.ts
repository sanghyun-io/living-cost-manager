import { describe, expect, test } from "vitest";
import { parseFixedCostInput } from "./index.js";

describe("parseFixedCostInput", () => {
  test("이름 + 금액 + 주기를 모두 추출한다", () => {
    expect(parseFixedCostInput("넷플릭스 17000원 매달")).toEqual({
      name: "넷플릭스",
      amount: 17000,
      periodMonths: 1,
    });
  });

  test("쉼표가 있는 금액", () => {
    expect(parseFixedCostInput("월세 650,000원")).toEqual({
      name: "월세",
      amount: 650000,
    });
  });

  test("한글 만/천 단위 금액", () => {
    expect(parseFixedCostInput("보험료 1만7천")).toEqual({
      name: "보험료",
      amount: 17000,
    });
    expect(parseFixedCostInput("구독 3만원 매달")).toEqual({
      name: "구독",
      amount: 30000,
      periodMonths: 1,
    });
    expect(parseFixedCostInput("적금 5천")).toEqual({
      name: "적금",
      amount: 5000,
    });
  });

  test("소수 만 단위", () => {
    expect(parseFixedCostInput("관리비 3.5만")).toMatchObject({ amount: 35000 });
  });

  test("주기 키워드: 매년/분기/반기", () => {
    expect(parseFixedCostInput("자동차보험 720000원 매년")).toMatchObject({ periodMonths: 12 });
    expect(parseFixedCostInput("종합소득세 분기")).toMatchObject({ periodMonths: 3 });
    expect(parseFixedCostInput("정수기 점검 반기")).toMatchObject({ periodMonths: 6 });
  });

  test("명시적 N개월마다", () => {
    expect(parseFixedCostInput("렌즈 30000원 3개월마다")).toMatchObject({
      amount: 30000,
      periodMonths: 3,
    });
    expect(parseFixedCostInput("정기검진 6개월에 한 번")).toMatchObject({ periodMonths: 6 });
  });

  test("금액/주기가 없으면 이름만", () => {
    expect(parseFixedCostInput("고양이 모래")).toEqual({ name: "고양이 모래" });
  });

  test("빈 입력은 빈 객체", () => {
    expect(parseFixedCostInput("")).toEqual({});
    expect(parseFixedCostInput("   ")).toEqual({});
  });

  test("금액/주기 토큰은 이름에서 제거된다", () => {
    const result = parseFixedCostInput("유튜브 프리미엄 14900원 매달");
    expect(result.name).toBe("유튜브 프리미엄");
    expect(result.amount).toBe(14900);
    expect(result.periodMonths).toBe(1);
  });

  test("숫자만 있고 이름이 없으면 name 생략", () => {
    const result = parseFixedCostInput("50000원");
    expect(result.amount).toBe(50000);
    expect(result.name).toBeUndefined();
  });
});
