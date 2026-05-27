// Pure display/parsing helpers shared by page.tsx and its extracted components.
// No React, no state — safe to import anywhere.
import {
  BANK_TRANSFER_OPTIONS,
  getCategoryPieSegments,
  type Category,
  type FixedCost
} from "./budget";
import { normalizePaymentCard, type PaymentCard } from "./cards";

export function formatWon(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0
  }).format(amount);
}

export function parseCurrencyInput(value: string) {
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

export function parsePeriodInput(value: string) {
  const parsed = Number(value.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(1, Math.round(parsed * 10) / 10);
}

export function formatNumberInput(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 0
  }).format(value);
}

export function formatSaveTime(value: Date) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(value);
}

export function clampBillingDay(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(31, Math.max(1, Math.round(value)));
}

export function mergeCategories(baseCategories: Category[], incomingCategories: Category[]) {
  const categoryMap = new Map<string, Category>();
  for (const category of baseCategories) {
    categoryMap.set(category.id, category);
  }
  for (const category of incomingCategories) {
    categoryMap.set(category.id, category);
  }

  return Array.from(categoryMap.values());
}

export function mergeCards(baseCards: PaymentCard[], incomingCards: PaymentCard[]) {
  const cardMap = new Map<string, PaymentCard>();
  for (const card of baseCards) {
    cardMap.set(card.id, card);
  }
  for (const card of incomingCards) {
    if (card.id === "main-credit-card" && card.label === "주 신용카드") {
      continue;
    }
    cardMap.set(card.id, normalizePaymentCard(card));
  }

  return Array.from(cardMap.values());
}

export function getPaymentOptions(paymentMethodId: FixedCost["paymentMethodId"], cards: PaymentCard[]) {
  if (paymentMethodId === "bank-transfer") {
    return BANK_TRANSFER_OPTIONS;
  }

  if (paymentMethodId === "credit-card") {
    return cards;
  }

  return [];
}

export const chartColors = ["#167761", "#235c9f", "#ad3b5f", "#d68b34", "#6d5bd0", "#4b8f8c", "#7b8794"];

export function buildPieBackground(segments: ReturnType<typeof getCategoryPieSegments>) {
  if (segments.length === 0 || segments.every((segment) => segment.amount === 0)) {
    return "#eef3f8";
  }

  const stops = segments.map((segment, index) => {
    const color = chartColors[index % chartColors.length];
    return `${color} ${segment.startPercent}% ${segment.endPercent}%`;
  });

  return `conic-gradient(${stops.join(", ")})`;
}
