import { LOCAL_USER_NAME } from "../lib/users";
import { formatSaveTime } from "../lib/formatting";
import type { ServerSession } from "../lib/serverApi";

interface AppHeaderProps {
  saveError: string;
  lastSavedAt: Date | null;
  serverSession: ServerSession | null;
  currentUserName: string | undefined;
  onOpenData: () => void;
  onOpenAuth: () => void;
  /** Combines server logout + local logout (wrapped in page). */
  onServerLogout: () => void;
}

export function AppHeader({
  saveError,
  lastSavedAt,
  serverSession,
  currentUserName,
  onOpenData,
  onOpenAuth,
  onServerLogout
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <span className={saveError ? "save-status save-status-error" : "save-status"}>
        {saveError || (lastSavedAt ? "저장됨 " + formatSaveTime(lastSavedAt) : "브라우저 저장 대기")}
      </span>
      {serverSession ? (
        <button className="account-status-pill account-status-connected" type="button" onClick={onOpenData}>
          서버 연결됨 · 동기화 관리
        </button>
      ) : (
        <>
          <button className="secondary-button" type="button" onClick={onOpenData}>
            데이터 관리
          </button>
          <button className="primary-button" type="button" onClick={onOpenAuth}>
            클라우드에 저장하기
          </button>
        </>
      )}
      <strong>{currentUserName ?? LOCAL_USER_NAME}</strong>
      {serverSession ? (
        <button className="secondary-button" type="button" onClick={onServerLogout}>
          서버 로그아웃
        </button>
      ) : null}
    </header>
  );
}
