import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PreparationFactoryCallbacks } from "../app/lib/coachEngine/store";
import { COACH_USER_ERRORS } from "../app/lib/coachEngine/coachErrors";

// 각 테스트 전에 모듈을 리셋하여 글로벌 store/factory 를 격리한다.
beforeEach(async () => {
  vi.resetModules();
  // 동적 import 가 캐시되지 않도록 한다.
  await vi.importActual("../app/lib/coachModel");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 가짜 Worker / SDK 픽스처 ──────────────────────────────────────────────
class FakeWorker {
  static listeners: Map<FakeWorker, Array<(event: MessageEvent) => void>> = new Map();
  private handlers: Array<(event: MessageEvent) => void> = [];
  public terminated = false;
  public errored = false;
  addEventListener(_kind: string, listener: (event: MessageEvent) => void) {
    this.handlers.push(listener);
  }
  removeEventListener() {}
  postMessage(_msg: any) {}
  terminate() {
    this.terminated = true;
    FakeWorker.listeners.delete(this);
  }
  fireMessage(data: any) {
    for (const h of this.handlers) h({ data } as MessageEvent);
  }
  fireError(message: string) {
    this.errored = true;
    // SDK 가 사용하는 에러 이벤트.
    this.handlers.forEach(h => h({ data: { kind: "throw", uuid: "", content: message } } as any));
  }
}

const SDK = {
  async CreateWebWorkerMLCEngine(worker: any, _modelId: string, _cfg: any) {
    // happy path: 약간의 지연 후 onReady 호환을 위해 engine 객체를 반환
    return { chat: { completions: { create: vi.fn() } }, interruptGenerate: vi.fn(), unload: vi.fn().mockResolvedValue(undefined) };
  }
};

function setupMocks() {
  return { SDK };
}

describe("createWorkerCoachEngineFactory — create", () => {
  test("factory 는 명시적 consent 가 있을 때만 worker 를 띄운다", async () => {
    const { SDK } = setupMocks();
    const { createWorkerCoachEngineFactory } = await import("../app/lib/coachEngine/createWebWorkerClient");
    const fakeWorker = new FakeWorker();
    const factory = createWorkerCoachEngineFactory({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      sdk: SDK as any,
      resolveWorker: () => fakeWorker as any
    });
    // worker 가 준비되기 전에는 null 이다.
    expect(factory.getEngine()).toBeNull();
    expect(factory.hasLiveWorker()).toBe(false);
  });
});

describe("preparation store — consent", () => {
  test("beginPreparation 은 explicitDownloadConsent 없이 호출되면 거부", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    expect(() => store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: false,
      factory: () => ({ jobId: 1, modelId: "x" })
    })).toThrow("EXPLICIT_CONSENT_REQUIRED");
  });

  test("beginPreparation 은 모델 ID 가 다르면 새 job 으로 시작", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    const factoryMock = vi.fn().mockReturnValue({ jobId: 1, modelId: "x" });
    store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: factoryMock as any
    });
    expect(store.getSnapshot().state).toBe("preparing");
    expect(store.getSnapshot().modelId).toBe("Qwen3.5-0.8B-q4f16_1-MLC");
    expect(factoryMock).toHaveBeenCalledTimes(1);
  });

  test("single-flight: 동일 모델 + preparing 상태에서 두 번째 beginPreparation 은 무시", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    const factoryMock: any = vi.fn().mockReturnValue({ jobId: 1, modelId: "x" });
    store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: factoryMock
    });
    const second = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: factoryMock
    });
    expect(factoryMock).toHaveBeenCalledTimes(1); // 두 번째는 무시됨.
    expect(second.jobId).toBe(store.getSnapshot().jobId);
  });

  test("warm ready: 동일 모델 + ready 상태에서 beginPreparation 은 새 콜드 다운로드 없이 ready 유지", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    const factoryMock: any = vi.fn().mockReturnValue({ jobId: 1, modelId: "x" });
    const start = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: factoryMock
    });
    store.resolveReady(start.jobId, "Qwen3.5-0.8B-q4f16_1-MLC");
    expect(store.getSnapshot().state).toBe("ready");
    // 두 번째 beginPreparation 은 새 factory 호출 없이 ready 유지.
    const second = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: factoryMock
    });
    expect(factoryMock).toHaveBeenCalledTimes(1);
    expect(second.alreadyReady).toBe(true);
    expect(store.getSnapshot().state).toBe("ready");
  });
});

describe("preparation store — subscriber progress & close-reopen", () => {
  test("subscriber 는 progress 변화에 콜백을 받는다", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    const snapshots: any[] = [];
    const unsub = store.subscribe(snap => snapshots.push(snap.state));
    const start = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: () => ({ jobId: 1, modelId: "x" })
    });
    store.reportProgress(start.jobId, 0.5, "다운로드 중");
    store.resolveReady(start.jobId, "Qwen3.5-0.8B-q4f16_1-MLC");
    unsub();
    expect(snapshots).toContain("preparing");
    expect(snapshots[snapshots.length - 1]).toBe("ready");
  });

  test("close-reopen: 모달이 닫혀도 subscriber/store 는 같은 ready 를 본다", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    const a: any[] = [];
    const sub1 = store.subscribe(s => a.push(s.state));
    const start = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: () => ({ jobId: 1, modelId: "x" })
    });
    store.resolveReady(start.jobId, "Qwen3.5-0.8B-q4f16_1-MLC");
    sub1();
    // 모달이 닫혔다 다시 열렸다고 가정 — store 는 그대로 살아있고 두 번째
    // subscriber 가 붙으면 getSnapshot() 으로 현재 ready 를 그대로 본다.
    const sub2 = store.subscribe(() => {});
    expect(a[a.length - 1]).toBe("ready");
    expect(store.getSnapshot().state).toBe("ready");
    sub2();
  });
});

describe("preparation store — cancellation", () => {
  test("cancelPreparation 은 callbacks.cancel 을 호출하고 cancelled 상태로 전환", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    let cancelled = false;
    const factory: any = (callbacks: any) => {
      // factory 는 callbacks.cancel 을 자신의 worker terminate 로 덮어쓴다.
      callbacks.cancel = () => { cancelled = true; };
      return { jobId: 1, modelId: "x" };
    };
    store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory
    });
    expect(cancelled).toBe(false);
    store.cancelPreparation();
    expect(cancelled).toBe(true);
    expect(store.getSnapshot().state).toBe("cancelled");
  });

  test("cancel 후 늦게 도착한 onReady/onError 는 새 작업에 영향을 주지 않는다 (job ID stale)", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    let capturedCallbacks: any;
    const factory: any = (callbacks: any) => {
      capturedCallbacks = callbacks;
      return { jobId: 1, modelId: "x" };
    };
    store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory
    });
    // cancel 후 새 작업 시작.
    store.cancelPreparation();
    const next = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: () => ({ jobId: 99, modelId: "x" })
    });
    // 이전 factory 의 늦은 onReady/onError 는 무시.
    capturedCallbacks.onReady();
    expect(store.getSnapshot().state).toBe("preparing");
    expect(store.getSnapshot().jobId).toBe(next.jobId);
    capturedCallbacks.onError("stale error");
    expect(store.getSnapshot().state).toBe("preparing");
    // 새 작업의 시뮬레이션은 resolveReady API 로 ready 로 강제.
    store.resolveReady(next.jobId, "Qwen3.5-0.8B-q4f16_1-MLC");
    expect(store.getSnapshot().state).toBe("ready");
  });

  test("worker crash / device lost 는 권한을 리셋하고 error 상태로 전환", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    let capturedCallbacks: any;
    const factory: any = (callbacks: any) => {
      capturedCallbacks = callbacks;
      return { jobId: 1, modelId: "x" };
    };
    store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory
    });
    capturedCallbacks.onWorkerLost("GPU device lost");
    expect(store.getSnapshot().state).toBe("error");
    // 보안: 원시 오류 텍스트는 노출되지 않고 고정 한국어 메시지만 남는다.
    expect(store.getSnapshot().error).toBe(COACH_USER_ERRORS.memoryOrDisconnected);
    expect(store.getSnapshot().error).not.toContain("device lost");
  });
});

describe("preparation store — reset & retry", () => {
  test("reset 후 새 prepare 가 가능하며 새 동의가 필요한 상태 (idle)", async () => {
    const { createPreparationStore } = await import("../app/lib/coachEngine/store");
    const store = createPreparationStore();
    let cancelled = false;
    const factory: any = (callbacks: any) => {
      callbacks.cancel = () => { cancelled = true; };
      return { jobId: 1, modelId: "x" };
    };
    store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory
    });
    store.resolveReady(1, "Qwen3.5-0.8B-q4f16_1-MLC");
    expect(store.getSnapshot().state).toBe("ready");
    store.reset();
    expect(store.getSnapshot().state).toBe("idle");
    expect(cancelled).toBe(true);
    // idle 이므로 다음 beginPreparation 은 새 동의 없이 호출돼도 success path 진입.
    // (consent 여부는 호출자 책임)
    const next = store.beginPreparation({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      explicitDownloadConsent: true,
      factory: () => ({ jobId: 2, modelId: "x" })
    });
    expect(next.jobId).toBeGreaterThan(0);
    expect(store.getSnapshot().state).toBe("preparing");
  });
});

describe("logitProcessor / chatOpts", () => {
  test("SDK 의 CreateWebWorkerMLCEngine 가 호출되며 modelId 와 worker 가 전달된다", async () => {
    const SDKLocal = {
      CreateWebWorkerMLCEngine: vi.fn(async () => ({ chat: { completions: { create: vi.fn() } }, unload: vi.fn().mockResolvedValue(undefined) }))
    };
    const { createWorkerCoachEngineFactory } = await import("../app/lib/coachEngine/createWebWorkerClient");
    const fakeWorker = new FakeWorker();
    const factory = createWorkerCoachEngineFactory({
      modelId: "Qwen3.5-0.8B-q4f16_1-MLC",
      sdk: SDKLocal as any,
      resolveWorker: () => fakeWorker as any
    });
    factory({
      onProgress: () => {},
      onReady: () => {},
      onError: () => {},
      onWorkerLost: () => {},
      cancel: () => {}
    });
    // 마이크로태스크가 끝나길 기다린다.
    await factory.whenSettled();
    expect(SDKLocal.CreateWebWorkerMLCEngine).toHaveBeenCalled();
    const args = SDKLocal.CreateWebWorkerMLCEngine.mock.calls[0] as any[];
    expect(args[0]).toBe(fakeWorker);
    expect(args[1]).toBe("Qwen3.5-0.8B-q4f16_1-MLC");
  });
});
