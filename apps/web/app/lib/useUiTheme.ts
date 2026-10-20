"use client";
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UiTheme } from '@living-cost-manager/shared';
import type { LocalUsersApi } from './useLocalUsers';
import type { ServerSession } from './serverApi';
import { getUserErasureKey } from './users';
import { useApplyUiTheme } from '../components/ThemeProvider';
import { createThemeApi, createThemeController, normalizeStoredUiTheme } from './uiTheme';

export function useUiTheme(users: LocalUsersApi, session: ServerSession | null, baseUrl?: string) {
  const [, update] = useState(0);
  const apply = useApplyUiTheme();
  const live = useRef({ users, session }); live.current = { users, session };
  const controller = useRef<ReturnType<typeof createThemeController> | null>(null);
  if (!controller.current) controller.current = createThemeController(createThemeApi(), () => update(n => n + 1));
  const profile = users.currentUser;
  const matched = !!profile && (!profile.serverUserId || profile.serverUserId === session?.user.id);
  const identity = JSON.stringify([profile?.id, matched, session?.user.id, session?.token, baseUrl]);
  const entered = useRef('');
  useLayoutEffect(() => {
    entered.current = identity;
    const id = profile?.id;
    const account = profile?.serverUserId && matched && session && baseUrl ? { id: session.user.id, token: session.token, baseUrl } : null;
    const valid = () => {
      if (!id || entered.current !== identity || live.current.users.currentUser?.id !== id) return false;
      if (account && (live.current.session?.token !== account.token || live.current.session.user.id !== account.id || live.current.users.currentUser.serverUserId !== account.id)) return false;
      try { if (window.localStorage.getItem(getUserErasureKey(id))) return false; } catch { /* memory mode */ }
      return true;
    };
    controller.current!.enter({ theme: matched ? normalizeStoredUiTheme(profile?.uiTheme) : 'jade', pending: !!profile?.uiThemePending }, account,
      record => valid() ? live.current.users.updateTheme(id!, record.theme, record.pending) : false, valid);
    return () => controller.current!.cancel();
  }, [identity]); // profile value updates must not restart reads or lose unsent intent
  const active = matched && entered.current === identity;
  const selected = active ? controller.current.record.theme : 'jade';
  useLayoutEffect(() => {
    document.documentElement.dataset.lcmTheme = selected; apply(selected);
  }, [selected, apply]);
  useEffect(() => {
    const retry = () => controller.current!.retry();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, []);
  return { selected, status: active ? controller.current.status : 'local', choose: (id: UiTheme) => controller.current!.choose(id), retry: () => controller.current!.retry() };
}
