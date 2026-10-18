// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { ReservePanel } from "../app/components/ReservePanel";
import { createFixedCost, type FixedCost } from "../app/lib/budget";

// jsdom has no layout observer; production components are unmocked.
beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const asOf = new Date("2026-10-19T03:00:00Z"); // KST 10/19
const annualCost: FixedCost = {
  ...createFixedCost({ id: "c1", name: "자동차세", amount: 600000, periodMonths: 12, billingDay: 15 }),
  billingAnchorDate: "2026-01-15"
};

function data(reserves: WorkspacePlanningData["reserves"]): WorkspacePlanningData {
  return { ...createDefaultWorkspacePlanningData(), reserves };
}

function setup(overrides: Partial<React.ComponentProps<typeof ReservePanel>> = {}) {
  const calls: Array<[string, unknown]> = [];
  const actions = {
    editReserve: (draft: unknown) => { calls.push(["editReserve", draft]); return { ok: true, message: "" }; },
    deleteReserve: (id: string) => { calls.push(["deleteReserve", id]); return { ok: true, message: "" }; },
    linkReserve: (id: string, costId: string) => { calls.push(["linkReserve", [id, costId]]); return { ok: true, message: "" }; }
  };
  const view = render(React.createElement(MantineProvider, null, React.createElement(ReservePanel, {
    planning: data([{ id: "reserve-c1", costId: "c1", savedAmount: 100000, targetAmount: null, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" }]),
    fixedCosts: [annualCost],
    asOf,
    canEdit: true,
    actions,
    ...overrides
  })));
  return { view, calls };
}

describe("ReservePanel — 큰지출준비", () => {
  test("기록·목표·직접기록기준 라벨 표시, 고정비 표 컬럼을 늘리지 않는다(별도 섹션)", () => {
    const { view } = setup();
    expect(view.container.querySelector("section.reserve-panel")).not.toBeNull();
    expect(screen.getByText("자동차세")).toBeDefined();
    expect(screen.getByText(/모아둠 ₩100,000/)).toBeDefined();
    expect(screen.getByText(/항목 금액 기준\(기록된 목표 아님\)/)).toBeDefined();
    expect(screen.getByText(/은행 확인 잔액이 아닙니다/)).toBeDefined();
    expect(screen.getByText(/이중 계산되지 않습니다/)).toBeDefined();
  });

  test("saved 기록 시 editReserve 호출(전체 총액·recordedAt 동반), 뷰어는 입력 없음", () => {
    const { calls } = setup();
    fireEvent.change(screen.getByLabelText("자동차세 모아둔 금액"), { target: { value: "150000" } });
    fireEvent.click(screen.getByText("기록"));
    const edit = calls.find(([name]) => name === "editReserve");
    expect(edit).toBeTruthy();
    const draft = edit![1] as { savedAmount: number; recordedAt: string | null; id: string };
    expect(draft.savedAmount).toBe(150000);
    expect(draft.recordedAt).toBeTruthy();
    const readonly = setup({ canEdit: false, actions: { editReserve: () => ({ ok: false, message: "" }), deleteReserve: () => ({ ok: false, message: "" }), linkReserve: () => ({ ok: false, message: "" }) } });
    expect(readonly.view.container.querySelector("input[aria-label='자동차세 모아둔 금액']")).toBeNull();
  });

  test("invalid 금액(문자·음수)은 액션 없이 거부", () => {
    const { calls } = setup();
    fireEvent.change(screen.getByLabelText("자동차세 모아둔 금액"), { target: { value: "-500" } });
    fireEvent.click(screen.getByText("기록"));
    expect(calls.length).toBe(0);
    expect(screen.getByText(/숫자 원 단위|원 단위로 입력/)).toBeDefined();
  });

  test("삭제는 명시 확인 통과 후에만; 확인 취소 시 기록 유지", () => {
    const { calls } = setup();
    vi.spyOn(window, "confirm").mockImplementation(() => false);
    fireEvent.click(screen.getByText("기록 삭제"));
    expect(calls.length).toBe(0);
    vi.mocked(window.confirm).mockImplementation(() => true);
    fireEvent.click(screen.getByText("기록 삭제"));
    expect(calls.some(([name]) => name === "deleteReserve")).toBe(true);
  });

  test("orphan 준비금은 '연결된 항목 없음' 또는 라벨로 보이고 재연결 선택이 열린다", () => {
    const { view } = setup({
      planning: data([{ id: "r", costId: "gone", savedAmount: null, targetAmount: null, targetDueDate: null, recordedAt: null, costLabel: "과거 항목" }])
    });
    expect(screen.getByText("과거 항목")).toBeDefined();
    expect(screen.getAllByLabelText("과거 항목 재연결 항목").length).toBeGreaterThan(0);
    expect(view.container.textContent).not.toContain("NaN");
  });

  test("연간 후보에서만 추가 제안(periodMonths>=12, 이미 있는 항목 제외)", () => {
    const monthly: FixedCost = { ...createFixedCost({ id: "m", name: "월 구독", amount: 5000, periodMonths: 1, billingDay: 1 }), billingAnchorDate: "2026-01-01" };
    setup({ fixedCosts: [annualCost, monthly], planning: data([]) });
    expect(screen.queryByText("월 구독 · ₩5,000")).toBeNull();
    expect(screen.getAllByLabelText("준비금으로 추가할 연간 항목").length).toBeGreaterThan(0);
  });
});
