import {
  createDefaultWorkspacePlanningData,
  workspacePlanningDataSchema,
  type WorkspacePlanningData
} from "@living-cost-manager/shared";
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

/** LCM1(예전 형식)는 가계부만 담고 계획 정보가 전혀 없다(planning: null —
 * 빈_CLEAR 로 취급하면 안 된다). LCM2 는 주간 예산·급여일·준비금 계획
 * 데이터만 담는다(서버 CAS revision/owner UID 등 남의 스코필드는 제외). */
export type ParsedLivingCostBackup = LivingCostBackup & { planning: WorkspacePlanningData | null };

const legacyMagicHeader = "LCM1";
const magicHeader = "LCM2";

/** planning 필드를 넘기면 LCM2(계획 포함), 생략하면 기존 LCM1 바이트 포맷 그대로.
 * LCM2 를 구버전 앱에 가져오면 마법헤더 불일치로 명시 실패한다 — 가계부만 조용히
 * 복원하고 계획을 잃는 일이 없다. */
export function buildLivingCostBackup(input: LivingCostBackup & { planning?: WorkspacePlanningData }): string {
  const { monthlyIncome, categories, cards, fixedCosts } = input;
  const planningSection = input.planning === undefined
    ? []
    : ["[planning]", writeRow(["json", JSON.stringify(input.planning ?? createDefaultWorkspacePlanningData())])];
  return [
    input.planning === undefined ? legacyMagicHeader : magicHeader,
    "[income]",
    writeRow(["monthlyIncome", String(sanitizeNumber(monthlyIncome, 0))]),
    "[categories]",
    writeRow(["id", "label"]),
    ...categories.map((category) => writeRow([category.id, category.label])),
    "[cards]",
    writeRow(["id", "label", "billingDay", "isEndOfMonth"]),
    ...cards.map((card) => writeRow([card.id, card.label, String(card.billingDay), String(card.isEndOfMonth)])),
    "[fixedCosts]",
    writeRow(["id", "name", "categoryId", "paymentMethodId", "paymentOptionId", "amount", "billingDay", "periodMonths", "isEndOfMonth", "billingAnchorDate", "renewalStatus", "potentialMonthlySavings", "confirmedMonthlySavings"]),
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
        String(item.isEndOfMonth), item.billingAnchorDate ?? "", item.renewalStatus ?? "unreviewed",
        String(item.potentialMonthlySavings ?? 0), String(item.confirmedMonthlySavings ?? 0)
      ])
    ),
    ...planningSection
  ].join("\n");
}

export function parseLivingCostBackup(content: string): ParsedLivingCostBackup {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = lines[0]?.trim();
  if (header !== magicHeader && header !== legacyMagicHeader) {
    throw new Error("Unsupported backup format");
  }

  const sections = readSections(lines.slice(1));
  const requiredHeaders: Record<string, string[]> = {
    income: ["monthlyIncome"], categories: ["id", "label"], cards: ["id", "label", "billingDay"],
    fixedCosts: ["id", "name", "categoryId", "paymentMethodId", "paymentOptionId", "amount", "billingDay"]
  };
  for (const [section, header] of Object.entries(requiredHeaders)) {
    const rows = sections.get(section);
    if (!rows || header.some((cell, index) => rows[0]?.[index] !== cell)) throw new Error("Incomplete backup: " + section);
    if (section !== "income") {
      const ids = new Set<string>();
      for (const row of rows.slice(1)) {
        if (row.length !== rows[0].length || !row[0] || !row[1] || ids.has(row[0])) throw new Error("Invalid backup row: " + section);
        ids.add(row[0]);
      }
    }
  }
  const income = sections.get("income")!;
  if (income.length !== 1 || income[0][1]?.trim() === "" || !Number.isFinite(Number(income[0][1]))) throw new Error("Invalid income");
  const monthlyIncome = parseIncome(sections.get("income") ?? []);
  const categories = parseCategories(sections.get("categories") ?? []);
  const cards = parseCards(sections.get("cards") ?? []);
  const fixedCosts = parseFixedCosts(sections.get("fixedCosts") ?? []);
  let planning: WorkspacePlanningData | null = null;
  if (header === magicHeader) {
    const rows = sections.get("planning");
    if (!rows || rows.length !== 1 || rows[0][0] !== "json" || rows[0].length !== 2 || !rows[0][1]) {
      throw new Error("Incomplete backup: planning");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rows[0][1]);
    } catch {
      throw new Error("Invalid backup row: planning");
    }
    const validated = workspacePlanningDataSchema.safeParse(decoded);
    if (!validated.success) throw new Error("Invalid backup row: planning");
    planning = validated.data;
  } else if (sections.has("planning")) {
    // LCM1 파일에 planning 섹션이 있으면 형식 혼합 — 조용히 계획만 버리지 않는다.
    throw new Error("Invalid backup: planning in legacy file");
  }

  return {
    monthlyIncome,
    categories: mergeCategories(DEFAULT_CATEGORIES, categories),
    cards,
    fixedCosts,
    planning
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
      if (sections.has(currentSection)) throw new Error("Duplicate backup section");
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
        isEndOfMonth: row[8] === "true",
        billingAnchorDate: row[9] || null,
        renewalStatus: (row[10] || "unreviewed") as FixedCost["renewalStatus"],
        potentialMonthlySavings: Number(row[11] || 0),
        confirmedMonthlySavings: Number(row[12] || 0)
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

  return Math.max(0, Math.round(value * 10) / 10);
}
