import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TEMPLATE_SCENARIOS } from "@living-cost-manager/shared";
import { alignTemplateAmounts, buildTemplateBudget, templateItemsUnchanged } from "../app/lib/templates";
import { isTemplateShareToken, parseTemplateShareFragment, templateApi } from "../app/lib/templateApi";

const VALID_TOKEN = "a".repeat(43);

describe("amounts survive a save only when item identity is stable", () => {
  test("canonicalized labels (NFKC/trim) keep every entered amount", () => {
    const prior = [
      { name: "  월세  ", category: "주거", periodMonths: 1 },
      { name: "ＡＢＣ구독", category: "구독", periodMonths: 12 }
    ];
    const saved = [
      { name: "월세", category: "주거", periodMonths: 1 },
      { name: "ABC구독", category: "구독", periodMonths: 12 }
    ];
    expect(templateItemsUnchanged(prior, saved)).toBe(true);
    expect(alignTemplateAmounts(prior, ["650000", "11900"], saved)).toEqual(["650000", "11900"]);
  });

  test("a genuinely edited item blanks only its own amount", () => {
    const prior = [
      { name: "월세", category: "주거", periodMonths: 1 },
      { name: "통신비", category: "통신", periodMonths: 1 }
    ];
    const editedName = [
      { name: "관리비", category: "주거", periodMonths: 1 },
      { name: "통신비", category: "통신", periodMonths: 1 }
    ];
    const editedCategory = [
      { name: "월세", category: "기타", periodMonths: 1 },
      { name: "통신비", category: "통신", periodMonths: 1 }
    ];
    const editedPeriod = [
      { name: "월세", category: "주거", periodMonths: 3 },
      { name: "통신비", category: "통신", periodMonths: 1 }
    ];
    // A save response may only differ from the sent draft by canonical
    // spelling. ANY other field drift — even category — means that row cannot
    // be trusted, so its amount blanks instead of silently staying applied.
    expect(templateItemsUnchanged(prior, editedName)).toBe(false);
    expect(alignTemplateAmounts(prior, ["650000", "79000"], editedName)).toEqual(["", "79000"]);
    expect(templateItemsUnchanged(prior, editedCategory)).toBe(false);
    expect(alignTemplateAmounts(prior, ["650000", "79000"], editedCategory)).toEqual(["", "79000"]);
    expect(alignTemplateAmounts(prior, ["650000", "79000"], editedPeriod)).toEqual(["", "79000"]);
  });

  test("added and removed items never shift a stale amount onto a neighbour", () => {
    const prior = [
      { name: "a", category: "x", periodMonths: 1 },
      { name: "b", category: "x", periodMonths: 1 },
      { name: "c", category: "y", periodMonths: 1 }
    ];
    const amounts = ["1000", "2000", "3000"];
    const appended = [...prior, { name: "d", category: "y", periodMonths: 12 }];
    expect(alignTemplateAmounts(prior, amounts, appended)).toEqual(["1000", "2000", "3000", ""]);
    const removedMiddle = [prior[0], prior[2]];
    // The response no longer aligns by stable order: both shifted slots blank.
    expect(alignTemplateAmounts(prior, amounts, removedMiddle)).toEqual(["1000", ""]);
    const reordered = [prior[1], prior[0]];
    expect(alignTemplateAmounts(prior, amounts, reordered)).toEqual(["", ""]);
    expect(alignTemplateAmounts(prior, amounts, [])).toEqual([]);
    // Missing draft entries fall back to blank, never undefined.
    expect(alignTemplateAmounts(prior, ["1000"], prior)).toEqual(["1000", "", ""]);
  });
});

describe("share fragments are shape-checked before any network use", () => {
  test("classifies none / token / invalid fragments", () => {
    expect(parseTemplateShareFragment("")).toEqual({ kind: "none" });
    expect(parseTemplateShareFragment("#other=abc")).toEqual({ kind: "none" });
    expect(parseTemplateShareFragment(`#template=${VALID_TOKEN}`)).toEqual({ kind: "token", token: VALID_TOKEN });
  });

  test("malformed, whitespace, overlong and unicode fragments are invalid", () => {
    for (const bad of [
      "#template=",
      "#template=" + "a".repeat(42),
      "#template=" + "a".repeat(44),
      "#template=" + "a".repeat(600),
      "#template=%20" + "a".repeat(40),
      "#template=" + "a".repeat(42) + " ",
      "#template=" + " 템".padEnd(44, "x"),
      "#template=" + encodeURIComponent("한글".repeat(22)),
      "#template=" + "a".repeat(43) + "\n"
    ]) {
      expect(parseTemplateShareFragment(bad), bad.slice(0, 40)).toEqual({ kind: "invalid" });
    }
    expect(isTemplateShareToken(VALID_TOKEN)).toBe(true);
    expect(isTemplateShareToken(`${VALID_TOKEN}extra`)).toBe(false);
  });
});

describe("templateApi.shared", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.example.test";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    vi.unstubAllGlobals();
  });

  test("requests nothing for malformed tokens and never echoes the raw value", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const bad of ["", "a".repeat(42), "a".repeat(44), "a".repeat(600), "%20abc", "a ".repeat(22), "한글".repeat(22)]) {
      await expect(templateApi.shared(bad)).rejects.toThrow("공유 링크 형식이 올바르지 않습니다.");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    let rejectionMessage = "UNEXPECTED SUCCESS";
    try { await templateApi.shared("r4nd0m/../secret-ish"); }
    catch (error) { rejectionMessage = error instanceof Error ? error.message : String(error); }
    expect(rejectionMessage).toContain("공유 링크 형식이 올바르지 않습니다.");
    expect(rejectionMessage).not.toContain("secret-ish");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("fetches only well-shaped tokens through the share endpoint", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ blueprint: TEMPLATE_SCENARIOS[0] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(templateApi.shared(VALID_TOKEN)).resolves.toEqual(TEMPLATE_SCENARIOS[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`https://api.example.test/template-shares/${VALID_TOKEN}`);
  });
});

describe("apply keeps every amount mandatory with an explicit zero", () => {
  const blueprint = TEMPLATE_SCENARIOS[0];
  test("any blank amount or blank income blocks a new space", () => {
    expect(() => buildTemplateBudget(blueprint, ["", "5000", "5000"], "100000")).toThrow();
    expect(() => buildTemplateBudget(blueprint, ["5000", "5000", "5000"], "")).toThrow();
    expect(() => buildTemplateBudget(blueprint, ["5000", " 5000 ", "5000"], "0")).toThrow();
  });
  test("explicit 0 is a real 0 and differs from an empty field", () => {
    const applied = buildTemplateBudget(blueprint, ["0", "0", "0"], "0");
    expect(applied.monthlyIncome).toBe(0);
    expect(applied.fixedCosts.every(item => item.amount === 0)).toBe(true);
  });
});
