import { describe, expect, test } from "vitest";
import { isServerSession, parseBudgetSnapshot } from "../app/lib/storage";
import { buildSnapshotKey, getCurrentBudgetSnapshotFromState } from "../app/lib/snapshot";
import {
  authEmailMessage,
  authPasswordMessage,
  validateEmail,
  validateName,
  validatePassword
} from "../app/lib/validation";
import { getErrorMessage, getServerSyncErrorMessage, mapServerErrorMessage } from "../app/lib/serverMessages";
import { EMAIL_NOT_VERIFIED_CODE, ServerApiError } from "../app/lib/serverApi";
import { DEFAULT_CARDS } from "../app/lib/cards";
import { DEFAULT_CATEGORIES } from "../app/lib/budget";

// These helpers moved out of page.tsx during the hooks refactor. Pinning them
// here guards the refactor's "behavior preserved" promise.

describe("parseBudgetSnapshot", () => {
  test("falls back to the sample snapshot when nothing is stored", () => {
    const result = parseBudgetSnapshot(null);
    expect(result.recovered).toBe(false);
    expect(result.snapshot.monthlyIncome).toBe(3_000_000);
  });

  test("marks recovery for corrupt JSON", () => {
    const result = parseBudgetSnapshot("{not-json");
    expect(result.recovered).toBe(true);
    expect(result.snapshot.categories).toEqual(DEFAULT_CATEGORIES);
  });

  test("normalizes stored values (income clamp/round, merge with defaults)", () => {
    const result = parseBudgetSnapshot(
      JSON.stringify({
        monthlyIncome: -5.4,
        fixedCosts: [{ id: "a", name: "A", amount: 1000 }],
        categories: [{ id: "custom-1", label: "커스텀" }],
        cards: [{ id: "card-1", label: "카드", billingDay: 99, isEndOfMonth: false }]
      })
    );
    expect(result.recovered).toBe(false);
    expect(result.snapshot.monthlyIncome).toBe(0);
    expect(result.snapshot.categories.some((c) => c.id === "custom-1")).toBe(true);
    expect(result.snapshot.categories.length).toBeGreaterThan(1); // defaults merged
    expect(result.snapshot.cards.length).toBeGreaterThan(0);
  });
});

describe("isServerSession", () => {
  test("accepts a complete session", () => {
    expect(
      isServerSession({
        token: "t",
        refreshToken: "r",
        user: { id: "u", email: "e@x.com", name: "n" },
        workspace: null
      })
    ).toBe(true);
  });

  test("rejects partial / empty shapes", () => {
    expect(isServerSession(null)).toBe(false);
    expect(isServerSession({ token: "", refreshToken: "r", user: { id: "u", email: "e", name: "n" } } as never)).toBe(false);
    expect(isServerSession({ token: "t" } as never)).toBe(false);
  });
});

describe("buildSnapshotKey", () => {
  const base = {
    monthlyIncome: 3_000_000,
    categories: DEFAULT_CATEGORIES,
    cards: DEFAULT_CARDS,
    fixedCosts: []
  };

  test("is stable for equal content and ignores income noise", () => {
    expect(buildSnapshotKey(base)).toBe(buildSnapshotKey({ ...base, monthlyIncome: 3_000_000.4 }));
  });

  test("changes when a projected field changes", () => {
    expect(buildSnapshotKey({ ...base, monthlyIncome: 4_000_000 })).not.toBe(buildSnapshotKey(base));
  });
});

describe("getCurrentBudgetSnapshotFromState", () => {
  test("re-keys the budget snapshot", () => {
    const out = getCurrentBudgetSnapshotFromState({
      monthlyIncome: 1,
      fixedCosts: [],
      categories: DEFAULT_CATEGORIES,
      cards: DEFAULT_CARDS
    });
    expect(out).toEqual({ monthlyIncome: 1, categories: DEFAULT_CATEGORIES, cards: DEFAULT_CARDS, fixedCosts: [] });
  });
});

describe("validators", () => {
  test("submit-time email/password/name copy", () => {
    expect(validateEmail("  ")).toBe("이메일을 입력해주세요.");
    expect(validateEmail("nope")).toBe("올바른 이메일 형식이 아닙니다.");
    expect(validateEmail("a@b.co")).toBeNull();
    expect(validatePassword("short")).toBe("비밀번호는 8자 이상이어야 합니다.");
    expect(validatePassword("longenough")).toBeNull();
    expect(validateName(" ")).toBe("이름을 입력해주세요.");
  });

  test("blur-time (inline) messages use the spaced variant", () => {
    expect(authEmailMessage("")).toBe("이메일을 입력해 주세요.");
    expect(authPasswordMessage("")).toBe("비밀번호를 입력해 주세요.");
    expect(authPasswordMessage("12345678")).toBeNull();
  });
});

describe("server error messages", () => {
  test("maps bare status codes to friendly copy", () => {
    expect(mapServerErrorMessage(new ServerApiError("x", 400))).toBe("입력값을 확인해주세요.");
    expect(mapServerErrorMessage(new ServerApiError("x", 409))).toBe("이미 가입된 이메일입니다.");
    expect(mapServerErrorMessage(new ServerApiError("x", 429))).toBe("요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
    expect(mapServerErrorMessage(new ServerApiError("x", 503))).toBe("서버에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.");
    expect(mapServerErrorMessage(new ServerApiError("x", 404))).toBeNull();
  });

  test("getErrorMessage falls through to Error.message for unmapped codes", () => {
    expect(getErrorMessage(new ServerApiError("boom", 404))).toBe("boom");
    expect(getErrorMessage("nope")).toBe("서버 요청에 실패했습니다.");
  });

  test("getServerSyncErrorMessage distinguishes verification vs auth failures", () => {
    expect(getServerSyncErrorMessage(new ServerApiError("x", 403, EMAIL_NOT_VERIFIED_CODE))).toContain("이메일 인증");
    expect(getServerSyncErrorMessage(new ServerApiError("x", 401))).toContain("다시 로그인");
    expect(getServerSyncErrorMessage(new ServerApiError("x", 404))).toBe("x");
  });
});
