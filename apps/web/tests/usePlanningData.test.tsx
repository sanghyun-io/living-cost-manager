// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData, type WorkspacePlanning } from "@living-cost-manager/shared";
import { usePlanningData } from "../app/lib/usePlanningData";
import { planningStorageKey, serializePlanning } from "../app/lib/planningStorage";
import { ServerApiError, type ServerApiClient, type ServerSession } from "../app/lib/serverApi";

const monday = "2026-10-19";
const profileA = 'ledger:' + JSON.stringify(["acct-1", "ws-1"]);
const profileB = 'ledger:' + JSON.stringify(["acct-2", "ws-2"]);

function session(roleWorkspaceId = "ws-1"): ServerSession {
  return {
    token: "t", refreshToken: "r",
    user: { id: "acct-1", email: "a@a.kr", name: "A", emailVerified: true },
    workspace: { id: roleWorkspaceId, name: "가계부", role: "owner" }
  };
}

function remote(revision: number, data: WorkspacePlanningData, snapshotVersion = 9): WorkspacePlanning {
  return { workspaceId: "ws-1", revision, currentSnapshotVersion: snapshotVersion, data };
}

function makeApi() {
  return {
    baseUrl: "https://api.test",
    getWorkspacePlanning: vi.fn(),
    putWorkspacePlanning: vi.fn()
  } as unknown as { getWorkspacePlanning: ReturnType<typeof vi.fn>; putWorkspacePlanning: ReturnType<typeof vi.fn> } & ServerApiClient;
}

function weekData(overrides: Partial<WorkspacePlanningData> = {}): WorkspacePlanningData {
  return {
    ...createDefaultWorkspacePlanningData(),
    weeks: [{ weekStart: monday, budgetAmount: 50000, spentAmount: null, recordedAt: null }],
    ...overrides
  };
}

function setup(options: Partial<Parameters<typeof usePlanningData>[0]> = {}) {
  const api = makeApi();
  const state = {
    budgetVersion: 9 as number | null,
    budgetCurrent: true,
    budgetDirty: false
  };
  const view = renderHook((props: Partial<Parameters<typeof usePlanningData>[0]>) => usePlanningData({
    profileId: profileA,
    serverSession: session(),
    serverApi: api,
    role: "owner",
    getBudgetServerVersion: () => state.budgetVersion,
    isBudgetServerCurrent: () => state.budgetCurrent,
    isBudgetDirty: () => state.budgetDirty,
    ...props
  }), { initialProps: options });
  return { api, view, state };
}

function controllableStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (store.fail && key.startsWith("living-cost-manager:planning")) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => { map.delete(key); },
    fail: false,
    _map: map
  };
  return store;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => cleanup());

describe("usePlanningData — local-first scope safety", () => {
  test("스코프 분리: A 의 예산 기록은 B 에게 보이지 않고 새 키를 만들지도 않는다", () => {
    const { view } = setup();
    act(() => { view.result.current.setBudget(monday, 30000); });
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toContain("30000");
    view.rerender({ profileId: profileB });
    expect(view.result.current.data.weeks.length).toBe(0);
    expect(window.localStorage.getItem(planningStorageKey(profileB))).toBeNull(); // no-op persist 금지
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toContain("30000"); // A 보존
  });

  test("손상 캐시: 기본값으로 덮어쓰지 않고 편집·자동 저장을 중단하며 원본 raw 를 보존한다", () => {
    window.localStorage.setItem(planningStorageKey(profileA), "{broken");
    const { view } = setup();
    expect(view.result.current.cacheCorrupt).toBe(true);
    expect(view.result.current.saveError).toContain("읽지 못해");
    let edit: { ok: boolean } | undefined;
    act(() => { edit = view.result.current.setBudget(monday, 1000); });
    expect(edit?.ok).toBe(false);
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toBe("{broken");
    // 원본 내보내기 채널은 살아 있다
    expect(view.result.current.exportCorruptRaw()).toBe("{broken");
  });

  test("quota 실패: saveError 표시, 전환(saveBeforeSwitch) 차단, 복구 후 재시도 성공", () => {
    const store = controllableStorage();
    store.fail = true;
    const { view } = setup({ storage: store });
    act(() => { view.result.current.setBudget(monday, 30000); });
    expect(view.result.current.saveError).toContain("저장하지 못했습니다");
    expect(view.result.current.saveBeforeSwitch()).toBe(false);
    expect(view.result.current.planningServerDirty).toBe(false); // 아직 미확인(오염 주장 금지)
    store.fail = false;
    act(() => { view.result.current.retrySave(); });
    expect(view.result.current.saveError).toBe("");
    expect(store.getItem(planningStorageKey(profileA))).toContain("30000");
    expect(view.result.current.saveBeforeSwitch()).toBe(true);
  });

  test("다른 탭 교차 쓰기: 미저장 편집을 조용히 버리지 않고 자동 저장을 멈춘다", () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(createDefaultWorkspacePlanningData()));
    const { view } = setup();
    // 탭 B 가 먼저 저장(같은 스코프)
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData()));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: planningStorageKey(profileA), newValue: serializePlanning(weekData()) }));
    });
    expect(view.result.current.saveError).toContain("다른 탭");
    let edit: { ok: boolean } | undefined;
    act(() => { edit = view.result.current.setBudget(monday, 7000); });
    expect(edit?.ok).toBe(false); // 충돌 해소 전 변경 금지
    // 메모리 상태는 이전 로드 기준 유지 — 저장 안 된 편집 폐기 없음
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toBe(serializePlanning(weekData()));
  });

  test("전환 가드: 편집 직후 같은 틱 saveBeforeSwitch 는 동기 플러시 후 true", () => {
    const { view } = setup();
    act(() => { view.result.current.setPayday(25); });
    expect(view.result.current.saveBeforeSwitch()).toBe(true);
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toContain("\"paydayDay\":25");
  });
});

describe("usePlanningData — manual server CAS", () => {
  test("GET 는 절대 자동 덮어쓰지 않는다: 다른 서버 기록은 staging 만", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData()));
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, weekData({ weeks: weekData().weeks, paydayDay: 10 })));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.data.paydayDay).toBe(null); // 자동 적용 없음
    expect(view.result.current.remoteStaged?.data.paydayDay).toBe(10);
    expect(view.result.current.baseConfirmed).toBe(false); // 미반영 편집 → 기준 진행 금지
    expect(view.result.current.planningServerDirty).toBe(true); // 발산은 곧 서버 미반영(진실)
    expect(view.result.current.hasRemoteDivergence).toBe(true);
  });

  test("미반영 편집이 있으면 재확인이 CAS revision 을 진행시키지 않는다(PUT 는 이전 기준으로 409 경로)", async () => {
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, createDefaultWorkspacePlanningData()));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setBudget(monday, 30000); });
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(5, weekData({ paydayDay: 11 })));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.baseConfirmed).toBe(true);
    // base revision 은 최초 확인 1 유지 — 새 5 를 채택해 blind PUT 허용하지 않음
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    put.mockResolvedValue(remote(1, createDefaultWorkspacePlanningData()));
    await act(async () => { await view.result.current.uploadNow(); });
    // staged divergence → 자동 업로드 거부(수동 교체 확인 없이는 PUT 자체 없음)
    expect(put).not.toHaveBeenCalled();
  });

  test("PUT 본문은 확인된 revision과 가계부 서버 버전 정확 일치; 성공 시 기준 갱신", async () => {
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(4, createDefaultWorkspacePlanningData(), 9));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setBudget(monday, 30000); });
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    // 실제 서버처럼 PUT本文의 data를 그대로 반영(reflect)한 응답
    put.mockImplementation(async (_workspaceId: string, input: { data: WorkspacePlanningData }) => remote(5, input.data, 9));
    await act(async () => { const out = await view.result.current.uploadNow(); expect(out.status).toBe("ok"); });
    const body = put.mock.calls[0][1];
    expect(body.expectedRevision).toBe(4);
    expect(body.expectedSnapshotVersion).toBe(9);
    expect(body.data.weeks[0].budgetAmount).toBe(30000);
    expect(view.result.current.conflict).toBe(false);
    expect(view.result.current.planningServerDirty).toBe(false);
  });

  test("PUT 409: 충돌 상태·로컬 유지·서버 revision 자동 채택 없음(재시도도 같은 expectedRevision)", async () => {
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(4, createDefaultWorkspacePlanningData(), 9));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setBudget(monday, 30000); });
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    put.mockRejectedValue(new ServerApiError("conflict", 409));
    await act(async () => { const out = await view.result.current.uploadNow(); expect(out.status).toBe("conflict"); });
    expect(view.result.current.conflict).toBe(true);
    expect(view.result.current.data.weeks[0].budgetAmount).toBe(30000); // 의도 유지
    put.mockResolvedValue(remote(9, weekData(), 9));
    await act(async () => { await view.result.current.uploadNow(); });
    expect((put.mock.calls[1][1] as { expectedRevision: number }).expectedRevision).toBe(4); // stale base 유지 — 자동 채택 금지
  });

  test("404 는 서버 기능 미사용으로 중립 표시하되 로컬은 계속 살고, 반복 조회 루프가 없다", async () => {
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockRejectedValue(new ServerApiError("not found", 404));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.serverSupport).toBe("missing");
    expect(view.result.current.statusMessage).toContain("제공하지 않습니다");
    expect(view.result.current.statusMessage).not.toMatch(/ServerApiError|stack|http/i);
    expect(api.getWorkspacePlanning).toHaveBeenCalledTimes(1);
    act(() => { view.result.current.setBudget(monday, 20000); });
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toContain("20000"); // 기능 미사용과 무관한 local-first
  });

  test("503 은 빈 서버 상태로 취급하지 않는다", async () => {
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockRejectedValue(new ServerApiError("unavailable", 503));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.serverSupport).toBe("unavailable");
    expect(view.result.current.baseConfirmed).toBe(false);
    expect(view.result.current.remoteStaged).toBeNull();
  });

  test("뷰어: 편집도 PUT 도 금지, 읽기 확인만 가능(개인 설정 경로와 무관)", async () => {
    const { api, view } = setup({ role: "viewer" });
    let edit: { ok: boolean } | undefined;
    act(() => { edit = view.result.current.setBudget(monday, 1000); });
    expect(edit?.ok).toBe(false);
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, weekData()));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(api.getWorkspacePlanning).toHaveBeenCalledTimes(1);
    const out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("skipped");
    expect(api.putWorkspacePlanning).not.toHaveBeenCalled();
    // P2-6: 뷰어도 명시적 읽기 hydration(서버 기록 표시) 가능 — PUT/편집은 계속 금지
    let adopted = false;
    act(() => { adopted = view.result.current.adoptRemote(); });
    expect(adopted).toBe(true);
    expect(view.result.current.data.weeks[0].budgetAmount).toBe(50000);
    expect(api.putWorkspacePlanning).not.toHaveBeenCalled();
  });

  test("샘플 모드(scopeReady false)는 서버를 전혀 호출하지 않는다", async () => {
    const { api, view } = setup({ scopeReady: false });
    await act(async () => { await view.result.current.checkRemote(); });
    const out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("skipped");
    expect(api.getWorkspacePlanning).not.toHaveBeenCalled();
    expect(api.putWorkspacePlanning).not.toHaveBeenCalled();
  });

  test("서버 기록 적용(명시): 교체 전 복구 사본 저장, 데이터·기준 이동", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData()));
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(3, weekData({ weeks: [{ weekStart: monday, budgetAmount: 99000, spentAmount: null, recordedAt: null }] })));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.remoteStaged).not.toBeNull();
    let applied = false;
    act(() => { applied = view.result.current.adoptRemote(); });
    expect(applied).toBe(true);
    expect(view.result.current.data.weeks[0].budgetAmount).toBe(99000);
    expect(view.result.current.baseConfirmed).toBe(true);
    expect(view.result.current.planningServerDirty).toBe(false);
    // 교체 전 원본이 복구 키에 보존됨
    const recoveryKeys = Object.keys(window.localStorage).filter(k => k.includes(":recovery:"));
    expect(recoveryKeys.length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(recoveryKeys[0])).toContain("50000");
  });

  test("체인 저장: 가계부 확인 버전으로 PUT, 미확인·diverged·no-op 은 반영 안 함", async () => {
    const { api, view } = setup();
    // 기준 없음 → skipped
    let out = await act(async () => view.result.current.chainUploadAfterBudgetConfirmed(11));
    expect(out.status).toBe("skipped");
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, createDefaultWorkspacePlanningData(), 11));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setBudget(monday, 40000); });
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    put.mockResolvedValue(remote(3, weekData(), 11));
    out = await act(async () => view.result.current.chainUploadAfterBudgetConfirmed(11));
    expect(out.status).toBe("ok");
    expect(put.mock.calls[0][1]).toMatchObject({ expectedRevision: 2, expectedSnapshotVersion: 11 });
    // staged divergence 체인 차단
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(4, weekData({ paydayDay: 12 })));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setPayday(20); });
    out = await act(async () => view.result.current.chainUploadAfterBudgetConfirmed(12));
    expect(out.status).toBe("diverged");
    expect(put).toHaveBeenCalledTimes(1);
  });

  test("가계부에 미반영 변경이면 계획 단독 PUT 를 막는다(순서 정직성)", async () => {
    const { api, view, state } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, createDefaultWorkspacePlanningData(), 9));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setBudget(monday, 30000); });
    state.budgetDirty = true;
    const out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("skipped");
    expect(api.putWorkspacePlanning).not.toHaveBeenCalled();
  });

  test("전체 백업(LCM2) 어댑터: 성공 시 기준 리셋, 쓰기 실패 시 원시 보존, rollback 복원, 복구 사본", () => {
    const store = controllableStorage();
    const seeded = serializePlanning(weekData());
    store.setItem(planningStorageKey(profileA), seeded);
    const { view } = setup({ storage: store });
    const adapter = view.result.current.importAdapter;
    expect(adapter.isCurrentScope(profileA)).toBe(true);
    expect(adapter.isCurrentScope(profileB)).toBe(false);
    expect(adapter.getRaw()).toBe(seeded);
    const imported: WorkspacePlanningData = { ...weekData(), paydayDay: 21 };
    expect(adapter.prepareReplace()).toBe(true);
    const recovery = [...store._map.keys()].find(key => key.includes(":recovery:"));
    expect(recovery).toBeTruthy();
    expect(store.getItem(recovery!)).toBe(seeded); // 원시 그대로 복구 사본
    // quota 실패 → 원시 그대로(자동 덮어쓰기 없음)
    store.fail = true;
    let failed = { ok: false };
    act(() => { failed = adapter.replace(imported, seeded); });
    expect(failed.ok).toBe(false);
    expect(store.getItem(planningStorageKey(profileA))).toBe(seeded);
    store.fail = false;
    // 성공 → 상태·기준 갱신, 서버 CAS 기준은 재확인 필요(null)
    act(() => { expect(adapter.replace(imported, seeded).ok).toBe(true); });
    expect(view.result.current.baseConfirmed).toBe(false);
    expect(store.getItem(planningStorageKey(profileA))).toContain("\"paydayDay\":21");
    // 가계부 쪽 실패 시 롤백 경로: 원시 복원
    act(() => { adapter.rollback(seeded); });
    expect(store.getItem(planningStorageKey(profileA))).toBe(seeded);
    expect(view.result.current.data.weeks[0].budgetAmount).toBe(50000);
  });
});
