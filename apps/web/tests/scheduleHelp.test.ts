import { expect, test } from "vitest";
import { createFixedCost } from "../app/lib/budget";
import { scheduleHelp } from "../app/lib/scheduleHelp";
test("schedule guidance explains missing anchors, fractional periods and leap month clamp", () => {
  const item = createFixedCost({ id: "x", name: "x", amount: 1200, periodMonths: 1, billingDay: 31 });
  expect(scheduleHelp(item)).toContain("기준 납부일을 입력");
  expect(scheduleHelp({ ...item, billingAnchorDate: "2024-01-31", periodMonths: 0.5 })).toContain("소수 개월");
  expect(scheduleHelp({ ...item, billingAnchorDate: "2024-01-31" }, new Date(2024, 1, 1))).toContain("2024/2/29");
  expect(scheduleHelp({ ...item, billingAnchorDate: "2024-01-31", isEndOfMonth: true }, new Date(2025, 1, 1))).toContain("2025/2/28 · 매 청구월 말일");
});
