export type Category = {
  id: string;
  label: string;
};

export type FixedCost = {
  id: string;
  name: string;
  categoryId: string;
  paymentMethodId: PaymentMethodId;
  paymentOptionId: string;
  amount: number;
  billingDay: number;
};

export type PaymentMethodId = "cash" | "bank-transfer" | "debit-card" | "credit-card" | "other";

export type PaymentMethod = {
  id: PaymentMethodId;
  label: string;
};

export type PaymentOption = {
  id: string;
  label: string;
  paymentMethodId: PaymentMethodId;
};

export type CategoryBucket = {
  categoryId: string;
  label: string;
  amount: number;
};

export type CategoryPieSegment = CategoryBucket & {
  percent: number;
  startPercent: number;
  endPercent: number;
};

export type BudgetSummary = {
  monthlyExpense: number;
  annualExpense: number;
  remainingIncome: number;
  expenseRate: number;
  averageExpense: number;
  highestCost: FixedCost | null;
};

type FixedCostInput = {
  id: string;
  name: string;
  categoryId?: string;
  category?: string;
  paymentMethodId?: PaymentMethodId;
  paymentOptionId?: string;
  cardId?: string;
  amount: number;
  billingDay: number;
  paymentMethod?: string;
};

const labelIdMap: Record<string, string> = {
  주거: "housing",
  통신: "telecom",
  보험: "insurance",
  구독: "subscription",
  교통: "transport",
  기타: "other",
  교육: "education"
};

export const DEFAULT_CATEGORIES: Category[] = [
  { id: "housing", label: "주거" },
  { id: "telecom", label: "통신" },
  { id: "insurance", label: "보험" },
  { id: "subscription", label: "구독" },
  { id: "transport", label: "교통" },
  { id: "other", label: "기타" }
];

export const PAYMENT_METHODS: PaymentMethod[] = [
  { id: "cash", label: "현금" },
  { id: "bank-transfer", label: "계좌이체" },
  { id: "debit-card", label: "체크카드" },
  { id: "credit-card", label: "신용카드" },
  { id: "other", label: "기타" }
];

export const BANK_TRANSFER_OPTIONS: PaymentOption[] = [
  { id: "auto-transfer", label: "자동이체", paymentMethodId: "bank-transfer" },
  { id: "manual-transfer", label: "수동이체", paymentMethodId: "bank-transfer" },
  { id: "scheduled-transfer", label: "예약이체", paymentMethodId: "bank-transfer" },
  { id: "cms-giro", label: "CMS/지로", paymentMethodId: "bank-transfer" }
];

export function createCategory(label: string): Category {
  const cleanLabel = sanitizeText(label, "새 카테고리");

  return {
    id: labelIdMap[cleanLabel] ?? "custom-" + slugifyLabel(cleanLabel),
    label: cleanLabel
  };
}

export function createFixedCost(input: FixedCostInput): FixedCost {
  return updateFixedCost(
    {
      id: input.id,
      name: "",
      categoryId: "other",
      paymentMethodId: "bank-transfer",
      paymentOptionId: "auto-transfer",
      amount: 0,
      billingDay: 1
    },
    {
      name: input.name,
      categoryId: input.categoryId ?? categoryIdFromLabel(input.category),
      paymentMethodId: input.paymentMethodId ?? paymentMethodIdFromLegacyPaymentMethod(input.paymentMethod),
      paymentOptionId: input.paymentOptionId ?? input.cardId ?? paymentOptionIdFromLegacyPaymentMethod(input.paymentMethod),
      amount: input.amount,
      billingDay: input.billingDay
    }
  );
}

export function updateFixedCost(item: FixedCost, patch: Partial<Omit<FixedCost, "id">>): FixedCost {
  const paymentMethodId = sanitizePaymentMethodId(patch.paymentMethodId ?? item.paymentMethodId);

  return {
    ...item,
    ...patch,
    name: sanitizeText(patch.name ?? item.name, "새 항목"),
    categoryId: sanitizeCategoryId(patch.categoryId ?? item.categoryId),
    paymentMethodId,
    paymentOptionId: sanitizePaymentOptionId(paymentMethodId, patch.paymentOptionId ?? item.paymentOptionId),
    amount: clampNumber(patch.amount ?? item.amount, 0, Number.MAX_SAFE_INTEGER),
    billingDay: clampNumber(patch.billingDay ?? item.billingDay, 1, 31)
  };
}

export function buildBudgetSummary(items: FixedCost[], monthlyIncome: number): BudgetSummary {
  const monthlyExpense = items.reduce((sum, item) => sum + item.amount, 0);
  const highestCost = items.reduce<FixedCost | null>(
    (highest, item) => (!highest || item.amount > highest.amount ? item : highest),
    null
  );

  return {
    monthlyExpense,
    annualExpense: monthlyExpense * 12,
    remainingIncome: monthlyIncome - monthlyExpense,
    expenseRate: monthlyIncome > 0 ? roundToOneDecimal((monthlyExpense / monthlyIncome) * 100) : 0,
    averageExpense: items.length > 0 ? Math.round(monthlyExpense / items.length) : 0,
    highestCost
  };
}

export function getCategoryBuckets(items: FixedCost[], categories: Category[]): CategoryBucket[] {
  const totals = items.reduce<Record<string, number>>((bucketMap, item) => {
    bucketMap[item.categoryId] = (bucketMap[item.categoryId] ?? 0) + item.amount;
    return bucketMap;
  }, {});

  return Object.entries(totals)
    .map(([categoryId, amount]) => ({
      categoryId,
      label: getCategoryLabel(categories, categoryId),
      amount
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function getCategoryLabel(categories: Category[], categoryId: string): string {
  return categories.find((category) => category.id === categoryId)?.label ?? categoryId;
}

export function getCategoryPieSegments(buckets: CategoryBucket[]): CategoryPieSegment[] {
  const total = buckets.reduce((sum, bucket) => sum + bucket.amount, 0);
  let cursor = 0;

  if (total <= 0) {
    return buckets.map((bucket) => ({ ...bucket, percent: 0, startPercent: 0, endPercent: 0 }));
  }

  return buckets.map((bucket, index) => {
    const percent = index === buckets.length - 1 ? roundToOneDecimal(100 - cursor) : roundToOneDecimal((bucket.amount / total) * 100);
    const segment = {
      ...bucket,
      percent,
      startPercent: cursor,
      endPercent: roundToOneDecimal(cursor + percent)
    };
    cursor = segment.endPercent;
    return segment;
  });
}

export function getPieSegmentAtPercent(
  segments: CategoryPieSegment[],
  percent: number
): CategoryPieSegment | null {
  if (segments.length === 0 || !Number.isFinite(percent)) {
    return null;
  }

  const normalized = ((percent % 100) + 100) % 100;
  return segments.find((segment) => normalized >= segment.startPercent && normalized < segment.endPercent) ?? segments.at(-1) ?? null;
}

export function renameCategory(categories: Category[], categoryId: string, label: string): Category[] {
  if (isDefaultCategory(categoryId)) {
    return categories;
  }

  return categories.map((category) =>
    category.id === categoryId ? { ...category, label: sanitizeText(label, category.label) } : category
  );
}

export function deleteCategory(
  categories: Category[],
  items: FixedCost[],
  categoryId: string
): { categories: Category[]; items: FixedCost[] } {
  if (isDefaultCategory(categoryId)) {
    return { categories, items };
  }

  return {
    categories: categories.filter((category) => category.id !== categoryId),
    items: items.map((item) => (item.categoryId === categoryId ? updateFixedCost(item, { categoryId: "other" }) : item))
  };
}

export function isDefaultCategory(categoryId: string): boolean {
  return DEFAULT_CATEGORIES.some((category) => category.id === categoryId);
}

function categoryIdFromLabel(label: string | undefined): string {
  if (!label) {
    return "other";
  }

  return labelIdMap[label.trim()] ?? createCategory(label).id;
}

function paymentOptionIdFromLegacyPaymentMethod(paymentMethod: string | undefined): string {
  if (!paymentMethod) {
    return "auto-transfer";
  }

  const legacyMap: Record<string, string> = {
    자동이체: "auto-transfer",
    계좌이체: "auto-transfer"
  };

  return legacyMap[paymentMethod.trim()] ?? "";
}

function paymentMethodIdFromLegacyPaymentMethod(paymentMethod: string | undefined): PaymentMethodId {
  if (!paymentMethod) {
    return "bank-transfer";
  }

  const legacyMap: Record<string, PaymentMethodId> = {
    현금: "cash",
    자동이체: "bank-transfer",
    계좌이체: "bank-transfer",
    체크카드: "debit-card",
    카드: "credit-card",
    신용카드: "credit-card",
    기타: "other"
  };

  return legacyMap[paymentMethod.trim()] ?? "other";
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeCategoryId(value: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return sanitized.length > 0 ? sanitized : "other";
}

function sanitizePaymentOptionId(paymentMethodId: PaymentMethodId, value: string): string {
  if (paymentMethodId === "bank-transfer") {
    const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
    return BANK_TRANSFER_OPTIONS.some((option) => option.id === sanitized) ? sanitized : "auto-transfer";
  }

  if (paymentMethodId !== "credit-card") {
    return "";
  }

  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return sanitized.length > 0 ? sanitized : "";
}

function sanitizePaymentMethodId(value: PaymentMethodId): PaymentMethodId {
  return PAYMENT_METHODS.some((method) => method.id === value) ? value : "other";
}

function sanitizeText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function slugifyLabel(value: string): string {
  const asciiSlug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (asciiSlug.length > 0) {
    return asciiSlug;
  }

  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }

  return hash.toString(36);
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
