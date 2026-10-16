// @vitest-environment jsdom
// Regression test for useCoach — editing budget should NOT kill the download.
// This test verifies the fix for the critical bug where useCoach.ts called
// store.reset() on every inputFingerprint change, killing the model download.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BudgetDataApi } from "../app/lib/useBudgetData";
import { useCoach } from "../app/lib/useCoach";
import { createPreparationStore } from "../app/lib/coachEngine/store";
let testStore = createPreparationStore();
vi.mock("../app/lib/coachEngine/pageManager", async importOriginal => ({
  ...await importOriginal<typeof import("../app/lib/coachEngine/pageManager")>(),
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

function budget(overrides: Partial<BudgetDataApi> = {}) {
  return {
    localScopeKey: "test/ws",
    profileName: "Test",
    monthlyIncome: 3000000,
    summary: { monthlyExpense: 600000 },
    fixedCosts: [
      { id: "x", name: "Netflix", categoryId: "subscription", amount: 17000, periodMonths: 1, billingDay: 1, isEndOfMonth: false, billingAnchorDate: null, renewalStatus: "unreviewed" }
    ],
    ...overrides
  } as unknown as BudgetDataApi;
}

describe("CRITICAL BUG REGRESSION — useCoach input change does not reset store", () => {
  it("editing budget (inputFingerprint change) does NOT kill the download", async () => {
    let prepareCalled = 0;
    let capturedCallbacks: any = null;
    const slowFactory: any = (callbacks: any) => {
      prepareCalled++;
      capturedCallbacks = callbacks;
      // Don't call onReady — keep in preparing state
      return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    };
    slowFactory.getEngine = () => null;
    slowFactory.unload = vi.fn();
    slowFactory.hasLiveWorker = () => true;
    mocks.factory.mockReturnValue(slowFactory);

    const h = renderHook(
      ({ income }) => useCoach({ budget: budget({ monthlyIncome: income }), serverApi: null }),
      { initialProps: { income: 3_000_000 } }
    );

    // Start preparation
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });

    expect(h.result.current.preparation.state).toBe("preparing");
    expect(prepareCalled).toBe(1);
    const originalJobId = h.result.current.preparation.jobId;

    // CRITICAL: Change input (edit budget) — this should NOT reset the store
    h.rerender({ income: 5_000_000 });
    await act(async () => { await Promise.resolve(); });

    // Store should still be preparing with the same jobId
    expect(h.result.current.preparation.state).toBe("preparing");
    expect(h.result.current.preparation.jobId).toBe(originalJobId);

    // Factory should NOT have been called again
    expect(prepareCalled).toBe(1);

    // Complete the preparation
    act(() => capturedCallbacks.onReady());
    await act(async () => { await Promise.resolve(); });

    expect(h.result.current.preparation.state).toBe("ready");
  });

  it("scope change preserves model preparation (no financial inputs in artifact job)", async () => {
    let prepareCalled = 0;
    const slowFactory: any = (callbacks: any) => {
      prepareCalled++;
      return { jobId: 0, modelId: "Qwen3.5-0.8B-q4f16_1-MLC" };
    };
    slowFactory.getEngine = () => null;
    slowFactory.unload = vi.fn();
    slowFactory.hasLiveWorker = () => true;
    mocks.factory.mockReturnValue(slowFactory);

    const h = renderHook(
      ({ scope }) => useCoach({ budget: budget({ localScopeKey: scope }), serverApi: null }),
      { initialProps: { scope: "workspace-A" } }
    );

    // Start preparation
    act(() => h.result.current.confirmConsentAndPrepare());
    await act(async () => { await Promise.resolve(); });

    expect(h.result.current.preparation.state).toBe("preparing");
    expect(prepareCalled).toBe(1);

    const jobId = h.result.current.preparation.jobId;
    h.rerender({ scope: "workspace-B" });
    await act(async () => { await Promise.resolve(); });

    // An approved model artifact contains no workspace financial input.
    expect(h.result.current.preparation.state).toBe("preparing");
    expect(h.result.current.preparation.jobId).toBe(jobId);
    expect(prepareCalled).toBe(1);
  });
});
