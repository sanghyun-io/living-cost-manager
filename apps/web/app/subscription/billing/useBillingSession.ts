"use client";
import { useEffect, useState } from "react";
import { createServerApiClient, SERVER_SESSION_STORAGE_KEY, type ServerSession } from "../../lib/serverApi";
import { readJson } from "../../lib/storage";
import { SessionVerification, type VerificationState } from "./sessionVerification";

/** Reuse the existing login/session, never add a second signup/credential flow. */
export function useBillingSession() {
  const [auth, setAuth] = useState<VerificationState>({ session: null, status: "loading" });
  const [retry, setRetry] = useState<(() => void) | null>(null);
  useEffect(() => {
    const verifier = new SessionVerification(async (session, signal) => {
      const api = createServerApiClient({ fetchImpl: (input, init) => fetch(input, { ...init, signal }) });
      if (!api) throw new Error("API unavailable");
      return api.me(session.token);
    }, setAuth);
    const check = (explicit = false) => {
      let candidate: ServerSession | null = null;
      try { candidate = readJson<ServerSession | null>(SERVER_SESSION_STORAGE_KEY, null); } catch { /* Storage denied: show existing login entry. */ }
      const session = candidate && typeof candidate.token === "string" && candidate.token.length > 0 && typeof candidate.user?.id === "string" && candidate.user.id.length > 0 ? candidate : null;
      void verifier.check(session, explicit);
    };
    setRetry(() => () => check(true));
    check();
    const changed = () => check();
    window.addEventListener("storage", changed);
    window.addEventListener("focus", changed);
    const visible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { verifier.dispose(); window.removeEventListener("storage", changed); window.removeEventListener("focus", changed); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return { ...auth, checked: auth.status !== "loading", retry };
}
