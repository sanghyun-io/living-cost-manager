"use client";

// 주간 예산·급여일·준비금 계획의 스코프 안전 클라이언트 정본.
//  - 로컬 우선: 모든 편집은 canonical scope(profileId = ledgerProfileId/게스트/샘플
//    분리)의 별도 localStorage 키에 먼저, 검증·읽기 되돌림 확인 후 저장된다.
//  - 서버는 수동 저장/확인만: GET 응답은 절대 자동 덮어쓰지 않고 staging 한다.
//    재확인에서 로컬에 미반영 편집이 있으면 CAS base revision을 진행시키지 않는다.
//  - 손상 원본/계정 삭제/quota 실패는 fail-closed — 기본값으로 덮어쓰지 않으며
//    전환·업로드·교체를 막는다.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDefaultWorkspacePlanningData,
  type WorkspacePlanningData,
  type WorkspaceRole
} from "@living-cost-manager/shared";
import { ServerApiError, isEmailNotVerifiedError, isServerAuthFailure, type ServerApiClient, type ServerSession } from "./serverApi";
import {
  addWeekSpent,
  canonicalPlanning,
  commitPlanningWrite,
  isPlanningNoOp,
  planningHash,
  planningStorageKey,
  readPlanningCache,
  removeReserve,
  reconnectReserve,
  restorePlanningRaw,
  serializePlanning,
  setPaydayDay,
  setWeekBudget,
  setWeekSpent,
  upsertReserve,
  type PlanningEdit,
  type PlanningImportAdapter,
  type ReserveDraft
} from "./planningStorage";
import { getUserErasureKey } from "./users";
import type { StringStorage } from "./account";

const EMPTY_STORAGE: StringStorage = {
  getItem: () => null,
  setItem: () => { throw new Error("storage unavailable"); },
  removeItem: () => {}
};
import { saveRecovery } from "./recoveryStorage";

export type PlanningServerSupport = "unknown" | "available" | "missing" | "forbidden" | "unavailable";

export interface RemoteStagedPlanning {
  data: WorkspacePlanningData;
  revision: number;
  checkedAt: Date;
}

export interface UsePlanningDataOptions {
  /** budget.localScopeKey — 정규 canonical scope. 미로딩 시 null. */
  profileId: string | null;
  serverSession: ServerSession | null;
  serverApi: ServerApiClient | null;
  /** sync.currentWorkspaceRole: 검증된 멤버 목록에서 도출된 역할. */
  role: WorkspaceRole | null;
  /** 확인된 가계부 서버 기준 버전(syncVersion). 없으면 계획 단독 업로드 불가. */
  getBudgetServerVersion: () => number | null;
  /** 가계부 서버 기준이 현재 유효한지(확인됨·충돌 미차단). */
  isBudgetServerCurrent: () => boolean;
  /** 가계부에 서버 미반영 변경이 있는지(있으면 계획 단독 업로드 금지). */
  isBudgetDirty: () => boolean;
  /** 샘플 모드 등 서버 스코프와 무관한 상태면 false — 어떤 서버 호출도 하지 않는다. */
  scopeReady?: boolean;
  /** 주입 가능한 저장소(기본 window.localStorage) — 순수 테스트용. */
  storage?: StringStorage | null;
}

export type PlanningUploadOutcome =
  | { status: "ok"; changed: boolean }
  | { status: "skipped"; reason: string }
  | { status: "conflict" }
  | { status: "diverged" }
  | { status: "error"; message: string };

const EMPTY_PLANNING = createDefaultWorkspacePlanningData();
const EMPTY_SERIALIZED = serializePlanning(EMPTY_PLANNING);

export function usePlanningData({
  profileId,
  serverSession,
  serverApi,
  role,
  getBudgetServerVersion,
  isBudgetServerCurrent,
  isBudgetDirty,
  scopeReady = true,
  storage = null
}: UsePlanningDataOptions) {
  const store: StringStorage = storage ?? (typeof window === "undefined" ? EMPTY_STORAGE : window.localStorage);
  const [data, setData] = useState<WorkspacePlanningData>(EMPTY_PLANNING);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [cacheCorrupt, setCacheCorrupt] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [serverSupport, setServerSupport] = useState<PlanningServerSupport>("unknown");
  const [base, setBase] = useState<{ revision: number; dataHash: string } | null>(null);
  const [remoteStaged, setRemoteStaged] = useState<RemoteStagedPlanning | null>(null);
  const [conflict, setConflict] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [lastPlanningSyncedAt, setLastPlanningSyncedAt] = useState<Date | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);

  const cacheRaw = useRef<string | null>(null);
  const corruptRaw = useRef<string | null>(null);
  const writeBlocked = useRef(false); // 삭제 마커/손상/다른 탭 충돌 — 자동 저장 중단
  const epoch = useRef<{ scope: string | null }>({ scope: profileId ?? null });
  if (epoch.current.scope !== (profileId ?? null)) epoch.current = { scope: profileId ?? null };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const latest = useRef({ data, loadedScope, profileId, serverSession, serverApi, role, base, remoteStaged, conflict, scopeReady });
  latest.current = { data, loadedScope, profileId, serverSession, serverApi, role, base, remoteStaged, conflict, scopeReady };
  const isActive = (ticket: { scope: string | null }) =>
    mounted.current && ticket === epoch.current && ticket.scope === (latest.current.profileId ?? null);

  const serializedData = useMemo(() => serializePlanning(data), [data]);
  const currentHash = serializedData;
  const hasSession = scopeReady && !!serverSession?.workspace && !!serverApi;
  const isViewer = role === "viewer";
  const canWriteLocally = !cacheCorrupt && loadedScope === profileId && !!profileId;
  const canEdit = canWriteLocally && !isViewer;
  // no-op 계획은 캐시가 없을 때 키를 만들지 않는다(빈 기본값 persist 없음).
  const pendingLocalWrite = !!profileId && loadedScope === profileId && !writeBlocked.current &&
    serializedData !== (cacheRaw.current ?? (isPlanningNoOp(data) ? serializedData : EMPTY_SERIALIZED));
  const planningActive = !!profileId && loadedScope === profileId && !isPlanningNoOp(data);
  const planningServerDirty = planningActive && hasSession &&
    (conflict || (base !== null && currentHash !== base.dataHash));
  const planningServerUnknown = planningActive && hasSession && !conflict && base === null;

  // ── scope load (local-first) ───────────────────────────────────────────
  useEffect(() => {
    if (!profileId) {
      setData(EMPTY_PLANNING);
      setLoadedScope(null);
      setCacheCorrupt(false);
      setSaveError("");
      setStatusMessage("");
      cacheRaw.current = null;
      corruptRaw.current = null;
      writeBlocked.current = false;
      return;
    }
    const ticket = epoch.current;
    setData(EMPTY_PLANNING);
    setLoadedScope(null);
    setServerSupport("unknown");
    setBase(null);
    setRemoteStaged(null);
    setConflict(false);
    setLastPlanningSyncedAt(null);
    if (store.getItem(getUserErasureKey(profileId))) {
      corruptRaw.current = null;
      cacheRaw.current = null;
      writeBlocked.current = true;
      setCacheCorrupt(false);
      setSaveError("다른 탭에서 계정이 삭제되어 계획 저장과 서버 반영을 중단했습니다.");
      setLoadedScope(profileId);
      return;
    }
    const cache = readPlanningCache(store, profileId);
    if (!isActive(ticket)) return;
    if (cache.status === "corrupt") {
      // 손상 원본 보존: 화면에는 비운 상태로 보이고 어떤 자동 저장도 하지 않는다.
      corruptRaw.current = cache.raw;
      cacheRaw.current = null;
      writeBlocked.current = true;
      setCacheCorrupt(true);
      setData(EMPTY_PLANNING);
      setSaveError("계획 기록을 읽지 못해 자동 저장을 중단했습니다. 원본은 보존되어 있습니다.");
      setLoadedScope(profileId);
      return;
    }
    corruptRaw.current = null;
    cacheRaw.current = cache.raw;
    writeBlocked.current = false;
    setData(cache.data);
    setCacheCorrupt(false);
    setSaveError("");
    setLoadedScope(profileId);
  }, [profileId]);

  // ── persistence effect (verified write, no silent retry of failures) ────
  useEffect(() => {
    if (!profileId || loadedScope !== profileId || writeBlocked.current) return;
    if (cacheRaw.current === null && isPlanningNoOp(data)) return; // 빈 기본값 persist 금지
    const nextRaw = serializePlanning(data);
    if (nextRaw === cacheRaw.current) return;
    const result = commitPlanningWrite(store, profileId, data, cacheRaw.current);
    if (result.ok) {
      cacheRaw.current = result.value;
      setSaveError("");
      return;
    }
    if (result.reason === "erased") {
      writeBlocked.current = true;
      setSaveError("계정이 삭제되어 계획 저장을 중단했습니다.");
      return;
    }
    if (result.reason === "concurrent") {
      writeBlocked.current = true;
      setSaveError("다른 탭에서 계획 기록을 변경했습니다. 현재 내용은 폐기되지 않았으니 백업 후 새로고침하세요.");
      return;
    }
    setSaveError("브라우저 저장 공간에 계획 기록을 저장하지 못했습니다. 전체 백업을 먼저 내보내세요.");
  }, [data, profileId, loadedScope, retryAttempt]);

  // ── cross-tab storage events (unsaved state is never silently discarded) ─
  useEffect(() => {
    if (!profileId) return;
    const key = planningStorageKey(profileId);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key || loadedScope !== profileId) return;
      if (store.getItem(getUserErasureKey(profileId))) {
        writeBlocked.current = true;
        setSaveError("다른 탭에서 계정이 삭제되어 계획 저장과 서버 반영을 중단했습니다.");
        return;
      }
      if (event.newValue === null) {
        writeBlocked.current = true;
        setSaveError("다른 탭에서 계획 기록을 삭제했습니다. 현재 내용은 백업한 뒤 새로고침하세요.");
        return;
      }
      if (event.newValue === cacheRaw.current) return; // 다른 탭이 같은 기준으로 저장
      if (event.newValue === serializePlanning(latest.current.data)) {
        cacheRaw.current = event.newValue; // 내용 동일 — 저장 기준만 맞춘다
        return;
      }
      writeBlocked.current = true;
      setSaveError("다른 탭이 이 계획을 먼저 변경했습니다. 현재 편집은 폐기되지 않았으니 백업 후 상태를 선택하세요.");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [profileId, loadedScope]);

  // ── flush & switch guard ────────────────────────────────────────────────
  function flushLocalWrite(): boolean {
    const scope = latest.current.profileId;
    if (!scope || latest.current.loadedScope !== scope) return true; // 활성 계획 스코프 없음
    const nextRaw = serializePlanning(latest.current.data);
    if (nextRaw === (cacheRaw.current ?? (isPlanningNoOp(latest.current.data) ? nextRaw : EMPTY_SERIALIZED))) {
      return true;
    }
    if (writeBlocked.current) {
      // 손상 원본 보호(편집 없음)만 통과, 그 외 미저장 편집은 전환 차단.
      return cacheRaw.current === null && isPlanningNoOp(latest.current.data);
    }
    const result = commitPlanningWrite(store, scope, latest.current.data, cacheRaw.current);
    if (result.ok) {
      cacheRaw.current = result.value;
      setSaveError("");
      return true;
    }
    setSaveError(result.reason === "concurrent"
      ? "다른 탭의 계획 변경으로 전환을 중단했습니다. 현재 내용을 백업하세요."
      : "계획 기록을 기기에 저장하지 못해 전환을 중단했습니다. 백업을 먼저 내보내세요.");
    return false;
  }

  /** true 면 계획 관점에서는 안전(내용이 이미 기기 저장이거나 저장할 것 없음). */
  function saveBeforeSwitch(): boolean {
    return flushLocalWrite();
  }

  // ── local edits (owner/editor 또는 기기 전용) ───────────────────────────
  function applyEdit(edit: PlanningEdit): { ok: boolean; message: string } {
    if (latest.current.role === "viewer") {
      return { ok: false, message: "보기 전용 가계부에서는 계획을 변경할 수 없습니다." };
    }
    if (!latest.current.profileId || latest.current.loadedScope !== latest.current.profileId) {
      return { ok: false, message: "계획을 변경할 수 없는 상태입니다." };
    }
    if (cacheCorrupt) return { ok: false, message: "손상된 기록을 보호하기 위해 변경을 중단했습니다." };
    if (writeBlocked.current) return { ok: false, message: "저장이 중단되어 변경할 수 없습니다. 백업 후 상태를 확인하세요." };
    if (!edit.ok) return { ok: false, message: edit.message };
    if (planningHash(edit.data) === planningHash(latest.current.data)) return { ok: true, message: "" };
    setData(edit.data);
    return { ok: true, message: "" };
  }

  function setPayday(day: number | null) { return applyEdit(setPaydayDay(latest.current.data, day)); }
  function setBudget(weekStart: string, amount: number | null) {
    return applyEdit(setWeekBudget(latest.current.data, weekStart, amount));
  }
  function addSpent(weekStart: string, increment: number) {
    return applyEdit(addWeekSpent(latest.current.data, weekStart, increment, new Date().toISOString()));
  }
  function setSpent(weekStart: string, total: number) {
    return applyEdit(setWeekSpent(latest.current.data, weekStart, total, new Date().toISOString()));
  }
  function editReserve(draft: ReserveDraft) { return applyEdit(upsertReserve(latest.current.data, draft)); }
  function deleteReserve(id: string) { return applyEdit(removeReserve(latest.current.data, id)); }
  function linkReserve(id: string, costId: string, costLabel?: string) {
    return applyEdit(reconnectReserve(latest.current.data, id, costId, costLabel));
  }

  // ── server layer (manual only) ──────────────────────────────────────────
  async function checkRemote(): Promise<void> {
    const ticket = epoch.current;
    const api = latest.current.serverApi;
    const session = latest.current.serverSession;
    if (!latest.current.scopeReady) return;
    if (!api || !session?.workspace) return;
    if (latest.current.loadedScope !== latest.current.profileId) return;
    setIsBusy(true);
    try {
      const remote = await api.getWorkspacePlanning(session.workspace.id, session.token);
      if (!isActive(ticket)) return;
      const remoteData = canonicalPlanning(remote.data);
      const remoteHash = planningHash(remoteData);
      const localHash = planningHash(latest.current.data);
      const knownBase = latest.current.base;
      setServerSupport("available");
      // 기준 채택은 안전할 때만: 내용 동일 / 서버에 저장된 적 없음(revision 0) /
      // 로컬이 마지막 확인 기준에서 변경되지 않은 경우. 미반영 편집이 있으면
      // revision을 진행시켜 blind PUT을 허용하지 않는다.
      const canAdoptBase = remoteHash === localHash || remote.revision === 0 ||
        (!!knownBase && localHash === knownBase.dataHash);
      if (canAdoptBase) {
        setBase({ revision: remote.revision, dataHash: remoteHash });
        setConflict(false);
      }
      if (remoteHash === localHash) {
        setRemoteStaged(null);
        setStatusMessage(canAdoptBase ? "서버 계획 기록과 이 기기 기록이 같습니다." : "서버 기록은 같지만 확인 기준을 다시 맞추세요.");
      } else {
        setRemoteStaged({ data: remoteData, revision: remote.revision, checkedAt: new Date() });
        setStatusMessage(canAdoptBase
          ? "서버에 다른 계획 기록이 있습니다. 적용 여부는 직접 선택하세요(자동 덮어쓰기 없음)."
          : "이 기기에 미반영 변경이 있고 서버 기록도 다릅니다. 대조 후 서버 적용 또는 서버 저장(교체)을 직접 선택하세요.");
      }
    } catch (error) {
      if (!isActive(ticket)) return;
      if (error instanceof ServerApiError && error.status === 404) {
        setServerSupport("missing");
        setStatusMessage("이 서버에서는 계획 저장 기능을 제공하지 않습니다. 기기에 저장된 기록은 그대로 유지됩니다.");
      } else if (isEmailNotVerifiedError(error)) {
        setServerSupport("available");
        setStatusMessage("이메일을 인증해야 서버에 저장할 수 있습니다. 기기 기록은 유지됩니다.");
      } else if (error instanceof ServerApiError && (error.status === 401 || error.status === 403)) {
        setServerSupport("forbidden");
        setStatusMessage("이 가계부의 서버 계획 기록에 접근할 수 없습니다. 멤버 권한을 확인하세요. 기기 기록은 유지됩니다.");
      } else if (error instanceof ServerApiError && error.status === 503) {
        setServerSupport("unavailable");
        setStatusMessage("서버 계획 저장을 확인할 수 없습니다(저장 상태 이상). 빈 상태로 간주하지 않으며 기기 기록은 유지됩니다.");
      } else {
        setStatusMessage("서버 계획 상태를 확인하지 못했습니다. 기기 기록은 유지됩니다.");
      }
    } finally {
      setIsBusy(false);
    }
  }

  /** options.snapshotVersion: 가계부 PUT이 방금 확인해 준 새 syncVersion(체인 저장).
   * forceStagedRevision: 사용자가 대조 후 "서버 기록 교체 저장"을 명시 선택. */
  async function uploadNow(options: { snapshotVersion?: number; forceStagedRevision?: boolean; allowDiverged?: boolean } = {}): Promise<PlanningUploadOutcome> {
    const ticket = epoch.current;
    const api = latest.current.serverApi;
    const session = latest.current.serverSession;
    const scope = latest.current.profileId;
    if (!latest.current.scopeReady) return { status: "skipped", reason: "샘플 모드에서는 서버 계획을 사용하지 않습니다." };
    if (!api || !session?.workspace || !scope || latest.current.loadedScope !== scope) {
      return { status: "skipped", reason: "서버 가계부가 선택되지 않았거나 계획 로딩이 끝나지 않았습니다." };
    }
    if (latest.current.role === "viewer") return { status: "skipped", reason: "보기 전용 권한은 서버에 저장할 수 없습니다." };
    if (writeBlocked.current) return { status: "skipped", reason: "기기 저장 상태가 안전하지 않아 업로드하지 않았습니다." };
    if (!flushLocalWrite()) return { status: "skipped", reason: "계획을 기기에 저장하지 못해 업로드하지 않았습니다." };
    const outgoing = canonicalPlanning(latest.current.data);
    const outgoingHash = planningHash(outgoing);
    let baseNow = latest.current.base;
    if (!baseNow) {
      await checkRemote();
      baseNow = latest.current.base;
      if (!isActive(ticket)) return { status: "skipped", reason: "스코프가 바뀌어 업로드를 중단했습니다." };
      if (!baseNow) {
        if (latest.current.remoteStaged && options.forceStagedRevision) {
          baseNow = { revision: latest.current.remoteStaged.revision, dataHash: planningHash(latest.current.remoteStaged.data) };
        } else if (latest.current.remoteStaged) {
          return { status: "diverged" };
        } else {
          return { status: "error", message: "서버 계획 상태를 확인한 뒤 저장할 수 있습니다." };
        }
      }
    }
    if (baseNow.dataHash === outgoingHash && !latest.current.conflict) return { status: "ok", changed: false }; // 이미 같은 내용
    const stagedDiverged = !!latest.current.remoteStaged && planningHash(latest.current.remoteStaged.data) !== outgoingHash;
    if (stagedDiverged && !options.allowDiverged) return { status: "diverged" };
    const snapshotVersion = options.snapshotVersion ?? getBudgetServerVersion();
    if (snapshotVersion === null || snapshotVersion === undefined) {
      return { status: "error", message: "가계부 서버 기준 버전이 확인되지 않아 계획만 저장하지 않았습니다. 먼저 서버 상태를 확인하세요." };
    }
    if (options.snapshotVersion === undefined && isBudgetDirty()) {
      return { status: "skipped", reason: "가계부에 서버 미반영 변경이 있어 계획 단독 업로드를 막았습니다. 먼저 함께 저장하세요." };
    }
    setIsBusy(true);
    try {
      const response = await api.putWorkspacePlanning(session.workspace.id, {
        expectedRevision: baseNow.revision,
        expectedSnapshotVersion: snapshotVersion,
        data: outgoing
      }, session.token);
      if (!isActive(ticket)) {
        // 서버에는 반영됐을 수 있으나 이 화면의 스코프가 이미 전환됨: 새 스코프는
        // 다음 확인에서 진실하게 다시 판단한다(화면에 오래된 값 커밋 금지).
        return { status: "skipped", reason: "전환 중 응답이 무효화되어 화면에는 반영하지 않았습니다." };
      }
      setBase({ revision: response.revision, dataHash: planningHash(canonicalPlanning(response.data)) });
      setConflict(false);
      setRemoteStaged(null);
      setLastPlanningSyncedAt(new Date());
      setStatusMessage("계획을 서버에 저장했습니다.");
      return { status: "ok", changed: true };
    } catch (error) {
      if (!isActive(ticket)) return { status: "skipped", reason: "전환 중 요청이 무효화되었습니다." };
      if (error instanceof ServerApiError && error.status === 409) {
        // 절대 서버 revision 을 자동 채택해 덮어쓰지 않는다.
        setConflict(true);
        setStatusMessage("서버에서 가계부나 계획을 먼저 저장해 계획 반영을 중단했습니다. 서버 기록을 확인한 뒤 적용/저장(교체)을 직접 선택하세요. 기기 기록은 유지됩니다.");
        return { status: "conflict" };
      }
      if (error instanceof ServerApiError && error.status === 404) {
        setServerSupport("missing");
        setStatusMessage("이 서버에서는 계획 저장 기능을 제공하지 않습니다. 기기 기록은 그대로 유지됩니다.");
        return { status: "error", message: "서버 기능 미사용" };
      }
      if (error instanceof ServerApiError && (error.status === 401 || error.status === 403)) {
        setStatusMessage("서버 저장 권한이 확인되지 않아 계획을 반영하지 않았습니다. 멤버 권한과 이메일 인증을 확인하세요.");
        return { status: "error", message: "권한 확인 필요" };
      }
      if (error instanceof ServerApiError && error.status === 503) {
        setServerSupport("unavailable");
        setStatusMessage("서버 계획 저장소를 사용할 수 없어 반영하지 않았습니다. 빈 상태로 간주하지 않으며 기기 기록은 유지됩니다.");
        return { status: "error", message: "서버 저장소 이상" };
      }
      setStatusMessage((isServerAuthFailure(error) ? "로그인이 만료되어" : "통신 실패로") + " 계획을 반영하지 않았습니다. 기기 기록은 유지됩니다.");
      return { status: "error", message: "저장 실패" };
    } finally {
      setIsBusy(false);
    }
  }

  /** 함께 저장(체인)용: 서버 기준 확인(base)과 대조 diverged 없음을 조건으로 반영 —
   * blind overwrite 경로 없음. 가계부 PUT이 확인해 준 새 snapshotVersion 사용. */
  async function chainUploadAfterBudgetConfirmed(snapshotVersion: number): Promise<PlanningUploadOutcome> {
    if (latest.current.role === "viewer") return { status: "skipped", reason: "보기 전용" };
    const localHash = planningHash(latest.current.data);
    if (isPlanningNoOp(latest.current.data) && latest.current.base === null) return { status: "skipped", reason: "no planning" };
    if (!isBudgetServerCurrent()) return { status: "skipped", reason: "가계부 서버 기준이 유효하지 않아 계획을 반영하지 않았습니다." };
    if (!latest.current.base) return { status: "skipped", reason: "계획 서버 기록을 먼저 확인해야 합니다. 데이터 관리에서 확인하세요." };
    if (localHash === latest.current.base.dataHash && !latest.current.conflict) return { status: "ok", changed: false }; // 변경 없음
    if (latest.current.remoteStaged && planningHash(latest.current.remoteStaged.data) !== localHash) {
      return { status: "diverged" };
    }
    return uploadNow({ snapshotVersion });
  }

  /** 명시적 서버 기록 적용(사용자 확인 후): 교체 전 원본을 복구 사본으로 남긴다. */
  function adoptRemote(): boolean {
    const scope = latest.current.profileId;
    const staged = latest.current.remoteStaged;
    if (!scope || latest.current.loadedScope !== scope || !staged) return false;
    if (latest.current.role === "viewer") return false;
    if (writeBlocked.current) return false;
    try {
      if (cacheRaw.current !== null) saveRecovery(store as unknown as Storage, planningStorageKey(scope), "import", cacheRaw.current);
    } catch {
      setStatusMessage("교체 전 복구 사본을 저장하지 못해 적용하지 않았습니다.");
      return false;
    }
    const result = commitPlanningWrite(store, scope, staged.data, cacheRaw.current);
    if (!result.ok) {
      setStatusMessage(result.reason === "quota"
        ? "저장 공간이 부족해 서버 기록을 적용하지 않았습니다. 기기 기록은 그대로입니다."
        : "다른 탭 변경 또는 쓰기 되돌림 확인 실패로 적용하지 않았습니다.");
      return false;
    }
    cacheRaw.current = result.value;
    setData(staged.data);
    setBase({ revision: staged.revision, dataHash: planningHash(staged.data) });
    setConflict(false);
    setRemoteStaged(null);
    setStatusMessage("서버 계획 기록을 이 기기에 적용했습니다. 교체 전 기록은 복구 사본으로 보관했습니다.");
    return true;
  }

  function discardRemote(): void {
    setRemoteStaged(null);
    setStatusMessage("서버 기록 비교를 닫았습니다. 확인 기준은 유지되며 자동 덮어쓰지는 없었습니다.");
  }

  /** 가계부 전체 복원(LCM2)의 두 로컬 키 원자성 어댑터. rawBefore/rollback 은
   * 호출(useBudgetData)이 잡은 원시 문자열 기준으로 맞춘다. */
  const importAdapter: PlanningImportAdapter = {
    isCurrentScope: candidate => candidate === profileId && loadedScope === profileId,
    getRaw: () => (loadedScope === profileId && profileId ? cacheRaw.current : undefined),
    prepareReplace: raw => {
      const scope = latest.current.profileId;
      if (!scope) return false;
      if (raw !== null) {
        try {
          saveRecovery(store as unknown as Storage, planningStorageKey(scope), cacheCorrupt ? "corrupt" : "import", raw);
        } catch {
          return false;
        }
      }
      return true;
    },
    replace: (imported, rawBefore) => {
      const scope = latest.current.profileId;
      if (!scope) return { ok: false, message: "저장할 계획 스코프가 없습니다." };
      const result = commitPlanningWrite(store, scope, imported, rawBefore ?? null);
      if (!result.ok) {
        return { ok: false, message: result.reason === "quota" ? "저장 공간이 부족해 계획을 교체하지 않았습니다." : "다른 탭 변경으로 계획 교체를 중단했습니다." };
      }
      cacheRaw.current = result.value;
      writeBlocked.current = false;
      setData(canonicalPlanning(imported));
      setCacheCorrupt(false);
      corruptRaw.current = null;
      // 가져온 파일에는 서버 CAS 기준이 없다(스코프/revision 미포함) — 재확인 필요.
      setBase(null);
      setRemoteStaged(null);
      setConflict(false);
      return { ok: true };
    },
    rollback: rawBefore => {
      const scope = latest.current.profileId;
      if (!scope) return;
      restorePlanningRaw(store, scope, rawBefore ?? null);
      const cache = readPlanningCache(store, scope);
      if (cache.status === "ok") {
        cacheRaw.current = cache.raw;
        setData(cache.data);
      }
    }
  };

  function exportCorruptRaw(): string | null {
    return corruptRaw.current;
  }

  return {
    // identity
    profileId,
    loaded: loadedScope === profileId && !!profileId,
    // local state
    data,
    cacheCorrupt,
    saveError,
    savePending: pendingLocalWrite,
    planningActive,
    planningServerDirty,
    planningServerUnknown,
    canEdit,
    isViewer,
    // server layer
    serverSupport,
    baseConfirmed: base !== null,
    remoteStaged,
    conflict,
    isBusy,
    lastPlanningSyncedAt,
    statusMessage,
    // actions
    checkRemote,
    uploadNow,
    chainUploadAfterBudgetConfirmed,
    adoptRemote,
    discardRemote,
    saveBeforeSwitch,
    retrySave: () => setRetryAttempt(attempt => attempt + 1),
    clearStatus: () => setStatusMessage(""),
    exportCorruptRaw,
    setPayday,
    setBudget,
    addSpent,
    setSpent,
    editReserve,
    deleteReserve,
    linkReserve,
    importAdapter
  };
}

export type PlanningDataApi = ReturnType<typeof usePlanningData>;
