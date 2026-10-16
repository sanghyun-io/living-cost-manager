// 헤더 저장 상태 파생의 순수 단위 테스트. 화면의 "저장됨" 주장은 확인된
// 스코프·버전·기준선·차단·오류·busy 조건이 모두 맞을 때만 성립해야 한다.
import { describe, expect, it } from "vitest";
import {
  deriveHeaderStorageState,
  getHeaderStorageView,
  getSyncStateView,
  type HeaderStorageInput
} from "../app/lib/syncStatus";

function input(overrides: Partial<HeaderStorageInput> = {}): HeaderStorageInput {
  return {
    signedIn: true,
    hasWorkspace: true,
    isChecked: true,
    versionChecked: true,
    baselineEstablished: true,
    baselineMatches: true,
    isBlocked: false,
    isBusy: false,
    hasError: false,
    authExpired: false,
    canSyncRole: true,
    localSaveError: false,
    localSavePending: false,
    ...overrides
  };
}

describe("deriveHeaderStorageState", () => {
  it("업로드/불러오기 성공 후 기준선 일치 → 기기·서버 저장됨(마지막 확인 기준 tooltip)", () => {
    const state = deriveHeaderStorageState(input());
    expect(state).toBe("server-saved");
    const view = getHeaderStorageView(state);
    expect(view.label).toBe("기기·서버에 저장됨");
    expect(view.tooltip).toContain("마지막 확인 기준");
    expect(view.label).not.toBe("동기화됨");
  });

  it("기준선과 다른 로컬 편집 직후(owner) → 기기에 저장됨 · 서버 미반영", () => {
    const view = getHeaderStorageView(deriveHeaderStorageState(input({ baselineMatches: false })));
    expect(view.label).toBe("기기에 저장됨 · 서버 미반영");
  });

  it("보기 전용 dirty는 서버 업로드를 암시하지 않는다", () => {
    const state = deriveHeaderStorageState(input({ baselineMatches: false, canSyncRole: false }));
    expect(state).toBe("device-saved");
    expect(getHeaderStorageView(state).label).toBe("기기에 저장됨");
  });

  it("게스트(미로그인)는 기기 저장만 주장한다", () => {
    expect(deriveHeaderStorageState(input({ signedIn: false, hasWorkspace: false }))).toBe("device-saved");
  });

  it("blocked(충돌·버전 불일치)는 절대 healthy 하지 않다 — baseline 일치라도", () => {
    const state = deriveHeaderStorageState(input({ isBlocked: true }));
    expect(state).toBe("conflict");
    expect(getHeaderStorageView(state).label).toBe("충돌 · 확인 필요");
  });

  it("확인되지 않은 스코프/미확인 버전/요청 오류 → 서버 상태 확인 필요", () => {
    expect(deriveHeaderStorageState(input({ isChecked: false }))).toBe("server-unknown");
    expect(deriveHeaderStorageState(input({ versionChecked: false }))).toBe("server-unknown");
    expect(deriveHeaderStorageState(input({ hasError: true }))).toBe("server-unknown");
    expect(deriveHeaderStorageState(input({ baselineEstablished: false }))).toBe("server-unknown");
    expect(getHeaderStorageView(deriveHeaderStorageState(input({ hasError: true }))).label).toBe("서버 상태 확인 필요");
  });

  it("통신 중 busy → 확인 중 (저장/미반영 주장 없음)", () => {
    expect(deriveHeaderStorageState(input({ isBusy: true }))).toBe("checking");
  });

  it("세션 만료는 고정 '다시 로그인 필요' 라벨", () => {
    expect(deriveHeaderStorageState(input({ authExpired: true, isChecked: false }))).toBe("auth-expired");
    expect(getHeaderStorageView("auth-expired").label).toBe("다시 로그인 필요");
  });

  it("로컬 저장 실패/대기는 모든 서버 주장보다 우선한다", () => {
    expect(deriveHeaderStorageState(input({ localSaveError: true }))).toBe("save-failed");
    expect(deriveHeaderStorageState(input({ localSavePending: true }))).toBe("saving");
    // 저장 실패가 pending보다 우선.
    expect(deriveHeaderStorageState(input({ localSaveError: true, localSavePending: true }))).toBe("save-failed");
    // pending/error는 healthy 서버 저장도 덮어쓴다.
    expect(deriveHeaderStorageState(input({ localSavePending: true, baselineMatches: true }))).not.toBe("server-saved");
  });

  it("DataModal 배지의 conflict 상태는 danger 톤과 확인 안내를 준다", () => {
    const view = getSyncStateView("conflict");
    expect(view.label).toBe("충돌 · 확인 필요");
    expect(view.tone).toBe("danger");
  });
});
