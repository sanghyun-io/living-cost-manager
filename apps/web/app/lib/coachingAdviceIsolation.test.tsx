// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BudgetDataApi } from "./useBudgetData";
import { useCoach } from "./useCoach";
import { createPreparationStore } from "./coachEngine/store";
let testStore = createPreparationStore();
vi.mock("./coachEngine/pageManager", async importOriginal => ({
  ...await importOriginal<typeof import("./coachEngine/pageManager")>(),
  getPageStore: () => testStore,
  getPageFactory: () => mocks.factory()
}));
beforeEach(() => { testStore = createPreparationStore(); });
import { useCoachingPreferences } from "./useCoachingPreferences";

const mocks = vi.hoisted(() => ({ stream: vi.fn(), engine: vi.fn(), factory: vi.fn() }));
vi.mock("./coach", () => ({ getCoachEngineStatus: () => "ready", getCoachEngine: mocks.engine, streamCoaching: mocks.stream }));
vi.mock("./coachModel", () => ({
  isCoachOptedIn: () => false,
  isWebGpuAvailable: () => true,
  setCoachOptIn: vi.fn(),
  COACH_MODEL_APPROX_MB: 1,
  COACH_MODEL_VRAM_MB: 1,
  COACH_MODEL_ID: "Qwen3.5-0.8B-q4f16_1-MLC",
  COACH_MODEL_ENABLE_THINKING: false
}));
vi.mock("./analytics", () => ({ track: vi.fn() }));
afterEach(() => {
  cleanup();
  testStore.cancelPreparation();
  vi.clearAllMocks();
});

// 가짜 엔진 팩토리: store 가 beginPreparation 직후 즉시 onReady 를 호출한다.
// store 가 동기적으로 jobId 를 증가시키고 snapshot 을 갱신하므로 setTimeout 없이
// 바로 호출하면 된다.
function installFakeReadyFactory() {
  let captured: any = null;
  const fakeFactory: any = (callbacks: any) => {
    captured = callbacks;
    callbacks.onReady();
    return { jobId: 1, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
  };
  fakeFactory.getEngine = () => ({});
  fakeFactory.unload = vi.fn().mockResolvedValue(undefined);
  fakeFactory.hasLiveWorker = () => true;
  mocks.factory.mockReturnValue(fakeFactory);
  return () => captured;
}

function budget() {
  return { localScopeKey: "synthetic-local/ws", profileName: "Synthetic", monthlyIncome: 1000000, summary: { monthlyExpense: 600000 },
    fixedCosts: [
      { id: "a", name: "보호보험", categoryId: "insurance", amount: 300000, periodMonths: 1, billingDay: null },
      { id: "b", name: "검토보험", categoryId: "insurance", amount: 300000, periodMonths: 1, billingDay: null }
    ] } as unknown as BudgetDataApi;
}

describe("actual useCoach personalization wiring (no model or business API)", () => {
  it("unknown readiness is idle until explicit request; every request entry point fails closed without engine/stream calls", async () => {
    const data = budget();
    const h = renderHook(() => useCoach({ budget: data, serverApi: null, coachingPreferencesReady: false }));
    expect(h.result.current.coachStatus).toBe("idle");
    expect(h.result.current.coachError).toBe("");
    expect(h.result.current.coachInput.savings).toEqual([]);
    expect(h.result.current.coachInput.insuranceHigh).toBe(false);
    expect(h.result.current.coachInput.insuranceReviewItemNames).toBeUndefined();
    expect(h.result.current.coachInput.monthlyTotal).toBe(600000);
    expect(h.result.current.coachFallbackHeadline).toBe("코칭 설정 확인 전에는 개인화 제안을 보류합니다.");
    await act(async () => { await h.result.current.runCoaching(); });
    expect(h.result.current.coachStatus).toBe("error");
    expect(h.result.current.coachError).toContain("코칭 설정을 확인할 수 없어 추천을 보류");
    act(() => h.result.current.confirmConsentAndRun());
    expect(h.result.current.coachAttemptConsent).toBe(false);
    expect(mocks.engine).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("actual corrupt storage readiness blocks coaching while preserving raw bytes and budget totals", async () => {
    const data = budget(); const ck = "lcm:coaching:local:ws:anonymous"; const raw = "{ corrupted protection intent";
    localStorage.setItem(ck, raw);
    const h = renderHook(() => {
      const prefs = useCoachingPreferences(data.fixedCosts, "local", "ws", null, null);
      const coach = useCoach({ budget: data, serverApi: null, protectedFixedCostIds: prefs.activeIds, coachingPreferencesReady: prefs.ready });
      return { prefs, coach };
    });
    expect(h.result.current.prefs.ready).toBe(false);
    await act(async () => { await h.result.current.coach.runCoaching(); });
    expect(h.result.current.coach.coachInput.monthlyTotal).toBe(600000);
    expect(h.result.current.coach.coachInput.savings).toEqual([]);
    expect(h.result.current.coach.coachInput.insuranceHigh).toBe(false);
    expect(localStorage.getItem(ck)).toBe(raw);
    expect(mocks.engine).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();
    localStorage.removeItem(ck); // synthetic test fixture only
  });

  it("readiness loss invalidates previous text before effects and captured run callbacks cannot bypass it; recovery enables explicit fresh coaching", async () => {
    const data = budget();
    mocks.engine.mockResolvedValue({});
    mocks.stream.mockImplementation(async (_engine, _input, emit) => { emit("새 코칭 결과입니다."); return "새 코칭 결과입니다."; });
    const getCaptured = installFakeReadyFactory();

    const renders: { ready: boolean; text: string }[] = [];
    const h = renderHook(({ ready }) => {
      const coach = useCoach({ budget: data, serverApi: null, coachingPreferencesReady: ready });
      renders.push({ ready, text: coach.coachingText }); return coach;
    }, { initialProps: { ready: true } });

    // consent + prepare → ready 상태.
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");

    // 첫 코칭 생성.
    await act(async () => { await h.result.current.runCoaching(); });
    expect(h.result.current.coachingText).toBe("새 코칭 결과입니다.");
    expect(mocks.stream).toHaveBeenCalledTimes(1);

    const capturedRun = h.result.current.runCoaching;
    const capturedConsent = h.result.current.confirmConsentAndPrepare;
    mocks.engine.mockClear(); mocks.stream.mockClear();

    // readiness 를 잃으면 텍스트/세대가 무효화되어야 한다.
    h.rerender({ ready: false });
    expect(renders.find(render => !render.ready)?.text).toBe("");
    await act(async () => { await capturedRun(); await capturedConsent(); });
    expect(mocks.engine).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();

    // 다시 준비 완료 → 다음 코칭은 명시적 클릭으로만.
    h.rerender({ ready: true });
    expect(h.result.current.coachInput.monthlyTotal).toBe(600000);
    expect(h.result.current.coachInput.insuranceHigh).toBe(true);
    expect(h.result.current.coachStatus).toBe("idle");
    expect(mocks.engine).not.toHaveBeenCalled(); expect(mocks.stream).not.toHaveBeenCalled();

    // 명시적 prepare 다시 호출 → ready 로 다시 진입.
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");

    await act(async () => { await h.result.current.runCoaching(); });
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(h.result.current.coachingText).toBe("새 코칭 결과입니다.");
  });

  it("readiness failure during pending engine initialization prevents streaming after late resolution", async () => {
    const data = budget();
    let captured: any = null;
    const slowFactory: any = (callbacks: any) => {
      captured = callbacks;
      // onReady 호출 안함 — pending 상태 유지
      return { jobId: 1, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    };
    slowFactory.getEngine = () => null; // 아직 준비 안됨
    slowFactory.unload = vi.fn();
    slowFactory.hasLiveWorker = () => true;
    mocks.factory.mockReturnValue(slowFactory);

    const h = renderHook(({ ready }) => useCoach({ budget: data, serverApi: null, coachingPreferencesReady: ready }), { initialProps: { ready: true } });

    // prepare 시작 (pending 상태로 진입).
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("preparing");

    // readiness 가 false 가 되면 runCoaching 이 stream 을 호출하지 않는다.
    // runCoaching 을 먼저 부른 뒤 rerender 하면, late resolution 도 stream 을
    // 시작하지 않아야 한다.
    let request!: Promise<void>;
    act(() => { request = h.result.current.runCoaching(); });
    h.rerender({ ready: false });
    await act(async () => { await request; });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(h.result.current.coachingText).toBe("");
    // CRITICAL — readiness loss 는 preparation 을 취소하지 않는다.
    // 모델 다운로드/초기화는 preferences 와 독립적이다. 준비는 계속 진행되며,
    // 단지 코칭 생성(runCoaching) 만 blockUnavailablePreferences() 로 차단된다.
    expect(h.result.current.preparation.state).toBe("preparing");
  });

  it("constructs mixed-insurance input with eligible names only, and passes protected names solely to local output guard", async () => {
    mocks.engine.mockResolvedValue({}); mocks.stream.mockResolvedValue("");
    installFakeReadyFactory();
    const data = budget();
    const h = renderHook(() => useCoach({ budget: data, serverApi: null, protectedFixedCostIds: new Set(["a"]) }));
    expect(h.result.current.coachInput.insuranceReviewItemNames).toEqual(["검토보험"]);
    expect(JSON.stringify(h.result.current.coachInput)).not.toContain("보호보험");
    expect(JSON.stringify(h.result.current.coachInput)).not.toContain("reason");

    // prepare → ready → run
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");

    await act(async () => { await h.result.current.runCoaching(); });
    expect(mocks.stream.mock.calls[0][3]).toEqual({ protectedItemNames: ["보호보험"] });
  });

  it("same-count protection swaps invalidate visible advice and reject late streaming output", async () => {
    mocks.engine.mockResolvedValue({});
    let emit!: (text: string) => void; let release!: () => void;
    mocks.stream.mockImplementation((_engine, _input, callback) => { emit = callback; return new Promise<void>(resolve => { release = resolve; }); });
    installFakeReadyFactory();

    const data = budget(); const renders: { ids: string[]; text: string }[] = [];
    const h = renderHook(({ ids }) => {
      const coach = useCoach({ budget: data, serverApi: null, protectedFixedCostIds: new Set(ids) });
      renders.push({ ids, text: coach.coachingText }); return coach;
    }, { initialProps: { ids: ["a"] } });

    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    let call!: Promise<void>;
    await act(async () => { call = h.result.current.runCoaching(); await Promise.resolve(); });
    act(() => emit("검토보험 보장 점검을 권해요."));
    expect(h.result.current.coachingText).toContain("검토보험");
    h.rerender({ ids: ["b"] });
    expect(renders.find(r => r.ids[0] === "b")?.text).toBe("");
    expect(h.result.current.coachInput.insuranceReviewItemNames).toEqual(["보호보험"]);
    act(() => emit("이전 검토보험 권유가 늦게 도착했어요."));
    await act(async () => { release(); await call; });
    expect(h.result.current.coachingText).toBe("");
  });
});
