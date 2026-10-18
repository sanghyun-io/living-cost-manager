// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { WeeklyBudgetPanel, type WeeklyBudgetActions } from "../app/components/WeeklyBudgetPanel";

beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));

// 2026-10-19 은 월요일. asOf 는 KST 10/19 낮.
const asOf = new Date("2026-10-19T03:00:00Z"); // KST 12:00
const mondayWeek = "2026-10-19";

function actionsStub(overrides: Partial<WeeklyBudgetActions> = {}): WeeklyBudgetActions & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    setBudget: (weekStart: string, amount: number | null) => {
      calls.push(["setBudget", [weekStart, amount]]);
      return overrides.setBudget ? overrides.setBudget(weekStart, amount) : { ok: true, message: "" };
    },
    addSpent: (weekStart: string, increment: number) => {
      calls.push(["addSpent", [weekStart, increment]]);
      return overrides.addSpent ? overrides.addSpent(weekStart, increment) : { ok: true, message: "" };
    },
    setSpent: (weekStart: string, total: number) => {
      calls.push(["setSpent", [weekStart, total]]);
      return overrides.setSpent ? overrides.setSpent(weekStart, total) : { ok: true, message: "" };
    },
    setPayday: (day: number | null) => {
      calls.push(["setPayday", day]);
      return overrides.setPayday ? overrides.setPayday(day) : { ok: true, message: "" };
    }
  };
}

function panel(overrides: Partial<React.ComponentProps<typeof WeeklyBudgetPanel>> = {}) {
  const actions = actionsStub();
  const element = React.createElement(WeeklyBudgetPanel, {
    data: createDefaultWorkspacePlanningData(),
    asOf,
    canEdit: true,
    isViewer: false,
    hasServer: false,
    serverSupport: "unknown",
    serverConfirmed: false,
    serverDirty: false,
    conflict: false,
    saveError: "",
    actions,
    ...overrides
  });
  return { actions, html: renderToStaticMarkup(React.createElement(MantineProvider, null, element)), element };
}

afterEach(cleanup);

describe("WeeklyBudgetPanel — 진실 표시(미설정 ≠ 0)", () => {
  test("기록 없는 활성 주: '예산미설정'과 '사용액 기록 없음'을 보여주며 0원/지출없음이 아니다", () => {
    const { html } = panel();
    expect(html).toContain("예산미설정");
    expect(html).toContain("사용액 기록 없음");
    expect(html).not.toContain("지출없음");
    expect(html).not.toMatch(/기록된 사용액[\s\S]*₩0/);
    expect(html).toContain("입력 기준");
    // "안전하게 써도 되는 금액" 보장이 아님 명시
    expect(html).toContain("보장하지 않습니다");
  });

  test("사용자 예산 0원과 기록된 사용액 0원은 그대로 표시(타임스탬프 동반)", () => {
    const data: WorkspacePlanningData = {
      ...createDefaultWorkspacePlanningData(),
      weeks: [{ weekStart: mondayWeek, budgetAmount: 0, spentAmount: 0, recordedAt: "2026-10-19T06:00:00Z" }]
    };
    const { html } = panel({ data });
    expect(html).toContain("₩0");
    expect(html).toContain("기록");
    expect(html).not.toContain("예산미설정");
    expect(html).not.toContain("사용액 기록 없음");
  });

  test("예산과 기록이 모두 있을 때만 '기록 기준 잔여' 숫자가 생긴다", () => {
    const data: WorkspacePlanningData = {
      ...createDefaultWorkspacePlanningData(),
      weeks: [{ weekStart: mondayWeek, budgetAmount: 100000, spentAmount: 40000, recordedAt: "2026-10-19T06:00:00Z" }]
    };
    const { html } = panel({ data });
    expect(html).toContain("₩60,000");
    expect(html).toContain("기록 기준 잔여");
  });
});

describe("WeeklyBudgetPanel — 입력 가드", () => {
  test("비운 입력은 0원이 아니며, 숫자·범위 밖은 액션 호출 없이 거부된다", () => {
    render(React.createElement(MantineProvider, null, React.createElement(WeeklyBudgetPanel, {
      data: createDefaultWorkspacePlanningData(), asOf, canEdit: true, isViewer: false,
      hasServer: false, serverSupport: "unknown", serverConfirmed: false, serverDirty: false, conflict: false, saveError: "",
      actions: actionsStub()
    })));
    fireEvent.change(screen.getByLabelText("지출 추가 금액"), { target: { value: "" } });
    fireEvent.click(screen.getByText("지출 추가"));
    expect(screen.getByText(/비워 두면 0원이 아닙니다/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("지출 추가 금액"), { target: { value: "-5000" } });
    fireEvent.click(screen.getByText("지출 추가"));
    expect(screen.getByText(/숫자 원 단위/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("주간 예산 금액"), { target: { value: "30000" } });
    fireEvent.click(screen.getByText("예산 설정"));
    expect(screen.getByText("주간 예산을 기록했습니다.")).toBeDefined();
  });

  test("쉼표 입력 1,000 은 1000원으로 해석되어 action 에 전달된다", () => {
    const actions = actionsStub();
    render(React.createElement(MantineProvider, null, React.createElement(WeeklyBudgetPanel, {
      data: createDefaultWorkspacePlanningData(), asOf, canEdit: true, isViewer: false,
      hasServer: false, serverSupport: "unknown", serverConfirmed: false, serverDirty: false, conflict: false, saveError: "",
      actions
    })));
    fireEvent.change(screen.getByLabelText("사용액 총액 수정"), { target: { value: "1,000" } });
    fireEvent.click(screen.getByText("사용액 수정"));
    expect(actions.calls.some(([name, args]) => name === "setSpent" && JSON.stringify(args) === JSON.stringify([mondayWeek, 1000]))).toBe(true);
  });

  test("저장소 상한/520주 거부 메시지는 편집 결과가 아니라 패널에 표시된다", () => {
    const actions = actionsStub({ addSpent: () => ({ ok: false, message: "누적 사용액이 지원 범위를 넘어 기록하지 않았습니다." }) });
    render(React.createElement(MantineProvider, null, React.createElement(WeeklyBudgetPanel, {
      data: createDefaultWorkspacePlanningData(), asOf, canEdit: true, isViewer: false,
      hasServer: false, serverSupport: "unknown", serverConfirmed: false, serverDirty: false, conflict: false, saveError: "",
      actions
    })));
    fireEvent.change(screen.getByLabelText("지출 추가 금액"), { target: { value: "5000" } });
    fireEvent.click(screen.getByText("지출 추가"));
    expect(screen.getByText(/지원 범위를 넘어/)).toBeDefined();
  });
});

describe("WeeklyBudgetPanel — 내비게이션과 권한", () => {
  test("기본 이번 주(월 시작) · 이전/다음 이동은 기간 라벨을 바꾸고 기록 배열은 그대로 둔다", () => {
    const { container } = render(React.createElement(MantineProvider, null, React.createElement(WeeklyBudgetPanel, {
      data: {
        ...createDefaultWorkspacePlanningData(),
        weeks: [
          { weekStart: "2026-10-12", budgetAmount: 10000, spentAmount: null, recordedAt: null },
          { weekStart: mondayWeek, budgetAmount: 20000, spentAmount: null, recordedAt: null }
        ]
      },
      asOf, canEdit: true, isViewer: false, hasServer: false, serverSupport: "unknown",
      serverConfirmed: false, serverDirty: false, conflict: false, saveError: "", actions: actionsStub()
    })));
    const header = () => container.querySelector(".weekly-budget-header")?.textContent ?? "";
    expect(header()).toContain("10/19 ~ 10/25");
    expect(header()).toContain("이번 주");
    fireEvent.click(screen.getByLabelText("이전 주"));
    expect(header()).toContain("10/12 ~ 10/18");
    fireEvent.click(screen.getByLabelText("다음 주"));
    fireEvent.click(screen.getByLabelText("다음 주"));
    expect(header()).toContain("10/26 ~ 11/01");
    fireEvent.click(screen.getByLabelText("이번 주로"));
    expect(header()).toContain("이번 주");
  });

  test("뷰어는 financial 편집 컨트롤이 없고 읽기 페인은 그대로다", () => {
    render(React.createElement(MantineProvider, null, React.createElement(WeeklyBudgetPanel, {
      data: { ...createDefaultWorkspacePlanningData(), weeks: [{ weekStart: mondayWeek, budgetAmount: 5000, spentAmount: null, recordedAt: null }] },
      asOf, canEdit: false, isViewer: true, hasServer: true, serverSupport: "available",
      serverConfirmed: true, serverDirty: false, conflict: false, saveError: "", actions: actionsStub()
    })));
    expect(screen.queryByLabelText("주간 예산 금액")).toBeNull();
    expect(screen.queryByLabelText("지출 추가 금액")).toBeNull();
    expect(screen.getByText(/보기 전용 가계부입니다/)).toBeDefined();
    expect(screen.getAllByText("₩5,000").length).toBeGreaterThan(0); // 읽기 유지
  });

  test("서버 기능 미사용(404)은 중립 안내 · raw 진단/알림 폭주 없이 기기 저장 표시", () => {
    render(React.createElement(MantineProvider, null, React.createElement(WeeklyBudgetPanel, {
      data: createDefaultWorkspacePlanningData(), asOf, canEdit: true, isViewer: false, hasServer: true,
      serverSupport: "missing", serverConfirmed: false, serverDirty: false, conflict: false, saveError: "", actions: actionsStub()
    })));
    expect(screen.getByText(/계획 저장 기능을 제공하지 않습니다/)).toBeDefined();
    expect(screen.getByText(/기기 저장 기록은 그대로 유지/)).toBeDefined();
  });
});
