import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { expect, test, vi } from "vitest";
import { FixedCostTable } from "../app/components/FixedCostTable";
import { getScheduleStatus } from "../app/components/FixedCostSchedule";
import { createFixedCost } from "../app/lib/budget";
import { emptyCostFilters } from "../app/lib/costViews";

function renderRows(count: number, deleteMode = false) {
  const noop = vi.fn();
  return renderToStaticMarkup(<MantineProvider><FixedCostTable
    focusItemId={null} focusRequest={0} costFilters={emptyCostFilters}
    onCostFilters={noop} onResetFilters={noop} categories={[{ id: "other", label: "기타" }]} cards={[]}
    visibleFixedCosts={Array.from({ length: count }, (_, i) => createFixedCost({ id: `cost-${i}`, name: `테스트 ${i}`, amount: 1000, periodMonths: 1, billingDay: 1 }))}
    visibleFixedCostTotal={count * 1000} categoryFilterId="all" isDeleteMode={deleteMode} selectedDeleteIds={[]}
    importMessage="" onItemChange={noop} onPaymentMethodChange={noop} onPaymentOptionChange={noop}
    onAddItem={noop} onDuplicateItem={noop} onEnterDeleteMode={noop} onCancelDeleteMode={noop}
    onConfirmDeleteItems={noop} onToggleDeleteSelection={noop} onFilterChange={noop}
    onOpenCategory={noop} onOpenCard={noop} onOpenData={noop}
  /></MantineProvider>);
}

test.each([0, 1, 10, 30])("%i rows share one schedule explanation and no repeated instructions", (count) => {
  const html = renderRows(count);
  expect(html.match(/납부일은 실제 청구 기준이며 카드 결제일과 별개입니다/g)).toHaveLength(1);
  expect(html.match(/납부일 미입력/g) ?? []).toHaveLength(count);
  expect(html).not.toContain("다음 납부일 미확인:");
  expect(html.match(/aria-label="테스트 \d+ 더보기"/g) ?? []).toHaveLength(count);
  expect(html).not.toContain(">복제</button>");
  const sharedId = html.match(/<p[^>]*id="([^"]+)"[^>]*>납부일은/)?.[1];
  expect(sharedId).toBeTruthy();
  expect(html.match(new RegExp(`aria-describedby="${sharedId}"`, "g")) ?? []).toHaveLength(count);
});

test("delete mode preserves selection and confirmation flow without row menus", () => {
  const html = renderRows(2, true);
  expect(html.match(/aria-label="삭제 선택"/g)).toHaveLength(2);
  expect(html).toContain("선택 삭제");
  expect(html).not.toContain("더보기");
});

test("compact schedule status keeps unknown, fractional, invalid and next due semantics", () => {
  const item = createFixedCost({ id: "x", name: "테스트", amount: 1200, periodMonths: 1, billingDay: 1 });
  expect(getScheduleStatus(item)).toBe("납부일 미입력");
  expect(getScheduleStatus({ ...item, billingAnchorDate: "2024-01-31", periodMonths: 0.5 })).toContain("주기를 정수 개월로 설정");
  expect(getScheduleStatus({ ...item, billingAnchorDate: "invalid" })).toContain("기준일과 주기를 확인");
  expect(getScheduleStatus({ ...item, billingAnchorDate: "2024-01-31" }, new Date(2024, 1, 1))).toBe("다음 2024/2/29");
  expect(getScheduleStatus({ ...item, billingAnchorDate: "2024-01-31", isEndOfMonth: true }, new Date(2025, 1, 1))).toBe("다음 2025/2/28");
});
