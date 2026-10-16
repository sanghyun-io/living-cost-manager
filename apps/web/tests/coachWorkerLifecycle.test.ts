import { afterEach, describe, expect, it, vi } from "vitest";
import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import { createWorkerCoachEngineFactory, type WebLLMSDKModule } from "../app/lib/coachEngine/createWebWorkerClient";
import { createPreparationStore } from "../app/lib/coachEngine/store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class TestWorker extends EventTarget {
  terminated = false;
  terminate() { this.terminated = true; }
  native(): Worker { return this as unknown as Worker; }
}
function engine(unload: () => Promise<void> = vi.fn().mockResolvedValue(undefined)) {
  return { unload, interruptGenerate: vi.fn() } as unknown as MLCEngineInterface;
}
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); });

describe("real controller lifecycle with deferred SDK reload", () => {
  it("validates explicit model-specific permission before the worker factory", () => {
    const resolveWorker = vi.fn(() => new TestWorker().native());
    const factory = createWorkerCoachEngineFactory({ modelId: "A", resolveWorker });
    const store = createPreparationStore();
    expect(() => store.beginPreparation({ modelId: "A", explicitDownloadConsent: false, factory })).toThrow("EXPLICIT_CONSENT_REQUIRED");
    expect(() => store.beginPreparation({ modelId: "B", explicitDownloadConsent: true, factory })).toThrow("MODEL_GRANT_MISMATCH");
    expect(resolveWorker).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("cancel settles even if SDK never settles; old %s cannot clear a new ready worker", async outcome => {
    const old = deferred<MLCEngineInterface>();
    const first = new TestWorker(), second = new TestWorker();
    const sdk: WebLLMSDKModule = { CreateWebWorkerMLCEngine: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(engine()) };
    const resolveWorker = vi.fn().mockReturnValueOnce(first.native()).mockReturnValueOnce(second.native());
    const factory = createWorkerCoachEngineFactory({ modelId: "A", sdk, resolveWorker });
    const store = createPreparationStore();
    store.beginPreparation({ modelId: "A", explicitDownloadConsent: true, factory });
    await tick();
    const pending = factory.whenSettled();
    store.cancelPreparation();
    await pending;
    expect(first.terminated).toBe(true);
    store.beginPreparation({ modelId: "A", explicitDownloadConsent: true, factory });
    await tick(); await factory.whenSettled();
    expect(store.getSnapshot().state).toBe("ready");
    if (outcome === "resolve") old.resolve(engine());
    else old.reject(new Error("old reload failure"));
    first.dispatchEvent(new Event("error"));
    await tick();
    expect(store.getSnapshot().state).toBe("ready");
    expect(factory.getEngine()).not.toBeNull();
    expect(second.terminated).toBe(false);
    await factory.unload();
  });

  it.each(["error", "messageerror", "coachWorkerFatal"])("chat protocol errors preserve ready; %s disposes and demands a fresh grant", async failure => {
    const worker = new TestWorker();
    const factory = createWorkerCoachEngineFactory({ modelId: "A", sdk: { CreateWebWorkerMLCEngine: async () => engine() }, resolveWorker: () => worker.native() });
    const store = createPreparationStore();
    store.beginPreparation({ modelId: "A", explicitDownloadConsent: true, factory });
    await factory.whenSettled();
    worker.dispatchEvent(new MessageEvent("message", { data: { kind: "throw", content: "logical chat failure" } }));
    expect(store.getSnapshot().state).toBe("ready");
    expect(factory.getEngine()).not.toBeNull();
    worker.dispatchEvent(failure === "coachWorkerFatal" ? new MessageEvent("message", { data: { kind: failure } }) : new Event(failure));
    await tick();
    expect(store.getSnapshot().state).toBe("error");
    expect(worker.terminated).toBe(true);
    expect(() => store.beginPreparation({ modelId: "A", explicitDownloadConsent: false, factory })).toThrow();
  });

  it("ready unload is bounded to 5s, and a new worker waits for disposal (peak live workers one)", async () => {
    vi.useFakeTimers();
    const workers: TestWorker[] = [];
    let peak = 0;
    const factory = createWorkerCoachEngineFactory({
      modelId: "A", sdk: { CreateWebWorkerMLCEngine: async () => engine(() => new Promise<void>(() => undefined)) },
      resolveWorker: () => {
        const worker = new TestWorker(); workers.push(worker);
        peak = Math.max(peak, workers.filter(w => !w.terminated).length);
        return worker.native();
      }
    });
    const store = createPreparationStore();
    store.beginPreparation({ modelId: "A", explicitDownloadConsent: true, factory });
    await factory.whenSettled();
    store.cancelPreparation();
    store.beginPreparation({ modelId: "A", explicitDownloadConsent: true, factory });
    await tick();
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await tick(); await factory.whenSettled();
    expect(workers).toHaveLength(2);
    expect(peak).toBe(1);
    const cleanup = factory.unload();
    await vi.advanceTimersByTimeAsync(5000); await cleanup;
    expect(workers.every(w => w.terminated)).toBe(true);
  });

  it("terminal snapshots cannot be regressed by throttled progress or late ready/error", async () => {
    vi.useFakeTimers();
    const store = createPreparationStore();
    const { jobId } = store.beginPreparation({ modelId: "A", explicitDownloadConsent: true, factory: () => ({ jobId: 0, modelId: "A" }) });
    store.reportProgress(jobId, 0.2, "old progress");
    store.resolveReady(jobId, "A");
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getSnapshot().progress).toBe(1);
    store.resolveError(jobId, "A", "late initialization error");
    store.reportProgress(jobId, 0.5, "late progress");
    expect(store.getSnapshot().state).toBe("ready");
    store.reportWorkerDeath(jobId, "fatal");
    store.resolveReady(jobId, "A");
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getSnapshot().state).toBe("error");
  });
});
