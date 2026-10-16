import { createPreparationStore } from "./store";
import type { WorkerCoachEngineFactory } from "./createWebWorkerClient";

// Page resource ownership is independent of modal mounts and financial inputs.
const store = createPreparationStore();
let factory: WorkerCoachEngineFactory | null = null;
let inferenceTail = Promise.resolve();
export function runExclusiveInference(task: () => Promise<void>): Promise<void> {
  const result = inferenceTail.then(task);
  inferenceTail = result.catch(() => undefined);
  return result;
}
export function getPageStore() { return store; }
export function getPageFactory(create: () => WorkerCoachEngineFactory) {
  if (!factory || store.getSnapshot().state === "idle" || store.getSnapshot().state === "error" || store.getSnapshot().state === "cancelled") {
    factory = create();
  }
  return factory;
}
