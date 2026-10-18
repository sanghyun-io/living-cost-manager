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
  | "conflict"
  | "auth-expired";

/**
 * 헤더 한 줄에 표시하는 저장 상태. 화면의 저장 주장은 마지막으로 확인한
 * 클라이언트 상태에만 근거한다(실시간 서버 조회가 아니다). 순수 함수라서
 * hook/컴포넌트 어디서든 같은 유한 집합 판정을 재사용한다.
 */
export type HeaderStorageState =
  | "save-failed"
  | "saving"
  | "device-saved"
  | "device-dirty"
  | "server-saved"
  | "checking"
  | "conflict"
  | "server-unknown"
  | "auth-expired";

export interface HeaderStorageInput {
  signedIn: boolean;
  hasWorkspace: boolean;
  /** 현재 확인 스코프의 서버 상태 확인이 살아 있는지. */
  isChecked: boolean;
  /** 서버 syncVersion 을 한 번이라도 확인했는지. */
  versionChecked: boolean;
  /** 동기화 기준선(baseline)이 설정됐는지. */
  baselineEstablished: boolean;
  /** 현재 로컬 스냅샷이 마지막 서버 기준선과 일치하는지. */
  baselineMatches: boolean;
  isBlocked: boolean;
  isBusy: boolean;
  hasError: boolean;
  authExpired: boolean;
  /** 현재 역할이 서버 업로드(동기화)가 가능한지 (owner/editor). */
  canSyncRole: boolean;
  /** 마지막 로컬 저장이 실패했는지. */
  localSaveError: boolean;
  /** 마지막 편집이 아직 localStorage 에 반영되기 전인지. */
  localSavePending: boolean;
}

export function deriveHeaderStorageState(input: HeaderStorageInput): HeaderStorageState {
  // 로컬 쓰기 오류/대기가 어떤 서버 주장보다 우선한다 — 저장되지 않았는데
  // "저장됨"이라고 표시하지 않는다.
  if (input.localSaveError) return "save-failed";
  if (input.localSavePending) return "saving";
  if (!input.signedIn || !input.hasWorkspace) return "device-saved";
  if (input.authExpired) return "auth-expired";
  if (input.isBlocked) return "conflict";
  if (input.isBusy) return "checking";
  // 확인 스코프·버전·기준선이 하나라도 불확실하면 서버를 주장하지 않는다.
  if (!input.isChecked || !input.versionChecked || input.hasError || !input.baselineEstablished) {
    return "server-unknown";
  }
  if (input.baselineMatches) return "server-saved";
  // 기준선과 다른 로컬 변경. 보기 전용은 업로드할 수ないので '미반영'을 암시하지 않는다.
  return input.canSyncRole ? "device-dirty" : "device-saved";
}

export type HeaderStorageView = { state: HeaderStorageState; label: string; tooltip: string };
export function getHeaderStorageView(state: HeaderStorageState): HeaderStorageView {
  switch (state) {
    case "save-failed":
      return { state, label: "기기 저장 실패", tooltip: "브라우저 저장에 실패했습니다. 백업을 내보내세요." };
    case "saving":
      return { state, label: "기기에 저장 중", tooltip: "이 브라우저에 저장하는 중입니다." };
    case "device-saved":
      return { state, label: "기기에 저장됨", tooltip: "이 브라우저에만 저장됩니다." };
    case "device-dirty":
      return { state, label: "기기에 저장됨 · 서버 미반영", tooltip: "마지막 저장 내용이 서버에 아직 없습니다. 데이터 관리에서 저장하세요." };
    case "server-saved":
      return { state, label: "기기·서버에 저장됨", tooltip: "마지막 확인 기준입니다. 실시간 서버 조회가 아닙니다." };
    case "checking":
      return { state, label: "동기화 확인 중", tooltip: "서버와 통신 중입니다." };
    case "conflict":
      return { state, label: "충돌 · 확인 필요", tooltip: "다른 기기/멤버 변경과 충돌했습니다. 데이터 관리에서 상태를 확인하세요." };
    case "server-unknown":
      return { state, label: "서버 상태 확인 필요", tooltip: "서버 저장 여부는 확인 전에는 표시하지 않습니다. 데이터 관리에서 확인하세요." };
    case "auth-expired":
      return { state, label: "다시 로그인 필요", tooltip: "서버 세션이 만료되어 확인하지 못합니다. 기기 저장은 유지됩니다." };
  }
}

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
    return input.hasServerApi ? "server-available" : "local-only";
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
        description: "이 브라우저에만 저장됩니다. 로그인해서 클라우드에 저장하면 다른 기기에서도 이어서 사용할 수 있습니다.",
        tone: "warning"
      };
    case "server-available":
      return {
        label: "서버 연결 가능",
        description: "서버 계정으로 로그인하면 백업과 가계부 동기화를 사용할 수 있습니다.",
        tone: "neutral"
      };
    case "signed-in":
      return {
        label: "서버 계정 연결됨",
        description: "가계부가 선택되었습니다. 필요할 때 서버 상태를 확인하거나 동기화하세요.",
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
    case "conflict":
      return {
        label: "충돌 · 확인 필요",
        description: "서버 데이터와 기준이 맞지 않습니다. 서버 데이터를 다시 불러오거나 업로드할지 직접 선택하세요.",
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

/**
 * 헤더의 "기기·서버 저장됨" 주장은 가계부와 계획 두 영역이 모두 확인될 때만 성립한다.
 *  - 계획의 로컬 쓰기 실패/대기는 가계부 서버 주장보다 우선한다(저장 안 된데 저장됨 금지).
 *  - 계획이 전혀 없는 no-op 상태는 가계부 상태를 그대로 두며 거짓 경보를 울리지 않는다.
 *  - 서버 세션이 없으면(게스트/로컬) 서버를 주장하지 않는 가계부 판정에만 영향 없다.
 */
export type PlanningStorageInput = {
  /** 계획 로컬 쓰기 실패(quota/concurrent) — 최우선. */
  saveError: boolean;
  /** 계획 편집이 아직 localStorage 에 반영되기 전. */
  savePending: boolean;
  /** 의미 있는 계획 데이터가 있는가(no-op 아니면 true). */
  active: boolean;
  /** 서버 기준 확인됐으나 로컬이 다름(미반영) 또는 충돌. */
  serverDirty: boolean;
  /** 활성 계획인데 서버 확인 기준이 아직 없음. */
  serverUnknown: boolean;
};

export function combinePlanningStorageState(budgetState: HeaderStorageState, planning: PlanningStorageInput): HeaderStorageState {
  if (planning.saveError || budgetState === "save-failed") return "save-failed";
  if (planning.savePending) return "saving";
  if (!planning.active) return budgetState;
  if (budgetState === "server-saved") {
    if (planning.serverDirty) return "device-dirty";
    if (planning.serverUnknown) return "server-unknown";
    return "server-saved";
  }
  return budgetState;
}
