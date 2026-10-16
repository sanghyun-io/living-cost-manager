// @vitest-environment jsdom
// AppHeader 저장 상태 렌더 + READY 버튼 단일 콜백 배선 확인.
import type { ComponentProps } from "react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "../app/components/AppHeader";
import { getHeaderStorageView } from "../app/lib/syncStatus";
import { formatSaveTime } from "../app/lib/formatting";
import type { ServerSession } from "../app/lib/serverApi";

const session = {
  token: "t1",
  user: { id: "u1", email: "synthetic@example.test", name: "Synthetic" },
  workspace: { id: "ws-1", name: "Synthetic ledger", role: "owner" }
} as unknown as ServerSession;

function baseProps(overrides: Partial<ComponentProps<typeof AppHeader>> = {}): ComponentProps<typeof AppHeader> {
  return {
    saveError: "",
    onRetrySave: vi.fn(),
    onExportUnsaved: vi.fn(),
    recoveryRequired: false,
    lastSavedAt: null,
    serverSession: null,
    currentUserName: undefined,
    onOpenData: vi.fn(),
    onOpenAuth: vi.fn(),
    onOpenCoach: vi.fn(),
    onOpenTemplates: vi.fn(),
    onServerLogout: vi.fn(),
    ...overrides
  };
}

afterEach(cleanup);

describe("header storage truthfulness", () => {
  it("확인 동기화 상태는 '기기·서버에 저장됨' + 마지막 확인 기준 tooltip", () => {
    const savedAt = new Date("2026-10-16T09:30:00");
    render(<MantineProvider><AppHeader {...baseProps({
      serverSession: session,
      lastSavedAt: savedAt,
      headerStorageView: getHeaderStorageView("server-saved")
    })} /></MantineProvider>);
    const status = document.querySelector(".save-status")!;
    expect(status.textContent).toContain("기기·서버에 저장됨");
    expect(status.textContent).toContain(formatSaveTime(savedAt));
    expect(status.getAttribute("title")).toContain("마지막 확인 기준");
  });

  it("dirty(owner) / 게스트(device-saved) / 확인 필요 / 충돌 라벨이 구분된다", () => {
    const cases: Array<[import("../app/lib/syncStatus").HeaderStorageState, string]> = [
      ["device-dirty", "기기에 저장됨 · 서버 미반영"],
      ["device-saved", "기기에 저장됨"],
      ["server-unknown", "서버 상태 확인 필요"],
      ["conflict", "충돌 · 확인 필요"],
      ["saving", "기기에 저장 중"],
      ["save-failed", "기기 저장 실패"],
      ["auth-expired", "다시 로그인 필요"]
    ];
    for (const [state, label] of cases) {
      const { unmount } = render(<MantineProvider><AppHeader {...baseProps({
        serverSession: session,
        lastSavedAt: new Date(),
        headerStorageView: getHeaderStorageView(state)
      })} /></MantineProvider>);
      expect(document.querySelector(".save-status")!.textContent).toContain(label);
      unmount();
    }
  });

  it("저장 실패가 있으면 상태 한 줄 대신 거부 배너가 우선한다", () => {
    render(<MantineProvider><AppHeader {...baseProps({
      saveError: "브라우저 저장 공간에 저장하지 못했습니다.",
      headerStorageView: getHeaderStorageView("save-failed")
    })} /></MantineProvider>);
    expect(screen.getByRole("alert").textContent).toContain("저장하지 못했습니다");
    expect(document.querySelector(".save-status")).toBeNull();
  });

  it("파생 상태가 없던 레거시 호출은 로컬 사실 라벨로 폴백(서버 주장 없음)", () => {
    render(<MantineProvider><AppHeader {...baseProps({ lastSavedAt: new Date() })} /></MantineProvider>);
    expect(document.querySelector(".save-status")!.textContent).toContain("이 브라우저에 저장됨");
  });

  it("로그인/게스트 모두 진입 버튼은 '데이터 관리'다", () => {
    const { unmount } = render(<MantineProvider><AppHeader {...baseProps({ serverSession: session })} /></MantineProvider>);
    expect(screen.getByRole("button", { name: "데이터 관리" })).toBeTruthy();
    expect(screen.queryByText("동기화 관리")).toBeNull();
    unmount();
    render(<MantineProvider><AppHeader {...baseProps()} /></MantineProvider>);
    expect(screen.getByRole("button", { name: "데이터 관리" })).toBeTruthy();
  });

  it("READY 버튼은 onOpenCoach 가 아니라 onViewPreparedCoach 를 정확히 1회 부르고, preparing/error 은 계속 모달만 연다", () => {
    const onViewPreparedCoach = vi.fn();
    const onOpenCoach = vi.fn();
    const { rerender } = render(<MantineProvider><AppHeader {...baseProps({
      serverSession: session,
      onOpenCoach,
      onViewPreparedCoach,
      coachHeaderIndicator: "ready",
      coachHeaderReadyLabel: "AI 준비 완료 · 코칭 보기"
    })} /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 준비 완료 · 코칭 보기" }));
    expect(onViewPreparedCoach).toHaveBeenCalledTimes(1);
    expect(onOpenCoach).not.toHaveBeenCalled();

    rerender(<MantineProvider><AppHeader {...baseProps({
      serverSession: session,
      onOpenCoach,
      onViewPreparedCoach,
      coachHeaderIndicator: "preparing",
      coachHeaderProgressLabel: "AI 준비 중 42%"
    })} /></MantineProvider>);
    fireEvent.click(screen.getByRole("button", { name: "AI 준비 중 42%" }));
    expect(onOpenCoach).toHaveBeenCalledTimes(1);
    expect(onViewPreparedCoach).toHaveBeenCalledTimes(1);
  });

  it("READY 저장 상태 전이(버튼이 새로 나타남) 자체는 아무 생성도 호출하지 않는다", () => {
    const onViewPreparedCoach = vi.fn();
    const { rerender } = render(<MantineProvider><AppHeader {...baseProps({ serverSession: session, onOpenCoach: vi.fn(), onViewPreparedCoach })} /></MantineProvider>);
    rerender(<MantineProvider><AppHeader {...baseProps({
      serverSession: session,
      onOpenCoach: vi.fn(),
      onViewPreparedCoach,
      coachHeaderIndicator: "ready",
      coachHeaderReadyLabel: "AI 준비 완료 · 코칭 보기"
    })} /></MantineProvider>);
    expect(onViewPreparedCoach).not.toHaveBeenCalled();
  });
});
