import { describe, expect, test } from "vitest";
import {
  buildBudgetSummary,
  BANK_TRANSFER_OPTIONS,
  createCategory,
  createFixedCost,
  DEFAULT_CATEGORIES,
  deleteCategory,
  getCategoryBuckets,
  getCategoryPieSegments,
  getPieSegmentAtPercent,
  renameCategory,
  updateFixedCost
} from "../app/lib/budget";
import {
  buildFixedCostCsvTemplate,
  parseFixedCostCsvTemplate
} from "../app/lib/budgetImportExport";
import {
  buildLivingCostBackup,
  parseLivingCostBackup
} from "../app/lib/backup";
import {
  createPaymentCard,
  DEFAULT_CARDS,
  deletePaymentCard,
  renamePaymentCard,
  updatePaymentCard
} from "../app/lib/cards";
import { createUser, getUserDataKey, mergeUsers } from "../app/lib/users";

describe("fixed cost dashboard", () => {
  test("summarizes fixed costs against monthly income", () => {
    const fixedCosts = [
      createFixedCost({ id: "rent", name: "월세", categoryId: "housing", amount: 650000, billingDay: 25 }),
      createFixedCost({ id: "phone", name: "통신비", categoryId: "telecom", amount: 79000, billingDay: 10 })
    ];

    const summary = buildBudgetSummary(fixedCosts, 3_000_000);

    expect(summary.monthlyExpense).toBe(729_000);
    expect(summary.annualExpense).toBe(8_748_000);
    expect(summary.remainingIncome).toBe(2_271_000);
    expect(summary.expenseRate).toBe(24.3);
  });

  test("updates editable fixed cost fields safely", () => {
    const item = createFixedCost({ id: "rent", name: "월세", categoryId: "housing", amount: 650000, billingDay: 25 });

    const updated = updateFixedCost(item, {
      amount: -5000,
      billingDay: 47,
      categoryId: "insurance",
      paymentMethodId: "credit-card",
      paymentOptionId: "card-living"
    });

    expect(updated.amount).toBe(0);
    expect(updated.billingDay).toBe(31);
    expect(updated.categoryId).toBe("insurance");
    expect(updated.paymentMethodId).toBe("credit-card");
    expect(updated.paymentOptionId).toBe("card-living");
  });

  test("keeps payment option empty except for supported payment methods", () => {
    const item = createFixedCost({
      id: "phone",
      name: "통신비",
      categoryId: "telecom",
      paymentMethodId: "credit-card",
      paymentOptionId: "card-living",
      amount: 79000,
      billingDay: 10
    });

    const cashItem = updateFixedCost(item, { paymentMethodId: "cash" });
    expect(cashItem.paymentMethodId).toBe("cash");
    expect(cashItem.paymentOptionId).toBe("");

    const transferItem = updateFixedCost(cashItem, { paymentMethodId: "bank-transfer" });
    expect(transferItem.paymentMethodId).toBe("bank-transfer");
    expect(transferItem.paymentOptionId).toBe("auto-transfer");

    const manualTransferItem = updateFixedCost(transferItem, { paymentOptionId: "manual-transfer" });
    expect(manualTransferItem.paymentOptionId).toBe("manual-transfer");

    const creditItem = updateFixedCost(manualTransferItem, { paymentMethodId: "credit-card", paymentOptionId: "card-living" });
    expect(creditItem.paymentMethodId).toBe("credit-card");
    expect(creditItem.paymentOptionId).toBe("card-living");
  });

  test("provides bank transfer payment options", () => {
    expect(BANK_TRANSFER_OPTIONS).toEqual([
      { id: "auto-transfer", label: "자동이체", paymentMethodId: "bank-transfer" },
      { id: "manual-transfer", label: "수동이체", paymentMethodId: "bank-transfer" },
      { id: "scheduled-transfer", label: "예약이체", paymentMethodId: "bank-transfer" },
      { id: "cms-giro", label: "CMS/지로", paymentMethodId: "bank-transfer" }
    ]);
  });

  test("groups category buckets by category id and displays category labels", () => {
    const categories = [...DEFAULT_CATEGORIES, createCategory("교육")];
    const fixedCosts = [
      createFixedCost({ id: "rent", name: "월세", categoryId: "housing", amount: 650000, billingDay: 25 }),
      createFixedCost({ id: "loan", name: "관리비", categoryId: "housing", amount: 120000, billingDay: 20 }),
      createFixedCost({ id: "academy", name: "학원비", categoryId: "education", amount: 300000, billingDay: 10 }),
      createFixedCost({ id: "phone", name: "통신비", categoryId: "telecom", amount: 79000, billingDay: 10 })
    ];

    expect(getCategoryBuckets(fixedCosts, categories)).toEqual([
      { categoryId: "housing", label: "주거", amount: 770000 },
      { categoryId: "education", label: "교육", amount: 300000 },
      { categoryId: "telecom", label: "통신", amount: 79000 }
    ]);
  });

  test("builds pie chart segments from category buckets", () => {
    const segments = getCategoryPieSegments([
      { categoryId: "housing", label: "주거", amount: 700000 },
      { categoryId: "telecom", label: "통신", amount: 300000 }
    ]);

    expect(segments).toEqual([
      { categoryId: "housing", label: "주거", amount: 700000, percent: 70, startPercent: 0, endPercent: 70 },
      { categoryId: "telecom", label: "통신", amount: 300000, percent: 30, startPercent: 70, endPercent: 100 }
    ]);
  });

  test("finds a pie chart segment by hover percent", () => {
    const segments = getCategoryPieSegments([
      { categoryId: "housing", label: "주거", amount: 700000 },
      { categoryId: "telecom", label: "통신", amount: 300000 }
    ]);

    expect(getPieSegmentAtPercent(segments, 20)?.categoryId).toBe("housing");
    expect(getPieSegmentAtPercent(segments, 80)?.categoryId).toBe("telecom");
    expect(getPieSegmentAtPercent(segments, 101)?.categoryId).toBe("housing");
  });

  test("renames custom categories while keeping their ids stable", () => {
    const category = createCategory("교육");
    const categories = [...DEFAULT_CATEGORIES, category];

    const renamed = renameCategory(categories, category.id, "자기계발");

    expect(renamed.find((item) => item.id === category.id)).toEqual({
      id: category.id,
      label: "자기계발"
    });
  });

  test("deletes only custom categories and moves linked costs to other", () => {
    const customCategory = createCategory("교육");
    const categories = [...DEFAULT_CATEGORIES, customCategory];
    const fixedCosts = [
      createFixedCost({ id: "academy", name: "학원비", categoryId: customCategory.id, amount: 300000, billingDay: 10 }),
      createFixedCost({ id: "rent", name: "월세", categoryId: "housing", amount: 650000, billingDay: 25 })
    ];

    const defaultDeleteResult = deleteCategory(categories, fixedCosts, "housing");
    expect(defaultDeleteResult.categories).toHaveLength(categories.length);
    expect(defaultDeleteResult.items[1].categoryId).toBe("housing");

    const customDeleteResult = deleteCategory(categories, fixedCosts, customCategory.id);
    expect(customDeleteResult.categories.some((category) => category.id === customCategory.id)).toBe(false);
    expect(customDeleteResult.items[0].categoryId).toBe("other");
  });

  test("creates stable user ids for user-scoped budget storage", () => {
    const user = createUser("민수");

    expect(user.name).toBe("민수");
    expect(user.id).toMatch(/^user-/);
    expect(getUserDataKey(user.id)).toContain("living-cost-manager:user:");
  });

  test("merges known users without duplicating the same account", () => {
    const user = createUser("mina");

    expect(mergeUsers([user], createUser("mina"))).toEqual([user]);
    expect(mergeUsers([user], createUser("june"))).toHaveLength(2);
  });

  test("renames custom payment cards while keeping ids stable", () => {
    const card = createPaymentCard("생활비 카드", 14);
    const cards = [card];

    const renamed = renamePaymentCard(cards, card.id, "우리 생활카드");

    expect(renamed.find((item) => item.id === card.id)).toEqual({
      id: card.id,
      label: "우리 생활카드",
      billingDay: 14
    });
  });

  test("updates payment card billing day safely", () => {
    const card = createPaymentCard("생활비 카드", 14);
    const updated = updatePaymentCard([card], card.id, { billingDay: 47 });

    expect(updated[0]).toEqual({
      id: card.id,
      label: "생활비 카드",
      billingDay: 31
    });
  });

  test("deletes only custom payment cards and clears linked credit-card selection", () => {
    const customCard = createPaymentCard("생활비 카드", 14);
    const cards = [customCard];
    const fixedCosts = [
      createFixedCost({
        id: "phone",
        name: "통신비",
        categoryId: "telecom",
        paymentMethodId: "credit-card",
        paymentOptionId: customCard.id,
        amount: 79000,
        billingDay: 10
      }),
      createFixedCost({
        id: "rent",
        name: "월세",
        categoryId: "housing",
        paymentMethodId: "bank-transfer",
        paymentOptionId: "auto-transfer",
        amount: 650000,
        billingDay: 25
      })
    ];

    expect(DEFAULT_CARDS).toEqual([]);

    const defaultDeleteResult = deletePaymentCard(cards, fixedCosts, "missing-card");
    expect(defaultDeleteResult.cards).toHaveLength(cards.length);
    expect(defaultDeleteResult.items[1].paymentOptionId).toBe("auto-transfer");

    const customDeleteResult = deletePaymentCard(cards, fixedCosts, customCard.id);
    expect(customDeleteResult.cards.some((card) => card.id === customCard.id)).toBe(false);
    expect(customDeleteResult.items[0].paymentMethodId).toBe("credit-card");
    expect(customDeleteResult.items[0].paymentOptionId).toBe("");
  });

  test("exports and imports an Excel-compatible fixed cost template", () => {
    const card = createPaymentCard("생활비 카드", 10);
    const fixedCosts = [
      createFixedCost({
        id: "rent",
        name: "월세",
        categoryId: "housing",
        paymentMethodId: "bank-transfer",
        paymentOptionId: "manual-transfer",
        amount: 650000,
        billingDay: 25
      }),
      createFixedCost({
        id: "phone",
        name: "통신비",
        categoryId: "telecom",
        paymentMethodId: "credit-card",
        paymentOptionId: card.id,
        amount: 79000,
        billingDay: 10
      })
    ];

    const csv = buildFixedCostCsvTemplate({
      fixedCosts,
      categories: DEFAULT_CATEGORIES,
      cards: [card]
    });

    expect(csv).toContain("카테고리ID");
    expect(csv).toContain("manual-transfer");
    expect(csv).toContain("생활비 카드");

    const imported = parseFixedCostCsvTemplate({
      csv,
      categories: DEFAULT_CATEGORIES,
      cards: []
    });

    expect(imported.importedCount).toBe(2);
    expect(imported.fixedCosts[0]).toMatchObject({
      id: "rent",
      categoryId: "housing",
      paymentMethodId: "bank-transfer",
      paymentOptionId: "manual-transfer"
    });
    expect(imported.fixedCosts[1].paymentMethodId).toBe("credit-card");
    expect(imported.fixedCosts[1].paymentOptionId).toBe(card.id);
    expect(imported.cards).toEqual([{ id: card.id, label: "생활비 카드", billingDay: 10 }]);
  });

  test("exports and imports the full app state with the lcm backup format", () => {
    const card = createPaymentCard("생활비 카드", 21);
    const customCategory = createCategory("운동");
    const fixedCosts = [
      createFixedCost({
        id: "gym",
        name: "헬스장",
        categoryId: customCategory.id,
        paymentMethodId: "credit-card",
        paymentOptionId: card.id,
        amount: 99000,
        billingDay: 21
      })
    ];

    const backup = buildLivingCostBackup({
      monthlyIncome: 4_200_000,
      categories: [...DEFAULT_CATEGORIES, customCategory],
      cards: [card],
      fixedCosts
    });

    expect(backup.startsWith("LCM1\n")).toBe(true);
    expect(backup).toContain("[fixedCosts]");
    expect(backup).toContain("생활비 카드");

    const imported = parseLivingCostBackup(backup);

    expect(imported.monthlyIncome).toBe(4_200_000);
    expect(imported.cards).toEqual([{ id: card.id, label: "생활비 카드", billingDay: 21 }]);
    expect(imported.categories.some((category) => category.id === customCategory.id)).toBe(true);
    expect(imported.fixedCosts).toEqual(fixedCosts);
  });
});
