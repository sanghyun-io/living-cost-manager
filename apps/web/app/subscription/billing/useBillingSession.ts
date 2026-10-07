"use client";
import { useEffect, useState } from "react";
import { createServerApiClient, SERVER_SESSION_STORAGE_KEY, type ServerSession } from "../../lib/serverApi";
import { readJson } from "../../lib/storage";

/** Reuse the existing login/session, never add a second signup/credential flow. */
export function useBillingSession() {
  const [auth, setAuth] = useState<{ session: ServerSession | null; checked: boolean }>({ session: null, checked: false });
  useEffect(() => {
    let alive = true, generation = 0;
    let verifying: AbortController | null = null;
    let lastToken: string | null | undefined;
    let lastId: string | null | undefined;
    const check = () => {
      let candidate: ServerSession | null = null;
      try { candidate = readJson<ServerSession | null>(SERVER_SESSION_STORAGE_KEY, null); } catch { /* Storage denied: show existing login entry. */ }
      const session = candidate && typeof candidate.token === "string" && typeof candidate.user?.id === "string" ? candidate : null;
      if (lastToken === (session?.token ?? null) && lastId === (session?.user.id ?? null)) return;
      lastToken = session?.token ?? null; lastId = session?.user.id ?? null;
      const mine = ++generation;
      verifying?.abort();
      const abort = new AbortController();
      verifying = abort;
      setAuth({ session: null, checked: false });
      const api = createServerApiClient({ fetchImpl: (input, init) => fetch(input, { ...init, signal: abort.signal }) });
      if (!session || !api) { setAuth({ session: null, checked: true }); return; }
      const timeout = setTimeout(() => abort.abort(), 15000);
      void api.me(session.token).then(({ user }) => {
        if (alive && mine === generation) setAuth({ session: user.id === session.user.id ? { ...session, user } : null, checked: true });
      }).catch(() => { if (alive && mine === generation) setAuth({ session: null, checked: true }); }).finally(() => clearTimeout(timeout));
    };
    check();
    window.addEventListener("storage", check);
    window.addEventListener("focus", check);
    const visible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; ++generation; verifying?.abort(); window.removeEventListener("storage", check); window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return auth;
}
