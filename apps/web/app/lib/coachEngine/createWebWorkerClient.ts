import type { ChatOptions, InitProgressCallback, MLCEngineConfig, MLCEngineInterface } from "@mlc-ai/web-llm";
import type { PreparationFactory } from "./store";
import { COACH_WORKER_URL } from "./workerManifest.generated";

export interface WebLLMSDKModule {
  CreateWebWorkerMLCEngine(worker: Worker, modelId: string | string[], engineConfig?: MLCEngineConfig, chatOpts?: ChatOptions | ChatOptions[]): Promise<MLCEngineInterface>;
}
export interface WorkerCoachEngineFactoryOptions {
  modelId: string;
  chatOpts?: ChatOptions;
  initProgressCallback?: InitProgressCallback;
  enableThinking?: boolean;
  sdk?: WebLLMSDKModule | null;
  resolveWorker?: () => Worker;
}
export interface WorkerCoachEngineFactory extends PreparationFactory {
  getEngine(): MLCEngineInterface | null;
  unload(): Promise<void>;
  hasLiveWorker(): boolean;
  whenSettled(): Promise<void>;
}
export type CallablePreparationFactory = WorkerCoachEngineFactory;
export function defaultResolveWorker(): Worker {
  return new Worker(COACH_WORKER_URL, { type: "classic" });
}

// Each invocation owns its cancellation race, listeners, engine and worker. SDK
// reload promises do NOT reject on terminate; never await one without this race.
export function createWorkerCoachEngineFactory(options: WorkerCoachEngineFactoryOptions): WorkerCoachEngineFactory {
  type Invocation = { worker: Worker | null; engine: MLCEngineInterface | null; stop: () => Promise<void> };
  let current: Invocation | null = null;
  let settled = Promise.resolve();
  let disposal = Promise.resolve();
  const factory: PreparationFactory = callbacks => {
    if (current) disposal = current.stop();
    let stopped = false;
    let abort!: () => void;
    const aborted = new Promise<null>(resolve => { abort = () => resolve(null); });
    let cleanup: Promise<void> | null = null;
    const invocation: Invocation = {
      worker: null, engine: null,
      stop() {
        if (cleanup) return cleanup;
        stopped = true;
        abort();
        const worker = invocation.worker;
        const engine = invocation.engine;
        invocation.engine = null;
        if (current === invocation) current = null;
        cleanup = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (engine) await Promise.race([
              Promise.resolve().then(() => engine.unload()).catch(() => undefined),
              new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            if (worker) {
              worker.removeEventListener("error", onError);
              worker.removeEventListener("messageerror", onMessageError);
              worker.removeEventListener("message", onMessage);
              worker.terminate();
            }
            invocation.worker = null;
          }
        })();
        disposal = cleanup;
        return cleanup;
      }
    };
    const fatal = (message: string) => {
      if (stopped) return;
      void invocation.stop();
      callbacks.onWorkerLost(message);
    };
    const onError = (event: ErrorEvent) => fatal(event.message || "워커 오류");
    const onMessageError = () => fatal("워커 메시지 오류");
    const onMessage = (event: MessageEvent) => {
      if (event.data?.kind === "coachWorkerFatal") fatal("GPU 연결이 끊겼습니다. 다시 동의하고 준비해 주세요.");
    };
    callbacks.cancel = invocation.stop;
    callbacks.unload = invocation.stop;
    const previousDisposal = disposal;
    current = invocation;
    settled = (async () => {
      try {
        await previousDisposal;
        if (stopped) return;
        invocation.worker = (options.resolveWorker ?? defaultResolveWorker)();
        invocation.worker.addEventListener("error", onError);
        invocation.worker.addEventListener("messageerror", onMessageError);
        invocation.worker.addEventListener("message", onMessage);
        const sdk = await Promise.race([options.sdk ? Promise.resolve(options.sdk) : import("@mlc-ai/web-llm"), aborted]);
        if (!sdk || stopped) return;
        const created = await Promise.race([
          sdk.CreateWebWorkerMLCEngine(invocation.worker, options.modelId, {
            initProgressCallback: report => {
              if (stopped) return;
              callbacks.onProgress(report.progress, report.text);
              options.initProgressCallback?.(report);
            }
          }, options.chatOpts),
          aborted
        ]);
        if (!created || stopped) return;
        invocation.engine = created;
        callbacks.onReady();
      } catch (error) {
        if (stopped) return;
        // Only the actual reload promise classifies initialization errors.
        // A later SDK `kind: throw` chat response must not discard a ready model.
        void invocation.stop();
        callbacks.onError(error instanceof Error ? error.message : String(error));
      }
    })();
    return { jobId: 0, modelId: options.modelId };
  };
  return Object.assign(factory, {
    modelId: options.modelId,
    getEngine: () => current?.engine ?? null,
    hasLiveWorker: () => current?.worker != null,
    whenSettled: () => settled,
    unload: () => current ? current.stop() : disposal
  });
}
export const _internal = { defaultResolveWorker };
