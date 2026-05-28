import type { WorkspaceSnapshot } from "@living-cost-manager/shared";

import { createFixedCost, DEFAULT_CATEGORIES, type Category, type FixedCost } from "./budget";
import { normalizePaymentCard, type PaymentCard } from "./cards";

export type LocalBudgetSnapshot = {
  monthlyIncome: number;
  categories: Category[];
  cards: PaymentCard[];
  fixedCosts: FixedCost[];
};

export function buildWorkspaceSnapshot(
  workspaceId: string,
  snapshot: LocalBudgetSnapshot,
  // 마지막으로 서버에서 읽은 syncVersion. PUT 시 서버가 이 값과 현재 DB 값을
  // 비교해 충돌(409)을 판정한다. 서버 스냅샷을 받은 적 없으면 0.
  syncVersion = 0
): WorkspaceSnapshot {
  return {
    workspaceId,
    syncVersion,
    monthlyIncome: Math.max(0, Math.round(snapshot.monthlyIncome)),
    categories: snapshot.categories.map((category) => ({
      ...category,
      workspaceId
    })),
    cards: snapshot.cards.map((card) => ({
      ...card,
      workspaceId
    })),
    fixedCosts: snapshot.fixedCosts.map((fixedCost) => ({
      ...fixedCost,
      workspaceId
    }))
  };
}

export function hydrateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): LocalBudgetSnapshot {
  return {
    monthlyIncome: Math.max(0, Math.round(snapshot.monthlyIncome)),
    categories: snapshot.categories.map(({ id, label }) => ({ id, label })),
    cards: snapshot.cards.map(({ id, label, billingDay, isEndOfMonth }) => normalizePaymentCard({ id, label, billingDay, isEndOfMonth })),
    fixedCosts: snapshot.fixedCosts.map(({ workspaceId: _workspaceId, ...fixedCost }) => createFixedCost(fixedCost))
  };
}

export function isWorkspaceSnapshotEmpty(snapshot: WorkspaceSnapshot): boolean {
  return (
    snapshot.monthlyIncome === 0 &&
    snapshot.categories.length === 0 &&
    snapshot.cards.length === 0 &&
    snapshot.fixedCosts.length === 0
  );
}

export function hasLocalBudgetData(snapshot: LocalBudgetSnapshot): boolean {
  return (
    snapshot.monthlyIncome > 0 ||
    snapshot.fixedCosts.length > 0 ||
    snapshot.cards.length > 0 ||
    snapshot.categories.some((category) => !DEFAULT_CATEGORIES.some((defaultCategory) => defaultCategory.id === category.id))
  );
}
