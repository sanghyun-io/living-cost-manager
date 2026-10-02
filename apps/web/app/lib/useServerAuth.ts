"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createServerApiClient,
  isServerAuthFailure,
  resolveServerSessionWorkspace,
  SERVER_SESSION_STORAGE_KEY,
  type ServerSession
} from "./serverApi";
import { getErrorMessage, getServerSyncErrorMessage } from "./serverMessages";
import { clearAuthQueryParam } from "./storage";
import { validateEmail, validateName, validatePassword } from "./validation";
import type { AuthFormValues } from "../components/modals/AuthModal";
import type { UIStateApi } from "./useUIState";
import type { LocalUsersApi } from "./useLocalUsers";
import type { WorkspaceSyncApi } from "./useWorkspaceSync";

interface UseServerAuthOptions {
  ui: UIStateApi;
  /**
   * useLocalUsers / useWorkspaceSync are created AFTER this hook (their event
   * handlers call back into it), so they're reached through stable getters.
   * The getters only run inside async handlers — never during render.
   */
  getUsers: () => LocalUsersApi;
  getSync: () => WorkspaceSyncApi;
}

/**
 * Server session + auth flows (login/register, forgot/reset/change password,
 * verification notices, deep links, restore) and the shared status/busy/error
 * channel every server-touching flow reports through.
 */
export function useServerAuth({ ui, getUsers, getSync }: UseServerAuthOptions) {
  const [serverSession, setServerSession] = useState<ServerSession | null>(null);
  // Snapshot of the session exactly as restored at boot; handed to AuthModal
  // for a one-time email/name draft prefill.
  const [bootServerSession, setBootServerSession] = useState<ServerSession | null>(null);
  const [serverStatus, setServerStatus] = useState("");
  const [isServerBusy, setIsServerBusy] = useState(false);
  const [serverErrorKind, setServerErrorKind] = useState<"auth" | "request" | null>(null);

  // Password-reset deep link (?reset_token). Holds the token while the modal is up.
  const [resetToken, setResetToken] = useState<string | null>(null);
  // Bumped after a successful reset to reopen AuthModal in login mode.
  const [authLoginRequest, setAuthLoginRequest] = useState(0);
  // Post-signup "check your email" notice. Holds the address we sent to.
  const [verifyNoticeEmail, setVerifyNoticeEmail] = useState<string | null>(null);
  // Change-password form (lives in the DataModal sync panel but must survive
  // DataModal unmounts and be readable by handleChangePassword, like before).
  const [changeCurrentPassword, setChangeCurrentPassword] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");

  const serverRestoreCheckedRef = useRef(false);
  const serverApi = useMemo(() => createServerApiClient(), []);

  // Handle auth deep links delivered by email. The app is a static-export SPA
  // served only at "/", so links use root query params: ?reset_token / ?verify_token.
  useEffect(() => {
    if (typeof window === "undefined" || !serverApi) {
      return;
    }
    const params = new URLSearchParams(window.location.search);

    const reset = params.get("reset_token");
    if (reset) {
      setResetToken(reset);
      return;
    }

    const verify = params.get("verify_token");
    if (verify) {
      clearAuthQueryParam("verify_token");
      void serverApi
        .verifyEmail(verify)
        .then(() => {
          setServerStatus("이메일 인증이 완료되었습니다.");
          // If the post-signup notice is still open, dismiss it now.
          setVerifyNoticeEmail(null);
          setServerSession((current) => {
            if (!current) {
              return current;
            }
            const updated = { ...current, user: { ...current.user, emailVerified: true } };
            saveServerSession(updated);
            return updated;
          });
        })
        .catch(() => {
          setServerStatus("이메일 인증 링크가 유효하지 않거나 만료되었습니다.");
        })
        .finally(() => {
          ui.setIsDataModalOpen(true);
        });
    }
    // ui.setIsDataModalOpen is a stable setter; the original effect only
    // depended on serverApi.
  }, [serverApi]);

  // Boot seeds the session inside the local-users effect so the first painted
  // frame has it; AuthModal prefills its drafts from bootServerSession.
  function applyBootSession(session: ServerSession) {
    setServerSession(session);
    setBootServerSession(session);
  }

  function saveServerSession(session: ServerSession) {
    window.localStorage.setItem(SERVER_SESSION_STORAGE_KEY, JSON.stringify(session));
  }

  // ResetPasswordModal dismiss: clears the pending token and strips the query
  // param (same as the old page onClose).
  function closeResetModal() {
    setResetToken(null);
    clearAuthQueryParam("reset_token");
  }

  async function resolveAndStoreServerSession(session: ServerSession) {
    if (!serverApi) {
      saveServerSession(session);
      setServerSession(session);
      getSync().setIsServerSnapshotChecked(false);
      return session;
    }

    const nextSession = await resolveServerSessionWorkspace(serverApi, session);
    saveServerSession(nextSession);
    setServerSession(nextSession);
    setServerErrorKind(null);
    getSync().setIsServerSnapshotChecked(false);
    await getSync().loadServerWorkspaces(nextSession);
    return nextSession;
  }

  async function handleServerAuthSubmit(values: AuthFormValues): Promise<boolean> {
    if (!serverApi) {
      setServerStatus("서버 API URL이 없어 로컬 전용으로 동작합니다.");
      return false;
    }

    const validationError =
      validateEmail(values.email) ??
      validatePassword(values.password) ??
      (values.mode === "register" ? validateName(values.name) : null);
    if (validationError) {
      setServerErrorKind("request");
      setServerStatus(validationError);
      return false;
    }

    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);

    try {
      const authResult =
        values.mode === "register"
          ? await serverApi.register({
              email: values.email,
              password: values.password,
              name: values.name || values.email
            })
          : await serverApi.login({ email: values.email, password: values.password });
      const nextSession = await resolveAndStoreServerSession({
        ...authResult,
        workspace: authResult.workspace ?? serverSession?.workspace ?? null
      });

      serverRestoreCheckedRef.current = true;
      // After signup, walk the user through email verification instead of
      // dropping them straight into the data modal. Cloud writes are gated on
      // verification, so the "check your email" notice sets expectations.
      const justRegisteredUnverified =
        values.mode === "register" && nextSession.user.emailVerified !== true;
      if (ui.isAuthModalOpen) {
        ui.setIsAuthModalOpen(false);
        if (justRegisteredUnverified) {
          setServerStatus("");
          setServerErrorKind(null);
          setVerifyNoticeEmail(nextSession.user.email);
        } else {
          ui.setIsDataModalOpen(true);
        }
      }
      await getSync().prepareServerSyncDecision(nextSession);
      await getSync().refreshSharing(nextSession);
      getUsers().handleLogin(nextSession.user.name || nextSession.user.email);
      return true;
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getErrorMessage(error));
      return false;
    } finally {
      setIsServerBusy(false);
    }
  }

  function handleServerLogout() {
    // Best-effort server-side logout (invalidates refresh tokens); ignore failures.
    if (serverApi && serverSession) {
      void serverApi.logout(serverSession.token).catch(() => undefined);
    }
    window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
    setServerSession(null);
    // Everything server-workspace-scoped (snapshot, checked flag, workspaces,
    // members, invitations, sync stamps, trend cache) is wiped there.
    getSync().resetOnServerLogout();
    setServerErrorKind(null);
    setServerStatus("서버 연결을 해제했습니다. 브라우저 데이터는 유지됩니다.");
  }

  async function handleForgotPassword(email: string) {
    if (!serverApi) {
      return;
    }
    const validationError = validateEmail(email);
    if (validationError) {
      setServerErrorKind("request");
      setServerStatus(validationError);
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      await serverApi.forgotPassword(email);
      setServerStatus("입력하신 이메일이 가입되어 있다면 재설정 링크를 보냈습니다. 메일함을 확인하세요.");
    } catch (error) {
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  // Returns true on success so ResetPasswordModal can clear its own draft
  // (the old page-level state was cleared here; now the modal mirrors that).
  async function handleResetPassword(password: string): Promise<boolean> {
    if (!serverApi || !resetToken) {
      return false;
    }
    const validationError = validatePassword(password);
    if (validationError) {
      setServerErrorKind("request");
      setServerStatus(validationError);
      return false;
    }
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      await serverApi.resetPassword(resetToken, password);
      setResetToken(null);
      clearAuthQueryParam("reset_token");
      setAuthLoginRequest((count) => count + 1);
      ui.setIsAuthModalOpen(true);
      setServerStatus("비밀번호를 재설정했습니다. 새 비밀번호로 로그인하세요.");
      return true;
    } catch (error) {
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
      return false;
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleChangePassword() {
    if (!serverApi || !serverSession) {
      return;
    }
    if (!changeCurrentPassword) {
      setServerErrorKind("request");
      setServerStatus("현재 비밀번호를 입력해주세요.");
      return;
    }
    const newPasswordError = validatePassword(changeNewPassword);
    if (newPasswordError) {
      setServerErrorKind("request");
      setServerStatus(newPasswordError === "비밀번호를 입력해주세요." ? "새 비밀번호를 입력해주세요." : "새 " + newPasswordError);
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      const updated = await serverApi.changePassword(
        changeCurrentPassword,
        changeNewPassword,
        serverSession.token
      );
      // change-password bumps tokenVersion and returns fresh tokens; keep workspace.
      const nextSession = await resolveAndStoreServerSession({
        ...updated,
        workspace: updated.workspace ?? serverSession.workspace ?? null
      });
      setServerSession(nextSession);
      setChangeCurrentPassword("");
      setChangeNewPassword("");
      setServerStatus("비밀번호를 변경했습니다.");
    } catch (error) {
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(
        isServerAuthFailure(error) ? "현재 비밀번호가 올바르지 않습니다." : getErrorMessage(error)
      );
    } finally {
      setIsServerBusy(false);
    }
  }

  async function handleResendVerification() {
    if (!serverApi || !serverSession) {
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    try {
      await serverApi.resendVerification(serverSession.token);
      setServerStatus("인증 메일을 다시 보냈습니다. 메일함을 확인하세요.");
    } catch (error) {
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      setIsServerBusy(false);
    }
  }

  async function refreshRestoredServerSession(session: ServerSession) {
    if (!serverApi) {
      return;
    }

    // The stored access token is short-lived; if it has expired, transparently
    // exchange the refresh token for a new pair before restoring the session.
    let activeSession = session;
    try {
      await serverApi.me(session.token);
    } catch (probeError) {
      if (isServerAuthFailure(probeError)) {
        try {
          const refreshed = await serverApi.refresh(session.refreshToken);
          activeSession = { ...refreshed, workspace: refreshed.workspace ?? session.workspace };
          saveServerSession(activeSession);
          setServerSession(activeSession);
        } catch {
          // refresh token also invalid -> fall through to the catch below via me()
        }
      }
    }

    try {
      const [{ user }, nextSession] = await Promise.all([
        serverApi.me(activeSession.token),
        resolveServerSessionWorkspace(serverApi, activeSession)
      ]);
      const restoredSession = {
        ...nextSession,
        user
      };

      saveServerSession(restoredSession);
      setServerSession(restoredSession);
      setServerErrorKind(null);
      await getSync().loadServerWorkspaces(restoredSession);
      if (restoredSession.workspace) {
        await getSync().prepareServerSyncDecision(restoredSession);
      } else {
        setServerStatus("사용 가능한 서버 워크스페이스가 없습니다.");
      }
    } catch (error) {
      if (isServerAuthFailure(error)) {
        window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
        setServerSession(null);
        getSync().dropSessionOnAuthFailure();
        return;
      }
      setServerErrorKind("request");
      setServerStatus(getServerSyncErrorMessage(error) + " 서버 연결은 유지했습니다. 데이터 관리에서 다시 시도하세요.");
    }
  }

  return {
    serverApi,
    serverSession,
    setServerSession,
    bootServerSession,
    serverStatus,
    setServerStatus,
    isServerBusy,
    setIsServerBusy,
    serverErrorKind,
    setServerErrorKind,
    saveServerSession,
    resolveAndStoreServerSession,
    serverRestoreCheckedRef,
    applyBootSession,
    refreshRestoredServerSession,
    resetToken,
    closeResetModal,
    authLoginRequest,
    verifyNoticeEmail,
    setVerifyNoticeEmail,
    changeCurrentPassword,
    changeNewPassword,
    setChangeCurrentPassword,
    setChangeNewPassword,
    handleServerAuthSubmit,
    handleServerLogout,
    handleForgotPassword,
    handleResetPassword,
    handleChangePassword,
    handleResendVerification
  };
}

export type ServerAuthApi = ReturnType<typeof useServerAuth>;
