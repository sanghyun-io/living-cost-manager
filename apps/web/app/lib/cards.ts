import { updateFixedCost, type FixedCost } from "./budget";

export type PaymentCard = {
  id: string;
  label: string;
  billingDay: number;
  isEndOfMonth: boolean;
};

export const DEFAULT_CARDS: PaymentCard[] = [];

export function createPaymentCard(label: string, billingDay = 1, isEndOfMonth = false): PaymentCard {
  const cleanLabel = sanitizeText(label, "새 카드");

  return {
    id: legacyCardIdMap[cleanLabel] ?? "card-" + slugifyLabel(cleanLabel),
    label: cleanLabel,
    billingDay: sanitizeBillingDay(billingDay),
    isEndOfMonth
  };
}

export function renamePaymentCard(cards: PaymentCard[], cardId: string, label: string): PaymentCard[] {
  if (isDefaultCard(cardId)) {
    return cards;
  }

  return cards.map((card) => (card.id === cardId ? { ...card, label: sanitizeText(label, card.label) } : card));
}

export function updatePaymentCard(cards: PaymentCard[], cardId: string, patch: Partial<Omit<PaymentCard, "id">>): PaymentCard[] {
  if (isDefaultCard(cardId)) {
    return cards;
  }

  return cards.map((card) =>
    card.id === cardId
      ? {
          ...card,
          label: patch.label === undefined ? card.label : sanitizeText(patch.label, card.label),
          billingDay: patch.billingDay === undefined ? card.billingDay : sanitizeBillingDay(patch.billingDay),
          isEndOfMonth: patch.isEndOfMonth === undefined ? card.isEndOfMonth : patch.isEndOfMonth
        }
      : card
  );
}

export function deletePaymentCard(
  cards: PaymentCard[],
  items: FixedCost[],
  cardId: string
): { cards: PaymentCard[]; items: FixedCost[] } {
  if (isDefaultCard(cardId) || !cards.some((card) => card.id === cardId)) {
    return { cards, items };
  }

  return {
    cards: cards.filter((card) => card.id !== cardId),
    items: items.map((item) => (item.paymentOptionId === cardId ? updateFixedCost(item, { paymentOptionId: "" }) : item))
  };
}

export function isDefaultCard(cardId: string): boolean {
  return DEFAULT_CARDS.some((card) => card.id === cardId);
}

export function cardIdFromLegacyPaymentMethod(paymentMethod: string | undefined): string {
  if (!paymentMethod) {
    return "";
  }

  const cleanValue = paymentMethod.trim();
  if (cleanValue.length === 0) {
    return "";
  }

  return legacyCardIdMap[cleanValue] ?? createPaymentCard(cleanValue).id;
}

export function normalizePaymentCard(card: PaymentCard): PaymentCard {
  return {
    ...card,
    label: sanitizeText(card.label, "새 카드"),
    billingDay: sanitizeBillingDay(card.billingDay),
    isEndOfMonth: card.isEndOfMonth ?? false
  };
}

const legacyCardIdMap: Record<string, string> = {};

function sanitizeText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeBillingDay(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(31, Math.max(1, Math.round(value)));
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
