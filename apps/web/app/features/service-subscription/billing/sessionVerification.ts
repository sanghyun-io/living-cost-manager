import { ServerApiError, type ServerSession } from "../../../lib/serverApi";

export interface VerificationState {
  session: ServerSession | null;
  status: "loading" | "verified" | "signed_out" | "unavailable" | "denied";
}
type Verify = (session: ServerSession, signal: AbortSignal) => Promise<{ user: ServerSession["user"] }>;
/** Successful identities are cached; transient failures are not successful logouts. */
export class SessionVerification {
  state: VerificationState = { session: null, status: "loading" };
  private identity: { token: string; id: string } | null = null;
  private verified = false;
  private refused = false;
  private failures = 0;
  private retryAt = 0;
  private generation = 0;
  private alive = true;
  private pending: AbortController | null = null;
  constructor(private verify: Verify, private publish: (state: VerificationState) => void, private now = Date.now) {}
  private update(state: VerificationState) { if (this.alive) { this.state = state; this.publish(state); } }
  dispose() { this.alive = false; ++this.generation; this.pending?.abort(); }
  async check(session: ServerSession | null, explicit = false) {
    if (!this.alive) return;
    const same = !!session && session.token === this.identity?.token && session.user.id === this.identity.id;
    if (!same) {
      ++this.generation; this.pending?.abort(); this.pending = null;
      this.identity = session ? { token: session.token, id: session.user.id } : null;
      this.verified = false; this.refused = false; this.failures = 0; this.retryAt = 0;
    }
    if (!session) { this.update({ session: null, status: "signed_out" }); return; }
    if (this.pending || this.verified || this.refused || this.now() < this.retryAt || (!explicit && this.failures >= 3)) return;
    const mine = ++this.generation;
    const abort = new AbortController(); this.pending = abort;
    this.update({ session: null, status: "loading" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.verify(session, abort.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("verification timeout")); }, 15000); })
      ]);
      if (!this.alive || mine !== this.generation) return;
      if (!response?.user || response.user.id !== session.user.id) {
        this.refused = true; this.update({ session: null, status: "denied" }); return;
      }
      this.verified = true; this.failures = 0;
      this.update({ session: { ...session, user: response.user }, status: "verified" });
    } catch (error) {
      if (!this.alive || mine !== this.generation) return;
      if (error instanceof ServerApiError && [401, 403].includes(error.status)) {
        this.refused = true; this.update({ session: null, status: "denied" });
      } else {
        this.failures++;
        this.retryAt = this.now() + Math.min(5000 * 2 ** (this.failures - 1), 60000);
        this.update({ session: null, status: "unavailable" });
      }
    } finally { if (timer !== undefined) clearTimeout(timer); if (mine === this.generation) this.pending = null; }
  }
}
