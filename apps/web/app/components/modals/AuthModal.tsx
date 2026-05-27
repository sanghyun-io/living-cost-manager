import { ModalShell } from "./ModalShell";

interface AuthModalProps {
  hasServerApi: boolean;
  authView: "auth" | "forgot";
  serverAuthMode: "login" | "register";
  serverEmail: string;
  serverPassword: string;
  serverName: string;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onModeChange: (mode: "login" | "register") => void;
  onViewChange: (view: "auth" | "forgot") => void;
  onSubmit: () => void;
  onForgotSubmit: () => void;
  onClose: () => void;
}

export function AuthModal({
  hasServerApi,
  authView,
  serverAuthMode,
  serverEmail,
  serverPassword,
  serverName,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  onEmailChange,
  onPasswordChange,
  onNameChange,
  onModeChange,
  onViewChange,
  onSubmit,
  onForgotSubmit,
  onClose
}: AuthModalProps) {
  const title = serverAuthMode === "register" ? "계정 가입" : "로그인";
  const statusClassName = serverErrorKind ? "sync-status sync-status-error" : "sync-status";

  return (
    <ModalShell titleId="auth-modal-title" sectionLabel="클라우드" title={title} className="auth-modal" onClose={onClose}>
      {hasServerApi ? (
        authView === "forgot" ? (
          <>
            <p className="auth-modal-intro">가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.</p>
            <form
              className="server-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                onForgotSubmit();
              }}
            >
              <div className="form-field">
                <label htmlFor="forgot-email">이메일</label>
                <input id="forgot-email" type="email" value={serverEmail} onChange={(event) => onEmailChange(event.target.value)} />
              </div>
              <button className="primary-button" disabled={isServerBusy} type="submit">
                재설정 링크 보내기
              </button>
            </form>
            <p className="auth-modal-switch">
              <button type="button" className="link-button" onClick={() => onViewChange("auth")}>
                로그인으로 돌아가기
              </button>
            </p>
            {serverStatus ? <p className={statusClassName}>{serverStatus}</p> : null}
          </>
        ) : (
          <>
            <p className="auth-modal-intro">
              클라우드에 저장하면 다른 기기에서도 데이터를 이어서 사용할 수 있습니다. 브라우저 로컬 저장은 그대로 유지됩니다.
            </p>
            <form
              className="server-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <div className="chart-toggle" aria-label="서버 계정 모드">
                <button className={serverAuthMode === "login" ? "active" : undefined} type="button" onClick={() => onModeChange("login")}>
                  로그인
                </button>
                <button className={serverAuthMode === "register" ? "active" : undefined} type="button" onClick={() => onModeChange("register")}>
                  가입
                </button>
              </div>
              <div className="form-field">
                <label htmlFor="auth-email">이메일</label>
                <input id="auth-email" type="email" value={serverEmail} onChange={(event) => onEmailChange(event.target.value)} />
              </div>
              {serverAuthMode === "register" ? (
                <div className="form-field">
                  <label htmlFor="auth-name">이름</label>
                  <input id="auth-name" type="text" value={serverName} onChange={(event) => onNameChange(event.target.value)} />
                </div>
              ) : null}
              <div className="form-field">
                <label htmlFor="auth-password">비밀번호</label>
                <input
                  id="auth-password"
                  type="password"
                  value={serverPassword}
                  onChange={(event) => onPasswordChange(event.target.value)}
                />
              </div>
              <button className="primary-button" disabled={isServerBusy} type="submit">
                {serverAuthMode === "register" ? "가입하고 클라우드에 저장" : "로그인"}
              </button>
            </form>
            <p className="auth-modal-switch">
              {serverAuthMode === "login" ? (
                <>
                  계정이 없으신가요?{" "}
                  <button type="button" className="link-button" onClick={() => onModeChange("register")}>
                    가입하기
                  </button>
                  <br />
                  <button type="button" className="link-button" onClick={() => onViewChange("forgot")}>
                    비밀번호를 잊으셨나요?
                  </button>
                </>
              ) : (
                <>
                  이미 계정이 있으신가요?{" "}
                  <button type="button" className="link-button" onClick={() => onModeChange("login")}>
                    로그인하기
                  </button>
                </>
              )}
            </p>
            {serverStatus ? <p className={statusClassName}>{serverStatus}</p> : null}
          </>
        )
      ) : (
        <div className="local-mode-warning" role="status">
          <strong>서버 API URL이 없어 클라우드 저장을 사용할 수 없습니다.</strong>
          <p>이 브라우저에만 저장됩니다. 데이터 관리에서 전체 Export 백업을 보관하세요.</p>
        </div>
      )}
    </ModalShell>
  );
}
