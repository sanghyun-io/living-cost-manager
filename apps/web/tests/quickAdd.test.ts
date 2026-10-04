import { expect, test } from "vitest";
import { previewQuickAdd } from "../app/lib/quickAdd";
test("preview parses annual and default monthly charges and rejects missing fields", () => {
  expect(previewQuickAdd("보험 120000원 매년")).toMatchObject({ valid: true, name: "보험", amount: 120000, periodMonths: 12 });
  expect(previewQuickAdd("통신 30000원")).toMatchObject({ valid: true, defaultPeriod: true, periodMonths: 1 });
  for (const text of ["", "넷플릭스", "17000원 매달", "보험 999999999999원", "보험 -1000원 매달", "보험 1000원 -2개월"]) expect(previewQuickAdd(text).valid).toBe(false);
});
