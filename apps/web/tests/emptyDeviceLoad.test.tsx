// @vitest-environment jsdom
// 빈 기기 수동 불러오기 CTA + AUTO 서버 적용 제거 회귀:
// - fresh(캐시 없는 새 가계부)라도 prepareServerSyncDecision 은 로컬을 자동
//   초기화/적용하지 않는다.
// - CTA는 "확인된 현재 서버 스냅샷 비어있지 않음 + 로컬 의미 예산 전체가 비어있음"
//   일 때만 보이고, 수입·카드·커스텀 카테고리 입력 즉시 사라진다.
// - 수동 불러오기 성공 후에는 기준선이 일치해 "기기·서버에 저장됨"이 보인다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { LocalBudgetSnapshot } from "../app/lib/snapshot";
import { buildSnapshotKey, hasLocalBudgetData, hydrateWorkspaceSnapshot } from "../app/lib/snapshot";
import { useWorkspaceSync } from "../app/lib/useWorkspaceSync";
import type { ServerSession } from "../app/lib/serverApi";
import type { WorkspaceSnapshot } from "@living-cost-manager/shared";

vi.mock("../app/lib/analytics", () => ({ track: vi.fn() }));

const emptyLocal: LocalBudgetSnapshot = { monthlyIncome: 0, categories: [], cards: [], fixedCosts: [] };

function remoteSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceId: "ws-1",
    syncVersion: 7,
    monthlyIncome: 2500000,
    categories: [{ id: "cat-1", label: "구독", workspaceId: "ws-1" }],
    cards: [],
    fixedCosts: [
      { id: "f-1", name: "서버 항목", categoryId: "cat-1", paymentMethodId: "card", paymentOptionId: "", amount: 17000, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null, renewalStatus: "unreviewed", potentialMonthlySavings: 0, confirmedMonthlySavings: 0, workspaceId: "ws-1" }
    ],
    ...overrides
  } as WorkspaceSnapshot;
}

function session(role: "owner" | "editor" | "viewer" = "owner"): ServerSession {
  return {
    token: "t1",
    user: { id: "u1", email: "synthetic@example.test", name: "Synthetic" },
    workspace: { id: "ws-1", name: "Synthetic ledger", role }
  } as unknown as ServerSession;
}

function makeHarness(opts: {
  snapshot?: () => LocalBudgetSnapshot;
  role?: "owner" | "editor" | "viewer";
  getSnapshotImpl?: () => Promise<WorkspaceSnapshot>;
  serverSession?: ServerSession | null;
}) {
  const budgetState = {
    snapshot: opts.snapshot ? opts.snapshot() : { ...emptyLocal },
    initializeFreshLedger: vi.fn(() => true),
    applyBudgetSnapshot: vi.fn((s: LocalBudgetSnapshot) => { budgetState.snapshot = s; })
  };
  const authState = {
    serverSession: opts.serverSession === undefined ? session(opts.role ?? "owner") : opts.serverSession,
    isServerBusy: false,
    serverErrorKind: null as "auth" | "request" | null,
    serverStatus: "",
    serverApi: {
      getWorkspaceSnapshot: vi.fn(opts.getSnapshotImpl ?? (async () => remoteSnapshot())),
      putWorkspaceSnapshot: vi.fn(async (id: string, snap: WorkspaceSnapshot) => ({ ...snap, syncVersion: snap.syncVersion + 1 })),
      listWorkspaces: vi.fn(async () => []),
      listMembers: vi.fn(async () => []),
      listInvitations: vi.fn(async () => []),
      listWorkspaceInvitations: vi.fn(async () => []),
      getSnapshotHistory: vi.fn(async () => [])
    }
  };
  const ui = { isDataModalOpen: false, isAuthModalOpen: false } as never;
  const coach = { invalidateMonthlyReport: vi.fn(), refreshMonthlyReport: vi.fn() } as never;
  const auth = {
    serverApi: authState.serverApi,
    get serverSession() { return authState.serverSession; },
    isServerBusy: false,
    serverErrorKind: null,
    serverStatus: "",
    setServerStatus: vi.fn((v: string) => { authState.serverStatus = v; }),
    setServerErrorKind: vi.fn((v: "auth" | "request" | null) => { authState.serverErrorKind = v; }),
    setIsServerBusy: vi.fn((v: boolean) => { authState.isServerBusy = v; }),
    saveServerSession: vi.fn(),
    setServerSession: vi.fn(),
    resolveAndStoreServerSession: vi.fn(async (s: ServerSession) => s)
  };
  const budget = {
    get currentBudgetSnapshot() { return budgetState.snapshot; },
    getCurrentBudgetSnapshot: () => budgetState.snapshot,
    initializeFreshLedger: budgetState.initializeFreshLedger,
    applyBudgetSnapshot: budgetState.applyBudgetSnapshot,
    saveBeforeSwitch: vi.fn(() => true),
    saveError: "",
    savePending: false
  };
  const h = renderHook(() => useWorkspaceSync({
    ui: ui as never,
    auth: auth as never,
    budget: budget as never,
    coach: coach as never,
    localUserId: "ledger:u1:ws-1",
    isLocalDataReady: true
  }));
  return { h, auth, authState, budget, budgetState, ui, coach };
}

beforeEach(() => {
  window.confirm = vi.fn(() => true) as never;
  // jsdom 에서 randomUUID 가 없는 환경을 대비한 최소 스텁(값은 synthetic).
  const cryptoWithUuid = { randomUUID: () => "uuid-synthetic" };
  if (typeof window.crypto?.randomUUID !== "function") {
    Object.defineProperty(window, "crypto", { configurable: true, value: cryptoWithUuid });
  }
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("fresh ledger: no AUTO server apply", () => {
  it("캐시 없는 새 가계부 + 서버 데이터 있어도 initializeFreshLedger/applyBudgetSnapshot 을 부르지 않는다", async () => {
    const t = makeHarness({});
    let result: boolean | undefined;
    await act(async () => { result = await t.h.result.current.prepareServerSyncDecision(session()); });
    expect(result).toBe(true);
    expect(t.budgetState.initializeFreshLedger).not.toHaveBeenCalled();
    expect(t.budgetState.applyBudgetSnapshot).not.toHaveBeenCalled();
    // 자동 업로드도 없다.
    expect(t.authState.serverApi.putWorkspaceSnapshot).not.toHaveBeenCalled();
  });
});

describe("empty-device manual cloud load CTA", () => {
  it("확인된 서버 비어있지 않음 + 로컬 전체 비어있음 → CTA 표시", async () => {
    const t = makeHarness({});
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(false); // 확인 전에는 제안 없음
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(true);
    expect(t.h.result.current.headerStorageState).toBe("server-unknown"); // 아직 왕복 없음
  });

  it("수입을 입력하면 즉시 사라진다(렌더 파생·클릭 시점 재확인)", async () => {
    const t = makeHarness({});
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(true);
    budgetWithIncome(t);
    await act(async () => { t.h.rerender(); });
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(false);
    // 클릭 시점에도 거부되어 아무 서버 읽기도 하지 않는다.
    const readsBefore = t.authState.serverApi.getWorkspaceSnapshot.mock.calls.length;
    act(() => { t.h.result.current.handleEmptyDeviceLoad(); });
    expect(t.authState.serverApi.getWorkspaceSnapshot.mock.calls.length).toBe(readsBefore);
  });

  function budgetWithIncome(t: ReturnType<typeof makeHarness>) {
    t.budgetState.snapshot = { ...t.budgetState.snapshot, monthlyIncome: 100 };
  }

  it("카드·커스텀 카테고리만 있어도 로컬이 '의미 있는 예산'이라 CTA를 보이지 않는다(고정비 0개여도)", async () => {
    const t = makeHarness({
      snapshot: () => ({ monthlyIncome: 0, categories: [{ id: "custom", label: "내 카테고리" }], cards: [], fixedCosts: [] })
    });
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    expect(hasLocalBudgetData(t.budgetState.snapshot)).toBe(true);
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(false);
  });

  it("서버 확인 실패(네트워크)와 403 권한 확인 실패에서는 약속하지 않는다", async () => {
    const fail = makeHarness({ getSnapshotImpl: async () => { throw new Error("Failed to fetch"); } });
    await act(async () => { await fail.h.result.current.prepareServerSyncDecision(session()); });
    expect(fail.h.result.current.showEmptyDeviceLoadOffer).toBe(false);
    expect(fail.h.result.current.headerStorageState).toBe("server-unknown");

    const forbidden = makeHarness({
      getSnapshotImpl: async () => { const e = new Error("Forbidden") as Error & { status: number }; e.status = 403; throw Object.assign(e, { name: "ServerApiError" }); }
    });
    await act(async () => { await forbidden.h.result.current.prepareServerSyncDecision(session()); });
    expect(forbidden.h.result.current.showEmptyDeviceLoadOffer).toBe(false);
  });

  it("수동 불러오기 성공 → 기준선 확립·복구 백업·'기기·서버에 저장됨'", async () => {
    const t = makeHarness({});
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(true);
    await act(async () => { t.h.result.current.handleEmptyDeviceLoad(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const hydrated = hydrateWorkspaceSnapshot(remoteSnapshot());
    expect(t.budgetState.applyBudgetSnapshot).toHaveBeenCalledWith(hydrated);
    expect(window.localStorage.length).toBeGreaterThan(0); // 복구 백업 저장
    expect(t.h.result.current.headerStorageState).toBe("server-saved");
    expect(t.h.result.current.displayedSyncState).toBe("synced");
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(false); // CTA는 한 번, 이제 기준선 일치
  });

  it("불러오기 후 즉시 편집 → '기기에 저장됨 · 서버 미반영'으로 즉시 강등", async () => {
    const t = makeHarness({});
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    await act(async () => { t.h.result.current.handleEmptyDeviceLoad(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(t.h.result.current.headerStorageState).toBe("server-saved");
    t.budgetState.snapshot = { ...t.budgetState.snapshot, fixedCosts: [...t.budgetState.snapshot.fixedCosts, { id: "new", name: "새 항목" } as never] };
    await act(async () => { t.h.rerender(); });
    expect(t.h.result.current.headerStorageState).toBe("device-dirty");
    expect(t.h.result.current.displayedSyncState).toBe("needs-decision");
  });

  it("불러오기 후 서버 버전이 올라간 재확인 → 차단되고 절대 healthy 를 주장하지 않는다", async () => {
    let responseVersion = 7;
    const t = makeHarness({ getSnapshotImpl: async () => remoteSnapshot({ syncVersion: responseVersion }) });
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    await act(async () => { t.h.result.current.handleEmptyDeviceLoad(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(t.h.result.current.headerStorageState).toBe("server-saved");
    responseVersion = 8;
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    expect(t.h.result.current.isSyncBlocked).toBe(true);
    expect(t.h.result.current.headerStorageState).toBe("conflict");
    expect(t.h.result.current.displayedSyncState).toBe("conflict");
    expect(t.h.result.current.showEmptyDeviceLoadOffer).toBe(false);
  });

  it("보기 전용(role viewer)은 dirty 라도 '서버 미반영'을 암시하지 않는다", async () => {
    const t = makeHarness({ role: "viewer" });
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session("viewer")); });
    await act(async () => { t.h.result.current.handleEmptyDeviceLoad(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(t.h.result.current.headerStorageState).toBe("server-saved");
    t.budgetState.snapshot = { ...t.budgetState.snapshot, monthlyIncome: 100 };
    await act(async () => { t.h.rerender(); });
    expect(t.h.result.current.headerStorageState).toBe("device-saved");
    expect(t.h.result.current.canUploadServerSnapshot).toBe(false);
  });

  it("로컬 저장 실패는 확인된 서버 저장보다 우선한다", async () => {
    const t = makeHarness({});
    await act(async () => { await t.h.result.current.prepareServerSyncDecision(session()); });
    await act(async () => { t.h.result.current.handleEmptyDeviceLoad(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(t.h.result.current.headerStorageState).toBe("server-saved");
    (t.budget as { saveError: string }).saveError = "브라우저 저장 공간에 저장하지 못했습니다.";
    await act(async () => { t.h.rerender(); });
    expect(t.h.result.current.headerStorageState).toBe("save-failed");
  });
});

describe("buildSnapshotKey stability for load reconciliation", () => {
  it("hydrate → key 는 수동 불러오기가 확립하는 기준선과 동일하다", () => {
    const hydrated = hydrateWorkspaceSnapshot(remoteSnapshot());
    expect(buildSnapshotKey(hydrated)).toBe(buildSnapshotKey(hydrated));
    expect(hasLocalBudgetData(hydrated)).toBe(true);
  });
});
