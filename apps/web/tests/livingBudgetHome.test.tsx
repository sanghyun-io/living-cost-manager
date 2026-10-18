// @vitest-environment jsdom
import React, { useState } from "react";
import { MantineProvider, NumberInput } from "@mantine/core";
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { BudgetStrip } from "../app/components/BudgetStrip";
import { UpcomingDues } from "../app/components/UpcomingDues";
import { MetricGrid } from "../app/components/MetricGrid";
import { InsightsPanel } from "../app/components/InsightsPanel";
import { buildBudgetSummary, createFixedCost, type FixedCost } from "../app/lib/budget";
import { buildHomePlan } from "../app/lib/homePlan";

const asOf = new Date("2026-10-09T15:00:00Z"); // October 10 in Korea.

function cost(id: string, name: string, amount: number, anchor: string | null, periodMonths = 1): FixedCost {
  return { ...createFixedCost({ id, name, amount, periodMonths, billingDay: 15 }), billingAnchorDate: anchor };
}

// page.tsx 의 첫 화면 조합과 같은 구조: 하나의 homePlan 을 모든 1·2차 표면이 공유한다.
function renderHome(items: FixedCost[], income: number) {
  const plan = buildHomePlan(items, income, asOf);
  const summary = buildBudgetSummary(items, income);
  return render(
    <MantineProvider>
      <section aria-label="이번 달 계획과 납부 예정">
        <BudgetStrip plan={plan} canEdit onIncomeChange={vi.fn()} />
        <UpcomingDues fixedCosts={items} asOf={asOf} plan={plan} onRevealItem={vi.fn()} />
      </section>
      <details className="quiet-disclosure">
        <summary>지출 분석</summary>
        <MetricGrid summary={summary} fixedCostCount={items.length} />
        <InsightsPanel fixedCosts={items} monthlyIncome={plan.monthlyIncome} monthlyExpense={plan.monthlyExpense} />
      </details>
    </MantineProvider>
  );
}

function countText(container: HTMLElement, needle: string): number {
  return container.textContent!.split(needle).length - 1;
}

describe("living-budget first screen: each financial fact displayed once", () => {
  test("plan amount, monthly normalization and the 30-day total each appear exactly once", () => {
    const items = [cost("a", "넷플릭스", 17000, "2026-10-20"), cost("b", "월세", 600000, "2026-11-01")];
    const { container } = renderHome(items, 3000000);
    expect(countText(container, "고정비 제외 계획금액")).toBe(1);
    expect(countText(container, "월 환산 고정비")).toBe(1);
    expect(countText(container, "다음 30일 예정 청구")).toBe(1);
    // 계획금액 = 수입 3,000,000 − 월 환산 고정비 617,000.
    expect(container.textContent).toContain("₩2,383,000");
    expect(container.textContent).not.toContain("수입 미입력");
    expect(container.textContent).not.toContain("남는 금액"); // MetricGrid 복제 셀 제거
    expect(container.textContent).not.toContain("고정비와 다음 결제");
  });

  test("insights no longer replica the due aggregate or the near-payment list", () => {
    const items = [cost("a", "넷플릭스", 17000, "2026-10-20")];
    const { container } = renderHome(items, 3000000);
    const analysis = container.querySelector<HTMLElement>(".insights-panel")!;
    expect(within(analysis).queryByText(/다음 30일/)).toBeNull();
    expect(within(analysis).queryByText(/가까운 납부/)).toBeNull();
    // 정본 목록은 그대로 1차 화면에 있다.
    expect(container.querySelector(".quiet-upcoming .quiet-upcoming-item")).toBeTruthy();
  });

  test("income 0 keeps the plan neutral: stored 0 shown, no unset claim, no negative headline", () => {
    const items = [cost("a", "넷플릭스", 17000, "2026-10-20")];
    const { container } = renderHome(items, 0);
    expect(container.textContent).toContain("월수입 ₩0 기준");
    expect(container.textContent).not.toContain("-₩17,000");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });
});

describe("canonical upcoming list interactions", () => {
  test("전체 보기 reveals the full accessible list and folds back", () => {
    const items = [1, 2, 3, 4, 5].map(n => cost(`c${n}`, `구독 ${n}`, 10000 * n, `2026-10-${10 + n}`));
    const plan = buildHomePlan(items, 100000, asOf);
    const { container, getByRole } = render(<MantineProvider><UpcomingDues fixedCosts={items} asOf={asOf} plan={plan} /></MantineProvider>);
    expect(container.querySelectorAll("li.quiet-upcoming-item")).toHaveLength(3);
    const toggle = getByRole("button", { name: "전체 보기 (5건)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(container.querySelectorAll("li.quiet-upcoming-item")).toHaveLength(5);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(getByRole("button", { name: "접기" }));
    expect(container.querySelectorAll("li.quiet-upcoming-item")).toHaveLength(3);
  });

  test("row reveal calls the single reveal handler with that item id", () => {
    const onRevealItem = vi.fn();
    const items = [cost("a", "넷플릭스", 17000, "2026-10-20"), cost("b", "월세", 600000, "2026-11-01")];
    const { getByRole } = render(<MantineProvider><UpcomingDues fixedCosts={items} asOf={asOf} plan={buildHomePlan(items, 100000, asOf)} onRevealItem={onRevealItem} /></MantineProvider>);
    fireEvent.click(getByRole("button", { name: "월세 항목 관리에서 보기" }));
    expect(onRevealItem).toHaveBeenCalledTimes(1);
    expect(onRevealItem).toHaveBeenCalledWith("b");
  });

  test("quarterly due total uses the actual charge, never the monthly normalization", () => {
    const items = [cost("q", "분기 결제", 300000, "2026-10-15", 3)];
    const { container } = render(<MantineProvider><UpcomingDues fixedCosts={items} asOf={asOf} plan={buildHomePlan(items, 1000000, asOf)} /></MantineProvider>);
    expect(container.textContent).toContain("₩300,000");
    expect(container.textContent).not.toContain("₩100,000");
  });
});

describe("analysis pane stays read-openable for non-editing controls", () => {
  test("keep-from-suggestions button belongs to the user and is clickable without edit rights", () => {
    const toggle = vi.fn();
    const items = [cost("s1", "넷플릭스", 17000, "2026-10-20"), cost("s2", "넷플릭스", 9900, "2026-10-21")];
    const { container } = render(
      <MantineProvider>
        <InsightsPanel fixedCosts={items} monthlyIncome={100000} monthlyExpense={26900} onKeepItem={toggle} />
      </MantineProvider>
    );
    const keep = container.querySelector<HTMLButtonElement>('button[aria-label="넷플릭스 절감 제안 제외"]');
    expect(keep).toBeTruthy(); // 중복 이름 인사이트가_actionable_ 항목을 만든다
    expect(keep!.hasAttribute("disabled")).toBe(false); // 분석 페인은 disabled 래퍼로 감기지 않는다
    fireEvent.click(keep!);
    expect(toggle).toHaveBeenCalledWith("s2");
  });
});

describe("management-closed fragment entries open the panel via the existing request handler", () => {
  // page.tsx 와 같은 배선(제거/우회 없음): toggle+hidden 패널, 편집 fieldset,
  // 분석 페인은 fieldset 밖 — 리뷰 P2 계약의 integration 단위 검증.
  function WiringHarness({ canEdit }: { canEdit: boolean }) {
    const [open, setOpen] = useState(false);
    const requestManagementOpen = () => setOpen(true);
    return (
      <MantineProvider>
        <InsightsPanel fixedCosts={[cost("a", "넷플릭스", 17000, "2026-10-20")]}
          monthlyIncome={100000} monthlyExpense={17000} onRequestEdit={requestManagementOpen} />
        <section id="fixed-costs" tabIndex={-1} aria-label="고정비 편집">
          <button type="button" aria-expanded={open} aria-controls="harness-panel" onClick={() => setOpen(value => !value)}>항목 관리</button>
          <div id="harness-panel" hidden={!open}>
            <fieldset disabled={!canEdit}>
              <NumberInput aria-label="금액" value={17000} onChange={() => {}} />
            </fieldset>
          </div>
        </section>
      </MantineProvider>
    );
  }

  test("owner: clicking 납부일·갱신 계획 수정 expands the closed panel and keeps native anchor + focus target", () => {
    const { container, getByRole } = render(<WiringHarness canEdit />);
    const panel = container.querySelector<HTMLElement>("#harness-panel")!;
    const toggle = getByRole("button", { name: "항목 관리" });
    expect(panel.hasAttribute("hidden")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const link = getByRole("link", { name: "납부일·갱신 계획 수정" });
    expect(link.getAttribute("href")).toBe("#fixed-costs"); // 네이티브 fragment preserved
    fireEvent.click(link);
    expect(panel.hasAttribute("hidden")).toBe(false); // 펼침은 기존 request handler 경로
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const target = container.querySelector<HTMLElement>("#fixed-costs")!;
    expect(target.getAttribute("tabindex")).toBe("-1"); // anchor focus 대상 그대로
    expect((container.querySelector("input[aria-label=금액]")!.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false); // 편집 가능
    expect(target.closest("[hidden]")).toBeNull(); // 더 이상 감기지 않음 — 강제 포커스 없음
  });

  test("viewer: the analysis link still opens read-only management; ledger inputs stay disabled", () => {
    const { container, getByRole } = render(<WiringHarness canEdit={false} />);
    const link = getByRole("link", { name: "납부일·갱신 계획 수정" });
    expect(link.closest("fieldset[disabled]")).toBeNull(); // 분석 페인은 통째 disable 없음
    fireEvent.click(link);
    const panel = container.querySelector<HTMLElement>("#harness-panel")!;
    expect(panel.hasAttribute("hidden")).toBe(false);
    const amount = container.querySelector<HTMLInputElement>("input[aria-label=금액]")!;
    // fieldset-disabled 전파는 브라우저 라이브 상태 — 가드 메커니즘 자체가 유지되는지 검증한다.
    expect(amount.closest("fieldset[disabled]")).not.toBeNull();
    expect((amount.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  });
});

describe("skip link and fragment audits", () => {
  test("the guide link target stays a supported visible entry while management is closed", () => {
    // 접힌 상태에서도 #fixed-costs 섹션(바)은 DOM에 보이고 anchor 가능해야 한다.
    const { container } = render(
      <MantineProvider>
        <section id="fixed-costs" tabIndex={-1} aria-label="고정비 편집">
          <button type="button" aria-expanded={false} aria-controls="management-panel">항목 관리 · 2개</button>
          <div id="management-panel" hidden />
        </section>
      </MantineProvider>
    );
    const target = container.querySelector<HTMLElement>("#fixed-costs")!;
    expect(target.closest("[hidden]")).toBeNull(); // skip/link 대상이 감긴 채로 남지 않는다
  });
});
