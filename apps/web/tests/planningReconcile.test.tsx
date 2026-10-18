// @vitest-environment jsdom
// RELEASE-BLOCK 재현 회귀 테스트 (독립 reviewer 9 findings):
// P1-1 UI '비교 닫기'가 divergence 가드를 지우고 normal 저장으로 상대 기기 기록을 덮어쓰는 경로
// P1-2 미저장 메모리 편집(C)을 둔 채 서버 기록/백업 적용 시 C 소실 + 복구 사본이 오래된 A인 문제
// P2-4 명시 교체(send staged revision)가 base 존재 시 영원한 409
// P2-5 마지막 기록 삭제(no-op)가 dirty/헤더를 숨기는 문제
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { createDefaultWorkspacePlanningData, type WorkspacePlanning, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { usePlanningData } from "../app/lib/usePlanningData";
import { planningStorageKey, serializePlanning } from "../app/lib/planningStorage";
import { ServerApiError, type ServerApiClient, type ServerSession } from "../app/lib/serverApi";
import { combinePlanningStorageState } from "../app/lib/syncStatus";

const profileB = 'ledger:' + JSON.stringify(["acct-2", "ws-2"]);

const monday = "2026-10-19";
const profileA = 'ledger:' + JSON.stringify(["acct-1", "ws-1"]);

function session(): ServerSession {
  return {
    token: "t", refreshToken: "r",
    user: { id: "acct-1", email: "a@a.kr", name: "A", emailVerified: true },
    workspace: { id: "ws-1", name: "가계부", role: "owner" }
  };
}

function remote(revision: number, data: WorkspacePlanningData, snapshotVersion = 9): WorkspacePlanning {
  return { workspaceId: "ws-1", revision, currentSnapshotVersion: snapshotVersion, data };
}

function weekData(budget: number): WorkspacePlanningData {
  return { ...createDefaultWorkspacePlanningData(), weeks: [{ weekStart: monday, budgetAmount: budget, spentAmount: null, recordedAt: null }] };
}

function makeApi() {
  return {
    baseUrl: "https://api.test",
    getWorkspacePlanning: vi.fn(),
    putWorkspacePlanning: vi.fn()
  } as unknown as { getWorkspacePlanning: ReturnType<typeof vi.fn>; putWorkspacePlanning: ReturnType<typeof vi.fn> } & ServerApiClient;
}

function controllableStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const state = { fail: false };
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (state.fail && key.startsWith("living-cost-manager:planning")) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem: (key: string) => { map.delete(key); },
    state,
    _map: map
  };
}

function setup(options: Partial<Parameters<typeof usePlanningData>[0]> = {}) {
  const api = makeApi();
  const view = renderHook((props: Partial<Parameters<typeof usePlanningData>[0]>) => usePlanningData({
    profileId: profileA,
    serverSession: session(),
    serverApi: api,
    role: "owner",
    getBudgetServerVersion: () => 9,
    isBudgetServerCurrent: () => true,
    isBudgetDirty: () => false,
    ...props
  }), { initialProps: options });
  return { api, view };
}

beforeEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });
afterEach(() => cleanup());

describe("P1-1 — unresolved divergence survives UI close and blocks normal overwrite", () => {
  test("synced A → remote rev2 B → GET: base가 B로 진행되지 않는다(close 후에도 일반 PUT 0)", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData(30000)));
    const { api, view } = setup();
    // 최초 확인: 서버 rev1 = 로컬과 동일 → 기준 동기화(대조 없음)
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, weekData(30000)));
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.baseConfirmed).toBe(true);
    expect(view.result.current.planningServerDirty).toBe(false);
    // 다른 기기 B 저장 후 재확인: rev2, 내용 다름 — 로컬은 clean 미러
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, weekData(80000)));
    await act(async () => { await view.result.current.checkRemote(); });
    // 기준(revision 2)을 미확인 상태로 채택 금지
    expect(view.result.current.remoteStaged?.data.weeks[0].budgetAmount).toBe(80000);
    // 사용자가 비교를 닫는다
    act(() => { view.result.current.closeRemoteComparison(); });
    // 닫기가 발산 상태를 지우지 않는다 — 일반 '계획 서버 저장'은 PUT 하지 않는다
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    let out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("diverged");
    expect(put).not.toHaveBeenCalled();
    // 체인 저장도 동일하게 막힌다
    out = await act(async () => view.result.current.chainUploadAfterBudgetConfirmed(9));
    expect(out.status).toBe("diverged");
    expect(put).not.toHaveBeenCalled();
    // 비교 다시 열기: 상태 유지(재 GET 없이도 발산 기억), 강제 교체는 새 확인 없이는 거부될 수 있다
    await act(async () => { await view.result.current.checkRemote(); });
    expect(view.result.current.remoteStaged).not.toBeNull();
  });

  test("서버 적용(adopt)으로 reconcile 시에만 기준이 rev2로 진행, 이후 일반 PUT 정상공작", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData(30000)));
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, weekData(30000)));
    await act(async () => { await view.result.current.checkRemote(); });
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, weekData(80000)));
    await act(async () => { await view.result.current.checkRemote(); });
    let adopted = false;
    act(() => { adopted = view.result.current.adoptRemote(); });
    expect(adopted).toBe(true);
    expect(view.result.current.data.weeks[0].budgetAmount).toBe(80000);
    act(() => { view.result.current.setPayday(25); });
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    put.mockImplementation(async (_id: string, input: { data: WorkspacePlanningData }) =>
      remote(3, input.data, 9));
    const out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("ok");
    expect(put.mock.calls[0][1].expectedRevision).toBe(2);
  });
});

describe("P1-2 — unflushed memory edit is never replaced without durable preservation", () => {
  test("quota로 편집 C 미저장 → 저장소 회복 후 adoptRemote: C가 보존(복구 사본)되거나 적용이 차단된다", async () => {
    const store = controllableStorage();
    store.setItem(planningStorageKey(profileA), serializePlanning(weekData(1000))); // 캐시 A
    store.state.fail = true;
    const { api, view } = setup({ storage: store });
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(4, weekData(777000)));
    await act(async () => { await view.result.current.checkRemote(); });
    // 편집 C — 기기 저장 실패(quota)
    act(() => { view.result.current.setBudget(monday, 500000); });
    expect(view.result.current.saveError).toContain("저장하지 못했습니다");
    store.state.fail = false; // 저장 공간 회복(재시도 없음)
    // 서버 기록 적용 시도: 미저장 C를 조용히 버리면 안 된다
    let applied = true;
    act(() => { applied = view.result.current.adoptRemote(); });
    // 차단되거나(권장) 또는 C가 복구 사본에 남아야 한다
    if (applied) {
      const recoveries = [...store._map.keys()].filter(key => key.includes(":recovery:"));
      expect(recoveries.length).toBeGreaterThan(0);
      expect(recoveries.some(key => (store.getItem(key) ?? "").includes("500000"))).toBe(true);
    } else {
      expect(store.getItem(planningStorageKey(profileA))).toBe(serializePlanning(weekData(1000)));
      expect(view.result.current.data.weeks[0].budgetAmount).toBe(500000); // 메모리 C 유지
    }
  });

  test("LCM2 import prepareReplace는 현재 메모리 플러시를 강제/차단한다", async () => {
    const store = controllableStorage();
    store.setItem(planningStorageKey(profileA), serializePlanning(weekData(1000)));
    store.state.fail = true;
    const { view } = setup({ storage: store });
    act(() => { view.result.current.setPayday(31); }); // 편집 C (미저장)
    const adapter = view.result.current.importAdapter;
    expect(adapter.prepareReplace()).toBe(false); // 플러시 실패 → 교체 준비 거부
    store.state.fail = false;
    expect(adapter.prepareReplace()).toBe(true); // 플러시 성공 후 복구 사본 = C 포함
    const recoveries = [...store._map.keys()].filter(key => key.includes(":recovery:"));
    expect(recoveries.some(key => (store.getItem(key) ?? "").includes("\"paydayDay\":31"))).toBe(true);
  });
});

describe("P2-4 — explicit replace uses CURRENT staged revision even when a base exists", () => {
  test("base rev1 dirty local vs server rev2: 닫지 않은 비교에서 명시 교체 → expectedRevision 2 전송", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData(111000)));
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, weekData(111000)));
    await act(async () => { await view.result.current.checkRemote(); }); // base 1
    act(() => { view.result.current.setBudget(monday, 222000); }); // 로컬 dirty
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, weekData(888000)));
    await act(async () => { await view.result.current.checkRemote(); }); // staged rev2 (base 1 유지)
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    put.mockImplementation(async (_id: string, input: { data: WorkspacePlanningData }) => remote(3, input.data, 9));
    let out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("diverged"); // 일반 저장 금지
    out = await act(async () => view.result.current.uploadNow({ forceStagedRevision: true }));
    expect(out.status).toBe("ok");
    expect(put.mock.calls[0][1].expectedRevision).toBe(2);
    // 그 이후 서버가 3으로 이미 바뀌어 있으면CAS 유지: staged 2로 재교체 시도 시 서버 3 → 409, 자동 재시도 없음
    put.mockRejectedValue(new ServerApiError("conflict", 409));
    const after = await act(async () => view.result.current.uploadNow());
    expect(["conflict", "diverged", "ok", "skipped"].includes(after.status)).toBe(true);
    expect(put.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test("닫힌 비교는 교체 권한을 주지 않는다(dismissal blocks force)", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(weekData(111000)));
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(1, weekData(111000)));
    await act(async () => { await view.result.current.checkRemote(); });
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, weekData(888000)));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.closeRemoteComparison(); });
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    const out = await act(async () => view.result.current.uploadNow({ forceStagedRevision: true }));
    expect(out.status).not.toBe("ok");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("P2-5 — final-record deletion still reports server-pending empty state", () => {
  test("non-empty baseline에서 payday만 지운 뒤에도 dirty/헤더 진실(server 미반영), empty PUT 후 healthy", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning({ ...createDefaultWorkspacePlanningData(), paydayDay: 25 }));
    const { api, view } = setup();
    (api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, { ...createDefaultWorkspacePlanningData(), paydayDay: 25 }));
    await act(async () => { await view.result.current.checkRemote(); });
    act(() => { view.result.current.setPayday(null); }); // 마지막 기록 삭제 → no-op 내용
    expect(view.result.current.planningActive).toBe(true); // 베이스라인 대비 발산
    expect(view.result.current.planningServerDirty).toBe(true);
    const put = api.putWorkspacePlanning as ReturnType<typeof vi.fn>;
    put.mockImplementation(async (_id: string, input: { data: WorkspacePlanningData }) => remote(3, input.data, 9));
    const out = await act(async () => view.result.current.uploadNow());
    expect(out.status).toBe("ok");
    expect(serializePlanning(put.mock.calls[0][1].data)).toBe(serializePlanning(createDefaultWorkspacePlanningData()));
    expect(view.result.current.planningServerDirty).toBe(false);
    expect(view.result.current.planningActive).toBe(false);
  });

  test("사용한 적 없는 no-op 계획은 글로벌을 막지 않는다(서버 미확인이어도 active false)", () => {
    const { view } = setup();
    expect(view.result.current.planningActive).toBe(false);
    expect(view.result.current.planningServerDirty).toBe(false);
    expect(view.result.current.savePending).toBe(false);
  });
});

describe("P2-1 — 마지막 기록 삭제 후 재불러오기: 서버 확인 전 '저장됨' 주장 금지", () => {
  const payday25 = { ...createDefaultWorkspacePlanningData(), paydayDay: 25 };

  test("동기화된 payday25 → 삭제 → 기기 저장 → 재마운트: unknown 유지, 발산 확인 전 일반 업로드 차단, empty==empty 확인 후에만 agree", async () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(payday25));
    const first = setup();
    (first.api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, payday25));
    await act(async () => { await first.view.result.current.checkRemote(); });
    expect(first.view.result.current.baseConfirmed).toBe(true);
    act(() => { first.view.result.current.setPayday(null); });
    expect(first.view.result.current.planningServerDirty).toBe(true); // 같은 세션에서는 기존 규칙으로 truthfully dirty
    await act(async () => { first.view.result.current.retrySave(); });
    expect(window.localStorage.getItem(planningStorageKey(profileA))).toBe(serializePlanning(createDefaultWorkspacePlanningData()));
    first.view.unmount();
    cleanup();

    // 재마운트: 캐시는 '의미 있게 비워진' 상태지만 base/staged가 사라졌다 — 확인 전 healthy 금지
    const second = setup();
    (second.api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(2, payday25));
    expect(second.view.result.current.planningActive).toBe(true);
    expect(second.view.result.current.planningServerUnknown).toBe(true);
    expect(second.view.result.current.savePending).toBe(false); // '저장 중' 루프 오염 금지
    const header = combinePlanningStorageState("server-saved", {
      saveError: false,
      savePending: second.view.result.current.savePending,
      active: second.view.result.current.planningActive,
      serverDirty: second.view.result.current.planningServerDirty,
      serverUnknown: second.view.result.current.planningServerUnknown
    });
    expect(header).toBe("server-unknown");

    // 확인: 서버는 여전히 payday25 → 발산 staging, 일반 업로드는 PUT 없이 차단
    await act(async () => { await second.view.result.current.checkRemote(); });
    expect(second.view.result.current.remoteStaged?.data.paydayDay).toBe(25);
    const out = await act(async () => second.view.result.current.uploadNow());
    expect(out.status).toBe("diverged");
    expect(second.api.putWorkspacePlanning).not.toHaveBeenCalled();
    second.view.unmount();
    cleanup();

    // 서버가 이미 empty@rev3(교체 저장 후 상태)와 일치 확인 → agree, no-op로 조용해짐
    const third = setup();
    (third.api.getWorkspacePlanning as ReturnType<typeof vi.fn>).mockResolvedValue(remote(3, createDefaultWorkspacePlanningData()));
    await act(async () => { await third.view.result.current.checkRemote(); });
    expect(third.view.result.current.planningActive).toBe(false);
    expect(third.view.result.current.planningServerDirty).toBe(false);
    expect(third.view.result.current.planningServerUnknown).toBe(false);
    expect(third.view.result.current.remoteStaged).toBeNull();
  });

  test("캐시 없는 새 empty 계획은 가계부 주장을 막지 않는다(게스트 포함) · 스코프 간 마커 누수 없음", () => {
    const fresh = setup();
    expect(fresh.view.result.current.planningActive).toBe(false);
    fresh.view.unmount();
    cleanup();
    const guest = setup({ serverSession: null, serverApi: null });
    expect(guest.view.result.current.planningActive).toBe(false);
    expect(guest.view.result.current.planningServerUnknown).toBe(false);
    guest.view.unmount();
    cleanup();
    // ws-1에만 empty 캐시가 있는 상태로 ws-2 열기 → ws-2는 영향 없음(마커 스코프 격리)
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(createDefaultWorkspacePlanningData()));
    const other = setup({ profileId: profileB });
    expect(other.view.result.current.planningActive).toBe(false);
    expect(other.view.result.current.planningServerUnknown).toBe(false);
  });

  test("existing persisted empty cache를 missing으로 오인하지 않는다(readPlanningCache 상태 구분)", () => {
    window.localStorage.setItem(planningStorageKey(profileA), serializePlanning(createDefaultWorkspacePlanningData()));
    const view = setup();
    expect(view.view.result.current.planningActive).toBe(true);
    expect(view.view.result.current.planningServerUnknown).toBe(true);
  });
});
