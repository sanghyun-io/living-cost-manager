import {
  BANK_TRANSFER_OPTIONS,
  createCategory,
  createFixedCost,
  getCategoryLabel,
  PAYMENT_METHODS,
  type Category,
  type FixedCost,
  type PaymentMethodId
} from "./budget";
import { createPaymentCard, type PaymentCard } from "./cards";

type ExportInput = {
  fixedCosts: FixedCost[];
  categories: Category[];
  cards: PaymentCard[];
};

type ImportInput = {
  csv: string;
  categories: Category[];
  cards: PaymentCard[];
};

export type FixedCostImportResult = {
  fixedCosts: FixedCost[];
  categories: Category[];
  cards: PaymentCard[];
  importedCount: number;
  skippedCount: number;
};

const columns = [
  "id",
  "항목",
  "카테고리ID",
  "카테고리",
  "결제수단ID",
  "결제수단",
  "결제옵션ID",
  "결제옵션",
  "납부일",
  "금액",
  "주기"
];

export function buildFixedCostCsvTemplate({ fixedCosts, categories, cards }: ExportInput): string {
  const rows = fixedCosts.map((item) => {
    const paymentMethod = PAYMENT_METHODS.find((method) => method.id === item.paymentMethodId);
    const paymentOption =
      item.paymentMethodId === "bank-transfer"
        ? BANK_TRANSFER_OPTIONS.find((option) => option.id === item.paymentOptionId)
        : cards.find((card) => card.id === item.paymentOptionId);

    return [
      item.id,
      item.name,
      item.categoryId,
      getCategoryLabel(categories, item.categoryId),
      item.paymentMethodId,
      paymentMethod?.label ?? "",
      item.paymentOptionId,
      paymentOption?.label ?? "",
      String(item.billingDay),
      String(item.amount),
      String(item.periodMonths)
    ];
  });

  return [columns, ...rows].map(formatCsvRow).join("\r\n");
}

export function parseFixedCostCsvTemplate({ csv, categories, cards }: ImportInput): FixedCostImportResult {
  const parsedRows = parseCsv(csv);
  const [headerRow, ...dataRows] = parsedRows;
  const headerMap = buildHeaderMap(headerRow ?? []);
  const nextCategories = [...categories];
  const nextCards = [...cards];
  const fixedCosts: FixedCost[] = [];
  let skippedCount = 0;

  dataRows.forEach((row, index) => {
    const name = getCell(row, headerMap, "항목");
    const amount = parseCurrencyAmount(getCell(row, headerMap, "금액"));

    if (!name && amount === 0) {
      skippedCount += 1;
      return;
    }

    const categoryId = resolveCategoryId({
      id: getCell(row, headerMap, "카테고리ID"),
      label: getCell(row, headerMap, "카테고리"),
      categories: nextCategories
    });
    const resolvedCategory = nextCategories.find((category) => category.id === categoryId);
    if (!resolvedCategory) {
      nextCategories.push(createCategory(getCell(row, headerMap, "카테고리") || categoryId));
    }

    const paymentMethodId = resolvePaymentMethodId({
      id: getCell(row, headerMap, "결제수단ID"),
      label: getCell(row, headerMap, "결제수단")
    });
    const paymentOptionId = resolvePaymentOptionId({
      id: getCell(row, headerMap, "결제옵션ID"),
      label: getCell(row, headerMap, "결제옵션"),
      paymentMethodId,
      billingDay: parseCurrencyAmount(getCell(row, headerMap, "납부일")) || 1,
      cards: nextCards
    });

    fixedCosts.push(
      createFixedCost({
        id: sanitizeImportId(getCell(row, headerMap, "id"), index),
        name: name || "새 고정비",
        categoryId,
        paymentMethodId,
        paymentOptionId,
        billingDay: parseCurrencyAmount(getCell(row, headerMap, "납부일")) || 1,
        amount,
        periodMonths: parseCurrencyAmount(getCell(row, headerMap, "주기")) || 1
      })
    );
  });

  return {
    fixedCosts,
    categories: nextCategories,
    cards: nextCards,
    importedCount: fixedCosts.length,
    skippedCount
  };
}

function resolveCategoryId({
  id,
  label,
  categories
}: {
  id: string;
  label: string;
  categories: Category[];
}): string {
  const byId = categories.find((category) => category.id === id);
  if (byId) {
    return byId.id;
  }

  const byLabel = categories.find((category) => category.label === label);
  if (byLabel) {
    return byLabel.id;
  }

  return createCategory(label || id || "기타").id;
}

function resolvePaymentMethodId({ id, label }: { id: string; label: string }): PaymentMethodId {
  const byId = PAYMENT_METHODS.find((method) => method.id === id);
  if (byId) {
    return byId.id;
  }

  const byLabel = PAYMENT_METHODS.find((method) => method.label === label);
  return byLabel?.id ?? "other";
}

function resolvePaymentOptionId({
  id,
  label,
  paymentMethodId,
  billingDay,
  cards
}: {
  id: string;
  label: string;
  paymentMethodId: PaymentMethodId;
  billingDay: number;
  cards: PaymentCard[];
}): string {
  if (paymentMethodId === "bank-transfer") {
    const byId = BANK_TRANSFER_OPTIONS.find((option) => option.id === id);
    const byLabel = BANK_TRANSFER_OPTIONS.find((option) => option.label === label);
    return byId?.id ?? byLabel?.id ?? "auto-transfer";
  }

  if (paymentMethodId !== "credit-card") {
    return "";
  }

  const byId = cards.find((card) => card.id === id);
  const byLabel = cards.find((card) => card.label === label);
  if (byId || byLabel) {
    return (byId ?? byLabel)!.id;
  }

  const cleanLabel = label || id;
  if (!cleanLabel) {
    return "";
  }

  const card = createPaymentCard(cleanLabel, billingDay);
  cards.push(card);
  return card.id;
}

function buildHeaderMap(headerRow: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headerRow.forEach((cell, index) => map.set(cell.trim().replace(/^\uFEFF/, ""), index));
  return map;
}

function getCell(row: string[], headerMap: Map<string, number>, column: string): string {
  const index = headerMap.get(column);
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function formatCsvRow(row: string[]): string {
  return row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",");
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const nextChar = csv[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => value.trim().length > 0));
}

function parseCurrencyAmount(value: string): number {
  const normalized = value.replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function sanitizeImportId(value: string, index: number): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
  return sanitized || "imported-cost-" + String(index + 1);
}
