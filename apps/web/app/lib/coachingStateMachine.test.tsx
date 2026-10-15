// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { coachingFingerprint, parseCoachingStorage, useCoachingPreferences } from "./useCoachingPreferences";
import type { ServerApiClient, ServerSession } from "./serverApi";
import type { FixedCost } from "./budget";

const items = [{ id: "a", name: "A" }, { id: "b", name: "B" }] as FixedCost[];
const dto = (ids: string[] = [], revision = 0) => ({ schemaVersion: 1 as const, revision, protectedItems: ids.map(fixedCostId => ({ fixedCostId })) });
const session = { token: "synthetic-token", user: { id: "server" }, workspace: { id: "ws", role: "viewer" } } as ServerSession;
const key = (uid = "local") => `lcm:coaching:${uid}:ws:server`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(uid = "local") {
  const get = vi.fn(); const put = vi.fn();
  const api = { getCoachingPreferences: get, putCoachingPreferences: put } as unknown as ServerApiClient;
  const renders: { uid: string; ready: boolean; ids: string[]; busy: boolean }[] = [];
  const hook = renderHook(({ uid, ws, linked, auth, source }) => {
    const value = useCoachingPreferences(source, uid, ws, api, auth, linked);
    renders.push({ uid, ready: value.ready, ids: [...value.activeIds], busy: value.busy });
    return value;
  }, { initialProps: { uid, ws: "ws", linked: "server", auth: session as ServerSession | null, source: items } });
  return { ...hook, get, put, api, renders };
}
beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("private coaching storage state machine", () => {
  it.each(["{broken", "", JSON.stringify({ storageVersion: 1, preferences: dto(), ackFingerprint: 42 }), JSON.stringify({ storageVersion: 2, preferences: dto(), ackFingerprint: null }), JSON.stringify({ storageVersion: 1, preferences: dto(), ackFingerprint: null, extra: true })])("preserves corrupt bytes and blocks EVERY mutation/API: %s", async raw => {
    localStorage.setItem(key(), raw);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const { result, get, put } = setup();
    expect(result.current.ready).toBe(false);
    expect(result.current.status).toContain("원본을 보존");
    act(() => { result.current.toggle("a"); result.current.setReason("a", "personal"); });
    await act(async () => { await result.current.load(); await result.current.save(); });
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(key())).toBe(raw);
    expect(get).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });

  it("strictly migrates known bare/old envelopes, retaining orphan intent", () => {
    expect(parseCoachingStorage(JSON.stringify(dto(["orphan"], 8)))?.preferences).toEqual(dto(["orphan"], 8));
    expect(parseCoachingStorage(JSON.stringify({ schemaVersion: 1, storageVersion: 1, preferences: dto(["a"]), syncedFingerprint: "unsafe-old" }))?.ackFingerprint).toBeNull();
    expect(parseCoachingStorage(JSON.stringify({ schemaVersion: 1, revision: 0, protectedItems: [], extra: true }))).toBeNull();
    expect(coachingFingerprint(dto(["orphan", "a"], 9))).toBe(coachingFingerprint(dto(["a", "orphan"], 0)));
  });

  it("hydrates without automatic cloud requests, persists unsynced clear-all across a REAL remount", () => {
    const first = setup();
    expect(first.result.current.dirty).toBe(false);
    act(() => { first.result.current.toggle("a"); first.result.current.toggle("a"); });
    expect(first.result.current.dirty).toBe(true);
    expect(first.get).not.toHaveBeenCalled(); expect(first.put).not.toHaveBeenCalled();
    first.unmount();
    const second = setup();
    expect(second.result.current.prefs.protectedItems).toEqual([]);
    expect(second.result.current.dirty).toBe(true);
  });

  it("acknowledges content not revision and remains clean on remount", async () => {
    const first = setup();
    act(() => first.result.current.toggle("a"));
    first.put.mockResolvedValue(dto(["a"], 12));
    await act(async () => { await first.result.current.save(); });
    expect(first.result.current.prefs.revision).toBe(12);
    expect(first.result.current.dirty).toBe(false);
    expect(JSON.parse(localStorage.getItem(key())!).ackFingerprint).toBe(coachingFingerprint(dto(["a"])));
    first.unmount();
    expect(setup().result.current.dirty).toBe(false);
  });

  it("preserves orphan reasons and dirty state when current ledger changes; only explicit save strips orphans", async () => {
    localStorage.setItem(key(), JSON.stringify({ storageVersion: 1, preferences: { ...dto(["a", "orphan"], 4), protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "orphan", reason: "essential" }] }, ackFingerprint: coachingFingerprint(dto(["a"])) }));
    const h = setup();
    expect(h.result.current.dirty).toBe(true);
    expect([...h.result.current.activeIds]).toEqual(["a"]);
    h.rerender({ uid: "local", ws: "ws", linked: "server", auth: session, source: [] });
    expect(h.result.current.dirty).toBe(true);
    expect(h.result.current.prefs.protectedItems).toHaveLength(2);
    h.put.mockResolvedValue(dto([], 5));
    await act(async () => { await h.result.current.save(); });
    expect(h.put.mock.calls[0][1]).toEqual({ schemaVersion: 1, expectedRevision: 4, protectedItems: [] });
    expect(h.result.current.dirty).toBe(false);
  });

  it("PUT preserves newer edits, learns revision for next CAS, and acks only submitted content", async () => {
    const h = setup(); const pending = deferred<ReturnType<typeof dto>>();
    h.put.mockReturnValueOnce(pending.promise);
    act(() => h.result.current.toggle("a"));
    let save!: Promise<void>;
    act(() => { save = h.result.current.save(); });
    act(() => { h.result.current.toggle("b"); h.result.current.setReason("a", "contract"); });
    await act(async () => { pending.resolve(dto(["a"], 6)); await save; });
    expect(h.result.current.prefs.revision).toBe(6);
    expect(h.result.current.prefs.protectedItems).toEqual([{ fixedCostId: "a", reason: "contract" }, { fixedCostId: "b" }]);
    expect(h.result.current.dirty).toBe(true);
    expect(JSON.parse(localStorage.getItem(key())!).ackFingerprint).toBe(coachingFingerprint(dto(["a"])));
    h.put.mockResolvedValueOnce({ ...h.result.current.prefs, revision: 7 });
    await act(async () => { await h.result.current.save(); });
    expect(h.put.mock.calls[1][1].expectedRevision).toBe(6);
    expect(h.result.current.dirty).toBe(false);
  });

  it.each(["GET", "PUT"])("%s late response/finally never modifies new scope or releases its busy lock", async method => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const h = setup(); const old = deferred<ReturnType<typeof dto>>(); const current = deferred<ReturnType<typeof dto>>();
    const operation = method === "GET" ? h.get : h.put;
    operation.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    let oldCall!: Promise<void>;
    act(() => { oldCall = method === "GET" ? h.result.current.load() : h.result.current.save(); });
    expect(h.result.current.busy).toBe(true);
    h.rerender({ uid: "other", ws: "ws", linked: "server", auth: session, source: items });
    expect(h.result.current.busy).toBe(false);
    // Capture render-time neutral state BEFORE hydration effects, not just final output.
    expect(h.renders.find(r => r.uid === "other")).toEqual({ uid: "other", ready: false, ids: [], busy: false });
    let newCall!: Promise<void>;
    act(() => { newCall = method === "GET" ? h.result.current.load() : h.result.current.save(); });
    await act(async () => { old.resolve(dto(["a"], 3)); await oldCall; });
    expect(h.result.current.busy).toBe(true);
    expect(h.result.current.activeIds.size).toBe(0);
    await act(async () => { current.resolve(dto([], 4)); await newCall; });
    expect(h.result.current.busy).toBe(false);
    expect(h.result.current.prefs.revision).toBe(method === "GET" ? 0 : 4); // empty GET needs confirmation
  });

  it("pre-effect scope gating hides old protections and stale captured callbacks cannot edit or request", async () => {
    const h = setup(); act(() => h.result.current.toggle("a"));
    const old = h.result.current;
    h.rerender({ uid: "other", ws: "ws", linked: "server", auth: session, source: items });
    expect(h.renders.find(r => r.uid === "other")?.ids).toEqual([]);
    await act(async () => { old.toggle("b"); await old.save(); });
    expect(h.result.current.activeIds.size).toBe(0);
    expect(h.put).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key())!).preferences.protectedItems).toEqual([{ fixedCostId: "a" }]);
  });

  it("requires confirmation BEFORE GET and refuses to overwrite edits during GET", async () => {
    const h = setup(); act(() => h.result.current.toggle("a"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { await h.result.current.load(true); });
    expect(h.get).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    const pending = deferred<ReturnType<typeof dto>>(); h.get.mockReturnValue(pending.promise);
    let call!: Promise<void>; act(() => { call = h.result.current.load(); });
    act(() => h.result.current.toggle("b"));
    await act(async () => { pending.resolve(dto(["a"], 8)); await call; });
    expect(h.result.current.prefs.protectedItems).toEqual(dto(["a", "b"]).protectedItems);
    expect(h.result.current.dirty).toBe(true);
  });

  it("rev0 empty never clears or falsely acknowledges; explicit rev>0 empty needs second confirmation", async () => {
    const h = setup(); act(() => h.result.current.toggle("a"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    h.get.mockResolvedValue(dto());
    await act(async () => { await h.result.current.load(); });
    expect(h.result.current.activeIds.has("a")).toBe(true); expect(h.result.current.dirty).toBe(true);
    h.get.mockResolvedValue(dto([], 9));
    confirm.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await act(async () => { await h.result.current.load(); });
    expect(h.result.current.activeIds.has("a")).toBe(true);
    confirm.mockReturnValue(true);
    await act(async () => { await h.result.current.load(); });
    expect(h.result.current.prefs).toEqual(dto([], 9)); expect(h.result.current.dirty).toBe(false);
  });

  it("cloud binding checks linked server identity AND requested workspace, not local ID", async () => {
    const h = setup(); expect(h.result.current.canCloudAccess).toBe(true);
    h.rerender({ uid: "local", ws: "wrong-ws", linked: "server", auth: session, source: items });
    expect(h.result.current.canCloudAccess).toBe(false);
    await act(async () => { await h.result.current.load(); await h.result.current.save(); });
    h.rerender({ uid: "local", ws: "ws", linked: "other-server", auth: session, source: items });
    expect(h.result.current.canCloudAccess).toBe(false);
    expect(h.get).not.toHaveBeenCalled(); expect(h.put).not.toHaveBeenCalled();
  });

  it.each([[401, "로그인이 만료"], [403, "접근 권한"], [409, "충돌"], [503, "일시적으로"]])("%i retains all intent and never auto-fetches/deletes", async (code, message) => {
    const h = setup(); act(() => h.result.current.toggle("a"));
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    h.put.mockRejectedValue(Object.assign(new Error("private body must not be logged"), { status: code }));
    await act(async () => { await h.result.current.save(); });
    expect(h.result.current.status).toContain(message);
    expect(h.result.current.activeIds.has("a")).toBe(true);
    expect(h.result.current.dirty).toBe(true); expect(h.result.current.busy).toBe(false);
    expect(h.get).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it("write failure preserves in-memory protection and never claims persisted", () => {
    const h = setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    act(() => h.result.current.toggle("a"));
    expect(h.result.current.activeIds.has("a")).toBe(true);
    expect(h.result.current.status).toContain("현재 화면의 설정만 유지");
    expect(h.result.current.dirty).toBe(true);
  });

  it("read exceptions are read-only too, and never attempt to repair storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const h = setup();
    act(() => h.result.current.toggle("a"));
    await act(async () => { await h.result.current.save(); await h.result.current.load(); });
    expect(h.result.current.ready).toBe(false);
    expect(writes).not.toHaveBeenCalled(); expect(h.put).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled();
  });

  it("a rev0 GET cannot leave old acknowledged nonempty intent falsely clean", async () => {
    localStorage.setItem(key(), JSON.stringify({ storageVersion: 1, preferences: dto(["a"], 3), ackFingerprint: coachingFingerprint(dto(["a"])) }));
    const h = setup(); expect(h.result.current.dirty).toBe(false);
    h.get.mockResolvedValue(dto());
    await act(async () => { await h.result.current.load(); });
    expect(h.result.current.prefs.revision).toBe(0);
    expect(h.result.current.activeIds.has("a")).toBe(true);
    expect(h.result.current.dirty).toBe(true);
  });

  it("1000-item guard blocks only additions, allows explicit removal", () => {
    localStorage.setItem(key(), JSON.stringify(dto(Array.from({ length: 1000 }, (_, i) => `id-${i}`))));
    const h = setup();
    act(() => h.result.current.toggle("a"));
    expect(h.result.current.prefs.protectedItems).toHaveLength(1000);
    expect(h.result.current.status).toContain("1,000");
    act(() => h.result.current.toggle("id-0"));
    expect(h.result.current.prefs.protectedItems).toHaveLength(999);
  });

  it("migrates same-owner old key without deleting or changing its bytes", () => {
    const raw = JSON.stringify(dto(["a"], 2));
    localStorage.setItem("lcm:coaching:local:ws", raw);
    const h = setup();
    expect(h.result.current.activeIds.has("a")).toBe(true);
    expect(localStorage.getItem("lcm:coaching:local:ws")).toBe(raw);
    expect(JSON.parse(localStorage.getItem(key())!).storageVersion).toBe(1);
  });

  it("synchronous double-click guard permits only one request and logout preserves storage", async () => {
    const h = setup(); act(() => h.result.current.toggle("a"));
    const pending = deferred<ReturnType<typeof dto>>(); h.put.mockReturnValue(pending.promise);
    let call!: Promise<void>;
    act(() => { call = h.result.current.save(); void h.result.current.save(); void h.result.current.load(); });
    expect(h.put).toHaveBeenCalledTimes(1); expect(h.get).not.toHaveBeenCalled();
    const raw = localStorage.getItem(key());
    h.rerender({ uid: "local", ws: "ws", linked: "server", auth: null, source: items });
    expect(h.result.current.busy).toBe(false);
    expect(h.result.current.activeIds.has("a")).toBe(true);
    await act(async () => { pending.resolve(dto(["a"], 4)); await call; });
    expect(h.result.current.prefs.revision).toBe(0);
    expect(localStorage.getItem(key())).toBe(raw);
  });
});
