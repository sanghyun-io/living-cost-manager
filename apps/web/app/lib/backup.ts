import {
  createFixedCost,
  DEFAULT_CATEGORIES,
  type Category,
  type FixedCost
} from "./budget";
import { normalizePaymentCard, type PaymentCard } from "./cards";

export type LivingCostBackup = {
  monthlyIncome: number;
  fixedCosts: FixedCost[];
  categories: Category[];
  cards: PaymentCard[];
};

const magicHeader = "LCM1";

export function buildLivingCostBackup({ monthlyIncome, categories, cards, fixedCosts }: LivingCostBackup): string {
  return [
    magicHeader,
    "[income]",
    writeRow(["monthlyIncome", String(sanitizeNumber(monthlyIncome, 0))]),
    "[categories]",
    writeRow(["id", "label"]),
    ...categories.map((category) => writeRow([category.id, category.label])),
    "[cards]",
    writeRow(["id", "label", "billingDay", "isEndOfMonth"]),
    ...cards.map((card) => writeRow([card.id, card.label, String(card.billingDay), String(card.isEndOfMonth)])),
    "[fixedCosts]",
    writeRow(["id", "name", "categoryId", "paymentMethodId", "paymentOptionId", "amount", "billingDay", "periodMonths", "isEndOfMonth"]),
    ...fixedCosts.map((item) =>
      writeRow([
        item.id,
        item.name,
        item.categoryId,
        item.paymentMethodId,
        item.paymentOptionId,
        String(item.amount),
        String(item.billingDay),
        String(item.periodMonths),
        String(item.isEndOfMonth)
      ])
    )
  ].join("\n");
}

export function parseLivingCostBackup(content: string): LivingCostBackup {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== magicHeader) {
    throw new Error("Unsupported backup format");
  }

  const sections = readSections(lines.slice(1));
  const monthlyIncome = parseIncome(sections.get("income") ?? []);
  const categories = parseCategories(sections.get("categories") ?? []);
  const cards = parseCards(sections.get("cards") ?? []);
  const fixedCosts = parseFixedCosts(sections.get("fixedCosts") ?? []);

  return {
    monthlyIncome,
    categories: mergeCategories(DEFAULT_CATEGORIES, categories),
    cards,
    fixedCosts
  };
}

function readSections(lines: string[]): Map<string, string[][]> {
  const sections = new Map<string, string[][]>();
  let currentSection = "";

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const sectionMatch = line.match(/^\[([a-zA-Z0-9-]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections.set(currentSection, []);
      continue;
    }

    if (!currentSection) {
      continue;
    }

    sections.get(currentSection)!.push(readRow(line));
  }

  return sections;
}

function parseIncome(rows: string[][]): number {
  const monthlyIncomeRow = rows.find((row) => row[0] === "monthlyIncome");
  return sanitizeNumber(Number(monthlyIncomeRow?.[1]), 0);
}

function parseCategories(rows: string[][]): Category[] {
  return rows
    .slice(1)
    .filter((row) => row[0] && row[1])
    .map((row) => ({ id: sanitizeId(row[0], "other"), label: sanitizeText(row[1], row[0]) }));
}

function parseCards(rows: string[][]): PaymentCard[] {
  return rows
    .slice(1)
    .filter((row) => row[0] && row[1])
    .map((row) =>
      normalizePaymentCard({
        id: sanitizeId(row[0], "card-imported"),
        label: sanitizeText(row[1], "새 카드"),
        billingDay: sanitizeNumber(Number(row[2]), 1),
        isEndOfMonth: row[3] === "true"
      })
    );
}

function parseFixedCosts(rows: string[][]): FixedCost[] {
  return rows
    .slice(1)
    .filter((row) => row[0] && row[1])
    .map((row, index) =>
      createFixedCost({
        id: sanitizeId(row[0], "imported-cost-" + String(index + 1)),
        name: sanitizeText(row[1], "새 고정비"),
        categoryId: sanitizeId(row[2], "other"),
        paymentMethodId: row[3] as FixedCost["paymentMethodId"],
        paymentOptionId: row[4] ?? "",
        amount: sanitizeNumber(Number(row[5]), 0),
        billingDay: sanitizeNumber(Number(row[6]), 1),
        periodMonths: sanitizePeriodMonths(Number(row[7])),
        isEndOfMonth: row[8] === "true"
      })
    );
}

function mergeCategories(baseCategories: Category[], incomingCategories: Category[]): Category[] {
  const categoryMap = new Map<string, Category>();
  for (const category of baseCategories) {
    categoryMap.set(category.id, category);
  }
  for (const category of incomingCategories) {
    categoryMap.set(category.id, category);
  }
  return Array.from(categoryMap.values());
}

function writeRow(cells: string[]): string {
  return cells.map(escapeCell).join("\t");
}

function readRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      cell += unescapeChar(char);
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\t") {
      cells.push(cell);
      cell = "";
      continue;
    }

    cell += char;
  }

  cells.push(cell);
  return cells;
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function unescapeChar(char: string): string {
  if (char === "t") {
    return "\t";
  }
  if (char === "n") {
    return "\n";
  }
  if (char === "r") {
    return "\r";
  }
  return char;
}

function sanitizeId(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
  return sanitized || fallback;
}

function sanitizeText(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeNumber(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.round(value));
}

function sanitizePeriodMonths(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.round(value * 10) / 10);
}
