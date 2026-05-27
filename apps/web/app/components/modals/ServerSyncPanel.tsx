import { formatSaveTime } from "../../lib/formatting";
import { workspaceRoleLabels } from "../../lib/sharing";
import type { SharingProps, SyncProps } from "../../lib/pageTypes";
import { BudgetSummaryCard } from "../BudgetSummaryCard";
import { SharingPanel } from "./SharingPanel";

interface ServerSyncPanelProps {
  sync: SyncProps;
  sharing: SharingProps;
}

export function ServerSyncPanel({ sync, sharing }: ServerSyncPanelProps) {
  const {
    serverSession,
    syncStateView,
    displayedSyncState,
    lastServerSyncedAt,
    localSnapshotSummary,
    serverSnapshotSummary,
    serverWorkspaces,
    currentWorkspaceRole,
    canUploadServerSnapshot,
    isServerBusy,
    serverStatus,
    serverErrorKind,
    changeCurrentPassword,
    changeNewPassword,
    showUploadButton,
    showLoadButton,
    onServerLogout,
    onResendVerification,
    onChangePassword,
    onChangeCurrentPassword,
    onChangeNewPassword,
    onSelectWorkspace,
    onCheckServer,
    onSyncNow,
    onLoadSnapshot,
    onStayLocal,
    onOpenAuth,
    onExportBackup
  } = sync;

  return (
    <section className="server-panel" aria-label="서버 동기화">
      <div className="server-panel-header">
        <div>
          <p className="section-label">서버 동기화</p>
          <h3>계정 및 공유</h3>
        </div>
        {serverSession ? (
          <button className="secondary-button" type="button" onClick={onServerLogout}>
            서버 로그아웃
          </button>
        ) : null}
      </div>

      <div className={"sync-state-card sync-state-" + syncStateView.tone}>
        <div>
          <span>현재 저장 모드</span>
          <strong>{syncStateView.label}</strong>
          <small>{syncStateView.description}</small>
        </div>
        <div>
          <span>마지막 서버 동기화</span>
          <strong>{lastServerSyncedAt ? formatSaveTime(lastServerSyncedAt) : "아직 없음"}</strong>
          <small>{serverSession?.workspace ? serverSession.workspace.name : "서버 워크스페이스 선택 전"}</small>
        </div>
      </div>

      {displayedSyncState === "local-only" || displayedSyncState === "server-available" ? (
        <div className="local-mode-warning" role="status">
          <strong>로컬 모드: 이 브라우저에만 저장됩니다.</strong>
          <p>브라우저 데이터를 삭제하거나 기기를 바꾸면 복구할 수 없습니다. 로그인해서 클라우드에 저장하면 다른 기기에서도 이어서 사용할 수 있습니다.</p>
          <button className="secondary-button" type="button" onClick={onExportBackup}>
            전체 Export 백업
          </button>
        </div>
      ) : null}

      <div className="sync-summary-grid" aria-label="동기화 데이터 비교">
        <BudgetSummaryCard title="이 브라우저" summary={localSnapshotSummary} />
        {serverSnapshotSummary ? (
          <BudgetSummaryCard title="서버 데이터" summary={serverSnapshotSummary} />
        ) : (
          <div className="sync-summary-card muted">
            <span>서버 데이터</span>
            <strong>확인 전</strong>
            <small>서버 상태 확인을 누르면 비교 정보가 표시됩니다.</small>
          </div>
        )}
      </div>

      {serverSession ? (
        <div className="server-session-summary">
          <div>
            <span>계정</span>
            <strong>{serverSession.user.name}</strong>
            <small>{serverSession.user.email}</small>
          </div>
          <div>
            <span>워크스페이스</span>
            <strong>{serverSession.workspace?.name ?? "선택 안 됨"}</strong>
            <small>{currentWorkspaceRole ? workspaceRoleLabels[currentWorkspaceRole] : "초대 수락 후 선택"}</small>
            {serverWorkspaces.length > 1 ? (
              <select
                aria-label="서버 워크스페이스 선택"
                value={serverSession.workspace?.id ?? ""}
                onChange={(event) => onSelectWorkspace(event.target.value)}
              >
                {serverWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>
      ) : null}

      {serverSession && serverSession.user.emailVerified === false ? (
        <div className="email-verify-badge" role="status">
          <span>이메일 미인증</span>
          <button className="link-button" type="button" disabled={isServerBusy} onClick={onResendVerification}>
            인증 메일 재발송
          </button>
        </div>
      ) : null}

      {serverSession ? (
        <details className="password-change">
          <summary>비밀번호 변경</summary>
          <form
            className="server-auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              onChangePassword();
            }}
          >
            <div className="form-field">
              <label htmlFor="change-current">현재 비밀번호</label>
              <input
                id="change-current"
                type="password"
                value={changeCurrentPassword}
                onChange={(event) => onChangeCurrentPassword(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="change-new">새 비밀번호</label>
              <input
                id="change-new"
                type="password"
                value={changeNewPassword}
                onChange={(event) => onChangeNewPassword(event.target.value)}
              />
            </div>
            <button
              className="secondary-button"
              type="submit"
              disabled={isServerBusy || changeCurrentPassword.length < 8 || changeNewPassword.length < 8}
            >
              비밀번호 변경
            </button>
          </form>
        </details>
      ) : null}

      {!serverSession ? (
        <div className="server-auth-cta">
          <p>클라우드에 저장하려면 로그인이 필요합니다. 계정이 없으면 가입한 뒤 이어서 사용할 수 있습니다.</p>
          <button className="primary-button" type="button" onClick={onOpenAuth}>
            로그인 / 가입하기
          </button>
        </div>
      ) : null}

      {serverStatus ? (
        <p className={serverErrorKind ? "sync-status sync-status-error" : "sync-status"}>{serverStatus}</p>
      ) : null}
      {serverSession && serverWorkspaces.length === 0 ? (
        <p className="local-note">사용 가능한 서버 워크스페이스가 없습니다. 새 계정을 만들거나 초대를 수락한 뒤 동기화를 사용할 수 있습니다.</p>
      ) : null}

      {serverSession?.workspace ? (
        <div className="sync-actions">
          <button className="secondary-button" disabled={isServerBusy} type="button" onClick={onCheckServer}>
            서버 상태 확인
          </button>
          <button className="secondary-button" disabled={isServerBusy || !canUploadServerSnapshot} type="button" onClick={onSyncNow}>
            지금 동기화
          </button>
          {showUploadButton ? (
            <button className="secondary-button" disabled={isServerBusy || !canUploadServerSnapshot} type="button" onClick={onSyncNow}>
              이 브라우저 데이터 업로드
            </button>
          ) : null}
          {showLoadButton ? (
            <button className="secondary-button" disabled={isServerBusy} type="button" onClick={onLoadSnapshot}>
              서버 데이터 불러오기
            </button>
          ) : null}
          <button className="secondary-button" disabled={isServerBusy} type="button" onClick={onStayLocal}>
            로컬 전용 유지
          </button>
        </div>
      ) : null}

      <SharingPanel {...sharing} />
    </section>
  );
}
