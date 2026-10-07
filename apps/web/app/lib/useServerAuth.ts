"use client";

import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { DELETE_ACCOUNT_CONFLICT_CODE } from "@living-cost-manager/shared";
import {
  createServerApiClient,
  isServerAuthFailure,
  resolveServerSessionWorkspace,
  SERVER_SESSION_STORAGE_KEY,
  ServerApiError,
  type ServerSession
} from "./serverApi";
import { getErrorMessage, getServerSyncErrorMessage } from "./serverMessages";
import { clearAuthQueryParam } from "./storage";
import { validateEmail, validateName, validatePassword } from "./validation";
import type { AuthFormValues } from "../components/modals/AuthModal";
import type { UIStateApi } from "./useUIState";
import type { LocalUsersApi } from "./useLocalUsers";
import type { WorkspaceSyncApi } from "./useWorkspaceSync";
import { clearEvents } from "./analytics";

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
  const [serverSession, updateServerSession] = useState<ServerSession | null>(null);
  const sessionRef = useRef<ServerSession | null>(null);
  const authGeneration = useRef(0);
  function commitSession(session: ServerSession | null) {
    sessionRef.current = session;
    updateServerSession(session);
  }
  function setServerSession(action: SetStateAction<ServerSession | null>) {
    authGeneration.current += 1;
    commitSession(typeof action === "function" ? action(sessionRef.current) : action);
    setIsServerBusy(false);
  }
  function isCurrent(generation: number) { return generation === authGeneration.current; }
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
      const generation = authGeneration.current;
      clearAuthQueryParam("verify_token");
      void serverApi
        .verifyEmail(verify)
        .then(() => {
          if (!isCurrent(generation)) return;
          setServerStatus("이메일 인증이 완료되었습니다.");
          // If the post-signup notice is still open, dismiss it now.
          setVerifyNoticeEmail(null);
          const current = sessionRef.current;
          if (current) {
            const updated = { ...current, user: { ...current.user, emailVerified: true } };
            saveServerSession(updated);
            commitSession(updated);
          }
        })
        .catch(() => {
          if (!isCurrent(generation)) return;
          setServerStatus("이메일 인증 링크가 유효하지 않거나 만료되었습니다.");
        })
        .finally(() => {
          if (isCurrent(generation)) ui.setIsDataModalOpen(true);
        });
    }
    // ui.setIsDataModalOpen is a stable setter; the original effect only
    // depended on serverApi.
  }, [serverApi]);

  // Boot seeds the session inside the local-users effect so the first painted
  // frame has it; AuthModal prefills its drafts from bootServerSession.
  function applyBootSession(session: ServerSession) {
    if (authGeneration.current !== 0) return;
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

  async function resolveAndStoreServerSession(session: ServerSession, generation = authGeneration.current) {
    if (!isCurrent(generation)) throw new Error("Stale auth response");
    if (!serverApi) {
      saveServerSession(session);
      commitSession(session);
      getSync().setIsServerSnapshotChecked(false);
      return session;
    }

    const nextSession = await resolveServerSessionWorkspace(serverApi, session);
    if (!isCurrent(generation)) throw new Error("Stale auth response");
    // Commit the local identity before exposing the session. Later list/network
    // failures must never leave account B paired with account A's local budget.
    getUsers().handleLogin(nextSession.user.name || nextSession.user.email, "server", nextSession.user);
    saveServerSession(nextSession);
    commitSession(nextSession);
    setServerErrorKind(null);
    getSync().setIsServerSnapshotChecked(false);
    await getSync().loadServerWorkspaces(nextSession);
    if (!isCurrent(generation)) throw new Error("Stale auth response");
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

    const generation = ++authGeneration.current;
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
      if (!isCurrent(generation)) return false;
      const nextSession = await resolveAndStoreServerSession({
        ...authResult,
        workspace: authResult.workspace ?? null
      }, generation);

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
      if (!isCurrent(generation)) return false;
      await getSync().refreshSharing(nextSession);
      if (!isCurrent(generation)) return false;
      return true;
    } catch (error) {
      if (!isCurrent(generation)) return false;
      setServerErrorKind(isServerAuthFailure(error) ? "auth" : "request");
      setServerStatus(getErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(generation)) setIsServerBusy(false);
    }
  }

  function handleServerLogout() {
    authGeneration.current += 1;
    setIsServerBusy(false);
    // Best-effort server-side logout (invalidates refresh tokens); ignore failures.
    if (serverApi && sessionRef.current) {
      void serverApi.logout(sessionRef.current.token).catch(() => undefined);
    }
    window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
    commitSession(null);
    // Everything server-workspace-scoped (snapshot, checked flag, workspaces,
    // members, invitations, sync stamps, trend cache) is wiped there.
    getSync().resetOnServerLogout();
    setServerErrorKind(null);
    setServerStatus("서버 연결을 해제했습니다. 브라우저 데이터는 유지됩니다.");
  }

  async function handleForgotPassword(email: string) {
    const generation = authGeneration.current;
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
      if (!isCurrent(generation)) return;
      setServerStatus("입력하신 이메일이 가입되어 있다면 재설정 링크를 보냈습니다. 메일함을 확인하세요.");
    } catch (error) {
      if (!isCurrent(generation)) return;
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      if (isCurrent(generation)) setIsServerBusy(false);
    }
  }

  // Returns true on success so ResetPasswordModal can clear its own draft
  // (the old page-level state was cleared here; now the modal mirrors that).
  async function handleResetPassword(password: string): Promise<boolean> {
    const generation = authGeneration.current;
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
      if (!isCurrent(generation)) return false;
      setResetToken(null);
      clearAuthQueryParam("reset_token");
      setAuthLoginRequest((count) => count + 1);
      ui.setIsAuthModalOpen(true);
      setServerStatus("비밀번호를 재설정했습니다. 새 비밀번호로 로그인하세요.");
      return true;
    } catch (error) {
      if (!isCurrent(generation)) return false;
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(generation)) setIsServerBusy(false);
    }
  }

  async function handleChangePassword() {
    const generation = authGeneration.current;
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
      if (!isCurrent(generation)) return;
      // change-password bumps tokenVersion and returns fresh tokens; keep workspace.
      const nextSession = await resolveAndStoreServerSession({
        ...updated,
        workspace: updated.workspace ?? serverSession.workspace ?? null
      }, generation);
      commitSession(nextSession);
      setChangeCurrentPassword("");
      setChangeNewPassword("");
      setServerStatus("비밀번호를 변경했습니다.");
    } catch (error) {
      if (!isCurrent(generation)) return;
      const wrongPassword = error instanceof ServerApiError && error.status === 401 && error.message === "Invalid credentials";
      if (isServerAuthFailure(error) && !wrongPassword) {
        window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
        commitSession(null);
        getSync().dropSessionOnAuthFailure();
        setServerErrorKind("auth");
        setServerStatus("서버 세션이 만료되었습니다. 다시 로그인해 주세요.");
      } else {
        setServerErrorKind("request");
        setServerStatus(wrongPassword ? "현재 비밀번호가 올바르지 않습니다." : getErrorMessage(error));
      }
    } finally {
      if (isCurrent(generation)) setIsServerBusy(false);
    }
  }

  async function handleResendVerification() {
    const generation = authGeneration.current;
    if (!serverApi || !serverSession) {
      return;
    }
    setIsServerBusy(true);
    setServerStatus("");
    try {
      await serverApi.resendVerification(serverSession.token);
      if (!isCurrent(generation)) return;
      setServerStatus("인증 메일을 다시 보냈습니다. 메일함을 확인하세요.");
    } catch (error) {
      if (!isCurrent(generation)) return;
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
    } finally {
      if (isCurrent(generation)) setIsServerBusy(false);
    }
  }

  /**
   * Outcome of DELETE /account for DeleteAccountModal: the modal closes only
   * on "deleted"; the other results keep it open with an inline error so the
   * user can correct the password or resolve workspace ownership first.
   */
  async function handleDeleteAccount(password: string): Promise<"deleted" | "error"> {
    const deletingSession = sessionRef.current;
    const removedUserId = deletingSession
      ? getUsers().knownUsers?.find((user) => user.serverUserId === deletingSession.user.id)?.id ?? "server:" + deletingSession.user.id
      : undefined;
    if (!serverApi || !deletingSession || !removedUserId) {
      setServerErrorKind("request");
      setServerStatus("로그인이 필요합니다.");
      return "error";
    }
    if (password.length < 8) {
      setServerErrorKind("request");
      setServerStatus("비밀번호를 입력해주세요.");
      return "error";
    }

    const generation = ++authGeneration.current;
    setIsServerBusy(true);
    setServerStatus("");
    setServerErrorKind(null);
    try {
      await serverApi.deleteAccount(password, deletingSession.token);

      // The account row is gone server-side (all issued tokens died with it).
      // Wipe every local trace of it and bounce the UI back to the login form.
      getUsers().handleAccountDeleted(removedUserId);
      void clearEvents();
      if (!isCurrent(generation)) return "deleted";
      window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
      commitSession(null);
      // Everything server-workspace-scoped (snapshot, workspaces, members,
      // invitations, trend cache) is reset here, same as a full logout.
      getSync().resetOnServerLogout();
      setChangeCurrentPassword("");
      setChangeNewPassword("");
      setAuthLoginRequest((count) => count + 1);
      ui.setIsAuthModalOpen(true);
      setServerStatus("계정을 삭제했습니다. 서버에 있던 모든 데이터가 영구적으로 제거되었습니다.");
      return "deleted";
    } catch (error) {
      if (!isCurrent(generation)) return "error";
      if (error instanceof ServerApiError && error.status === 401 && error.message === "Invalid credentials") {
        // Password re-confirmation failed — keep the session usable.
        setServerErrorKind("request");
        setServerStatus("비밀번호가 올바르지 않습니다.");
        return "error";
      }
      if (error instanceof ServerApiError && error.code === DELETE_ACCOUNT_CONFLICT_CODE) {
        setServerErrorKind("request");
        setServerStatus("공동 가계부의 소유권부터 이전해야 계정을 삭제할 수 있습니다.");
        return "error";
      }
      if (isServerAuthFailure(error)) {
        // Session died while we were deleting: treat exactly like the boot
        // restore's auth-failure path so the UI never keeps a stale session.
        window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
        commitSession(null);
        getSync().dropSessionOnAuthFailure();
        setServerErrorKind("auth");
        setServerStatus("서버 세션이 만료되었습니다. 다시 로그인해 주세요.");
        return "error";
      }
      setServerErrorKind("request");
      setServerStatus(getErrorMessage(error));
      return "error";
    } finally {
      if (isCurrent(generation)) setIsServerBusy(false);
    }
  }

  async function refreshRestoredServerSession(session: ServerSession) {
    const generation = authGeneration.current;
    if (!serverApi || sessionRef.current?.token !== session.token) {
      return;
    }

    // The stored access token is short-lived; if it has expired, transparently
    // exchange the refresh token for a new pair before restoring the session.
    let activeSession = session;
    try {
      await serverApi.me(session.token);
      if (!isCurrent(generation)) return;
    } catch (probeError) {
      if (!isCurrent(generation)) return;
      if (isServerAuthFailure(probeError)) {
        try {
          const refreshed = await serverApi.refresh(session.refreshToken);
          if (!isCurrent(generation)) return;
          activeSession = { ...refreshed, workspace: refreshed.workspace ?? session.workspace };
          saveServerSession(activeSession);
          commitSession(activeSession);
        } catch {
          // refresh token also invalid -> fall through to the catch below via me()
        }
      }
    }

    if (!isCurrent(generation)) return;
    try {
      const [{ user }, nextSession] = await Promise.all([
        serverApi.me(activeSession.token),
        resolveServerSessionWorkspace(serverApi, activeSession)
      ]);
      if (!isCurrent(generation)) return;
      const restoredSession = {
        ...nextSession,
        user
      };

      saveServerSession(restoredSession);
      commitSession(restoredSession);
      setServerErrorKind(null);
      await getSync().loadServerWorkspaces(restoredSession);
      if (!isCurrent(generation)) return;
      if (restoredSession.workspace) {
        await getSync().prepareServerSyncDecision(restoredSession);
      } else {
        setServerStatus("선택한 가계부가 없습니다. 화면 상단에서 가계부를 선택하거나 새로 만드세요.");
      }
    } catch (error) {
      if (!isCurrent(generation)) return;
      if (isServerAuthFailure(error)) {
        window.localStorage.removeItem(SERVER_SESSION_STORAGE_KEY);
        commitSession(null);
        getSync().dropSessionOnAuthFailure();
        return;
      }
      setServerErrorKind("request");
      setServerStatus(getServerSyncErrorMessage(error) + " 서버 연결은 유지했습니다. 데이터 관리에서 다시 시도하세요.");
    }
  }

  return {
    matchesServerScope: (accountId: string | undefined, workspaceId: string | undefined) => sessionRef.current?.user.id === accountId && sessionRef.current?.workspace?.id === workspaceId,
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
    handleDeleteAccount,
    handleResendVerification
  };
}

export type ServerAuthApi = ReturnType<typeof useServerAuth>;
