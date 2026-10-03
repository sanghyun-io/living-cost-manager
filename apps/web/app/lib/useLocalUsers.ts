"use client";

import { useEffect, useState } from "react";
import { cleanupLocalAccountData } from "./account";
import { track } from "./analytics";
import { createUser, createServerLocalUser, getUserDataKey, getUserErasureKey, LOCAL_USER_NAME, mergeUsers, resolveStartupUser, type AppUser } from "./users";
import { SERVER_SESSION_STORAGE_KEY, type ServerSession } from "./serverApi";
import { ACTIVE_USER_KEY, USERS_KEY, STORAGE_KEY, LEGACY_STORAGE_KEY, isServerSession, readJson } from "./storage";
import { emptyBudgetSnapshot, sampleBudgetSnapshot } from "./seedData";
import type { LocalBudgetSnapshot } from "./snapshot";
import type { UIStateApi } from "./useUIState";
import type { ServerAuthApi } from "./useServerAuth";

/** Local (browser-only) user accounts and the active-user pointer. */
interface UseLocalUsersOptions {
  ui: UIStateApi;
  /**
   * The server-auth hook is created BEFORE this one (boot restores the server
   * session into it), so it is passed as a stable handle.
   */
  auth: ServerAuthApi;
  /**
   * The budget hook is created AFTER this one; handleLogin needs the live
   * snapshot to persist it under the switched-to user's key. The getter is
   * only invoked from event handlers (never during render).
   */
  getBudget: () => LocalBudgetSnapshot;
}

export function useLocalUsers({ ui, auth, getBudget }: UseLocalUsersOptions) {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [knownUsers, setKnownUsers] = useState<AppUser[]>([]);
  const [isBootLoaded, setIsBootLoaded] = useState(false);
  // True once the active user's budget data has been read from localStorage
  // (the budget hook flips it via setIsLoaded after its load effect runs).
  const [isLoaded, setIsLoaded] = useState(false);
  const sampleUserId = "demo-sample";
  const sampleReturnKey = "living-cost-manager:sample-return:v1";

  useEffect(() => {
    const users = readJson<AppUser[]>(USERS_KEY, []).filter((user) => !window.localStorage.getItem(getUserErasureKey(user.id)));
    const activeUserId = window.localStorage.getItem(ACTIVE_USER_KEY);
    const storedServerSession = readJson<ServerSession | null>(SERVER_SESSION_STORAGE_KEY, null);
    const validServerSession = isServerSession(storedServerSession) ? storedServerSession : null;
    const startupUser = resolveStartupUser({
      users,
      activeUserId,
      serverUser: validServerSession?.user ?? null
    });

    window.localStorage.setItem(USERS_KEY, JSON.stringify(startupUser.users));
    window.localStorage.setItem(ACTIVE_USER_KEY, startupUser.user.id);
    const startupKey = getUserDataKey(startupUser.user.id);
    if (!window.localStorage.getItem(startupKey)) {
      const legacy = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
      window.localStorage.setItem(startupKey, legacy ?? JSON.stringify(emptyBudgetSnapshot));
    }
    setKnownUsers(startupUser.users);
    setCurrentUser(startupUser.user);
    if (validServerSession) {
      // Old behavior: boot seeded serverSession (+ AuthModal prefill) in this
      // same effect so the first painted frame already had the session.
      // applyBootSession only touches stable setState functions, so the
      // mount-time capture of the auth handle is safe.
      auth.applyBootSession(validServerSession);
    }
    setIsBootLoaded(true);
    // Mount-only, exactly like the original page effect.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore the stored session once per app start (refresh tokens, workspaces,
  // snapshot decision). The ref guard lives in useServerAuth so the auth
  // submit flow can mark it checked too — same as the original page.
  const { serverApi, serverSession, serverRestoreCheckedRef, refreshRestoredServerSession } = auth;
  useEffect(() => {
    if (!isBootLoaded || !serverSession || !serverApi || serverRestoreCheckedRef.current) {
      return;
    }

    serverRestoreCheckedRef.current = true;
    void refreshRestoredServerSession(serverSession);
    // refreshRestoredServerSession closes over the render's handlers but only
    // mutates through setState/refs, matching the original effect exactly.
  }, [isBootLoaded, serverApi, serverSession, serverRestoreCheckedRef, refreshRestoredServerSession]);

  /**
   * Switches (or creates) the active local user. `method` only tags the
   * analytics event: "server" when a server-auth flow calls in for its
   * freshly signed-in account, "local" for plain browser-only logins.
   */
  function handleLogin(userName: string, method: "local" | "server" = "local", serverUser?: ServerSession["user"]) {
    const liveUsers = readJson<AppUser[]>(USERS_KEY, knownUsers).filter((user) => !window.localStorage.getItem(getUserErasureKey(user.id)));
    const identity = serverUser ?? auth.serverSession?.user;
    const nextUser = method === "server" && identity
      ? liveUsers.find((user) => user.serverUserId === identity.id) ?? createServerLocalUser(identity)
      : createUser(userName);
    if (window.localStorage.getItem(getUserErasureKey(nextUser.id))) throw new Error("삭제된 계정입니다. 다시 로그인하세요.");
    const isNewUser = !liveUsers.some((user) => user.id === nextUser.id);
    const nextUsers = mergeUsers(liveUsers, nextUser);
    const userDataKey = getUserDataKey(nextUser.id);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, nextUser.id);
    if (!window.localStorage.getItem(userDataKey)) {
      window.localStorage.setItem(userDataKey, JSON.stringify(emptyBudgetSnapshot));
    }
    setKnownUsers(nextUsers);
    if (currentUser?.id !== nextUser.id) setIsLoaded(false);
    setCurrentUser(nextUser);

    track(
      isNewUser
        ? { type: "auth.register", timestamp: Date.now(), data: {} }
        : { type: "auth.login", timestamp: Date.now(), data: { method } }
    );
  }

  // Demo lives in its own local profile; neither direction replaces real data.
  function handleChooseDataMode(mode: "sample" | "blank") {
    auth.handleServerLogout();
    const liveUsers = readJson<AppUser[]>(USERS_KEY, knownUsers).filter((user) => !window.localStorage.getItem(getUserErasureKey(user.id)));
    if (mode === "sample" && currentUser && currentUser.id !== sampleUserId && !window.localStorage.getItem(getUserErasureKey(currentUser.id))) {
      window.localStorage.setItem(sampleReturnKey, currentUser.id);
    }
    const returnId = window.localStorage.getItem(sampleReturnKey);
    const nextUser = mode === "sample" ? { id: sampleUserId, name: "샘플 체험" }
      : liveUsers.find((user) => user.id === returnId && user.id !== sampleUserId) ?? createUser(LOCAL_USER_NAME);
    const key = getUserDataKey(nextUser.id);
    if (!window.localStorage.getItem(key)) {
      window.localStorage.setItem(key, JSON.stringify(mode === "sample" ? sampleBudgetSnapshot : emptyBudgetSnapshot));
    }
    const nextUsers = mergeUsers(liveUsers, nextUser);
    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, nextUser.id);
    setKnownUsers(nextUsers);
    setIsLoaded(false);
    setCurrentUser(nextUser);
  }

  function handleLogout() {
    const localUser = createUser(LOCAL_USER_NAME);
    const liveUsers = readJson<AppUser[]>(USERS_KEY, knownUsers).filter((user) => !window.localStorage.getItem(getUserErasureKey(user.id)));
    const nextUsers = mergeUsers(liveUsers, localUser);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, localUser.id);
    setKnownUsers(nextUsers);
    setCurrentUser(localUser);
    setIsLoaded(false);
    ui.closeDataAndManagementModals();
    ui.setIsDeleteMode(false);
    ui.setSelectedDeleteIds([]);
    track({ type: "auth.logout", timestamp: Date.now(), data: {} });
  }

  /**
   * Local mirror of a successful server-side account deletion: wipes every
   * trace of the removed account (user entry, per-user budget data, legacy
   * snapshot, server session) and moves the UI to another known user or a
   * fresh local one. Mirrors handleLogout's state resets, but unlike logout
   * the deleted user's data is NOT kept.
   */
  function handleAccountDeleted(removedUserId: string | null = currentUser?.id ?? null) {
    const result = removedUserId
      ? cleanupLocalAccountData(window.localStorage, removedUserId, { clearServerSession: false })
      : { remainingUsers: knownUsers, activeUserId: null };

    if (currentUser && removedUserId !== currentUser.id) {
      setKnownUsers(result.remainingUsers);
      window.localStorage.setItem(ACTIVE_USER_KEY, currentUser.id);
      return;
    }

    if (result.remainingUsers.length > 0) {
      // Another browser user takes the active pointer (their data lives under
      // their own key and is loaded by the budget hook below).
      const nextUser = result.remainingUsers[0];
      setKnownUsers(result.remainingUsers);
      setCurrentUser(nextUser);
    } else {
      const localUser = createUser(LOCAL_USER_NAME);
      window.localStorage.setItem(USERS_KEY, JSON.stringify([localUser]));
      window.localStorage.setItem(ACTIVE_USER_KEY, localUser.id);
      window.localStorage.setItem(getUserDataKey(localUser.id), JSON.stringify(emptyBudgetSnapshot));
      setKnownUsers([localUser]);
      setCurrentUser(localUser);
    }
    setIsLoaded(false);
    ui.closeDataAndManagementModals();
    ui.setIsDeleteMode(false);
    ui.setSelectedDeleteIds([]);
  }

  return {
    currentUser,
    knownUsers,
    isBootLoaded,
    isLoaded,
    setIsLoaded,
    handleLogin,
    handleLogout,
    isSampleMode: currentUser?.id === sampleUserId,
    handleChooseDataMode,
    handleAccountDeleted
  };
}

export type LocalUsersApi = ReturnType<typeof useLocalUsers>;
