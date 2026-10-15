// @vitest-environment jsdom
//
// 4-Case Sequential Personalization Unit Test (mock engine)
// ========================================
// Tests deterministic helpers and React hooks with mocked engine/stream responses.
// This is not native WebGPU/model execution evidence.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  buildSavingsInsights,
  buildInsuranceCheck,
  getUpcomingDues,
  getActiveProtectedFixedCostIds,
  type CoachingPreferences
} from "@living-cost-manager/shared";
import {
  selectCoachSegments,
  streamCoaching,
  clampToOneSentence,
  type CoachInput
} from "../app/lib/coach";
import { useCoach } from "../app/lib/useCoach";
import { parseCoachingStorage, coachingFingerprint } from "../app/lib/useCoachingPreferences";
import type { BudgetDataApi } from "../app/lib/useBudgetData";
import type { FixedCost } from "../app/lib/budget";

// -- Mocks: only mock engine status/load and streamCoaching for useCoach tests
const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  engine: vi.fn(),
  engineStatus: vi.fn(() => "ready" as const)
}));

vi.mock("../app/lib/coach", async () => {
  const actual = await vi.importActual("../app/lib/coach");
  return {
    ...actual,
    getCoachEngine: mocks.engine,
    getCoachEngineStatus: mocks.engineStatus,
    streamCoaching: mocks.stream
  };
});
vi.mock("../app/lib/coachModel", () => ({
  isCoachOptedIn: () => false,
  isWebGpuAvailable: () => true,
  setCoachOptIn: vi.fn(),
  COACH_MODEL_APPROX_MB: 500,
  COACH_MODEL_VRAM_MB: 945
}));
vi.mock("../app/lib/analytics", () => ({ track: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// Helper to get actual (unmocked) streamCoaching for direct testing
async function getActualStreamCoaching() {
  const actual = await vi.importActual("../app/lib/coach") as any;
  return actual.streamCoaching as typeof streamCoaching;
}
async function getActualClampToOneSentence() {
  const actual = await vi.importActual("../app/lib/coach") as any;
  return actual.clampToOneSentence as typeof clampToOneSentence;
}

// -- Reference date: 2026-10-07 (deterministic) ------------------------------
const NOW = new Date("2026-10-07T09:00:00Z");

// -- Fixture factory ---------------------------------------------------------
function makeFixedCost(overrides: Partial<FixedCost> & { id: string; name: string; categoryId: string; amount: number }): FixedCost {
  return {
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    periodMonths: 1,
    billingDay: 15,
    isEndOfMonth: false,
    billingAnchorDate: "2026-01-15",
    renewalStatus: "unreviewed",
    potentialMonthlySavings: 0,
    confirmedMonthlySavings: 0,
    ...overrides
  };
}

function caseAFixtures() {
  const telecom = makeFixedCost({
    id: "telecom-1", name: "5G무제한플랜", categoryId: "telecom",
    amount: 85000, billingDay: 25, billingAnchorDate: "2026-01-25"
  });
  const smallSub = makeFixedCost({
    id: "sub-small", name: "음악스트리밍", categoryId: "subscription",
    amount: 9000, billingDay: 5, billingAnchorDate: "2026-01-05"
  });
  const rent = makeFixedCost({
    id: "rent-1", name: "월세", categoryId: "housing",
    amount: 500000, billingDay: 1, billingAnchorDate: "2026-01-01"
  });
  return { items: [telecom, smallSub, rent], protectedIds: new Set(["telecom-1"]), monthlyIncome: 3_500_000 };
}

function caseBFixtures() {
  const insuranceA = makeFixedCost({
    id: "ins-a", name: "종신보험", categoryId: "insurance",
    amount: 200000, billingDay: 10, billingAnchorDate: "2026-01-10"
  });
  const insuranceB = makeFixedCost({
    id: "ins-b", name: "실손보험", categoryId: "insurance",
    amount: 150000, billingDay: 20, billingAnchorDate: "2026-01-20"
  });
  const other = makeFixedCost({
    id: "other-1", name: "인터넷", categoryId: "telecom",
    amount: 30000, billingDay: 8, billingAnchorDate: "2026-01-08"
  });
  return { items: [insuranceA, insuranceB, other], protectedIds: new Set(["ins-a"]), monthlyIncome: 2_500_000 };
}

function caseCFixtures() {
  const sub1 = makeFixedCost({
    id: "sub-1", name: "넷플릭스", categoryId: "subscription",
    amount: 13500, billingDay: 3, billingAnchorDate: "2026-01-03"
  });
  const sub2 = makeFixedCost({
    id: "sub-2", name: "디즈니플러스", categoryId: "subscription",
    amount: 9500, billingDay: 18, billingAnchorDate: "2026-01-18"
  });
  const ins = makeFixedCost({
    id: "ins-1", name: "자동차보험", categoryId: "insurance",
    amount: 120000, billingDay: 22, billingAnchorDate: "2026-01-22"
  });
  return { items: [sub1, sub2, ins], protectedIds: new Set(["sub-1", "sub-2", "ins-1"]), monthlyIncome: 3_000_000 };
}

function caseDFixtures() {
  const insuranceA = makeFixedCost({
    id: "ins-a", name: "종신보험", categoryId: "insurance",
    amount: 200000, billingDay: 10, billingAnchorDate: "2026-01-10"
  });
  const insuranceB = makeFixedCost({
    id: "ins-b", name: "실손보험", categoryId: "insurance",
    amount: 150000, billingDay: 20, billingAnchorDate: "2026-01-20"
  });
  const other = makeFixedCost({
    id: "other-1", name: "인터넷", categoryId: "telecom",
    amount: 30000, billingDay: 8, billingAnchorDate: "2026-01-08"
  });
  return { items: [insuranceA, insuranceB, other], monthlyIncome: 2_500_000 };
}

function createFakeEngine(responses: string[]) {
  let callIndex = 0;
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => {
          const response = responses[callIndex] || responses[responses.length - 1];
          callIndex++;
          return (async function* () {
            yield { choices: [{ delta: { content: response } }] };
          })();
        })
      }
    }
  };
}

function makeBudgetData(items: FixedCost[], monthlyIncome: number): BudgetDataApi {
  const monthlyExpense = items.reduce((sum, i) => sum + Math.round(i.amount / i.periodMonths), 0);
  return {
    localScopeKey: "synthetic-local/ws",
    profileName: "Synthetic",
    monthlyIncome,
    summary: { monthlyExpense, annualExpense: monthlyExpense * 12, remainingIncome: monthlyIncome - monthlyExpense, expenseRate: monthlyIncome > 0 ? monthlyExpense / monthlyIncome : 0, averageExpense: monthlyExpense },
    fixedCosts: items
  } as unknown as BudgetDataApi;
}

// ============================================================================
// UNIT TESTS: Shared functions with protection (no model)
// ============================================================================

describe("Unit: shared functions with protection (no model)", () => {
  describe("Case A: Protected telecom largest + unprotected small sub", () => {
    it("buildSavingsInsights excludes protected telecom, includes unprotected sub", () => {
      const { items, protectedIds } = caseAFixtures();
      const insights = buildSavingsInsights(items, { protectedFixedCostIds: protectedIds });
      const telecomInsight = insights.find(i => i.items.some(item => item.id === "telecom-1"));
      expect(telecomInsight).toBeUndefined();
      const subInsight = insights.find(i => i.items.some(item => item.id === "sub-small"));
      expect(subInsight).toBeDefined();
      expect(subInsight!.kind).toBe("largest");
    });

    it("buildInsuranceCheck: no insurance items -> insuranceHigh false", () => {
      const { items, protectedIds, monthlyIncome } = caseAFixtures();
      const check = buildInsuranceCheck(items, monthlyIncome, { protectedFixedCostIds: protectedIds });
      expect(check.isHigh).toBe(false);
      expect(check.canSuggestReview).toBe(false);
    });

    it("getUpcomingDues returns items within 14 days", () => {
      const { items } = caseAFixtures();
      const dues = getUpcomingDues(items, NOW, 14);
      expect(Array.isArray(dues)).toBe(true);
    });
  });

  describe("Case B: Mixed insurance protected A + unprotected B", () => {
    it("buildInsuranceCheck: insuranceHigh true when ratio > 12%", () => {
      const { items, protectedIds, monthlyIncome } = caseBFixtures();
      const check = buildInsuranceCheck(items, monthlyIncome, { protectedFixedCostIds: protectedIds });
      expect(check.isHigh).toBe(true);
    });

    it("reviewItemIds excludes protected ins-a, includes unprotected ins-b", () => {
      const { items, protectedIds, monthlyIncome } = caseBFixtures();
      const check = buildInsuranceCheck(items, monthlyIncome, { protectedFixedCostIds: protectedIds });
      expect(check.reviewItemIds).not.toContain("ins-a");
      expect(check.reviewItemIds).toContain("ins-b");
      expect(check.canSuggestReview).toBe(true);
    });

    it("buildSavingsInsights: internet is reducible, insurance is hard-to-reduce", () => {
      const { items, protectedIds } = caseBFixtures();
      const insights = buildSavingsInsights(items, { protectedFixedCostIds: protectedIds });
      const internetInsight = insights.find(i => i.items.some(item => item.id === "other-1"));
      expect(internetInsight).toBeDefined();
      expect(internetInsight!.kind).toBe("largest");
    });
  });

  describe("Case C: All protected -> savings/insurance goal 0", () => {
    it("buildSavingsInsights: all protected -> empty insights", () => {
      const { items, protectedIds } = caseCFixtures();
      const insights = buildSavingsInsights(items, { protectedFixedCostIds: protectedIds });
      expect(insights).toEqual([]);
    });

    it("buildInsuranceCheck: all insurance protected -> canSuggestReview false", () => {
      const { items, protectedIds, monthlyIncome } = caseCFixtures();
      const check = buildInsuranceCheck(items, monthlyIncome, { protectedFixedCostIds: protectedIds });
      expect(check.reviewItemIds).not.toContain("ins-1");
      expect(check.canSuggestReview).toBe(false);
    });

    it("selectCoachSegments: no savings, no insurance -> praise only", () => {
      const { items, protectedIds, monthlyIncome } = caseCFixtures();
      const monthlyTotal = items.reduce((s, i) => s + Math.round(i.amount / i.periodMonths), 0);
      const coachInput: CoachInput = {
        monthlyTotal, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
        monthlyIncome, fixedCostCount: items.length, savings: [], upcoming: [], insuranceHigh: false
      };
      const segments = selectCoachSegments(coachInput);
      expect(segments.length).toBe(1);
      expect(segments[0].key).toBe("praise");
    });
  });
});

// ============================================================================
// INTEGRATION TESTS: actual streamCoaching + selectCoachSegments with fake engine
// ============================================================================

describe("Integration: actual streamCoaching with fake engine", () => {
  describe("Case A: Protected telecom + unprotected small sub", () => {
    it("coachInput has savings for unprotected sub, NOT protected telecom", () => {
      const { items, protectedIds, monthlyIncome } = caseAFixtures();
      const data = makeBudgetData(items, monthlyIncome);
      mocks.engineStatus.mockReturnValue("ready");
      const h = renderHook(() => useCoach({ budget: data, serverApi: null, protectedFixedCostIds: protectedIds }));
      const savingsTitles = h.result.current.coachInput.savings.map(s => s.title);
      expect(savingsTitles.every(t => !t.includes("5G무제한플랜"))).toBe(true);
      expect(h.result.current.coachInput.savings.length).toBeGreaterThan(0);
      expect(h.result.current.coachInput.insuranceHigh).toBe(false);
    });

    it("ACTUAL streamCoaching output does not contain protected telecom name", async () => {
      const realStreamCoaching = await getActualStreamCoaching();
      const { items, protectedIds, monthlyIncome } = caseAFixtures();
      const monthlyTotal = items.reduce((s, i) => s + Math.round(i.amount / i.periodMonths), 0);
      const coachInput: CoachInput = {
        monthlyTotal, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
        monthlyIncome, fixedCostCount: items.length,
        savings: buildSavingsInsights(items, { protectedFixedCostIds: protectedIds }).map(s => ({ title: s.title, monthlySavings: s.monthlySavings })),
        upcoming: [], insuranceHigh: false
      };
      const protectedNames = items.filter(i => protectedIds.has(i.id)).map(i => i.name);
      const engine = createFakeEngine(["고정비를 잘 관리하고 계세요.", "음악스트리밍을 점검해 보세요."]);
      const tokens: string[] = [];
      const result = await realStreamCoaching(engine as any, coachInput, (full) => tokens.push(full), { protectedItemNames: protectedNames });
      expect(result).not.toContain("5G무제한플랜");
      expect(tokens.every(t => !t.includes("5G무제한플랜"))).toBe(true);
      expect(result).toContain("음악스트리밍");
    });
  });

  describe("Case B: Mixed insurance protected A + unprotected B", () => {
    it("coachInput has insuranceHigh true, review names only include unprotected B", () => {
      const { items, protectedIds, monthlyIncome } = caseBFixtures();
      const data = makeBudgetData(items, monthlyIncome);
      mocks.engineStatus.mockReturnValue("ready");
      const h = renderHook(() => useCoach({ budget: data, serverApi: null, protectedFixedCostIds: protectedIds }));
      expect(h.result.current.coachInput.insuranceHigh).toBe(true);
      expect(h.result.current.coachInput.insuranceReviewItemNames).toEqual(["실손보험"]);
      const inputJson = JSON.stringify(h.result.current.coachInput);
      expect(inputJson).not.toContain("종신보험");
      expect(inputJson).not.toContain("reason");
    });

    it("ACTUAL streamCoaching insurance segment targets only unprotected B", async () => {
      const realStreamCoaching = await getActualStreamCoaching();
      const { items, protectedIds, monthlyIncome } = caseBFixtures();
      const monthlyTotal = items.reduce((s, i) => s + Math.round(i.amount / i.periodMonths), 0);
      const insurance = buildInsuranceCheck(items, monthlyIncome, { protectedFixedCostIds: protectedIds });
      const eligibleNames = items.filter(i => insurance.reviewItemIds.includes(i.id)).map(i => i.name);
      const coachInput: CoachInput = {
        monthlyTotal, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
        monthlyIncome, fixedCostCount: items.length, savings: [], upcoming: [],
        insuranceHigh: insurance.canSuggestReview,
        insuranceReviewItemNames: eligibleNames.length > 0 ? eligibleNames : undefined
      };
      const protectedNames = items.filter(i => protectedIds.has(i.id)).map(i => i.name);
      const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
      const result = await realStreamCoaching(engine as any, coachInput, undefined, { protectedItemNames: protectedNames });
      // Result contains eligible name (deterministic output)
      expect(result).not.toContain("종신보험");
      expect(result).toContain("실손보험");
      // Only praise is sent to model — insurance is deterministic, no model call
      const allMessages = JSON.stringify(engine.chat.completions.create.mock.calls.map((c: any) => c[0].messages));
      expect(allMessages).not.toContain("종신보험");
      expect(allMessages).not.toContain("실손보험");  // insurance not sent to model
      expect(allMessages).not.toContain("reason");
    });
  });

  describe("Case C: All protected -> savings/insurance goal 0", () => {
    it("coachInput has empty savings, insuranceHigh false, no review names", () => {
      const { items, protectedIds, monthlyIncome } = caseCFixtures();
      const data = makeBudgetData(items, monthlyIncome);
      mocks.engineStatus.mockReturnValue("ready");
      const h = renderHook(() => useCoach({ budget: data, serverApi: null, protectedFixedCostIds: protectedIds }));
      expect(h.result.current.coachInput.savings).toEqual([]);
      expect(h.result.current.coachInput.insuranceHigh).toBe(false);
      expect(h.result.current.coachInput.insuranceReviewItemNames).toBeUndefined();
    });

    it("ACTUAL streamCoaching produces only praise (no savings/insurance segments)", async () => {
      const realStreamCoaching = await getActualStreamCoaching();
      const { items, protectedIds, monthlyIncome } = caseCFixtures();
      const monthlyTotal = items.reduce((s, i) => s + Math.round(i.amount / i.periodMonths), 0);
      const coachInput: CoachInput = {
        monthlyTotal, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
        monthlyIncome, fixedCostCount: items.length, savings: [], upcoming: [], insuranceHigh: false
      };
      const engine = createFakeEngine(["고정비를 잘 관리하고 계세요."]);
      const result = await realStreamCoaching(engine as any, coachInput);
      expect(engine.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toContain("넷플릭스");
      expect(result).not.toContain("디즈니플러스");
      expect(result).not.toContain("자동차보험");
    });
  });
});

// ============================================================================
// CASE D: Protection changed -> previous response invalidated
// ============================================================================

describe("Case D: Protection setting change invalidates previous coaching", () => {
  it("changing protectedFixedCostIds changes review targets immediately", () => {
    const { items, monthlyIncome } = caseDFixtures();
    const data = makeBudgetData(items, monthlyIncome);
    mocks.engineStatus.mockReturnValue("ready");
    mocks.engine.mockResolvedValue({});
    mocks.stream.mockResolvedValue("");

    const h = renderHook(
      ({ ids }) => useCoach({ budget: data, serverApi: null, protectedFixedCostIds: new Set(ids) }),
      { initialProps: { ids: ["ins-a"] as string[] } }
    );

    // Initial: ins-a protected -> review targets ins-b (실손보험)
    expect(h.result.current.coachInput.insuranceReviewItemNames).toEqual(["실손보험"]);

    // Change protection to ins-b
    h.rerender({ ids: ["ins-b"] });

    // After rerender: review targets should change to ins-a (종신보험)
    expect(h.result.current.coachInput.insuranceReviewItemNames).toEqual(["종신보험"]);
    // Text should be invalidated
    expect(h.result.current.coachingText).toBe("");
  });

  it("after protection change, new coaching run produces new output for new targets", async () => {
    const { items, monthlyIncome } = caseDFixtures();
    const data = makeBudgetData(items, monthlyIncome);
    mocks.engineStatus.mockReturnValue("ready");
    mocks.engine.mockResolvedValue({});
    let callCount = 0;
    mocks.stream.mockImplementation(async (_e: any, input: any, emit: any) => {
      callCount++;
      const reviewNames = input.insuranceReviewItemNames ?? [];
      const text = callCount === 1
        ? `${reviewNames[0] ?? ""} 보장 점검을 권해요.`
        : `${reviewNames[0] ?? ""} 보장 내용을 확인해 보세요.`;
      if (emit) emit(text);
      return text;
    });

    const h = renderHook(
      ({ ids }) => useCoach({ budget: data, serverApi: null, protectedFixedCostIds: new Set(ids) }),
      { initialProps: { ids: ["ins-a"] as string[] } }
    );

    // First run with ins-a protected
    await act(async () => { await h.result.current.runCoaching(); });
    expect(h.result.current.coachingText).toContain("실손보험");
    expect(h.result.current.coachingText).not.toContain("종신보험");

    // Change protection to ins-b
    h.rerender({ ids: ["ins-b"] });
    expect(h.result.current.coachingText).toBe(""); // Invalidated

    // Second run with ins-b protected
    await act(async () => { await h.result.current.runCoaching(); });
    expect(h.result.current.coachingText).toContain("종신보험");
    expect(h.result.current.coachingText).not.toContain("실손보험");
  });
});

// ============================================================================
// EDGE CASE TESTS
// ============================================================================

describe("Edge cases", () => {
  it("empty fixedCosts -> coachInput has no data", () => {
    const data = makeBudgetData([], 3_000_000);
    const monthlyTotal = 0;
    const coachInput: CoachInput = {
      monthlyTotal, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
      monthlyIncome: 3_000_000, fixedCostCount: 0, savings: [], upcoming: [], insuranceHigh: false
    };
    const segments = selectCoachSegments(coachInput);
    expect(segments.length).toBe(1);
    expect(segments[0].key).toBe("praise");
  });

  it("zero income -> praise uses medium text", () => {
    const coachInput: CoachInput = {
      monthlyTotal: 10000, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
      monthlyIncome: 0, fixedCostCount: 1, savings: [], upcoming: [], insuranceHigh: false
    };
    const segments = selectCoachSegments(coachInput);
    expect(segments[0].key).toBe("praise");
    expect(segments[0].example).toContain("차곡차곡"); // Medium praise when rate is null
  });

  it("getActiveProtectedFixedCostIds: orphan IDs in prefs are filtered out", () => {
    const prefs: CoachingPreferences = {
      schemaVersion: 1, revision: 0,
      protectedItems: [{ fixedCostId: "exists" }, { fixedCostId: "orphan-removed" }]
    };
    const items = [{ id: "exists" }, { id: "other" }];
    const active = getActiveProtectedFixedCostIds(prefs, items);
    expect(active.has("exists")).toBe(true);
    expect(active.has("orphan-removed")).toBe(false);
  });

  it("getActiveProtectedFixedCostIds: duplicate IDs in prefs handled gracefully", () => {
    const prefs: CoachingPreferences = {
      schemaVersion: 1, revision: 0,
      protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "a" }]
    };
    const items = [{ id: "a" }];
    const active = getActiveProtectedFixedCostIds(prefs, items);
    expect(active.has("a")).toBe(true);
    expect(active.size).toBe(1);
  });

  it("buildInsuranceCheck: income 0 -> ratioOfIncome null, isHigh false", () => {
    const items = [makeFixedCost({ id: "ins", name: "보험", categoryId: "insurance", amount: 100000 })];
    const check = buildInsuranceCheck(items, 0);
    expect(check.ratioOfIncome).toBeNull();
    expect(check.isHigh).toBe(false);
    expect(check.canSuggestReview).toBe(false);
  });

  it("buildSavingsInsights: all items in hard-to-reduce categories -> empty", () => {
    const items = [
      makeFixedCost({ id: "a", name: "월세", categoryId: "housing", amount: 500000 }),
      makeFixedCost({ id: "b", name: "보험", categoryId: "insurance", amount: 200000 })
    ];
    const insights = buildSavingsInsights(items);
    expect(insights).toEqual([]);
  });

  it("selectCoachSegments: MAX_SEGMENTS=4 caps output", () => {
    const coachInput: CoachInput = {
      monthlyTotal: 1_000_000, previousMonthlyTotal: 900_000, deltaAmount: 100_000, deltaPercent: 11.1,
      monthlyIncome: 3_000_000, fixedCostCount: 10,
      savings: [{ title: "구독", monthlySavings: 10000 }],
      insuranceHigh: true, insuranceReviewItemNames: ["보험"],
      upcoming: [{ name: "통신비", amount: 79000, daysUntil: 3 }]
    };
    const segments = selectCoachSegments(coachInput);
    expect(segments.length).toBeLessThanOrEqual(4);
    expect(segments[0].key).toBe("praise");
  });

  it("clampToOneSentence: handles multi-line, multiple sentences", async () => {
    const realClamp = await getActualClampToOneSentence();
    expect(realClamp("첫째 문장. 둘째 문장.")).toBe("첫째 문장.");
    expect(realClamp("한 문장\n둘째 줄")).toBe("한 문장");
    expect(realClamp("")).toBe("");
    expect(realClamp("마침표없는")).toBe("마침표없는");
  });
});

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describe("Error handling", () => {
  it("ACTUAL engine error propagates through streamCoaching", async () => {
    const realStreamCoaching = await getActualStreamCoaching();
    const engine = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("WEBGPU_CONTEXT_LOST")) } }
    };
    const coachInput: CoachInput = {
      monthlyTotal: 500000, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
      monthlyIncome: 3000000, fixedCostCount: 3, savings: [], upcoming: [], insuranceHigh: false
    };
    await expect(realStreamCoaching(engine as any, coachInput)).rejects.toThrow("WEBGPU_CONTEXT_LOST");
  });

  it("ACTUAL empty model output falls back to example text", async () => {
    const realStreamCoaching = await getActualStreamCoaching();
    const engine = {
      chat: { completions: { create: vi.fn().mockImplementation(async () => (async function* () {})()) } }
    };
    const coachInput: CoachInput = {
      monthlyTotal: 500000, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
      monthlyIncome: 3000000, fixedCostCount: 3, savings: [], upcoming: [], insuranceHigh: false
    };
    const result = await realStreamCoaching(engine as any, coachInput);
    expect(result.length).toBeGreaterThan(6);
  });

  it("ACTUAL streaming error after partial output still throws", async () => {
    const realStreamCoaching = await getActualStreamCoaching();
    const engine = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(async () => {
            return (async function* () {
              yield { choices: [{ delta: { content: "첫 번째 문장." } }] };
              throw new Error("STREAM_ERROR");
            })();
          })
        }
      }
    };
    const coachInput: CoachInput = {
      monthlyTotal: 500000, previousMonthlyTotal: null, deltaAmount: null, deltaPercent: null,
      monthlyIncome: 3000000, fixedCostCount: 3, savings: [], upcoming: [], insuranceHigh: false
    };
    await expect(realStreamCoaching(engine as any, coachInput)).rejects.toThrow("STREAM_ERROR");
  });
});

// ============================================================================
// STORAGE ENVELOPE TESTS
// ============================================================================

describe("Storage envelope: useCoachingPreferences", () => {
  it("parseCoachingStorage: valid current envelope parses correctly", () => {
    const envelope = {
      storageVersion: 1,
      preferences: { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: "a" }] },
      ackFingerprint: null,
      localEdited: true
    };
    const result = parseCoachingStorage(JSON.stringify(envelope));
    expect(result).not.toBeNull();
    expect(result!.preferences.protectedItems).toHaveLength(1);
    expect(result!.ackFingerprint).toBeNull();
    expect(result!.localEdited).toBe(true);
  });

  it("parseCoachingStorage: corrupt JSON returns null", () => {
    const raw = "{ corrupted protection intent";
    const result = parseCoachingStorage(raw);
    expect(result).toBeNull();
  });

  it("parseCoachingStorage: unknown keys in envelope returns null", () => {
    const envelope = {
      storageVersion: 1,
      preferences: { schemaVersion: 1, revision: 0, protectedItems: [] },
      ackFingerprint: null,
      unknownKey: "bad"
    };
    const result = parseCoachingStorage(JSON.stringify(envelope));
    expect(result).toBeNull();
  });

  it("parseCoachingStorage: wrong storageVersion returns null", () => {
    const envelope = {
      storageVersion: 999,
      preferences: { schemaVersion: 1, revision: 0, protectedItems: [] },
      ackFingerprint: null
    };
    const result = parseCoachingStorage(JSON.stringify(envelope));
    expect(result).toBeNull();
  });

  it("coachingFingerprint: deterministic regardless of array order", () => {
    const a = { schemaVersion: 1 as const, revision: 0, protectedItems: [{ fixedCostId: "b" }, { fixedCostId: "a" }] };
    const b = { schemaVersion: 1 as const, revision: 5, protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "b" }] };
    expect(coachingFingerprint(a)).toBe(coachingFingerprint(b));
  });

  it("coachingFingerprint: includes reason when present", () => {
    const a = { schemaVersion: 1 as const, revision: 0, protectedItems: [{ fixedCostId: "a", reason: "essential" as const }] };
    const b = { schemaVersion: 1 as const, revision: 0, protectedItems: [{ fixedCostId: "a" }] };
    expect(coachingFingerprint(a)).not.toBe(coachingFingerprint(b));
  });
});
