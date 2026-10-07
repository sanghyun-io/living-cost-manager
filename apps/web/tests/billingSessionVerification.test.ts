import { afterEach, expect, test, vi } from "vitest";
import { SessionVerification } from "../app/subscription/billing/sessionVerification";
import { ServerApiError, type ServerSession } from "../app/lib/serverApi";
const session = (id = "synthetic-account", token = "synthetic-token"): ServerSession => ({ token, refreshToken: "synthetic-refresh", user: { id } as ServerSession["user"], workspace: null });
afterEach(() => vi.useRealTimers());
test("5xx same identity recovers on throttled focus, event storm deduplicates, successful cache suppresses more requests", async () => {
  let now = 0;
  const verify = vi.fn().mockRejectedValueOnce(new ServerApiError("sanitized", 503)).mockResolvedValue({ user: session().user });
  const auth = new SessionVerification(verify, () => {}, () => now);
  await auth.check(session()); expect(auth.state.status).toBe("unavailable");
  await Promise.all(Array.from({ length: 20 }, () => auth.check(session()))); expect(verify).toHaveBeenCalledTimes(1);
  now = 5000; await Promise.all(Array.from({ length: 20 }, () => auth.check(session())));
  expect(verify).toHaveBeenCalledTimes(2); expect(auth.state.status).toBe("verified");
  await auth.check(session()); await auth.check(session(), true); expect(verify).toHaveBeenCalledTimes(2); auth.dispose();
});
test("held timeout becomes unavailable, bounded same-token focus retry can recover", async () => {
  vi.useFakeTimers(); let now = 0;
  const verify = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ user: session().user });
  const auth = new SessionVerification(verify, () => {}, () => now);
  const pending = auth.check(session()); await auth.check(session()); expect(verify).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000); await pending; expect(auth.state.status).toBe("unavailable");
  now = 5000; await auth.check(session()); expect(auth.state.status).toBe("verified"); expect(verify).toHaveBeenCalledTimes(2); auth.dispose();
});
test.each([401, 403])("HTTP %s refusal is stable until token changes, never focus retried", async status => {
  const verify = vi.fn().mockRejectedValueOnce(new ServerApiError("do not display", status)).mockResolvedValue({ user: session().user });
  const auth = new SessionVerification(verify, () => {}, () => 60000);
  await auth.check(session()); expect(auth.state.status).toBe("denied");
  await auth.check(session()); await auth.check(session(), true); expect(verify).toHaveBeenCalledTimes(1);
  await auth.check(session("synthetic-account", "synthetic-refreshed-token")); expect(auth.state.status).toBe("verified"); auth.dispose();
});
test("account change and late old validation cannot log in the old account", async () => {
  let finish!: (response: { user: ServerSession["user"] }) => void;
  const verify = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ user: session("other").user });
  const auth = new SessionVerification(verify, () => {});
  const old = auth.check(session()); await auth.check(session("other", "other-token"));
  finish({ user: session().user }); await old; expect(auth.state.session?.user.id).toBe("other");
  await auth.check(null); expect(auth.state.session).toBeNull(); expect(auth.state.status).toBe("signed_out"); auth.dispose();
});
test("mismatching returned identity is a refusal, not a verified session", async () => {
  const verify = vi.fn().mockResolvedValue({ user: session("wrong-account").user });
  const auth = new SessionVerification(verify, () => {}); await auth.check(session());
  expect(auth.state.status).toBe("denied"); expect(auth.state.session).toBeNull(); auth.dispose();
});
test("three transient failures cap automatic retries; explicit retry obeys backoff", async () => {
  let now = 0; const verify = vi.fn().mockRejectedValue(new Error("offline"));
  const auth = new SessionVerification(verify, () => {}, () => now);
  await auth.check(session()); now += 5000; await auth.check(session()); now += 10000; await auth.check(session());
  now += 20000; await auth.check(session()); expect(verify).toHaveBeenCalledTimes(3);
  await auth.check(session(), true); expect(verify).toHaveBeenCalledTimes(4);
  await auth.check(session(), true); expect(verify).toHaveBeenCalledTimes(4); auth.dispose();
});
