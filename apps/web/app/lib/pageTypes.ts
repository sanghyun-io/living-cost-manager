// Shared types for page.tsx and its extracted components.
// Grouped prop bundles (SyncProps, SharingProps, DataModalProps) are added here
// as those components are extracted (Tasks 7-9).
import type { Category, FixedCost } from "./budget";
import type { PaymentCard } from "./cards";

// Local in-memory budget shape held by the Home component. Structurally
// equivalent to lib/snapshot.ts's LocalBudgetSnapshot (kept as a distinct alias
// for now to avoid a premature merge).
export type BudgetSnapshot = {
  monthlyIncome: number;
  fixedCosts: FixedCost[];
  categories: Category[];
  cards: PaymentCard[];
};
