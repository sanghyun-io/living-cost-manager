// @vitest-environment jsdom
// P2-3 RELEASE-BLOCK 회귀: 체인 저장이 외부 busy 가드에 항상 막혀 '매번 skip'이던
// 결함의 실제 양-훅(useWorkspaceSync + usePlanningData) 통합 피스처.
// auth/budget/coach/ui 는 최소 스텁이지만 두 훅과 업로드 체인 로직은 프로덕션 코드 그 자체.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useRef, useState } from "react";
import { renderHook, act, cleanup } from "@testing-library/react";
import { createDefaultWorkspacePlanningData, type WorkspacePlanning, type WorkspacePlanningData, type WorkspaceRole, type WorkspaceSnapshot } from "@living-cost-manager/shared";
import { useWorkspaceSync } from "../app/lib/useWorkspaceSync";
import { usePlanningData, type PlanningDataApi } from "../app/lib/usePlanningData";
import { ServerApiError, type ServerApiClient, type ServerSession } from "../app/lib/serverApi";
import { combinePlanningStorageState } from "../app/lib/syncStatus";
import { ledgerProfileId } from "../app/lib/ledgerStorage";
import { planningStorageKey, serializePlanning } from "../app/lib/planningStorage";

const monday = "2026-10-19";
const profileOne = ledgerProfileId("acct-1", "ws-1");
const profileTwo = ledgerProfileId("acct-1", "ws-2");

function session(): ServerSession {
  return {
    token: "t", refreshToken: "r",
    user: { id: "acct-1", email: "a@a.kr", name: "A", emailVerified: true },
    workspace: { id: "ws-1", name: "가계부", role: "owner" }
  };
}

// 서버측 가계부 스냅샷(빈 서버: 첫 동기화 경로). 로컬 스텁의 수입은 별도로 보유.
function serverSnapshot(withCost: boolean): WorkspaceSnapshot & { monthlyIncome: number } {
  return {
    workspaceId: "ws-1", syncVersion: 0, monthlyIncome: 0,
    categories: [], cards: [],
    fixedCosts: withCost ? [{
      workspaceId: "ws-1", id: "fc-1", name: "월세", categoryId: "housing",
      paymentMethodId: "bank-transfer", paymentOptionId: "auto-transfer",
      amount: 500000, periodMonths: 1, billingDay: 1, isEndOfMonth: false,
      billingAnchorDate: null, renewalStatus: "unreviewed",
      potentialMonthlySavings: 0, confirmedMonthlySavings: 0
    } as never] : []
  };
}

// 로컬(이 브라우저 스텁) 가계부 상태. 서버 빈 스냅샷과 구별된다.
function localSnapshot(): WorkspaceSnapshot & { monthlyIncome: number } {
  return { workspaceId: "ws-1", syncVersion: 0, monthlyIncome: 3_000_000, categories: [], cards: [], fixedCosts: [] };
}

function planningRemote(revision: number, data: WorkspacePlanningData, snapshotVersion: number): WorkspacePlanning {
  return { workspaceId: "ws-1", revision, currentSnapshotVersion: snapshotVersion, data };
}

function weekData(budget: number): WorkspacePlanningData {
  return { ...createDefaultWorkspacePlanningData(), weeks: [{ weekStart: monday, budgetAmount: budget, spentAmount: null, recordedAt: null }] };
}

function makeSequencer() {
  const state: Record<string, unknown> = {
    snapshotVersion: 9,
    getSnapshot: vi.fn(),
    putSnapshot: vi.fn(),
    getPlanning: vi.fn(),
    putPlanning: vi.fn()
  };
  state.getSnapshot = vi.fn(async () => ({ ...serverSnapshot(false), syncVersion: state.snapshotVersion }));
  state.api = {
    baseUrl: "https://api.test",
    getWorkspaceSnapshot: state.getSnapshot,
    putWorkspaceSnapshot: state.putSnapshot,
    getWorkspacePlanning: state.getPlanning,
    putWorkspacePlanning: state.putPlanning
  } as unknown as ServerApiClient;
  return state as unknown as {
    snapshotVersion: number;
    api: ServerApiClient;
    getSnapshot: ReturnType<typeof vi.fn>;
    putSnapshot: ReturnType<typeof vi.fn>;
    getPlanning: ReturnType<typeof vi.fn>;
    putPlanning: ReturnType<typeof vi.fn>;
  };
}

function harness(sequencer: ReturnType<typeof makeSequencer>) {
  const planningRef = { current: null as PlanningDataApi | null };
  const captured = { statuses: [] as string[] };
  const view = renderHook((props: { profileId: string; role?: WorkspaceRole }) => {
    const [snapshot, setSnapshot] = useState(() => localSnapshot());
    const [busy, setBusy] = useState(false);
    const [errorKind, setErrorKind] = useState<"auth" | "request" | null>(null);
    const snapRef = useRef(snapshot);
    snapRef.current = snapshot;
    const auth = {
      serverApi: sequencer.api,
      serverSession: session(),
      isServerBusy: busy,
      serverErrorKind: errorKind,
      setIsServerBusy: (value: boolean) => setBusy(value),
      setServerErrorKind: (value: "auth" | "request" | null) => setErrorKind(value),
      setServerStatus: (message: string) => { captured.statuses.push(message); },
      saveServerSession: () => {},
      setServerSession: () => {},
      resolveAndStoreServerSession: async (s: ServerSession) => s
    } as never;
    const budget = {
      currentBudgetSnapshot: { monthlyIncome: snapshot.monthlyIncome, categories: [], cards: [], fixedCosts: snapshot.fixedCosts },
      getCurrentBudgetSnapshot: () => ({ monthlyIncome: snapRef.current.monthlyIncome, categories: [] as never[], cards: [] as never[], fixedCosts: snapRef.current.fixedCosts as never[] }),
      saveError: "",
      savePending: false,
      saveBeforeSwitch: () => true,
      applyBudgetSnapshot: (next: unknown) => setSnapshot(next as WorkspaceSnapshot & { monthlyIncome: number }),
      localScopeKey: props.profileId
    } as never;
    const coach = { invalidateMonthlyReport: () => {}, refreshMonthlyReport: () => Promise.resolve() } as never;
    const ui = { isAuthModalOpen: false, isDataModalOpen: false, setImportMessage: () => {} } as never;
    const sync = useWorkspaceSync({
      ui, auth, budget, coach,
      localUserId: props.profileId, isLocalDataReady: true,
      getPlanning: () => planningRef.current
    });
    const planning = usePlanningData({
      profileId: props.profileId,
      serverSession: session(),
      serverApi: sequencer.api,
      role: props.role ?? "owner",
      getBudgetServerVersion: sync.getBudgetServerVersion,
      isBudgetServerCurrent: sync.isBudgetServerCurrent,
      isBudgetDirty: sync.isBudgetDirty
    });
    planningRef.current = planning;
    return { sync, planning, editBudget: () => setSnapshot(snapshot2 => ({ ...snapshot2, monthlyIncome: 3_100_000 })) };
  }, { initialProps: { profileId: profileOne } as { profileId: string; role?: WorkspaceRole } });
  return { view, captured, planningRef };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(window, "confirm").mockImplementation(() => true);
});
afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("P2-3 — 실제 useWorkspaceSync + usePlanningData 체인 통합", () => {
  test("가계부 PUT 확인 버전 N+1로 계획 PUT exact CAS; 이전엔 외부 busy 가드로 항상 skip이었음", async () => {
    const seq = makeSequencer();
    seq.putSnapshot.mockImplementation(async (_id: string, snap: WorkspaceSnapshot) => ({ ...snap, syncVersion: 10 }));
    seq.getPlanning.mockResolvedValue(planningRemote(5, createDefaultWorkspacePlanningData(), 9));
    seq.putPlanning.mockImplementation(async (_id: string, input: { data: WorkspacePlanningData }) =>
      planningRemote(6, input.data, 10));
    const { view, captured } = harness(seq);
    // 1) 서버 기준 확인(가계부·계획)
    await act(async () => { await view.result.current.sync.prepareServerSyncDecision(session()); });
    await act(async () => { await view.result.current.planning.checkRemote(); });
    expect(view.result.current.planning.baseConfirmed).toBe(true);
    // 2) 양쪽 편집 — 그 자체로는 어떤 요청도 나가지 않는다(수동 저장 원칙)
    await act(async () => {
      view.result.current.planning.setBudget(monday, 30000);
      view.result.current.editBudget();
    });
    expect(seq.putSnapshot).not.toHaveBeenCalled();
    expect(seq.putPlanning).not.toHaveBeenCalled();
    expect(view.result.current.planning.planningServerDirty).toBe(true);
    expect(view.result.current.sync.isBudgetDirty()).toBe(true);
    // 3) 명시 함께 저장: 가계부 PUT(syncVersion 9→10) 확인 후 계획 PUT expectedSnapshotVersion=10 exact
    await act(async () => { await view.result.current.sync.handleSyncNow(); });
    expect(seq.putSnapshot).toHaveBeenCalledTimes(1);
    expect(seq.putSnapshot.mock.calls[0][1].syncVersion).toBe(9);
    expect(seq.putPlanning).toHaveBeenCalledTimes(1);
    expect(seq.putPlanning.mock.calls[0][1]).toMatchObject({ expectedRevision: 5, expectedSnapshotVersion: 10 });
    expect(captured.statuses[captured.statuses.length - 1]).toContain("가계부와 주간 계획을 서버에 동기화했습니다");
    expect(view.result.current.planning.planningServerDirty).toBe(false);
  });

  test("가계부 409 → 계획 PUT 0회(미확인 가계부 기준에 계획 저장 금지)", async () => {
    const seq = makeSequencer();
    seq.putSnapshot.mockRejectedValue(new ServerApiError("conflict", 409));
    seq.getPlanning.mockResolvedValue(planningRemote(5, createDefaultWorkspacePlanningData(), 9));
    const { view } = harness(seq);
    await act(async () => { await view.result.current.sync.prepareServerSyncDecision(session()); });
    await act(async () => { await view.result.current.planning.checkRemote(); });
    await act(async () => { view.result.current.planning.setBudget(monday, 30000); });
    await act(async () => { await view.result.current.sync.handleSyncNow(); });
    expect(seq.putSnapshot).toHaveBeenCalledTimes(1);
    expect(seq.putPlanning).not.toHaveBeenCalled();
    expect(view.result.current.planning.planningServerDirty).toBe(true); // 계획 발산 진실 유지
  });

  test("계획 409 → 가계부는 저장됨 + 부분 성공 진실('가계부 저장됨 · 계획 미반영'), 헤더 device-dirty", async () => {
    const seq = makeSequencer();
    seq.putSnapshot.mockImplementation(async (_id: string, snap: WorkspaceSnapshot) => ({ ...snap, syncVersion: 10 }));
    seq.getPlanning.mockResolvedValue(planningRemote(5, createDefaultWorkspacePlanningData(), 9));
    seq.putPlanning.mockRejectedValue(new ServerApiError("conflict", 409));
    const { view, captured } = harness(seq);
    await act(async () => { await view.result.current.sync.prepareServerSyncDecision(session()); });
    await act(async () => { await view.result.current.planning.checkRemote(); });
    await act(async () => { view.result.current.planning.setBudget(monday, 30000); });
    await act(async () => { await view.result.current.sync.handleSyncNow(); });
    const last = captured.statuses[captured.statuses.length - 1];
    expect(last).toContain("가계부는 서버에 저장됨 · 주간 계획 미반영");
    expect(last).not.toContain("동기화했습니다"); // globally healthy 주장 금지
    // 가계부 자체는 기준선 일치 + 확인 버전 유지
    expect(seq.putSnapshot).toHaveBeenCalledTimes(1);
    expect(view.result.current.planning.planningServerDirty).toBe(true);
    const combined = combinePlanningStorageState(view.result.current.sync.headerStorageState, {
      saveError: false, savePending: false, active: true,
      serverDirty: view.result.current.planning.planningServerDirty,
      serverUnknown: view.result.current.planning.planningServerUnknown
    });
    expect(["device-dirty", "conflict"]).toContain(combined);
  });

  test("요청 대기 중 스코프 전환 → 늦은 응답이 새 스코프에 쓰이지 않는다", async () => {
    const seq = makeSequencer();
    seq.putSnapshot.mockImplementation(async (_id: string, snap: WorkspaceSnapshot) => ({ ...snap, syncVersion: 10 }));
    seq.getPlanning.mockResolvedValue(planningRemote(5, createDefaultWorkspacePlanningData(), 9));
    let resolveLate: ((value: WorkspacePlanning) => void) | null = null;
    seq.putPlanning.mockImplementation(() => new Promise<WorkspacePlanning>(resolve => { resolveLate = resolve; }));
    const { view } = harness(seq);
    await act(async () => { await view.result.current.sync.prepareServerSyncDecision(session()); });
    await act(async () => { await view.result.current.planning.checkRemote(); });
    await act(async () => { view.result.current.planning.setBudget(monday, 30000); });
    let chainPromise: Promise<unknown> | null = null;
    act(() => { chainPromise = view.result.current.sync.handleSyncNow(); });
    // 가계부 PUT 확인 후 계획 PUT 대기 중 — 그 시점에 다른 가계부 스코프로 전환
    await vi.waitFor(() => expect(seq.putPlanning).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
    view.rerender({ profileId: profileTwo });
    await act(async () => { resolveLate?.(planningRemote(6, weekData(30000), 10)); await chainPromise; });
    // 새 스코프(ws-2)에는 아무것도 쓰이지 않았다
    expect(window.localStorage.getItem(planningStorageKey(profileTwo))).toBeNull();
    // 이전 스코프(ws-1)의 기기 저장 편집은 그대로 보존
    expect(window.localStorage.getItem(planningStorageKey(profileOne))).toContain("30000");
    // 새 스코프는 미확인 상태(오래된 응답으로 healthy 주장 금지)
    expect(view.result.current.planning.baseConfirmed).toBe(false);
    expect(view.result.current.planning.planningActive).toBe(false);
    // ws-1 캐시 원본이 여전히 ws-1 키에만 존재
    expect(serializePlanning(view.result.current.planning.data)).toBe(serializePlanning(createDefaultWorkspacePlanningData()));
  });
});

describe("P2-2 — 체인 commit 직전 최신 자격 재확인", () => {
  test("prepare 후 멤버십 viewer 강등 + 가계부 PUT 확인 → 계획 PUT 0회, 부분 성공 진실 유지", async () => {
    const seq = makeSequencer();
    let releaseBudget: (value: WorkspaceSnapshot & { monthlyIncome: number }) => void = () => {};
    seq.putSnapshot.mockImplementation(() => new Promise<WorkspaceSnapshot & { monthlyIncome: number }>(resolve => { releaseBudget = resolve; }));
    seq.getPlanning.mockResolvedValue(planningRemote(5, createDefaultWorkspacePlanningData(), 9));
    const { view, captured } = harness(seq);
    await act(async () => { await view.result.current.sync.prepareServerSyncDecision(session()); });
    await act(async () => { await view.result.current.planning.checkRemote(); });
    expect(view.result.current.planning.baseConfirmed).toBe(true);
    await act(async () => { view.result.current.planning.setBudget(monday, 30000); });
    let chain: Promise<unknown> | null = null;
    act(() => { chain = view.result.current.sync.handleSyncNow(); });
    // 가계부 PUT 대기 중 멤버가 viewer로 강등됨(페이지는 sync 역할 파생을 재평가)
    view.rerender({ profileId: profileOne, role: "viewer" });
    await act(async () => { releaseBudget({ ...serverSnapshot(false), syncVersion: 10 }); await chain; });
    expect(seq.putSnapshot).toHaveBeenCalledTimes(1);      // 가계부는 저장됨
    expect(seq.putPlanning).not.toHaveBeenCalled();        // 강등된 권한으로는 계획 PUT 금지
    const last = captured.statuses[captured.statuses.length - 1];
    expect(last).toContain("가계부는 서버에 저장됨 · 주간 계획 미반영");
    expect(last).not.toContain("동기화했습니다");
    expect(view.result.current.planning.data.weeks[0].budgetAmount).toBe(30000); // 의도 유지
  });

  test("prepare 후 다른 탭 충돌(로컬 쓰기 차단) 발생 → 계획 PUT 0회", async () => {
    const seq = makeSequencer();
    let releaseBudget: (value: WorkspaceSnapshot & { monthlyIncome: number }) => void = () => {};
    seq.putSnapshot.mockImplementation(() => new Promise<WorkspaceSnapshot & { monthlyIncome: number }>(resolve => { releaseBudget = resolve; }));
    seq.getPlanning.mockResolvedValue(planningRemote(5, createDefaultWorkspacePlanningData(), 9));
    const { view, captured } = harness(seq);
    await act(async () => { await view.result.current.sync.prepareServerSyncDecision(session()); });
    await act(async () => { await view.result.current.planning.checkRemote(); });
    await act(async () => { view.result.current.planning.setBudget(monday, 30000); });
    let chain: Promise<unknown> | null = null;
    act(() => { chain = view.result.current.sync.handleSyncNow(); });
    // 준비 이후 다른 탭이 같은 계획을 먼저 변경 — commit 직전 차단 상태 재평가
    window.localStorage.setItem(planningStorageKey(profileOne), serializePlanning(weekData(999000)));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: planningStorageKey(profileOne),
        newValue: serializePlanning(weekData(999000))
      }));
    });
    await act(async () => { releaseBudget({ ...serverSnapshot(false), syncVersion: 10 }); await chain; });
    expect(seq.putPlanning).not.toHaveBeenCalled();
    expect(captured.statuses[captured.statuses.length - 1]).toContain("주간 계획 미반영");
    expect(view.result.current.planning.saveError).toContain("다른 탭");
    expect(view.result.current.planning.planningServerDirty).toBe(true);
  });
});
