// Seed / sample budget data used when bootstrapping a fresh local user.
import { createFixedCost, DEFAULT_CATEGORIES, type FixedCost } from "./budget";
import { DEFAULT_CARDS } from "./cards";
import type { BudgetSnapshot } from "./pageTypes";

export const seedFixedCosts: FixedCost[] = [
  createFixedCost({
    id: "rent",
    name: "월세",
    categoryId: "housing",
    paymentMethodId: "bank-transfer",
    amount: 650000,
    billingDay: 25
  }),
  createFixedCost({
    id: "phone",
    name: "통신비",
    categoryId: "telecom",
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    amount: 79000,
    billingDay: 10
  }),
  createFixedCost({
    id: "insurance",
    name: "보험료",
    categoryId: "insurance",
    paymentMethodId: "bank-transfer",
    amount: 155000,
    billingDay: 15
  }),
  createFixedCost({
    id: "subscription",
    name: "구독 서비스",
    categoryId: "subscription",
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    amount: 35000,
    billingDay: 5
  }),
  createFixedCost({
    id: "transport",
    name: "교통 정기권",
    categoryId: "transport",
    paymentMethodId: "debit-card",
    amount: 120000,
    billingDay: 1
  })
];

export const sampleBudgetSnapshot: BudgetSnapshot = {
  monthlyIncome: 3_000_000,
  fixedCosts: seedFixedCosts,
  categories: DEFAULT_CATEGORIES,
  cards: DEFAULT_CARDS
};

export const emptyBudgetSnapshot: BudgetSnapshot = {
  monthlyIncome: 0,
  fixedCosts: [],
  categories: DEFAULT_CATEGORIES,
  cards: DEFAULT_CARDS
};
