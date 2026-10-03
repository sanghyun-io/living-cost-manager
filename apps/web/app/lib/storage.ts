// Browser storage helpers shared by the page hooks (users, budget, server
// session). Moved out of page.tsx during the hooks refactor; behavior is
// unchanged.
import {
  createFixedCost,
  DEFAULT_CATEGORIES,
  type Category,
  type FixedCost
} from "./budget";
import { DEFAULT_CARDS, type PaymentCard } from "./cards";
import { mergeCards, mergeCategories } from "./formatting";
import { emptyBudgetSnapshot } from "./seedData";
import type { BudgetSnapshot } from "./pageTypes";
import type { ServerSession } from "./serverApi";

export const USERS_KEY = "living-cost-manager:users:v1";
export const ACTIVE_USER_KEY = "living-cost-manager:active-user:v1";
export const STORAGE_KEY = "living-cost-manager:v2";
export const LEGACY_STORAGE_KEY = "living-cost-manager:v1";

export function readJson<T>(key: string, fallback: T): T {
  const stored = window.localStorage.getItem(key);
  if (!stored) {
    return fallback;
  }

  try {
    return JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

export function parseBudgetSnapshot(stored: string | null): { snapshot: BudgetSnapshot; recovered: boolean } {
  const fallback = emptyBudgetSnapshot;

  if (!stored) {
    return { snapshot: fallback, recovered: false };
  }

  try {
    const parsed = JSON.parse(stored) as {
      monthlyIncome?: number;
      fixedCosts?: FixedCost[];
      categories?: Category[];
      cards?: PaymentCard[];
    };

    return {
      snapshot: {
      monthlyIncome: typeof parsed.monthlyIncome === "number" ? Math.max(0, Math.round(parsed.monthlyIncome)) : fallback.monthlyIncome,
      fixedCosts: Array.isArray(parsed.fixedCosts) ? parsed.fixedCosts.map((item) => createFixedCost(item)) : fallback.fixedCosts,
      categories: Array.isArray(parsed.categories) ? mergeCategories(DEFAULT_CATEGORIES, parsed.categories) : fallback.categories,
      cards: Array.isArray(parsed.cards) ? mergeCards(DEFAULT_CARDS, parsed.cards) : fallback.cards
      },
      recovered: false
    };
  } catch {
    return { snapshot: fallback, recovered: true };
  }
}

// Type guard for a session read back from localStorage (the shape can be
// stale JSON from older app versions).
export function isServerSession(value: ServerSession | null): value is ServerSession {
  return (
    !!value &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.refreshToken === "string" &&
    value.refreshToken.length > 0 &&
    typeof value.user?.id === "string" &&
    typeof value.user?.email === "string" &&
    typeof value.user?.name === "string"
  );
}

// Auth deep links are delivered as root query params (?reset_token /
// ?verify_token); once handled, the param is stripped so reloads don't
// re-trigger the flow.
export function clearAuthQueryParam(key: string) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete(key);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
