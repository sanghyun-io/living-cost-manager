"use client";

import { useEffect, useState } from "react";
import { createUser, getUserDataKey, LOCAL_USER_NAME, mergeUsers, resolveStartupUser, type AppUser } from "./users";
import { SERVER_SESSION_STORAGE_KEY, type ServerSession } from "./serverApi";
import { ACTIVE_USER_KEY, USERS_KEY, isServerSession, readJson } from "./storage";
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
  const initialDataMode: "sample" | "blank" = "sample";

  useEffect(() => {
    const users = readJson<AppUser[]>(USERS_KEY, []);
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

  function handleLogin(userName: string) {
    const nextUser = createUser(userName);
    const isNewUser = !knownUsers.some((user) => user.id === nextUser.id);
    const nextUsers = mergeUsers(knownUsers, nextUser);
    const userDataKey = getUserDataKey(nextUser.id);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, nextUser.id);
    if (currentUser && currentUser.id !== nextUser.id) {
      window.localStorage.setItem(userDataKey, JSON.stringify(getBudget()));
    } else if (isNewUser && !window.localStorage.getItem(userDataKey)) {
      const snapshot = initialDataMode === "blank" ? emptyBudgetSnapshot : sampleBudgetSnapshot;
      window.localStorage.setItem(userDataKey, JSON.stringify(snapshot));
    }
    setKnownUsers(nextUsers);
    setIsLoaded(false);
    setCurrentUser(nextUser);
  }

  function handleLogout() {
    const localUser = createUser(LOCAL_USER_NAME);
    const nextUsers = mergeUsers(knownUsers, localUser);

    window.localStorage.setItem(USERS_KEY, JSON.stringify(nextUsers));
    window.localStorage.setItem(ACTIVE_USER_KEY, localUser.id);
    setKnownUsers(nextUsers);
    setCurrentUser(localUser);
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
    handleLogout
  };
}

export type LocalUsersApi = ReturnType<typeof useLocalUsers>;
