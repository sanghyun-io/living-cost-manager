// @vitest-environment jsdom
// 모바일 행 상세 disclosure:
// - ≤560px 에서 이름·금액·납부일이 기본 노출, 나머지 필드는 '상세' 안에 있다.
// - 필드는 이중 렌더/언마운트 없이 한 번만 DOM 에 존재하고 값·draft 가 유지된다.
// - 네이티브 details 라서 보기 전용 fieldset[disabled] 안에서도 토글이 동작한다.
// - 데스크톱에는 summary 가 렌더되지 않고 details 가 항상 열려 표 컬럼에 참여한다.
import type { ComponentProps } from "react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedCostTable } from "../app/components/FixedCostTable";
import { createFixedCost, type FixedCost } from "../app/lib/budget";

// jsdom does not implement ResizeObserver; Mantine overlay components guard on it.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

function setCompactViewport(compact: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: compact && query === "(max-width: 560px)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}

function item(overrides: Partial<FixedCost> = {}): FixedCost {
  const base = createFixedCost({
    id: "row-1",
    name: "Synthetic 구독",
    amount: 17000,
    periodMonths: 1,
    categoryId: "subscription",
    paymentMethodId: "credit-card",
    billingDay: 20,
    billingAnchorDate: "2026-10-20",
    renewalStatus: "cancel-planned"
  });
  return { ...base, ...overrides };
}

function tableProps(overrides: Partial<ComponentProps<typeof FixedCostTable>> = {}): ComponentProps<typeof FixedCostTable> {
  return {
    focusItemId: null,
    focusRequest: 0,
    costFilters: { query: "", method: "all", review: "all", sort: "original" },
    onCostFilters: vi.fn(),
    onResetFilters: vi.fn(),
    categories: [{ id: "subscription", label: "구독" }],
    cards: [],
    visibleFixedCosts: [item()],
    visibleFixedCostTotal: 17000,
    categoryFilterId: "all",
    isDeleteMode: false,
    selectedDeleteIds: [],
    importMessage: "",
    onItemChange: vi.fn(),
    onPaymentMethodChange: vi.fn(),
    onPaymentOptionChange: vi.fn(),
    onAddItem: vi.fn(),
    onDuplicateItem: vi.fn(),
    onEnterDeleteMode: vi.fn(),
    onCancelDeleteMode: vi.fn(),
    onConfirmDeleteItems: vi.fn(),
    onToggleDeleteSelection: vi.fn(),
    onFilterChange: vi.fn(),
    onOpenCategory: vi.fn(),
    onOpenCard: vi.fn(),
    onOpenData: vi.fn(),
    ...overrides
  };
}

function renderTable(props: ComponentProps<typeof FixedCostTable>, wrapper?: (ui: React.ReactElement) => React.ReactElement) {
  const ui = <MantineProvider><FixedCostTable {...props} /></MantineProvider>;
  return render(wrapper ? wrapper(ui) : ui);
}

function getRowSummary(): HTMLElement {
  const summary = document.querySelector("summary.cost-details-toggle");
  if (!summary) throw new Error("summary not rendered");
  return summary as HTMLElement;
}

// jsdom 은 summary click 의 toggle 이벤트를 React 에 안전하게 전달하지 않아
// open 토글 후 toggle 이벤트를 명시적으로 dispatch 한다(실브라우저는 네이티브).
function openRow(details: Element) {
  fireEvent.click(getRowSummary());
  // toggle 은 non-delegated 이벤트라 요소에 직접 dispatch 해야 React handler 가 받는다.
  act(() => { details.dispatchEvent(new Event("toggle")); });
}

beforeEach(() => { setCompactViewport(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("compact (≤560px) row details", () => {
  it("주요 3필드만 기본 노출하고 상세 필드는 한 번만 DOM 에 존재하며 값이 유지된다", () => {
    renderTable(tableProps());
    expect(screen.getAllByLabelText("항목명")).toHaveLength(1);
    expect(screen.getAllByLabelText("금액")).toHaveLength(1);
    expect(screen.getAllByLabelText("Synthetic 구독 기준 납부일")).toHaveLength(1);
    const details = document.querySelector("details.cost-row-details")!;
    expect(details.hasAttribute("open")).toBe(false);
    // 접힌 상태에서도 모든 입력은 DOM/상태에 그대로 있다(이중 렌더 없음).
    expect((screen.getByLabelText("항목명") as HTMLInputElement).value).toBe("Synthetic 구독");
    expect((screen.getByLabelText("금액") as HTMLInputElement).value).toBe("17,000");
    // Mantine Select: listbox 컨테이너도 label 과 연결되므로 실제 input 만 셉니다.
    expect(document.querySelectorAll('input[aria-label="카테고리"].mantine-Select-input')).toHaveLength(1);
    expect(document.querySelectorAll('input[aria-label="주기"]')).toHaveLength(1);
    const summary = getRowSummary();
    expect(summary.textContent).toContain("상세");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.getAttribute("aria-controls")).toBe(details.querySelector(".cost-row-details-body")!.id);
    openRow(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(getRowSummary().textContent).toContain("상세 닫기");
    expect(getRowSummary().getAttribute("aria-expanded")).toBe("true");
  });

  it("보기 전용: 부모 fieldset[disabled] 이어도 상세를 펼칠 수 있다(네이티브 summary)", () => {
    renderTable(tableProps(), (ui) => <fieldset disabled>{ui}</fieldset>);
    const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
    // 실제 브라우저에서는 fieldset[disabled] 가 내부 form control 편집을 막는다.
    // jsdom 은 fieldset 계승 disabled 전파를 구현하지 않아 input.disabled 로 단언하지 않는다.
    const details = document.querySelector("details.cost-row-details")!;
    expect(fieldset.contains(details)).toBe(true);
    openRow(details);
    expect(details.hasAttribute("open")).toBe(true);
    expect(getRowSummary().textContent).toContain("상세 닫기");
    // 요약(내 코칭 설정) 등 리더 필드는 펼쳐진 채로 값이 남아 있다.
    expect((screen.getByLabelText("금액") as HTMLInputElement).value).toBe("17,000");
  });

  it("해지 예정 경고는 접힌 상태에서도 이름 셀에 보인다", () => {
    renderTable(tableProps());
    const nameCell = document.querySelector(".cost-cell-name")!;
    expect(nameCell.textContent).toContain("해지 예정");
    expect(nameCell.contains(document.querySelector("details"))).toBe(false);
  });

  it("포커스 요청이 접힌 행에 오면 포커스 전에 펼쳐진다", async () => {
    const props = tableProps({ focusItemId: "row-1", focusRequest: 1 });
    renderTable(props);
    const details = document.querySelector("details.cost-row-details")!;
    // effect: 펼쳐진 뒤 이름 입력에 포커스.
    expect(details.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText("항목명"));
  });

  it("갱신 상태 라벨은 '계속 이용'으로 표시되고 값(keep)은 그대로다", () => {
    renderTable(tableProps({ visibleFixedCosts: [item({ renewalStatus: "keep" })] }));
    const renewal = screen.getAllByLabelText("갱신 검토", { selector: "input" })[0] as HTMLInputElement;
    expect(renewal.value).toBe("계속 이용");
  });

  it("보호 토글은 '절감 제안 제외' / '제안 제외됨' 라벨을 쓴다", () => {
    const onToggleProtected = vi.fn();
    const { rerender } = renderTable(tableProps({ onToggleProtected, protectedIds: new Set<string>() }));
    fireEvent.click(screen.getByRole("button", { name: "Synthetic 구독 절감 제안 제외" }));
    expect(onToggleProtected).toHaveBeenCalledWith("row-1");
    rerender(<MantineProvider><FixedCostTable {...tableProps({ onToggleProtected, protectedIds: new Set(["row-1"]) })} /></MantineProvider>);
    expect(screen.getByRole("button", { name: "Synthetic 구독 절감 제안 다시 받기" }).textContent).toBe("제안 제외됨");
  });
});

describe("desktop (>560px) row table", () => {
  beforeEach(() => { setCompactViewport(false); });

  it("상세 summary 없이 모든 컬럼이 펼쳐진 채 한 번씩 존재한다", () => {
    renderTable(tableProps());
    expect(document.querySelector("summary.cost-details-toggle")).toBeNull();
    const details = document.querySelector("details.cost-row-details")!;
    expect(details.hasAttribute("open")).toBe(true);
    expect(screen.getAllByLabelText("항목명")).toHaveLength(1);
    expect(screen.getAllByLabelText("금액")).toHaveLength(1);
    expect(document.querySelectorAll('input[aria-label="카테고리"].mantine-Select-input')).toHaveLength(1);
    expect(document.querySelectorAll('input[aria-label="주기"]')).toHaveLength(1);
  });

  it("헤더 라벨이 새로운 우선순위 열 순서(이름·금액·납부일·…)와 정렬된다", () => {
    renderTable(tableProps());
    const heads = Array.from(document.querySelectorAll(".table-head > span")).map((s) => s.textContent);
    expect(heads.slice(0, 6)).toEqual(["항목", "금액", "납부일", "카테고리", "결제수단", "결제 옵션"]);
  });
});
