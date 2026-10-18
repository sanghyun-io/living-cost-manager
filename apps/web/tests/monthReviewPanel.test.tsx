// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { MonthReviewPanel, type MonthReviewActions } from "../app/components/MonthReviewPanel";
import { createFixedCost, type FixedCost } from "../app/lib/budget";

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const asOf = new Date("2026-10-30T06:00:00Z"); // KST 2026-10-30
const costs: FixedCost[] = [
  createFixedCost({ id: "net", name: "넷플릭스", categoryId: "subscription", paymentMethodId: "bank-transfer", paymentOptionId: "", amount: 17000, periodMonths: 1, billingDay: 15 })
];

function planning(weeks: WorkspacePlanningData["weeks"]): WorkspacePlanningData {
  return { ...createDefaultWorkspacePlanningData(), weeks };
}

function openPanel(handle: { details: HTMLDetailsElement }) {
  fireEvent.click(handle.details.querySelector("summary") as HTMLElement);
}

function harness(overrides: Partial<{
  planning: WorkspacePlanningData; fixedCosts: FixedCost[]; monthlyIncome: number; scopeKey: string;
  canEdit: boolean; isViewer: boolean;
}> = {}) {
  const applyCalls: unknown[] = [];
  let recoveryAllowed = true;
  let confirmValue = true;
  vi.spyOn(window, "confirm").mockImplementation(() => confirmValue);
  const actions: MonthReviewActions = {
    saveRecoveryCopy: () => recoveryAllowed,
    applyPatches: patches => { applyCalls.push(patches); return { ok: true, message: "재발 변경을 반영했습니다." }; }
  };
  const props = {
    planning: overrides.planning ?? planning([]),
    fixedCosts: overrides.fixedCosts ?? costs,
    monthlyIncome: overrides.monthlyIncome ?? 3_000_000,
    scopeKey: overrides.scopeKey ?? "scope-1",
    asOf,
    canEdit: overrides.canEdit ?? true,
    isViewer: overrides.isViewer ?? false,
    actions
  };
  const view = render(React.createElement(MantineProvider, null, React.createElement(MonthReviewPanel, props)));
  const details = view.container.querySelector("details") as HTMLDetailsElement;
  return {
    view, details, applyCalls, props,
    setRecovery: (value: boolean) => { recoveryAllowed = value; },
    setConfirm: (value: boolean) => { confirmValue = value; },
    rerenderWith: (next: Partial<typeof props>) => {
      view.rerender(React.createElement(MantineProvider, null, React.createElement(MonthReviewPanel, { ...props, ...next })));
    }
  };
}

describe("MonthReviewPanel — 사용자 개시 · 순수 초안 · 가드 적용", () => {
  test("자동 펼침 없음(디폴트 닫힘); 내용은 기간기록기준·계획/기록 표시(자동 팝업·알림 권한 없음)", () => {
    const handle = harness({ planning: planning([{ weekStart: "2026-10-05", budgetAmount: 100000, spentAmount: 60000, recordedAt: "2026-10-11T00:00:00Z" }]) });
    expect(handle.details.open).toBe(false);
    expect(handle.view.container.textContent).toContain("2026년 10월");
    expect(handle.view.container.textContent).toContain("기간기록기준");
    expect(handle.view.container.textContent).toContain("₩100,000");
    expect(handle.view.container.textContent).toContain("₩60,000");
  });

  test("사용액 기록 없으면 실적 비교 없음(계획 vs 계획만)", () => {
    const handle = harness({ planning: planning([{ weekStart: "2026-10-05", budgetAmount: 100000, spentAmount: null, recordedAt: null }]) });
    expect(handle.view.container.textContent).toContain("계획 vs 계획");
    expect(handle.view.container.textContent).not.toContain("기록된 사용액 합계");
  });

  test("invalid 수입 가정은 거부, 0원은 유효(미입력과 구분)", () => {
    const handle = harness();
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "-10" } });
    expect(handle.view.container.textContent).toMatch(/숫자 원 단위|원 단위로 입력/);
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "0" } });
    expect(handle.view.container.textContent).toContain("다음 달 가정");
  });

  test("수입 가정 적용 시 재발 패치만 전달(일회성 제외), 항목 미선택 추가 버튼 비활성", () => {
    const handle = harness();
    const addButton = screen.getByText("가정에 추가").closest("button") as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "2,500,000" } });
    fireEvent.change(screen.getByLabelText("일회성 지출 가정"), { target: { value: "300000" } });
    fireEvent.click(screen.getByText("이 변경 적용(재발 항목만)"));
    expect(handle.applyCalls).toHaveLength(1);
    const patches = handle.applyCalls[0] as { newIncome: number | null; costs: unknown[] };
    expect(patches.newIncome).toBe(2500000);
    expect(patches.costs).toEqual([]);
  });

  test("복구본 저장 실패 시 적용 금지(사전 조건)", () => {
    const handle = harness();
    handle.setRecovery(false);
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "1000000" } });
    fireEvent.click(screen.getByText("이 변경 적용(재발 항목만)"));
    expect(handle.applyCalls.length).toBe(0);
    expect(handle.view.container.textContent).toContain("복구본을 저장하지 못해");
  });

  test("확인 취소 시 원본 그대로", () => {
    const handle = harness();
    handle.setConfirm(false);
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "1000000" } });
    fireEvent.click(screen.getByText("이 변경 적용(재발 항목만)"));
    expect(handle.applyCalls.length).toBe(0);
  });

  test("기준(정본)이 바뀌면 적용 비활성 + '다시 비교'로 재생성(블라인드 병합 없음)", () => {
    const handle = harness();
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "1000000" } });
    handle.rerenderWith({ fixedCosts: [...costs, createFixedCost({ id: "new", name: "신규", categoryId: "other", paymentMethodId: "bank-transfer", paymentOptionId: "", amount: 9000, periodMonths: 1, billingDay: 3 })] });
    expect(handle.view.container.textContent).toContain("현행 정본");
    const apply = screen.getByText("이 변경 적용(재발 항목만)").closest("button") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByText("다시 비교"));
    expect((screen.getByText("이 변경 적용(재발 항목만)").closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  test("스코프 전환 시 초안 폐기(자동 저장 없음)", () => {
    const handle = harness();
    fireEvent.change(screen.getByLabelText("가정 월수입"), { target: { value: "123456" } });
    handle.rerenderWith({ scopeKey: "scope-2" });
    expect((screen.getByLabelText("가정 월수입") as HTMLInputElement).value).toBe("");
  });

  test("뷰어는 비교만(적용 버튼 없음)", () => {
    const handle = harness({ canEdit: false, isViewer: true });
    expect(handle.view.container.textContent).toContain("보기 전용");
    expect(screen.queryByText("이 변경 적용(재발 항목만)")).toBeNull();
  });

  test("모델 다운로드·자동 예측 없음 — 가정 대조임을 명시", () => {
    const handle = harness();
    expect(handle.view.container.textContent).toContain("자동 예측 없음");
    expect(handle.view.container.querySelector("button[aria-label='모델 다운로드']")).toBeNull();
  });
});
