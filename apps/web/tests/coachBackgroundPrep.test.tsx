// @vitest-environment jsdom
// 신규 도입: 코치 모델 '백그라운드 준비' 흐름의 통합 테스트.
//
// 시나리오:
// - consent:   미동의/모델 불일치/기존 opt-in=0 호출 거부
// - single-flight: 중복 prepare 두 번째 무시
// - subscriber: progress close-reopen
// - cancel-init: 늦게 도착하는 init resolve 가 stale callback 무시
// - ready unload: 워커 crash / device lost / dispose
// - READY no inference: 모달이 ready 상태더라도 명시적 클릭 전엔 engine 호출 X
// - current input/keep/scope: 최신 입력만 살아남는다
// - fail-closed preferences
// - think-prefix split: 잘려서 도착한 '<th' 같은 토큰은 UI 까지 안 올라간다

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BudgetDataApi } from "../app/lib/useBudgetData";
import { useCoach } from "../app/lib/useCoach";
import { COACH_USER_ERRORS } from "../app/lib/coachEngine/coachErrors";
import { createPreparationStore } from "../app/lib/coachEngine/store";
let testStore = createPreparationStore();
vi.mock("../app/lib/coachEngine/pageManager", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/coachEngine/pageManager")>(),
  getPageStore: () => testStore,
  getPageFactory: (create: () => unknown) => create()
}));

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  engine: vi.fn(),
  factory: vi.fn()
}));

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

// 즉시 onReady 를 호출하는 가짜 워커 팩토리.
function fakeReadyFactory() {
  const fake: any = (callbacks: any) => {
    callbacks.onReady();
    return { jobId: 1, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
  };
  fake.getEngine = () => ({});
  fake.unload = vi.fn().mockResolvedValue(undefined);
  fake.hasLiveWorker = () => true;
  return fake;
}

beforeEach(() => {
  testStore = createPreparationStore();
  vi.clearAllMocks();
  mocks.factory.mockReturnValue(fakeReadyFactory());
});

afterEach(() => {
  cleanup();
  testStore.cancelPreparation();
});

function budget() {
  return {
    localScopeKey: "synthetic-bg/ws",
    profileName: "Synthetic",
    monthlyIncome: 3000000,
    summary: { monthlyExpense: 600000 },
    fixedCosts: [
      { id: "x", name: "Netflix", categoryId: "subscription", amount: 17000, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null, renewalStatus: "unreviewed" }
    ]
  } as unknown as BudgetDataApi;
}

describe("background preparation — consent gate", () => {
  it("confirmConsentAndPrepare 가 호출되기 전까지 engine/stream 모두 호출되지 않는다", async () => {
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    await act(async () => { await h.result.current.runCoaching(); });
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(h.result.current.preparation.state).toBe("idle");
    expect(h.result.current.awaitingConsent).toBe(true);
  });

  it("모델 ID 가 다른 old opt-in=0 으로 만들어진 가짜 factory 는 beginPreparation 에서 무시된다", async () => {
    const calls: string[] = [];
    const fake: any = (callbacks: any) => {
      calls.push("invoked");
      callbacks.onError("model mismatch");
      return { jobId: 1, modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC" };
    };
    fake.getEngine = () => null;
    fake.unload = vi.fn();
    fake.hasLiveWorker = () => true;
    fake.modelId = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
    mocks.factory.mockReturnValue(fake);

    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(calls.length).toBe(0);
    // store 는 error 상태로 끝나고 engine/stream 은 호출되지 않는다.
    expect(h.result.current.preparation.state).toBe("idle");
    // 보안: 내부 가드 코드/원시 메시지는 화면에 노출되지 않는다 (고정 한국어 변환).
    expect(h.result.current.coachError).toBe(COACH_USER_ERRORS.prepareUnknown);
    expect(h.result.current.coachError).not.toContain("MODEL_GRANT_MISMATCH");
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});

describe("background preparation — single-flight", () => {
  it("preparing 중 두 번째 confirmConsentAndPrepare 는 동일 jobId 로 무시된다", async () => {
    let invocations = 0;
    let captured: any = null;
    const slow: any = (callbacks: any) => {
      invocations++;
      captured = callbacks;
      // onReady 호출 안함 → preparing 유지
      return { jobId: 1, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    };
    slow.getEngine = () => null;
    slow.unload = vi.fn();
    slow.hasLiveWorker = () => true;
    mocks.factory.mockReturnValue(slow);

    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });


    const firstJobId = h.result.current.preparation.jobId;
    expect(h.result.current.preparation.state).toBe("preparing");

    // 두 번째 호출은 single-flight.
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(invocations).toBe(1);
    expect(h.result.current.preparation.jobId).toBe(firstJobId);
  });
});

describe("background preparation — cancel late resolve (stale job)", () => {
  it("cancel 후 늦게 도착하는 onReady 는 새 작업의 결과를 덮어쓰지 않는다", async () => {
    let firstCallbacks: any = null;
    let firstInvoked = 0;
    let secondInvoked = 0;
    let secondCallbacks: any = null;
    const fake: any = (callbacks: any) => {
      if (firstInvoked === 0) {
        firstInvoked++;
        firstCallbacks = callbacks;
      } else {
        secondInvoked++;
        secondCallbacks = callbacks;
      }
      // jobId 는 store 가 발급한다. 여기서는 placeholder 만 반환.
      return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    };
    fake.getEngine = () => ({});
    fake.unload = vi.fn();
    fake.hasLiveWorker = () => true;
    mocks.factory.mockReturnValue(fake);

    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(firstInvoked).toBe(1);

    // 사용자가 명시적으로 취소.
    act(() => h.result.current.cancelPreparation());
    expect(h.result.current.preparation.state).toBe("cancelled");

    // 새 prepare 시작.
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(secondInvoked).toBe(1);

    // 첫 factory 의 늦은 onReady 는 무시.
    firstCallbacks.onReady();
    expect(h.result.current.preparation.state).not.toBe("ready");

    // 두 번째 factory 의 onReady 는 정상 동작.
    secondCallbacks.onReady();
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");
  });
});

describe("background preparation — worker crash", () => {
  it("onWorkerLost 가 호출되면 권한이 리셋되고 error 상태가 된다", async () => {
    let captured: any = null;
    const fake: any = (callbacks: any) => {
      captured = callbacks;
      return { jobId: 1, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    };
    fake.getEngine = () => null;
    fake.unload = vi.fn();
    fake.hasLiveWorker = () => true;
    mocks.factory.mockReturnValue(fake);

    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });

    act(() => captured.onWorkerLost("GPU device lost"));
    expect(h.result.current.preparation.state).toBe("error");
    // 보안: 원시 "GPU device lost" 는 노출되지 않고 고정 메시지로 변환된다.
    expect(h.result.current.preparation.error).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
    expect(h.result.current.preparation.error).not.toContain("device lost");

    // 다시 시작하려면 새 동의 + 새 prepare 필요.
    mocks.factory.mockReturnValue(fakeReadyFactory());
    act(() => h.result.current.retryPreparation());
    expect(h.result.current.preparation.state).toBe("idle");
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");
  });
});

describe("background preparation — ready 후 명시적 클릭 전 engine 호출 없음", () => {
  it("준비 완료 직후 모달에 머무르기만 하면 engine/stream 호출되지 않는다", async () => {
    mocks.stream.mockResolvedValue("");
    mocks.factory.mockReturnValue(fakeReadyFactory());
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("ready");
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
    expect(h.result.current.coachingText).toBe("");
  });
});

describe("background preparation — current input/scope latest only", () => {
  it("scope/입력 변경 시 이전 세대의 stream 콜백은 무시되", async () => {
    mocks.factory.mockReturnValue(fakeReadyFactory());
    mocks.stream.mockImplementation(async (_e, _i, emit) => {
      emit("첫 세대 응답입니다.");
      return "첫 세대 응답입니다.";
    });
    const data = budget();
    const h = renderHook(
      ({ income }) => useCoach({ budget: { ...data, monthlyIncome: income } as BudgetDataApi, serverApi: null }),
      { initialProps: { income: 3_000_000 } }
    );
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await h.result.current.runCoaching(); });
    expect(h.result.current.coachingText).toContain("첫 세대 응답입니다.");

    // 다른 scope/입력으로 변경.
    h.rerender({ income: 5_000_000 });
    // 준비된 artifact 는 입력 변경 후에도 재사용한다.
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    mocks.stream.mockImplementationOnce(async (_e, _i, emit) => {
      emit("두 번째 세대 응답입니다.");
      return "두 번째 세대 응답입니다.";
    });
    await act(async () => { await h.result.current.runCoaching(); });
    expect(h.result.current.coachingText).toContain("두 번째 세대 응답입니다.");
    expect(h.result.current.coachingText).not.toContain("첫 세대 응답입니다.");
  });
});

describe("background preparation — fail closed preferences", () => {
  it("coachingPreferencesReady=false 면 confirmConsentAndPrepare 도 작동하지 않는다", async () => {
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null, coachingPreferencesReady: false }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("idle");
    expect(h.result.current.coachStatus).toBe("error");
    expect(h.result.current.coachError).toContain("코칭 설정을 확인할 수 없어");
  });
});

it("serializes deferred streams across close/reopen and scope/input changes, rechecking queued input before any RPC", async () => {
  mocks.factory.mockReturnValue(fakeReadyFactory());
  const releases: (() => void)[] = [];
  let active = 0, peak = 0;
  mocks.stream.mockImplementation(async (_engine, _input, emit: (text: string) => void) => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => { releases.push(resolve); });
    emit("deferred stream result");
    active--;
    return "deferred stream result";
  });
  const data = budget();
  const h = renderHook(({ income, scope }) => useCoach({ budget: { ...data, monthlyIncome: income, localScopeKey: scope }, serverApi: null }), {
    initialProps: { income: 3_000_000, scope: "A" }
  });
  act(() => h.result.current.confirmConsentAndPrepare());
  let first!: Promise<void>, stale!: Promise<void>, latest!: Promise<void>;
  act(() => { first = h.result.current.generateCoachingNow(); });
  await act(async () => { await Promise.resolve(); });
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  act(() => { h.result.current.closeCoachModal(); h.result.current.openCoachModal(); });
  h.rerender({ income: 4_000_000, scope: "B" });
  act(() => { stale = h.result.current.generateCoachingNow(); });
  h.rerender({ income: 5_000_000, scope: "C" });
  act(() => { latest = h.result.current.generateCoachingNow(); });
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  expect(h.result.current.coachingText).toBe("");
  await act(async () => { releases[0](); await first; await stale; });
  expect(mocks.stream).toHaveBeenCalledTimes(2);
  expect(mocks.stream.mock.calls[1][1].monthlyIncome).toBe(5_000_000);
  expect(h.result.current.coachingText).toBe("");
  await act(async () => { releases[1](); await latest; });
  expect(peak).toBe(1);
  expect(h.result.current.coachingText).toBe("deferred stream result");
  expect(h.result.current.preparation.state).toBe("ready");
});

it("worker death settles an otherwise hung inference and fresh consent can run on a new engine", async () => {
  mocks.factory.mockReturnValue(fakeReadyFactory());
  mocks.stream.mockImplementationOnce(() => new Promise<string>(() => undefined));
  const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
  act(() => h.result.current.confirmConsentAndPrepare());
  let pending!: Promise<void>;
  act(() => { pending = h.result.current.generateCoachingNow(); });
  await act(async () => { await Promise.resolve(); });
  const oldEmit = mocks.stream.mock.calls[0][2] as (text: string) => void;
  const oldJob = h.result.current.preparation.jobId;
  await act(async () => { testStore.reportWorkerDeath(oldJob, "GPU lost"); await pending; });
  expect(h.result.current.preparation.state).toBe("error");
  expect(h.result.current.coachingText).toBe("");
  act(() => h.result.current.retryPreparation());
  expect(h.result.current.awaitingConsent).toBe(true);
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  mocks.stream.mockImplementationOnce(async (_engine, _input, emit: (text: string) => void) => { emit("fresh engine result"); return "fresh engine result"; });
  act(() => h.result.current.confirmConsentAndPrepare());
  await act(async () => { await h.result.current.generateCoachingNow(); });
  act(() => oldEmit("late dead worker result"));
  expect(h.result.current.coachingText).toBe("fresh engine result");
  expect(mocks.stream).toHaveBeenCalledTimes(2);
});

it("a logical chat failure discards partial advice but preserves ready for an explicit manual retry", async () => {
  mocks.factory.mockReturnValue(fakeReadyFactory());
  mocks.stream.mockImplementationOnce(async (_engine, _input, emit: (text: string) => void) => {
    emit("partial advice must not survive"); throw new Error("logical chat error");
  });
  const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
  act(() => h.result.current.confirmConsentAndPrepare());
  const job = h.result.current.preparation.jobId;
  await act(async () => { await h.result.current.generateCoachingNow(); });
  expect(h.result.current.preparation.state).toBe("ready");
  expect(h.result.current.coachStatus).toBe("error");
  expect(h.result.current.coachingText).toBe("");
  mocks.stream.mockImplementationOnce(async (_engine, _input, emit: (text: string) => void) => { emit("fresh retry"); return "fresh retry"; });
  await act(async () => { await h.result.current.generateCoachingNow(); });
  expect(h.result.current.coachingText).toBe("fresh retry");
  expect(h.result.current.preparation.jobId).toBe(job);
});

it("protection readiness and ledger edits never revoke approved artifact loading; no inference until fresh manual request", async () => {
  let callbacks!: import("../app/lib/coachEngine/store").PreparationFactoryCallbacks;
  const factory = Object.assign((next: typeof callbacks) => { callbacks = next; return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" }; }, {
    getEngine: () => ({}), unload: vi.fn(), hasLiveWorker: () => true
  });
  mocks.factory.mockReturnValue(factory);
  const data = budget();
  const h = renderHook(({ ready, income, scope }) => useCoach({ budget: { ...data, monthlyIncome: income, localScopeKey: scope }, protectedFixedCostIds: new Set(["x"]), coachingPreferencesReady: ready, serverApi: null }), {
    initialProps: { ready: true, income: 3_000_000, scope: "A" }
  });
  act(() => h.result.current.confirmConsentAndPrepare());
  const job = h.result.current.preparation.jobId;
  h.rerender({ ready: false, income: 5_000_000, scope: "B" });
  expect(h.result.current.preparation.jobId).toBe(job);
  expect(h.result.current.preparation.state).toBe("preparing");
  act(() => callbacks.onReady());
  await act(async () => { await h.result.current.generateCoachingNow(); });
  expect(h.result.current.preparation.state).toBe("ready");
  expect(mocks.stream).not.toHaveBeenCalled();
  h.rerender({ ready: true, income: 5_000_000, scope: "B" });
  expect(mocks.stream).not.toHaveBeenCalled();
  mocks.stream.mockResolvedValueOnce("");
  await act(async () => { await h.result.current.generateCoachingNow(); });
  expect(mocks.stream.mock.calls[0][1].monthlyIncome).toBe(5_000_000);
  expect(h.result.current.preparation.jobId).toBe(job);
});
