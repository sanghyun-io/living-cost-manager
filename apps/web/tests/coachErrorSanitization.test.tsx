// @vitest-environment jsdom
// 보안 리뷰 후속: 원시 SDK 오류 → 사용자 고정 한국어 메시지 매핑 검증.
//
// 검증 목표:
// 1. 진단성 원시 오류(모델 URL·서명 쿼리·<script>·스택·초장문)가 UI/store에
//    그대로 흐르지 않고 반드시 유한 집합의 고정 한국어로 변환된다.
// 2. phase 구분: prepare 실패는 준비 안내, inference 실패는 코칭 안내.
// 3. 준비 오류 후 flow 불변: 취소/사망/실패 시 권한 리셋 → 새 동의 필요 (refreshed
//    consent), inference 실패는 READY·jobId(다운로드 결과물)를 보존하고 재동의·
//    재다운로드를 요구하지 않는다.
// 4. 워커 치명(error/messageerror/coachWorkerFatal)은 여전히 grant를 클리어한다.
// 5. cancel 문구는 원시 오류 없이 상태 기반 안내를 쓴다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { ComponentProps, PropsWithChildren } from "react";
import { MantineProvider } from "@mantine/core";
import type { BudgetDataApi } from "../app/lib/useBudgetData";
import { useCoach } from "../app/lib/useCoach";
import {
  COACH_USER_ERRORS,
  classifyCoachError,
  sanitizeCoachError
} from "../app/lib/coachEngine/coachErrors";
import { createPreparationStore } from "../app/lib/coachEngine/store";
import { CoachModal } from "../app/components/modals/CoachModal";

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

vi.mock("../app/components/modals/ModalShell", () => ({
  ModalShell: ({ children }: PropsWithChildren) => <div role="dialog">{children}</div>
}));

// 진단성 원시 오류 합성: 모델 URL + 서명 쿼리 + HTML + 스택텍스트 + 초장문.
// 어떤 조각도 사용자 화면에 흘러나와서는 안 된다. 런타임 스택에 의존하면
// (테스트 러너 프레임에 "Timeout" 같은 분류어가 섞임) 환경 따라 흔들리므로
// 분류어 통제를 거친 합성 스택 텍스트를 쓴다.
const SYNTHETIC_STACK = [
  "Error: diagnostic",
  "    at Object.<anonymous> (/Users/dev/secrets/artifact-prep.js:12:34)",
  "    at prepareSegment (/Users/dev/secrets/artifact-prep.js:88:9)"
].join("\n");
const LEAK_MARKERS = ["example.invalid", "SECURE_TOKEN_123", "<script>", "signing-secret", "at Object.<anonymous>", "at useCoach"] as const;
function hostileRaw(): string {
  const body = "QWEN_SYSTEM_PROMPT_FRAGMENT ".repeat(400);
  return [
    "Uncaught RuntimeError: failed while preparing artifact",
    "https://example.invalid/model?signature=SECURE_TOKEN_123&key=***",
    "<script>alert('signing-secret')</script>",
    SYNTHETIC_STACK,
    body,
    "at useCoach (/Users/dev/secrets/useCoach.ts:384:12)"
  ].join("\n");
}

// 이 문자열은 어떤 카테고리 패턴에도 걸리면 안 되므로 unknown 폴백으로 고정된다.
function assertNoLeak(text: string | null): void {
  expect(text).not.toBeNull();
  for (const marker of LEAK_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

const SAFE_SET: ReadonlySet<string> = new Set(Object.values(COACH_USER_ERRORS));

let testStore = createPreparationStore();

beforeEach(() => {
  testStore = createPreparationStore();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  testStore.cancelPreparation();
});

function budget() {
  return {
    localScopeKey: "synthetic-sanitize/ws",
    profileName: "Synthetic",
    monthlyIncome: 3000000,
    summary: { monthlyExpense: 600000 },
    fixedCosts: [
      { id: "x", name: "Netflix", categoryId: "subscription", amount: 17000, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null, renewalStatus: "unreviewed" }
    ]
  } as unknown as BudgetDataApi;
}

describe("coachErrors helper — 고정 한국어 분류", () => {
  it("분류 결과는 항상 유한 enum 이고, 메시지는 항상 고정 집합에 속한다", () => {
    const samples = [hostileRaw(), "", "??? ", "GPU device lost", "Failed to fetch", "Out of memory", "ENGINE_NOT_READY", "<script>x</script>"];
    for (const s of samples) {
      for (const phase of ["prepare", "inference"] as const) {
        const message = sanitizeCoachError(s, phase);
        expect(SAFE_SET.has(message)).toBe(true);
      }
    }
  });

  it("진단성 원시 오류(URL·스크립트·스택·초장문)는 unknown → 고정 폴백, 원조각 비노출", () => {
    const hostile = hostileRaw();
    expect(classifyCoachError(hostile)).toBe("unknown");
    const prepare = sanitizeCoachError(hostile, "prepare");
    const inference = sanitizeCoachError(hostile, "inference");
    expect(prepare).toBe(COACH_USER_ERRORS.prepareUnknown);
    expect(inference).toBe(COACH_USER_ERRORS.coachingFailed);
    assertNoLeak(prepare);
    assertNoLeak(inference);
    // Error 객체 입력도 동일하게 처리된다.
    expect(sanitizeCoachError(new Error(hostile), "prepare")).toBe(COACH_USER_ERRORS.prepareUnknown);
  });

  it("카테고리 매핑: GPU/adapter 미지원 → 기기 안내", () => {
    for (const raw of [
      "WebGPU is not available",
      "WebGPU is not supported on this browser",
      "Error: No WebGPU adapter found",
      "RequestAdapter returned null"
    ]) {
      expect(classifyCoachError(raw)).toBe("gpu-unsupported");
      expect(sanitizeCoachError(raw, "prepare")).toBe(COACH_USER_ERRORS.gpuUnsupported);
    }
  });

  it("카테고리 매핑: 메모리 부족/device-lost → 안전 메모리·연결 안내", () => {
    for (const raw of [
      "GPU: Device lost",
      "WebGPU context lost",
      "GPU 연결이 끊겼습니다. 다시 동의하고 준비해 주세요.",
      "워커 오류"
    ]) {
      expect(classifyCoachError(raw)).toBe("device-lost");
    }
    for (const raw of [
      "RuntimeError: CUDA out of memory",
      "Error: Out of memory while loading",
      "insufficient memory on adapter"
    ]) {
      expect(classifyCoachError(raw)).toBe("out-of-memory");
    }
    // device-lost 와 out-of-memory 는 같은 안전 메시지로 수렴한다.
    expect(sanitizeCoachError("GPU: Device lost", "prepare")).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
    expect(sanitizeCoachError("insufficient memory on adapter", "inference")).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
    expect(sanitizeCoachError("워커 메시지 오류", "prepare")).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
  });

  it("카테고리 매핑: 네트워크/다운로드 → 준비 안내(prepare) / 코칭 안내(inference)", () => {
    for (const raw of [
      "TypeError: Failed to fetch https://example.invalid/model?signature=***",
      "network error during download",
      "Error: timed out while loading shard"
    ]) {
      expect(classifyCoachError(raw)).toBe("network");
    }
    expect(sanitizeCoachError("Failed to fetch shard", "prepare")).toBe(COACH_USER_ERRORS.prepareNetwork);
    expect(sanitizeCoachError("Failed to fetch shard", "inference")).toBe(COACH_USER_ERRORS.coachingFailed);
    // 준비 네트워크 실패 메시지에도 서명 쿼리가 남지 않는다.
    assertNoLeak(sanitizeCoachError(hostileRaw() + " failed to fetch", "prepare"));
  });

  it("내부 가드 코드는 유한 정확 일치로 분류되고 코드 자체가 화면에 남지 않는다", () => {
    expect(classifyCoachError("EXPLICIT_CONSENT_REQUIRED")).toBe("consent-required");
    expect(sanitizeCoachError("EXPLICIT_CONSENT_REQUIRED", "prepare")).toBe(COACH_USER_ERRORS.consentRequired);
    expect(classifyCoachError("WEBGPU_UNAVAILABLE")).toBe("gpu-unsupported");
    expect(classifyCoachError("ENGINE_NOT_READY")).toBe("chat");
    expect(sanitizeCoachError(new Error("ENGINE_NOT_READY"), "inference")).toBe(COACH_USER_ERRORS.coachingFailed);
    expect(classifyCoachError("MODEL_GRANT_MISMATCH")).toBe("unknown");
  });

  it("논리적 chat 실패(unknown/inference)는 코칭 실패 안내로 수렴", () => {
    expect(sanitizeCoachError("Uncaught Error: logits NaN detected", "inference")).toBe(COACH_USER_ERRORS.coachingFailed);
    expect(sanitizeCoachError("", "inference")).toBe(COACH_USER_ERRORS.coachingFailed);
  });
});

describe("store 경계 — 스냅샷 error 는 항상 고정 메시지", () => {
  function captureCallbacks() {
    let captured: import("../app/lib/coachEngine/store").PreparationFactoryCallbacks;
    const factory = Object.assign((cb: typeof captured) => {
      captured = cb;
      return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    }, {});
    const { jobId } = testStore.beginPreparation({ modelId: "Qwen3.5-0.8B-q4f16_1-MLC", explicitDownloadConsent: true, factory: factory as never });
    return { captured: captured!, jobId };
  }

  it("factory 콜백 onError(onError via start throw) 원시 오류를 분류만 하고 보관하지 않는다", () => {
    const { captured, jobId } = captureCallbacks();
    captured.onError(hostileRaw());
    expect(testStore.getSnapshot().state).toBe("error");
    expect(testStore.getSnapshot().error).toBe(COACH_USER_ERRORS.prepareUnknown);
    assertNoLeak(testStore.getSnapshot().error);
    expect(jobId).toBeGreaterThan(0);
  });

  it("resolveError / reportWorkerDeath / onWorkerLost 입력도 고정 집합으로 정규화", () => {
    const a = captureCallbacks();
    testStore.resolveError(a.jobId, "Qwen3.5-0.8B-q4f16_1-MLC", hostileRaw());
    expect(testStore.getSnapshot().error).toBe(COACH_USER_ERRORS.prepareUnknown);
    assertNoLeak(testStore.getSnapshot().error);

    const b = captureCallbacks();
    testStore.reportWorkerDeath(b.jobId, "Failed to fetch https://example.invalid/model?signature=***");
    expect(testStore.getSnapshot().state).toBe("error");
    expect(testStore.getSnapshot().error).toBe(COACH_USER_ERRORS.prepareNetwork); // 원시 텍스트 분류: fetch 실패
    assertNoLeak(testStore.getSnapshot().error);

    const c = captureCallbacks();
    testStore.reportWorkerDeath(c.jobId, "worker context lost");
    expect(testStore.getSnapshot().error).toBe(COACH_USER_ERRORS.memoryOrDisconnected);

    const d = captureCallbacks();
    testStore.reportWorkerDeath(d.jobId, "워커 연결이 끊겼습니다");
    expect(testStore.getSnapshot().error).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
  });

  it("취소는 원시 오류 없이 진행되고 cancel 후 늦은 onError 는 상태 자체를 바꾸지 않는다", () => {
    const { captured } = captureCallbacks();
    testStore.cancelPreparation();
    expect(testStore.getSnapshot().state).toBe("cancelled");
    expect(testStore.getSnapshot().error).toBeNull();
    captured.onError(hostileRaw());
    expect(testStore.getSnapshot().state).toBe("cancelled");
  });
});

describe("useCoach 흐름 — 고정 메시지 변환 + 흐름 불변", () => {
  function captureHookFactory() {
    let captured: import("../app/lib/coachEngine/store").PreparationFactoryCallbacks | null = null;
    const factory = Object.assign((cb: import("../app/lib/coachEngine/store").PreparationFactoryCallbacks) => {
      captured = cb;
      return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    }, {
      getEngine: () => ({}),
      unload: vi.fn().mockResolvedValue(undefined),
      hasLiveWorker: () => true,
      whenSettled: () => Promise.resolve()
    });
    mocks.factory.mockReturnValue(factory);
    return { get captured() { return captured!; } };
  }

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

  it("준비 실패(원시 진단 오류): coachError 는 고정 한국어, 재시작은 새 동의 필요", async () => {
    const holder = captureHookFactory();
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    act(() => holder.captured.onError(hostileRaw()));
    expect(h.result.current.coachStatus).toBe("error");
    expect(h.result.current.coachError).toBe(COACH_USER_ERRORS.prepareUnknown);
    assertNoLeak(h.result.current.coachError);
    expect(h.result.current.preparation.error).toBe(COACH_USER_ERRORS.prepareUnknown);
    act(() => h.result.current.closeCoachModal());
    expect(h.result.current.headerIndicator).toBe("error");

    // refreshed consent flow: 재시도하면 다시 새 동의 화면이 떠야 한다.
    act(() => h.result.current.retryPreparation());
    expect(h.result.current.preparation.state).toBe("idle");
    expect(h.result.current.headerIndicator).toBe("none");
    expect(h.result.current.awaitingConsent).toBe(true);
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    expect(h.result.current.preparation.state).toBe("preparing");
  });

  it("추론 실패(READY 유지): 고정 코칭 실패 안내, 다운로드 결과물·jobId·동의 보존(재다운로드 없음)", async () => {
    mocks.factory.mockReturnValue(fakeReadyFactory());
    mocks.stream.mockRejectedValueOnce(new Error(hostileRaw()));
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const job = h.result.current.preparation.jobId;
    expect(h.result.current.preparation.state).toBe("ready");

    await act(async () => { await h.result.current.generateCoachingNow(); });
    expect(h.result.current.coachStatus).toBe("error");
    expect(h.result.current.coachError).toBe(COACH_USER_ERRORS.coachingFailed);
    assertNoLeak(h.result.current.coachError);
    expect(h.result.current.coachingText).toBe("");
    // ready + 같은 jobId: 모델 유지, 새 권한/재다운로드 없음, 재동의 요구도 없다.
    expect(h.result.current.preparation.state).toBe("ready");
    expect(h.result.current.preparation.jobId).toBe(job);
    expect(h.result.current.awaitingConsent).toBe(false);

    // 명시 재클릭으로 같은 워커에서 재추론 가능.
    mocks.stream.mockImplementationOnce(async (_engine: unknown, _input: unknown, emit: (text: string) => void) => {
      emit("재시도 코칭 결과");
      return "재시도 코칭 결과";
    });
    await act(async () => { await h.result.current.generateCoachingNow(); });
    expect(h.result.current.coachingText).toBe("재시도 코칭 결과");
  });

  it("추론 중 워커 치명(원시 진단 오류 포함): grant 리셋 → error 상태, 고정 메모리/연결 안내", async () => {
    const holder = captureHookFactory();
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    act(() => holder.captured.onReady());
    expect(h.result.current.preparation.state).toBe("ready");

    act(() => holder.captured.onWorkerLost("GPU: Device lost\n" + hostileRaw()));
    expect(h.result.current.preparation.state).toBe("error");
    expect(h.result.current.preparation.error).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
    assertNoLeak(h.result.current.preparation.error);
    // worker fatal 은 grant를 클리어: 새 동의 없이는 재준비 불가.
    act(() => h.result.current.retryPreparation());
    expect(h.result.current.awaitingConsent).toBe(true);
  });

  it("준비 취소: 원시 오류 없이 상태 기반 안내(error null), 문구는 고정 한국어", async () => {
    const holder = captureHookFactory();
    const h = renderHook(() => useCoach({ budget: budget(), serverApi: null }));
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });
    act(() => h.result.current.cancelPreparation());
    expect(h.result.current.preparation.state).toBe("cancelled");
    expect(h.result.current.preparation.error).toBeNull();
    expect(h.result.current.coachError).toBe("");
    expect(h.result.current.coachStatus).toBe("idle");
    void holder;
  });
});

describe("CoachModal 렌더 — 변환된 메시지 외 원시 조각 비노출", () => {
  function modalProps(overrides: Partial<ComponentProps<typeof CoachModal>> = {}): ComponentProps<typeof CoachModal> {
    return {
      opened: true, webGpuAvailable: true, preferencesReady: true, hasData: true,
      approxMb: 453, vramMb: 1629.49, modelName: "Qwen3.5-0.8B-q4f16_1-MLC", status: "error",
      loadProgress: 0, loadText: "", coaching: "", errorMessage: "", fallbackHeadline: "",
      awaitingConsent: false, preparationState: "idle", onStart: vi.fn(), onRegenerate: vi.fn(),
      onClose: vi.fn(), onConfirmConsent: vi.fn(), onContinueWithoutPreparation: vi.fn(),
      onGenerateCoaching: vi.fn(), onCancelPreparation: vi.fn(), onRetryPreparation: vi.fn(),
      ...overrides
    };
  }

  it("inference 원시 진단 오류를 sanitize 해 넘기면 고정 문구만 렌더된다", () => {
    const hostile = hostileRaw();
    const { container } = render(
      <MantineProvider>
        <CoachModal {...modalProps({ errorMessage: sanitizeCoachError(hostile, "inference") })} />
      </MantineProvider>
    );
    expect(screen.getByText(COACH_USER_ERRORS.coachingFailed)).toBeTruthy();
    for (const marker of LEAK_MARKERS) {
      expect(container.textContent).not.toContain(marker);
    }
  });

  it("cancelled 상태는 오류 문구 없이 다시 시도 안내만 보인다", () => {
    const { container } = render(
      <MantineProvider>
        <CoachModal {...modalProps({ status: "idle", preparationState: "cancelled", errorMessage: "" })} />
      </MantineProvider>
    );
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(container.textContent).not.toContain(COACH_USER_ERRORS.coachingFailed);
    expect(container.textContent).not.toContain(COACH_USER_ERRORS.prepareUnknown);
  });
});
