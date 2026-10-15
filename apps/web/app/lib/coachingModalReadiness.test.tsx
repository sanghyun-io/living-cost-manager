// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BudgetDataApi } from "./useBudgetData";
import { useCoach } from "./useCoach";

const mocks = vi.hoisted(() => ({ engine: vi.fn(), stream: vi.fn() }));
// A genuine cold-start state is important: "ready" would hide a missing
// readiness check in awaitingConsent even before the page-wiring fix.
vi.mock("./coach", () => ({ getCoachEngineStatus: () => "none", getCoachEngine: mocks.engine, streamCoaching: mocks.stream }));
vi.mock("./coachModel", () => ({ isCoachOptedIn: () => false, isWebGpuAvailable: () => true, setCoachOptIn: vi.fn(), COACH_MODEL_APPROX_MB: 1, COACH_MODEL_VRAM_MB: 1 }));
vi.mock("./analytics", () => ({ track: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("opening a cold coach with unavailable preferences shows an error, exposes no consent, and never starts engine or stream", async () => {
  const data = {
    localScopeKey: "synthetic-modal/ws", profileName: "Synthetic", monthlyIncome: 1000000,
    summary: { monthlyExpense: 300000 },
    fixedCosts: [{ id: "synthetic-item", name: "Synthetic cost", categoryId: "subscription", amount: 300000, periodMonths: 1, billingDay: null }]
  } as unknown as BudgetDataApi;
  const h = renderHook(() => useCoach({ budget: data, serverApi: null, coachingPreferencesReady: false }));
  expect(h.result.current.isCoachModalOpen).toBe(false);
  expect(h.result.current.coachStatus).toBe("idle");
  expect(h.result.current.awaitingConsent).toBe(false);
  act(() => h.result.current.openCoachModal());
  expect(h.result.current.isCoachModalOpen).toBe(true);
  expect(h.result.current.coachStatus).toBe("error");
  expect(h.result.current.coachError).toContain("코칭 설정을 확인할 수 없어 추천을 보류");
  expect(h.result.current.awaitingConsent).toBe(false);
  expect(h.result.current.coachAttemptConsent).toBe(false);
  await act(async () => { await h.result.current.runCoaching(); h.result.current.confirmConsentAndRun(); });
  expect(h.result.current.awaitingConsent).toBe(false);
  expect(h.result.current.coachStatus).toBe("error");
  expect(mocks.engine).not.toHaveBeenCalled();
  expect(mocks.stream).not.toHaveBeenCalled();
});
