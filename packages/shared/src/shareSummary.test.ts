import { describe, expect, test } from "vitest";
import { buildShareSummary, expenseRatioPercent } from "./index.js";

describe("expenseRatioPercent", () => {
  test("비율 계산 (소수 1자리)", () => {
    expect(expenseRatioPercent({ monthlyIncome: 3000000, monthlyExpense: 1000000 })).toBe(33.3);
  });
  test("수입 0이면 null", () => {
    expect(expenseRatioPercent({ monthlyIncome: 0, monthlyExpense: 1000 })).toBeNull();
  });
});

describe("buildShareSummary", () => {
  test("고정비 + 비율 + Top 카테고리 포함", () => {
    const text = buildShareSummary({
      monthlyIncome: 3000000,
      monthlyExpense: 1039000,
      topCategoryLabel: "주거",
      topCategoryAmount: 650000
    });
    expect(text).toContain("월 고정비 1,039,000원");
    expect(text).toContain("수입 대비 34.6%");
    expect(text).toContain("가장 큰 항목: 주거 650,000원");
    expect(text).toContain("Living Cost Manager");
  });

  test("수입 없으면 비율 줄 생략", () => {
    const text = buildShareSummary({ monthlyIncome: 0, monthlyExpense: 500000 });
    expect(text).toContain("월 고정비 500,000원");
    expect(text).not.toContain("수입 대비");
  });

  test("Top 카테고리 없으면 해당 줄 생략", () => {
    const text = buildShareSummary({ monthlyIncome: 3000000, monthlyExpense: 500000 });
    expect(text).not.toContain("가장 큰 항목");
  });

  test("절대 수입액은 노출하지 않는다", () => {
    const text = buildShareSummary({ monthlyIncome: 3000000, monthlyExpense: 500000 });
    expect(text).not.toContain("3,000,000");
  });
});
