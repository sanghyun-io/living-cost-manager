import type { WorkspaceDto } from '@living-cost-manager/shared';

// Source-only release policy, never a URL/localStorage/NEXT_PUBLIC switch.
// Restoring paid features requires a reviewed release and server enforcement.
export const FREE_PUBLIC_RELEASE = true;
export const CROSS_LEDGER_AGGREGATION_AVAILABLE = false;
export const FREE_LEDGER_LIMIT_MESSAGE = '현재 무료판에서는 새 가계부 추가를 제공하지 않습니다. 기존 가계부는 그대로 이용할 수 있습니다.';
export const LEDGER_LIST_UNAVAILABLE_MESSAGE = '가계부 목록을 확인한 뒤 첫 가계부를 만들 수 있습니다. 목록 새로고침으로 다시 확인하세요.';
export function canCreateFirstOwnedLedger(workspaces: readonly WorkspaceDto[], checked: boolean): boolean {
  return checked && !workspaces.some(workspace => workspace.role === 'owner');
}
