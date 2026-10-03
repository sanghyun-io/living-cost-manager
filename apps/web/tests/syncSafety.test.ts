import { describe, expect, it } from "vitest";
import { blockSync, canAutoSync, canReplaceLocal, createSyncSafety, establishSyncBaseline, syncScope, syncSnapshotKey } from "../app/lib/syncSafety";
import type { LocalBudgetSnapshot } from "../app/lib/snapshot";

const scope = syncScope("local-a", true, "account", "workspace");

describe("whole-snapshot sync safety", () => {
  it("requires local identity/readiness, even for the same server workspace", () => {
    expect(syncScope(null, true, "account", "workspace")).toBe("");
    expect(syncScope("local-a", false, "account", "workspace")).toBe("");
    expect(syncScope("local-b", true, "account", "workspace")).not.toBe(scope);
    expect(syncScope("local-a", true, "other-account", "workspace")).not.toBe(scope);
    expect(syncScope("local-a", true, "account", "other-workspace")).not.toBe(scope);
  });

  it("remote inspection and opt-in alone cannot authorize an automatic overwrite", () => {
    const state = createSyncSafety(scope);
    state.version = 42;
    state.enabled = true;
    expect(canAutoSync(state, "local")).toBe(false);
    establishSyncBaseline(state, "local", 42);
    expect(canAutoSync(state, "local")).toBe(false);
    expect(canAutoSync(state, "edited")).toBe(true);
    state.enabled = false;
    expect(canAutoSync(state, "edited")).toBe(false);
  });

  it("preserves edits made during upload as dirty against the outgoing baseline", () => {
    const state = createSyncSafety(scope);
    establishSyncBaseline(state, "original", 1);
    state.enabled = true;
    state.busy = true;
    expect(canAutoSync(state, "outgoing")).toBe(false);
    establishSyncBaseline(state, "outgoing", 2);
    state.busy = false;
    expect(canAutoSync(state, "edited-during-await")).toBe(true);
    expect(canAutoSync(state, "outgoing")).toBe(false);
  });

  it("a conflict cannot be cleared by fetching/adopting a newer version or toggling", () => {
    const state = createSyncSafety(scope);
    establishSyncBaseline(state, "base", 1);
    state.enabled = true;
    blockSync(state);
    expect(state.enabled).toBe(false);
    state.version = 100;
    state.enabled = true;
    expect(canAutoSync(state, "edit")).toBe(false);
    state.enabled = false;
    establishSyncBaseline(state, "explicit-fresh-load", 100);
    expect(canAutoSync(state, "edit")).toBe(false);
    state.enabled = true;
    expect(canAutoSync(state, "edit")).toBe(true);
  });

  it("rejects stale loads across local users and ABA scope transitions", () => {
    const request = createSyncSafety(scope);
    const otherLocalUser = createSyncSafety(syncScope("local-b", true, "account", "workspace"));
    expect(canReplaceLocal(request, otherLocalUser, "same-data", "same-data")).toBe(false);
    expect(canReplaceLocal(request, createSyncSafety(scope), "same-data", "same-data")).toBe(false);
    expect(canReplaceLocal(request, request, "before", "edited")).toBe(false);
    expect(canReplaceLocal(request, request, "before", "before")).toBe(true);
    const unscoped = createSyncSafety("");
    expect(canReplaceLocal(unscoped, unscoped, "before", "before")).toBe(false);
  });

  it("detects end-of-month edits that the legacy key omitted", () => {
    const snapshot: LocalBudgetSnapshot = {
      monthlyIncome: 100, categories: [], fixedCosts: [],
      cards: [{ id: "card", label: "Card", billingDay: 28, isEndOfMonth: false }]
    };
    expect(syncSnapshotKey(snapshot)).not.toBe(syncSnapshotKey({
      ...snapshot, cards: [{ ...snapshot.cards[0], isEndOfMonth: true }]
    }));
  });
});
