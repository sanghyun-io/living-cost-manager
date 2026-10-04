import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
vi.mock("../app/lib/serverApi", () => ({ getServerApiBaseUrl: () => endpoint.value }));
const endpoint = vi.hoisted(() => ({ value: "https://api.example.test/living-cost-manager/v1" }));
import * as consent from "../app/lib/marketingConsent";
import * as marketing from "../app/lib/marketing";

let values: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
const personal = { workspace: { sharedWorkspace: false } };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => {
  values = new Map();
  storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  endpoint.value = "https://api.example.test/living-cost-manager/v1";
  consent.__resetMarketingConsentMemoryForTests();
});
afterEach(async () => { marketing.disableMarketing(); await flush(); vi.unstubAllGlobals(); });

describe("consent storage fails closed", () => {
  test("absent consent defaults off; enabled scope is stable until revocation", () => {
    expect(consent.readMarketingConsent()).toEqual({ enabled: false, scope: null, browserOptOut: false });
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(false);
    const first = consent.enableMarketingConsent();
    expect(first.enabled).toBe(true);
    expect(consent.enableMarketingConsent()).toEqual(first);
    consent.disableMarketingConsent();
    expect(consent.readMarketingConsent().enabled).toBe(false);
    expect(consent.enableMarketingConsent().scope).not.toBe(first.scope);
  });
  test.each([null, "", "x".repeat(129)])("invalid scope %s is rejected", (scope) => {
    values.set(consent.MARKETING_CONSENT_STORAGE_KEY, "on");
    if (scope !== null) values.set(consent.MARKETING_CONSENT_SCOPE_STORAGE_KEY, scope);
    expect(consent.readMarketingConsent().enabled).toBe(false);
  });
  test.each([consent.MARKETING_CONSENT_STORAGE_KEY, consent.MARKETING_CONSENT_SCOPE_STORAGE_KEY])("partial write failure at %s rolls back", (failedKey) => {
    storage.setItem.mockImplementation((key: string, value: string) => { if (key === failedKey) throw Error("quota"); values.set(key, value); });
    expect(consent.enableMarketingConsent().enabled).toBe(false);
    expect(values.size).toBe(0);
  });
  test("silent dropped writes and read-back errors cannot enable", () => {
    storage.setItem.mockImplementation(() => undefined);
    expect(consent.enableMarketingConsent().enabled).toBe(false);
    storage.getItem.mockImplementation(() => { throw Error("security"); });
    expect(consent.readMarketingConsent().enabled).toBe(false);
    expect(consent.hasMarketingSentMarker("scope", "personal_cost_saved")).toBe(true);
  });
  test("remove failure leaves a durable OFF tombstone for other tabs and reloads", () => {
    consent.enableMarketingConsent();
    storage.removeItem.mockImplementation(() => { throw Error("security"); });
    expect(consent.disableMarketingConsent()).toBe(true);
    expect(values.get(consent.MARKETING_CONSENT_STORAGE_KEY)).toBe("off");
    // A fresh module/tab has no in-memory denial but shares persisted consent.
    consent.__resetMarketingConsentMemoryForTests();
    expect(consent.readMarketingConsent().enabled).toBe(false);
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(false);
    expect(consent.enableMarketingConsent().enabled).toBe(true);
  });
  test("write and remove failures report non-durable revocation and session fallback survives reload", () => {
    const session = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage, sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value)
    } });
    expect(consent.enableMarketingConsent().enabled).toBe(true);
    storage.setItem.mockImplementation(() => { throw Error("readonly"); });
    storage.removeItem.mockImplementation(() => { throw Error("readonly"); });
    expect(consent.disableMarketingConsent()).toBe(false);
    expect(values.get(consent.MARKETING_CONSENT_STORAGE_KEY)).toBe("on");
    consent.__resetMarketingConsentMemoryForTests();
    expect(consent.readMarketingConsent().enabled).toBe(false);
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(false);
    // A different tab without the session tombstone still cannot transmit while
    // shared storage is read-only: marking a dispatch must successfully persist.
    session.clear();
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(false);
  });
  test("failed enable plus failed cleanup cannot override session denial", () => {
    const session = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: storage, sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value)
    } });
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key === consent.MARKETING_CONSENT_STORAGE_KEY) throw Error("readonly");
      values.set(key, value);
    });
    storage.removeItem.mockImplementation(() => { throw Error("readonly"); });
    expect(consent.enableMarketingConsent().enabled).toBe(false);
    consent.__resetMarketingConsentMemoryForTests();
    expect(consent.readMarketingConsent().enabled).toBe(false);
  });
  test("inaccessible localStorage and browser privacy properties fail closed", () => {
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get() { throw Error("denied"); } }));
    expect(consent.enableMarketingConsent().enabled).toBe(false);
    vi.stubGlobal("navigator", Object.defineProperty({}, "globalPrivacyControl", { get() { throw Error("denied"); } }));
    expect(consent.isBrowserOptOut()).toBe(true);
  });
});

describe("anonymous transport", () => {
  test("browser-local remote OFF aborts transport, preserves session denial, ignores other messages and closes channels", async () => {
    const session = new Map<string, string>();
    const channels: LocalChannel[] = [];
    class LocalChannel {
      onmessage: ((message: { data: unknown }) => void) | null = null;
      closed = false;
      messages: unknown[] = [];
      constructor(readonly name: string) { channels.push(this); }
      postMessage(message: unknown) { this.messages.push(message); }
      close() { this.closed = true; }
    }
    vi.stubGlobal("window", { localStorage: storage, BroadcastChannel: LocalChannel, sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value)
    } });
    const scope = consent.enableMarketingConsent().scope!;
    vi.mocked(fetch).mockReturnValue(new Promise(() => undefined));
    marketing.sendMarketingEvent("personal_cost_saved", personal); await flush();
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    const notified = vi.fn();
    const unsubscribe = marketing.subscribeMarketingRevocation(notified);
    channels[0].onmessage!({ data: "on" });
    expect(signal.aborted).toBe(false); expect(notified).not.toHaveBeenCalled();
    channels[0].onmessage!({ data: "off" });
    expect(signal.aborted).toBe(true); expect(notified).toHaveBeenCalledExactlyOnceWith(true);
    // Even if another tab restores shared ON, this tab's session denial survives
    // a reload until this tab explicitly opts in again.
    values.set(consent.MARKETING_CONSENT_STORAGE_KEY, "on");
    values.set(consent.MARKETING_CONSENT_SCOPE_STORAGE_KEY, scope);
    consent.__resetMarketingConsentMemoryForTests();
    expect(consent.readMarketingConsent().enabled).toBe(false);
    unsubscribe(); expect(channels[0].closed).toBe(true);
    marketing.disableMarketing();
    expect(channels[1].messages).toEqual(["off"]);
    expect(channels[1].closed).toBe(true);
  });
  test.each([{ globalPrivacyControl: true }, { doNotTrack: "1" }, { doNotTrack: "true" }, { webkitDoNotTrack: true }, { msDoNotTrack: "1" }])("privacy override %j applies at actual send time", async (privacy) => {
    consent.enableMarketingConsent();
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(true);
    vi.stubGlobal("navigator", privacy);
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(consent.enableMarketingConsent().enabled).toBe(false);
  });
  test("revocation drops deferred dispatch and aborts active request", async () => {
    consent.enableMarketingConsent();
    marketing.sendMarketingEvent("personal_cost_saved", personal);
    marketing.disableMarketing();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    consent.enableMarketingConsent();
    vi.mocked(fetch).mockReturnValue(new Promise(() => undefined));
    marketing.sendMarketingEvent("personal_cost_saved", personal);
    await flush();
    const options = vi.mocked(fetch).mock.calls[0][1]!;
    expect(options.signal?.aborted).toBe(false);
    marketing.disableMarketing();
    expect(options.signal?.aborted).toBe(true);
  });
  test("only event name is sent; no credentials, referrer, URL or identity metadata", async () => {
    consent.enableMarketingConsent();
    marketing.sendMarketingEvent("personal_cost_saved", personal);
    await flush();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(endpoint.value + "/marketing/events", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"event":"personal_cost_saved"}',
      credentials: "omit", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal)
    });
  });
  test.each([undefined, null, {}, 1, ["personal_cost_saved"], " personal_cost_saved", "personal_cost_saved\n", "PERSONAL_COST_SAVED", "unknown"]) ("rejects invalid event %j", async (event) => {
    consent.enableMarketingConsent();
    expect(marketing.sendMarketingEvent(event, personal)).toBe(false);
    await flush(); expect(fetch).not.toHaveBeenCalled();
    expect(values.size).toBe(2);
  });
  test.each([null, undefined, { sharedWorkspace: true }, {}])("ambiguous/shared context %j never sends", (workspace) => {
    consent.enableMarketingConsent();
    expect(marketing.sendMarketingEvent("personal_cost_saved", { workspace } as typeof personal)).toBe(false);
  });
  test.each(["", "/api", "ftp://example.test", "https://user:password@example.test", "https://example.test?secret=1", "https://example.test#private"]) ("unsafe base %s never sends", (base) => {
    endpoint.value = base; consent.enableMarketingConsent();
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(false);
  });
  test.each(["throw", "reject", "http-error"])("persistent markers prevent retry after %s and key count stays bounded across periods", async (failure) => {
    vi.mocked(fetch).mockImplementation(() => {
      if (failure === "throw") throw Error("offline");
      if (failure === "reject") return Promise.reject(Error("offline"));
      return Promise.resolve({ ok: false, status: 500 } as Response);
    });
    for (let period = 0; period < 3; period++) {
      const scope = consent.enableMarketingConsent().scope;
      for (const event of marketing.MARKETING_EVENT_NAMES) {
        expect(marketing.sendMarketingEvent(event, personal)).toBe(true);
        await flush();
        consent.__resetMarketingConsentMemoryForTests();
        expect(marketing.sendMarketingEvent(event, personal)).toBe(false);
        expect(values.get(consent.marketingSentKey(event))).toBe(scope);
      }
      expect(values.size).toBe(5);
      marketing.disableMarketing();
    }
    expect(fetch).toHaveBeenCalledTimes(9);
  });
  test.each(["read", "write", "readback"])("marker %s failure blocks transport", async (failure) => {
    consent.enableMarketingConsent();
    storage.getItem.mockImplementation((key: string) => {
      if (key.startsWith(consent.MARKETING_SENT_KEY_PREFIX)) {
        if (failure === "read") throw Error("denied");
        if (failure === "readback") return null;
      }
      return values.get(key) ?? null;
    });
    storage.setItem.mockImplementation((key: string, value: string) => { if (failure === "write") throw Error("quota"); values.set(key, value); });
    expect(marketing.sendMarketingEvent("personal_cost_saved", personal)).toBe(false);
    await flush(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("save signal classification", () => {
  test.each(["2024-02-29", "2026-12-31"])("valid calendar date %s", (billingAnchorDate) => {
    expect(marketing.classifyItemChangeSignals({ billingAnchorDate })).toEqual([{ event: "personal_billing_date_saved", value: billingAnchorDate }]);
  });
  test.each([null, "", "2026-02-29", "2026-04-31", "2026-00-12", "2026-13-01", "2026-01-00", "2026-1-01", "2026-01-01T00:00:00Z"])("invalid date %s", (billingAnchorDate) => {
    expect(marketing.classifyItemChangeSignals({ billingAnchorDate })).toEqual([]);
  });
  test.each(["keep", "cancel-planned", "change-review", "completed"] as const)("decision %s classified", (renewalStatus) => {
    expect(marketing.classifyItemChangeSignals({ renewalStatus })).toEqual([{ event: "personal_renewal_decision_saved", value: renewalStatus }]);
  });
  test("unreviewed is not a decision; pending signals require matching persisted item/value", () => {
    expect(marketing.classifyItemChangeSignals({ renewalStatus: "unreviewed" })).toEqual([]);
    const entry = { event: "personal_billing_date_saved" as const, itemId: "one", value: "2026-10-05", scope: "s", profileId: "p" };
    expect(marketing.isPendingSignalSatisfied(entry, [])).toBe(false);
    expect(marketing.isPendingSignalSatisfied(entry, [{ id: "one", billingAnchorDate: "2026-10-06", renewalStatus: "keep" }])).toBe(false);
    expect(marketing.isPendingSignalSatisfied(entry, [{ id: "one", billingAnchorDate: entry.value, renewalStatus: "keep" }])).toBe(true);
  });
});
