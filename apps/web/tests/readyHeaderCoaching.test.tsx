// @vitest-environment jsdom
// 헤더 READY 버튼의 단일 클릭 생성 정책:
// - 일반 열기(도구 메뉴 등)와 READY 저장 상태 전이는 절대 생성하지 않는다.
// - READY 버튼 클릭은 모달을 열고, 유효한 현재 조언이 있으면 재사용(추가 추론 없음),
//   없으면 1회 생성한다. 중복 클릭은 single-flight, 워커 상실/설정 미확인 시에는
//   새 다운로드·새 동의·추론 없이 안내만 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BudgetDataApi } from "../app/lib/useBudgetData";
import { useCoach } from "../app/lib/useCoach";
import { createPreparationStore } from "../app/lib/coachEngine/store";
import { COACH_USER_ERRORS } from "../app/lib/coachEngine/coachErrors";
let testStore = createPreparationStore();
vi.mock("../app/lib/coachEngine/pageManager", async importOriginal => ({
  ...(await importOriginal<typeof import("../app/lib/coachEngine/pageManager")>()),
  getPageStore: () => testStore,
  getPageFactory: (create: () => unknown) => create()
}));
beforeEach(() => { testStore = createPreparationStore(); });

const mocks = vi.hoisted(() => ({ stream: vi.fn(), engine: vi.fn(), factory: vi.fn() }));
vi.mock("../app/lib/coach", () => ({
  getCoachEngineStatus: () => "none",
  getCoachEngine: mocks.engine,
  streamCoaching: mocks.stream
}));
vi.mock("../app/lib/coachModel", () => ({
  isCoachOptedIn: () => false,
  isWebGpuAvailable: () => true,
  setCoachOptIn: vi.fn(),
  COACH_MODEL_APPROX_MB: 453,
  COACH_MODEL_VRAM_MB: 1629.49,
  COACH_MODEL_ID: "Qwen3.5-0.8B-q4f16_1-MLC",
  COACH_MODEL_ENABLE_THINKING: false
}));
vi.mock("../app/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../app/lib/coachEngine/createWebWorkerClient", () => ({
  createWorkerCoachEngineFactory: mocks.factory
}));

afterEach(() => {
  cleanup();
  testStore.cancelPreparation();
  vi.clearAllMocks();
});

const engineStub = { interruptGenerate: vi.fn() };

function budget(): BudgetDataApi {
  return {
    localScopeKey: "synthetic-scope/ws",
    profileName: "Synthetic",
    monthlyIncome: 3000000,
    summary: { monthlyExpense: 600000 },
    fixedCosts: [
      { id: "x", name: "Synthetic cost", categoryId: "subscription", amount: 170000, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null, renewalStatus: "unreviewed" }
    ]
  } as unknown as BudgetDataApi;
}

function makeReadyFactory() {
  let callbacks: { onReady: () => void } | null = null;
  const factory: any = (cbs: { onReady: () => void }) => {
    callbacks = cbs;
    return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
  };
  factory.getEngine = () => engineStub;
  factory.unload = vi.fn();
  factory.hasLiveWorker = () => true;
  return {
    factory,
    ready: () => { callbacks?.onReady(); }
  };
}

async function startPreparation(h: { result: { current: { confirmConsentAndPrepare: () => void } } }) {
  act(() => h.result.current.confirmConsentAndPrepare());
  await act(async () => { await Promise.resolve(); });
}

describe("READY header one-click view/generate", () => {
  it("normal open never generates; READY click with no result generates exactly once", async () => {
    const { factory, ready } = makeReadyFactory();
    mocks.factory.mockReturnValue(factory);
    mocks.stream.mockImplementation(async (_engine: unknown, _input: unknown, cb: (t: string) => void) => { cb("코칭 결과"); });
    const h = renderHook(({ prefs }) => useCoach({ budget: budget(), serverApi: null, coachingPreferencesReady: prefs }), { initialProps: { prefs: true } });
    await startPreparation(h);
    act(() => { ready(); });
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");

    // 일반 열기: 생성 금지.
    mocks.stream.mockClear();
    act(() => h.result.current.openCoachModal());
    await act(async () => { await Promise.resolve(); });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(h.result.current.coachingText).toBe("");

    // READY 클릭: 모달 열림 + 1회 생성.
    act(() => h.result.current.viewPreparedCoaching());
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.isCoachModalOpen).toBe(true);
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(h.result.current.coachingText).toContain("코칭 결과");

    // 유효한 현재 조언 재사용: 추가 추론(GPU) 없음.
    act(() => h.result.current.viewPreparedCoaching());
    await act(async () => { await Promise.resolve(); });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it("double activation on one generation is deduped to a single stream call", async () => {
    const { factory, ready } = makeReadyFactory();
    mocks.factory.mockReturnValue(factory);
    let resolveStream: () => void = () => {};
    mocks.stream.mockImplementation(() => new Promise<void>(resolve => { resolveStream = resolve; }));
    const h = renderHook(({ prefs }) => useCoach({ budget: budget(), serverApi: null, coachingPreferencesReady: prefs }), { initialProps: { prefs: true } });
    await startPreparation(h);
    act(() => { ready(); });
    await act(async () => { await Promise.resolve(); });
    act(() => {
      h.result.current.viewPreparedCoaching();
      h.result.current.viewPreparedCoaching();
    });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    await act(async () => { resolveStream(); });
  });

  it("worker lost blocks silently starting a new download or inference", async () => {
    const { factory, ready } = makeReadyFactory();
    mocks.factory.mockReturnValue(factory);
    mocks.stream.mockImplementation(async () => {});
    const h = renderHook(({ prefs }) => useCoach({ budget: budget(), serverApi: null, coachingPreferencesReady: prefs }), { initialProps: { prefs: true } });
    await startPreparation(h);
    act(() => { ready(); });
    await act(async () => { await Promise.resolve(); });
    const factoryCalls = mocks.factory.mock.calls.length;
    // 워커 상실 → error 상태(고정 메시지, 권한 리셋).
    const jobId = h.result.current.preparation.jobId;
    act(() => { testStore.reportWorkerDeath(jobId, "worker terminated"); });
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("error");
    mocks.stream.mockClear();
    act(() => h.result.current.viewPreparedCoaching());
    await act(async () => { await Promise.resolve(); });
    // 새 추론도, 암시적 재다운로드(factory 재호출)도 없다.
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.factory.mock.calls.length).toBe(factoryCalls);
  });

  it("unavailable preferences blocks READY click without inference", async () => {
    const { factory, ready } = makeReadyFactory();
    mocks.factory.mockReturnValue(factory);
    const h = renderHook(({ prefs }) => useCoach({ budget: budget(), serverApi: null, coachingPreferencesReady: prefs }), { initialProps: { prefs: true } });
    await startPreparation(h);
    act(() => { ready(); });
    await act(async () => { await Promise.resolve(); });
    h.rerender({ prefs: false });
    await act(async () => { await Promise.resolve(); });
    mocks.stream.mockClear();
    act(() => h.result.current.viewPreparedCoaching());
    await act(async () => { await Promise.resolve(); });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(h.result.current.coachStatus).toBe("error");
  });

  it("prepare error survives modal reopen as the sanitized fixed message, not blank/generic", () => {
    const h = renderHook(({ prefs }) => useCoach({ budget: budget(), serverApi: null, coachingPreferencesReady: prefs }), { initialProps: { prefs: true } });
    act(() => h.result.current.confirmConsentAndPrepare());
    const jobId = h.result.current.preparation.jobId;
    act(() => {
      testStore.resolveError(jobId, "Qwen3.5-0.8B-q4f16_1-MLC", "HTTPS://cdn.example/signed?token=secret Failed to fetch");
    });
    expect(h.result.current.preparation.state).toBe("error");
    act(() => h.result.current.openCoachModal());
    expect(h.result.current.coachError).toBe(COACH_USER_ERRORS.prepareNetwork);
    expect(h.result.current.coachStatus).toBe("error");
  });
});
