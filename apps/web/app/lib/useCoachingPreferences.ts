"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { coachingPreferencesSchema, getActiveProtectedFixedCostIds, type CoachingPreferences, type ProtectedCoachingItem } from "@living-cost-manager/shared";
import type { FixedCost } from "./budget";
import type { ServerApiClient, ServerSession } from "./serverApi";

const EMPTY: CoachingPreferences = { schemaVersion: 1, revision: 0, protectedItems: [] };
const EMPTY_IDS: ReadonlySet<string> = new Set();
export interface CoachingStorageEnvelope {
  storageVersion: 1;
  preferences: CoachingPreferences;
  ackFingerprint: string | null;
  localEdited?: boolean;
}

/** Content only: revisions, current ledger membership and array order are not intent. */
export function coachingFingerprint(prefs: CoachingPreferences): string {
  return JSON.stringify([...prefs.protectedItems]
    .sort((a, b) => a.fixedCostId < b.fixedCostId ? -1 : a.fixedCostId > b.fixedCostId ? 1 : 0)
    .map(item => ({ fixedCostId: item.fixedCostId, ...(item.reason ? { reason: item.reason } : {}) })));
}

/** Only known formats migrate. Invalid envelopes must never fall back to a bare DTO. */
export function parseCoachingStorage(raw: string): CoachingStorageEnvelope | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    if ("preferences" in obj) {
      const current = "ackFingerprint" in obj;
      const allowed = current
        ? ["storageVersion", "preferences", "ackFingerprint", "localEdited"]
        : ["schemaVersion", "storageVersion", "preferences", "syncedFingerprint"];
      if (Object.keys(obj).some(key => !allowed.includes(key))) return null;
      if (current ? obj.storageVersion !== 1 : obj.schemaVersion !== 1 || (obj.storageVersion !== undefined && obj.storageVersion !== 1)) return null;
      if (current && obj.ackFingerprint !== null && typeof obj.ackFingerprint !== "string") return null;
      if (obj.localEdited !== undefined && typeof obj.localEdited !== "boolean") return null;
      if (!current && obj.syncedFingerprint !== undefined && typeof obj.syncedFingerprint !== "string") return null;
      const prefs = coachingPreferencesSchema.safeParse(obj.preferences);
      if (!prefs.success) return null;
      // Old fingerprints included revision and dropped orphans: never treat them as an ack.
      return { storageVersion: 1, preferences: prefs.data, ackFingerprint: current ? obj.ackFingerprint as string | null : null,
        localEdited: current ? obj.localEdited as boolean | undefined : true };
    }
    const prefs = coachingPreferencesSchema.safeParse(value);
    // Legacy data has no trustworthy ack/clear-intent metadata. Conservatively
    // retain even an empty saved snapshot as unsynced rather than falsely clean it.
    return prefs.success ? { storageVersion: 1, preferences: prefs.data, ackFingerprint: null, localEdited: true } : null;
  } catch { return null; }
}

interface State {
  loadedKey: string | null;
  writeAllowed: boolean;
  prefs: CoachingPreferences;
  ack: string | null;
  localEdited: boolean;
  status: string;
  busy: boolean;
  persistError: boolean;
}
const INITIAL: State = { loadedKey: null, writeAllowed: false, prefs: EMPTY, ack: null, localEdited: false, status: "", busy: false, persistError: false };
function isDirty(state: State) {
  return state.ack === null ? state.localEdited || state.prefs.protectedItems.length > 0 : coachingFingerprint(state.prefs) !== state.ack;
}
function errorMessage(error: unknown) {
  const code = error && typeof error === "object" && "status" in error ? error.status : null;
  if (code === 401) return "로그인이 만료됐어요. 기기 설정은 유지했습니다.";
  if (code === 403) return "접근 권한이 없어요. 기기 설정은 유지했습니다.";
  if (code === 409) return "다른 변경과 충돌했어요. 서버를 다시 불러와 직접 비교한 뒤 적용해 주세요.";
  if (code === 503) return "서버가 일시적으로 사용할 수 없어요. 나중에 다시 시도해 주세요. 기기 설정은 유지했습니다.";
  return "요청을 완료하지 못했어요. 기기 설정은 유지했습니다.";
}

export function useCoachingPreferences(items: FixedCost[], userId: string | null, workspaceId: string | null,
  api: ServerApiClient | null, session: ServerSession | null, serverUserId?: string | null) {
  // Linked account, not the transient auth token, owns local storage (logout never deletes it).
  const identity = serverUserId ?? "anonymous";
  const scopeKey = `lcm:coaching:${encodeURIComponent(userId ?? "guest")}:${encodeURIComponent(workspaceId ?? "local")}:${encodeURIComponent(identity)}`;
  // Auth changes also invalidate pending requests, even when the storage owner is unchanged.
  const requestScope = JSON.stringify([scopeKey, session?.user.id, session?.workspace?.id, session?.token, serverUserId]);
  const liveScope = useRef(requestScope);
  const generation = useRef(0);
  const editGeneration = useRef(0);
  const requestBusy = useRef(false);
  if (liveScope.current !== requestScope) {
    liveScope.current = requestScope;
    generation.current++;
    editGeneration.current++;
    requestBusy.current = false;
  }
  const [state, setState] = useState<State>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  function update(change: (current: State) => State) {
    const next = change(stateRef.current);
    stateRef.current = next;
    setState(next);
  }
  const ready = state.loadedKey === requestScope && state.writeAllowed;
  const prefs = state.loadedKey === requestScope ? state.prefs : EMPTY;
  const activeIds = useMemo(() => ready ? getActiveProtectedFixedCostIds(prefs, items) : EMPTY_IDS, [ready, prefs, items]);
  const canCloudAccess = !!(ready && api && userId && serverUserId && session?.workspace && workspaceId === session.workspace.id && serverUserId === session.user.id);

  useEffect(() => {
    generation.current++;
    requestBusy.current = false;
    let next: State = { ...INITIAL, loadedKey: requestScope, writeAllowed: true };
    try {
      // Earlier local format omitted the linked-account suffix. Read only the same
      // explicit local-user/workspace key; never enumerate storage or delete its source.
      const legacyKey = `lcm:coaching:${encodeURIComponent(userId ?? "guest")}:${encodeURIComponent(workspaceId ?? "local")}`;
      const raw = localStorage.getItem(scopeKey) ?? (userId ? localStorage.getItem(legacyKey) : null);
      if (raw !== null) {
        const envelope = parseCoachingStorage(raw);
        if (envelope) next = { ...next, prefs: envelope.preferences, ack: envelope.ackFingerprint, localEdited: envelope.localEdited ?? false };
        else next = { ...next, writeAllowed: false, status: "저장된 설정을 읽지 못했어요. 원본을 보존하고 편집·동기화를 차단했습니다." };
      }
    } catch {
      next = { ...next, writeAllowed: false, status: "기기 설정에 접근하지 못했어요. 원본을 보존하고 편집·동기화를 차단했습니다." };
    }
    stateRef.current = next;
    setState(next);
    return () => { generation.current++; requestBusy.current = false; };
  }, [scopeKey, requestScope, userId, workspaceId]);

  useEffect(() => {
    if (state.loadedKey !== requestScope || !state.writeAllowed || liveScope.current !== requestScope) return;
    try {
      const envelope: CoachingStorageEnvelope = { storageVersion: 1, preferences: state.prefs, ackFingerprint: state.ack, localEdited: state.localEdited };
      localStorage.setItem(scopeKey, JSON.stringify(envelope));
      if (stateRef.current.persistError) update(s => ({ ...s, persistError: false }));
    } catch {
      update(s => ({ ...s, persistError: true }));
    }
  }, [scopeKey, requestScope, state.loadedKey, state.writeAllowed, state.prefs, state.ack, state.localEdited]);

  function canEdit() { return liveScope.current === requestScope && stateRef.current.loadedKey === requestScope && stateRef.current.writeAllowed; }
  function toggle(id: string, reason?: ProtectedCoachingItem["reason"]) {
    if (!canEdit()) return;
    const current = stateRef.current.prefs;
    const exists = current.protectedItems.some(item => item.fixedCostId === id);
    if (!exists && current.protectedItems.length >= 1000) {
      update(s => ({ ...s, status: "유지 설정은 최대 1,000건까지 가능합니다." })); return;
    }
    const proposed = { ...current, protectedItems: exists ? current.protectedItems.filter(item => item.fixedCostId !== id) : [...current.protectedItems, { fixedCostId: id, ...(reason ? { reason } : {}) }] };
    if (!coachingPreferencesSchema.safeParse(proposed).success) return;
    editGeneration.current++;
    update(s => ({ ...s, prefs: proposed, localEdited: true, status: "" }));
  }
  function setReason(id: string, reason: ProtectedCoachingItem["reason"] | undefined) {
    if (!canEdit() || !stateRef.current.prefs.protectedItems.some(item => item.fixedCostId === id)) return;
    const proposed = { ...stateRef.current.prefs, protectedItems: stateRef.current.prefs.protectedItems.map(item => item.fixedCostId === id ? { fixedCostId: id, ...(reason ? { reason } : {}) } : item) };
    if (!coachingPreferencesSchema.safeParse(proposed).success) return;
    editGeneration.current++;
    update(s => ({ ...s, prefs: proposed, localEdited: true, status: "" }));
  }
  function begin() {
    if (!canEdit() || !canCloudAccess || !api || !session?.workspace || requestBusy.current) return null;
    requestBusy.current = true;
    const ticket = ++generation.current;
    const edits = editGeneration.current;
    update(s => ({ ...s, busy: true, status: "처리 중…" }));
    return { ticket, edits, snapshot: stateRef.current.prefs };
  }
  function isCurrent(ticket: number) { return liveScope.current === requestScope && generation.current === ticket; }
  function finish(ticket: number) {
    if (!isCurrent(ticket)) return;
    requestBusy.current = false;
    update(s => ({ ...s, busy: false }));
  }
  async function load(_replace = false) {
    if (!canEdit() || !canCloudAccess || requestBusy.current) return;
    // Never permit a caller's legacy `replace` flag to bypass consent.
    if (isDirty(stateRef.current) && !window.confirm("기기의 미동기화 설정을 서버 설정으로 바꿀까요?")) return;
    const request = begin();
    if (!request || !api || !session?.workspace) return;
    try {
      const saved = coachingPreferencesSchema.parse(await api.getCoachingPreferences(session.workspace.id, session.token));
      if (!isCurrent(request.ticket)) return;
      if (request.edits !== editGeneration.current) {
        update(s => ({ ...s, status: "불러오는 동안 수정한 기기 설정을 유지했습니다. 다시 불러와 주세요." })); return;
      }
      if (saved.revision === 0 && saved.protectedItems.length === 0) {
        update(s => ({ ...s, prefs: { ...s.prefs, revision: 0 }, ack: null, status: "서버에 저장된 설정이 없어요. 기기 설정은 유지했습니다." })); return;
      }
      if (saved.protectedItems.length === 0 && !window.confirm("서버에는 모든 항목을 해제한 설정이 있어요. 기기 설정을 비울까요?")) return;
      if (!isCurrent(request.ticket) || request.edits !== editGeneration.current) return;
      update(s => ({ ...s, prefs: saved, ack: coachingFingerprint(saved), localEdited: false, status: "서버 설정을 불러왔어요." }));
    } catch (error) {
      if (isCurrent(request.ticket)) update(s => ({ ...s, status: errorMessage(error) }));
    } finally { finish(request.ticket); }
  }
  async function save() {
    const request = begin();
    if (!request || !api || !session?.workspace) return;
    // Only an explicit save may remove orphan IDs; local reads and dirty detection never do.
    const submitted = { ...request.snapshot, protectedItems: request.snapshot.protectedItems.filter(item => items.some(source => source.id === item.fixedCostId)) };
    try {
      const saved = coachingPreferencesSchema.parse(await api.putCoachingPreferences(session.workspace.id, {
        schemaVersion: 1, expectedRevision: submitted.revision, protectedItems: submitted.protectedItems
      }, session.token));
      if (!isCurrent(request.ticket)) return;
      if (coachingFingerprint(saved) !== coachingFingerprint(submitted)) throw new Error("Unexpected acknowledgement");
      const newerEdits = request.edits !== editGeneration.current;
      update(s => ({ ...s, prefs: newerEdits ? { ...s.prefs, revision: saved.revision } : saved,
        ack: coachingFingerprint(submitted), localEdited: newerEdits,
        status: newerEdits ? "요청한 설정은 서버에 저장했지만 진행 중 수정은 미동기화 상태입니다." : "내 코칭 설정을 서버에 저장했어요." }));
    } catch (error) {
      if (isCurrent(request.ticket)) update(s => ({ ...s, status: errorMessage(error) }));
    } finally { finish(request.ticket); }
  }
  return { prefs, activeIds, toggle, setReason, ready, dirty: ready && isDirty(state),
    status: state.loadedKey !== requestScope ? "" : state.persistError ? "기기에 저장하지 못했어요. 현재 화면의 설정만 유지 중입니다. 저장 공간을 확인해 주세요." : state.status,
    busy: state.loadedKey === requestScope && state.busy, load, save, canCloudAccess };
}
