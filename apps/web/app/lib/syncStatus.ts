import { getMonthlyEquivalentAmount } from "./budget";
import type { LocalBudgetSnapshot } from "./snapshot";

export type AccountSyncState =
  | "local-only"
  | "server-available"
  | "signed-in"
  | "checking"
  | "needs-decision"
  | "syncing"
  | "synced"
  | "failed"
  | "auth-expired";

export type AccountSyncStateInput = {
  hasServerApi: boolean;
  hasSession: boolean;
  hasWorkspace: boolean;
  isBusy: boolean;
  isSnapshotChecked: boolean;
  hasServerSnapshot: boolean;
  hasAuthFailure: boolean;
  hasError: boolean;
};

export type SyncStateView = {
  label: string;
  description: string;
  tone: "neutral" | "success" | "warning" | "danger";
};

export type BudgetSnapshotSummary = {
  monthlyIncome: number;
  fixedCostCount: number;
  monthlyExpense: number;
  categoryCount: number;
  cardCount: number;
};

export function getAccountSyncState(input: AccountSyncStateInput): AccountSyncState {
  if (!input.hasServerApi || !input.hasSession) {
    return "local-only";
  }

  if (input.hasAuthFailure) {
    return "auth-expired";
  }

  if (input.isBusy) {
    return "syncing";
  }

  if (input.hasError) {
    return "failed";
  }

  if (!input.hasWorkspace) {
    return "server-available";
  }

  if (!input.isSnapshotChecked) {
    return "checking";
  }

  if (input.hasServerSnapshot) {
    return "needs-decision";
  }

  return "signed-in";
}

export function getSyncStateView(state: AccountSyncState): SyncStateView {
  switch (state) {
    case "local-only":
      return {
        label: "로컬 전용",
        description: "이 브라우저에만 저장됩니다. 기기를 바꾸기 전 전체 Export 백업을 보관하세요.",
        tone: "warning"
      };
    case "server-available":
      return {
        label: "서버 연결 가능",
        description: "서버 계정으로 로그인하면 백업과 워크스페이스 동기화를 사용할 수 있습니다.",
        tone: "neutral"
      };
    case "signed-in":
      return {
        label: "서버 계정 연결됨",
        description: "워크스페이스가 선택되었습니다. 필요할 때 서버 상태를 확인하거나 동기화하세요.",
        tone: "success"
      };
    case "checking":
      return {
        label: "서버 상태 확인 필요",
        description: "동기화 전에 서버 데이터 상태를 확인해야 합니다.",
        tone: "neutral"
      };
    case "needs-decision":
      return {
        label: "동기화 선택 필요",
        description: "서버 데이터와 이 브라우저 데이터 중 어느 쪽을 사용할지 선택하세요.",
        tone: "warning"
      };
    case "syncing":
      return {
        label: "동기화 중",
        description: "서버와 데이터를 주고받는 중입니다. 이 창을 닫지 마세요.",
        tone: "neutral"
      };
    case "synced":
      return {
        label: "동기화됨",
        description: "마지막 서버 동기화가 성공했습니다.",
        tone: "success"
      };
    case "failed":
      return {
        label: "서버 동기화 실패",
        description: "서버 요청에 실패했습니다. 로컬 저장은 유지되며 다시 시도할 수 있습니다.",
        tone: "danger"
      };
    case "auth-expired":
      return {
        label: "다시 로그인 필요",
        description: "서버 세션이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.",
        tone: "danger"
      };
  }
}

export function summarizeBudgetSnapshot(snapshot: LocalBudgetSnapshot): BudgetSnapshotSummary {
  return {
    monthlyIncome: Math.max(0, Math.round(snapshot.monthlyIncome)),
    fixedCostCount: snapshot.fixedCosts.length,
    monthlyExpense: snapshot.fixedCosts.reduce((total, item) => total + getMonthlyEquivalentAmount(item), 0),
    categoryCount: snapshot.categories.length,
    cardCount: snapshot.cards.length
  };
}
