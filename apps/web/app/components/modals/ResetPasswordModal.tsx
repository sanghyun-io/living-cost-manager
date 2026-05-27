import { ModalShell } from "./ModalShell";

interface ResetPasswordModalProps {
  resetPasswordValue: string;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ResetPasswordModal({
  resetPasswordValue,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  onPasswordChange,
  onSubmit,
  onClose
}: ResetPasswordModalProps) {
  const statusClassName = serverErrorKind ? "sync-status sync-status-error" : "sync-status";
  return (
    <ModalShell titleId="reset-modal-title" sectionLabel="클라우드" title="비밀번호 재설정" className="auth-modal" onClose={onClose}>
      <p className="auth-modal-intro">새 비밀번호를 입력하세요. (최소 8자)</p>
      <form
        className="server-auth-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="form-field">
          <label htmlFor="reset-password">새 비밀번호</label>
          <input
            id="reset-password"
            type="password"
            value={resetPasswordValue}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
        </div>
        <button className="primary-button" disabled={isServerBusy || resetPasswordValue.length < 8} type="submit">
          비밀번호 변경
        </button>
      </form>
      {serverStatus ? <p className={statusClassName}>{serverStatus}</p> : null}
    </ModalShell>
  );
}
