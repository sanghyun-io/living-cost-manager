/// <reference lib="webworker" />
// 코치 모델 추론용 dedicated Worker entry.
//
// The installed SDK accepts both MessageEvent and raw event.data. Keep the
// handler receiver explicit; neither payload shape is itself an SDK bug.

import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

// WebLLM 0.2.84 only logs unexpected device.lost and unloads its internal
// engine; it does not notify the proxy. Observe the native device in this
// dedicated worker so a silently unloaded model cannot remain READY in UI.
// Explicit unload uses reason=destroyed and must not report an error.
type ObservedDevice = { lost: Promise<{ reason: string; message: string }> };
type ObservedAdapter = { requestDevice: (...args: unknown[]) => Promise<ObservedDevice> };
const gpu = (navigator as unknown as { gpu?: { requestAdapter: (...args: unknown[]) => Promise<ObservedAdapter | null> } }).gpu;
if (gpu) {
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = async (...args) => {
    const adapter = await requestAdapter(...args);
    if (adapter) {
      const requestDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...deviceArgs) => {
        const device = await requestDevice(...deviceArgs);
        void device.lost.then(info => {
          if (info.reason !== "destroyed") self.postMessage({ kind: "coachWorkerFatal", message: "GPU 연결이 끊겼습니다. 다시 동의하고 준비해 주세요." });
        });
        return device;
      };
    }
    return adapter;
  };
}

const handler = new WebWorkerMLCEngineHandler();
self.addEventListener("unhandledrejection", () => {
  self.postMessage({ kind: "coachWorkerFatal" });
});

// CRITICAL: 핸들러의 this 를 보존하기 위해 wrapper 를 사용한다.
// `self.onmessage = handler.onmessage` 는 this 를 잃어버린다.
self.addEventListener("message", (event: MessageEvent) => {
  handler.onmessage(event.data);
});

export {};
