// 주간 예산·급여일·준비금 계획의 기기 로컬 저장과 순수 편집 함수.
// 가계부 데이터와 반드시 다른 키에 저장된다 — 구버전 클라이언트의 예산 저장
// 경로(:user:…:v1)에는 계획 필드가 조용히 추가되지 않으며, 그 역도 같다.
// 손상(cache corrupt) 원본은 절대 기본값으로 덮어쓰지 않고 그대로 보존한다.
import {
  createDefaultWorkspacePlanningData,
  planningWeekEnd,
  workspacePlanningDataSchema,
  type WorkspacePlanningData
} from "@living-cost-manager/shared";
import { getUserErasureKey } from "./users";
import { isoWeekdayOf, parseCivilDate, weekStartFor } from "./planningTime";
import type { StringStorage } from "./account";

export const PLANNING_MAX_WEEKS = 520;
export const PLANNING_MAX_RESERVES = 1000;
export const MAX_KRW = 2147483647;

export function planningStorageKey(profileId: string): string {
  return "living-cost-manager:planning:" + encodeURIComponent(profileId) + ":v1";
}

export type PlanningCache =
  | { status: "missing"; data: WorkspacePlanningData; raw: null }
  | { status: "ok"; data: WorkspacePlanningData; raw: string }
  /** 읽히지 않는 원본. raw 를 그대로 두고 어떤 자동 저장도 중단한다. */
  | { status: "corrupt"; data: null; raw: string; reason: string };

/** 스키마가 unknown 키/버전을 거부(strict/literal 1)하므로 미러링된 신규 필드는
 * 거부되는 것이 맞다 — 조용히 stripping 하지 않는다. */
export function readPlanningCache(storage: StringStorage, profileId: string): PlanningCache {
  const raw = storage.getItem(planningStorageKey(profileId));
  if (raw === null) return { status: "missing", data: createDefaultWorkspacePlanningData(), raw: null };
  try {
    const parsed = workspacePlanningDataSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { status: "corrupt", data: null, raw, reason: parsed.error.issues[0]?.message ?? "invalid" };
    }
    return { status: "ok", data: canonicalPlanning(parsed.data), raw };
  } catch {
    return { status: "corrupt", data: null, raw, reason: "unreadable" };
  }
}

/** 비교/저장용 정규 직렬화: 키 순서 고정 + 주 오름차순·준비금 ID 순. */
export function canonicalPlanning(data: WorkspacePlanningData): WorkspacePlanningData {
  return {
    schemaVersion: 1,
    paydayDay: data.paydayDay,
    weekStartDay: data.weekStartDay,
    weeks: [...data.weeks]
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
      .map(week => ({
        weekStart: week.weekStart,
        budgetAmount: week.budgetAmount,
        spentAmount: week.spentAmount,
        recordedAt: week.recordedAt
      })),
    reserves: [...data.reserves]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(reserve => ({
        id: reserve.id,
        costId: reserve.costId,
        savedAmount: reserve.savedAmount,
        targetAmount: reserve.targetAmount,
        targetDueDate: reserve.targetDueDate,
        recordedAt: reserve.recordedAt,
        ...(reserve.costLabel !== undefined ? { costLabel: reserve.costLabel } : {})
      }))
  };
}

export function serializePlanning(data: WorkspacePlanningData): string {
  return JSON.stringify(canonicalPlanning(data));
}

export function planningHash(data: WorkspacePlanningData): string {
  return serializePlanning(data);
}

export type PlanningWriteResult =
  | { ok: true; value: string }
  | { ok: false; reason: "erased" | "concurrent" | "quota" | "readback" };

/** 동시 탭 쓰기 검사 + 읽기 되돌림 확인. 실패 시 호출자는 상태 전환/업로드를
 * 막아야 한다(가계부의 안전 메커니즘과 동일 원칙). */
export function commitPlanningWrite(
  storage: StringStorage,
  profileId: string,
  data: WorkspacePlanningData,
  expectedRaw: string | null
): PlanningWriteResult {
  if (storage.getItem(getUserErasureKey(profileId))) return { ok: false, reason: "erased" };
  const key = planningStorageKey(profileId);
  if (storage.getItem(key) !== expectedRaw) return { ok: false, reason: "concurrent" };
  const value = serializePlanning(data);
  try {
    storage.setItem(key, value);
  } catch {
    return { ok: false, reason: "quota" };
  }
  if (storage.getItem(key) !== value) return { ok: false, reason: "readback" };
  return { ok: true, value };
}

/** 원본 문자열 그대로 보존(회복/감사용). quota 실패 시 호출자가 롤백에 쓴다. */
export function restorePlanningRaw(storage: StringStorage, profileId: string, raw: string | null): boolean {
  if (storage.getItem(getUserErasureKey(profileId))) return false;
  const key = planningStorageKey(profileId);
  try {
    if (raw === null) storage.removeItem(key);
    else storage.setItem(key, raw);
  } catch {
    return false;
  }
  return storage.getItem(key) === raw;
}

// ── 입력 파싱 ────────────────────────────────────────────────────────────
/** 공백 ≠ 0. 쉼표/공백만 허용하고 NaN·Infinity·음수·범위 초과를 거부한다. */
export function parseKrwInput(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "금액을 입력하세요. 비워 두면 0원이 아닙니다." };
  if (!/^[\d,]+$/u.test(trimmed.replace(/\s/g, ""))) return { ok: false, message: "숫자 원 단위만 입력할 수 있습니다." };
  const digits = trimmed.replace(/[,\s]/g, "");
  if (digits.length > 10) return { ok: false, message: "금액이 지원 범위(2,147,483,647원 이하)를 넘습니다." };
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_KRW) return { ok: false, message: "0 이상 2,147,483,647 이하의 원 단위로 입력하세요." };
  return { ok: true, value };
}

// ── 순수 편집 (원본 변경 없음, 실패 시 reason) ──────────────────────────
export type PlanningEdit = { ok: true; data: WorkspacePlanningData } | { ok: false; message: string };

/** 가계부 전체 복원(LCM2)의 두 로컬 키 원자성을 위한 최소 어댑터. useBudgetData 는
 * 생성 순서상 planning 훅을 ref로 늦게 받는다. prepareReplace 는 현재 메모리 편집의
 * successful flush + 해당 내용 복구 사본 저장을 요구하므로 인자가 없다. */
export type PlanningImportAdapter = {
  isCurrentScope: (candidate: string | null | undefined) => boolean;
  /** 현재 스코프 미로딩이면 undefined(교체 불가), 캐시 없으면 null. prepareReplace 후 재조회. */
  getRaw: () => string | null | undefined;
  prepareReplace: () => boolean;
  replace: (imported: WorkspacePlanningData, rawBefore: string | null) => { ok: boolean; message?: string };
  rollback: (rawBefore: string | null) => void;
};

function validate(data: WorkspacePlanningData): WorkspacePlanningData | null {
  const result = workspacePlanningDataSchema.safeParse(data);
  return result.success ? canonicalPlanning(result.data) : null;
}

export function setPaydayDay(data: WorkspacePlanningData, day: number | null): PlanningEdit {
  if (day !== null && (!Number.isInteger(day) || day < 1 || day > 31)) {
    return { ok: false, message: "급여일은 1~31일 사이 또는 미설정이어야 합니다." };
  }
  const next = { ...data, paydayDay: day };
  const validated = validate(next);
  return validated ? { ok: true, data: validated } : { ok: false, message: "계획을 변경할 수 없습니다(검증 실패)." };
}

function upsertWeek(data: WorkspacePlanningData, weekStart: string, patch: { budgetAmount?: number | null; spentAmount?: number | null; recordedAt?: string | null }, dropWhenEmpty: boolean): PlanningEdit {
  if (!parseCivilDate(weekStart)) return { ok: false, message: "주간 기간이 올바르지 않습니다." };
  if (isoWeekdayOf(weekStart) !== data.weekStartDay) return { ok: false, message: "주 시작 요일과 맞지 않는 기간입니다." };
  const existing = data.weeks.find(week => week.weekStart === weekStart);
  const merged = {
    weekStart,
    budgetAmount: patch.budgetAmount !== undefined ? patch.budgetAmount : existing?.budgetAmount ?? null,
    spentAmount: patch.spentAmount !== undefined ? patch.spentAmount : existing?.spentAmount ?? null,
    recordedAt: patch.recordedAt !== undefined ? patch.recordedAt : existing?.recordedAt ?? null
  };
  if ((merged.spentAmount === null) !== (merged.recordedAt === null)) {
    return { ok: false, message: "사용액과 기록 시각은 함께 저장됩니다." };
  }
  const isEmptyPlaceholder = merged.budgetAmount === null && merged.spentAmount === null;
  let weeks: WorkspacePlanningData["weeks"];
  if (existing) {
    weeks = data.weeks.map(week => (week.weekStart === weekStart ? merged : week));
    if (dropWhenEmpty && isEmptyPlaceholder) weeks = weeks.filter(week => week.weekStart !== weekStart);
  } else {
    if (isEmptyPlaceholder && dropWhenEmpty) return { ok: true, data };
    if (data.weeks.length >= PLANNING_MAX_WEEKS) {
      return { ok: false, message: `주는 최대 ${PLANNING_MAX_WEEKS}주까지 보관합니다. 오래된 기록은 삭제하지 않았습니다.` };
    }
    weeks = [...data.weeks, merged];
  }
  const validated = validate({ ...data, weeks });
  return validated ? { ok: true, data: validated } : { ok: false, message: "계획을 변경할 수 없습니다(검증 실패)." };
}

/** 예산 설정. null = 예산미설정(0원이 아님). 0원은 유효한 사용자 예산이다. */
export function setWeekBudget(data: WorkspacePlanningData, weekStart: string, budgetAmount: number | null): PlanningEdit {
  if (budgetAmount !== null && (!Number.isSafeInteger(budgetAmount) || budgetAmount < 0 || budgetAmount > MAX_KRW)) {
    return { ok: false, message: "예산은 0 이상 2,147,483,647 이하의 원 단위입니다." };
  }
  return upsertWeek(data, weekStart, { budgetAmount }, true);
}

/** 사용액 추가(현재 기록 기준). 기록이 없던 주에서는 이번 입력이 첫 전체 기록이 된다. */
export function addWeekSpent(data: WorkspacePlanningData, weekStart: string, increment: number, recordedAt: string): PlanningEdit {
  if (!Number.isSafeInteger(increment) || increment <= 0 || increment > MAX_KRW) {
    return { ok: false, message: "더할 금액은 1원 이상의 원 단위여야 합니다." };
  }
  const existing = data.weeks.find(week => week.weekStart === weekStart);
  const base = existing?.spentAmount;
  const total = base === null || base === undefined ? increment : base + increment;
  if (!Number.isSafeInteger(total) || total > MAX_KRW) {
    return { ok: false, message: "누적 사용액이 지원 범위를 넘어 기록하지 않았습니다." };
  }
  return upsertWeek(data, weekStart, { spentAmount: total, recordedAt }, false);
}

/** 사용액 총액 수정. 0원도 명시 기록(타임스탬프 동반)이다. */
export function setWeekSpent(data: WorkspacePlanningData, weekStart: string, total: number, recordedAt: string): PlanningEdit {
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_KRW) {
    return { ok: false, message: "사용액은 0 이상 2,147,483,647 이하의 원 단위입니다." };
  }
  return upsertWeek(data, weekStart, { spentAmount: total, recordedAt }, false);
}

// ── 준비금 (M4가 소비. 스키마 경계는 여기서 정본) ────────────────────────
export function findReserveForCost(data: WorkspacePlanningData, costId: string): WorkspacePlanningData["reserves"][number] | undefined {
  return data.reserves.find(reserve => reserve.costId === costId);
}

export type ReserveDraft = {
  id?: string;
  costId: string;
  savedAmount: number | null;
  targetAmount: number | null;
  targetDueDate: string | null;
  recordedAt: string | null;
  costLabel?: string;
};

export function upsertReserve(data: WorkspacePlanningData, draft: ReserveDraft): PlanningEdit {
  if (!draft.costId) return { ok: false, message: "결합할 항목이 없습니다." };
  for (const value of [draft.savedAmount, draft.targetAmount]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_KRW)) {
      return { ok: false, message: "준비금 금액은 0 이상 2,147,483,647 이하의 원 단위여야 합니다." };
    }
  }
  if (draft.targetDueDate !== null && !parseCivilDate(draft.targetDueDate)) {
    return { ok: false, message: "목표 납부일이 올바르지 않습니다." };
  }
  const hasRecordedValue = draft.savedAmount !== null || draft.targetAmount !== null || draft.targetDueDate !== null;
  if (hasRecordedValue && !draft.recordedAt) {
    return { ok: false, message: "기록 기준을 표시할 시각이 필요합니다." };
  }
  const id = draft.id ?? "reserve-" + draft.costId;
  const entry = {
    id,
    costId: draft.costId,
    savedAmount: draft.savedAmount,
    targetAmount: draft.targetAmount,
    targetDueDate: draft.targetDueDate,
    recordedAt: draft.recordedAt,
    ...(draft.costLabel !== undefined ? { costLabel: draft.costLabel } : {})
  };
  const duplicateCost = data.reserves.some(reserve => reserve.costId === draft.costId && reserve.id !== id);
  if (duplicateCost) return { ok: false, message: "같은 항목에 준비금이 이미 있습니다." };
  const exists = data.reserves.some(reserve => reserve.id === id);
  const reserves = exists ? data.reserves.map(reserve => (reserve.id === id ? entry : reserve)) : [...data.reserves, entry];
  if (!exists && data.reserves.length >= PLANNING_MAX_RESERVES) {
    return { ok: false, message: `준비금은 최대 ${PLANNING_MAX_RESERVES}개까지 보관합니다.` };
  }
  const validated = validate({ ...data, reserves });
  return validated ? { ok: true, data: validated } : { ok: false, message: "준비금을 변경할 수 없습니다(검증 실패)." };
}

export function removeReserve(data: WorkspacePlanningData, id: string): PlanningEdit {
  const validated = validate({ ...data, reserves: data.reserves.filter(reserve => reserve.id !== id) });
  return validated ? { ok: true, data: validated } : { ok: false, message: "준비금을 삭제할 수 없습니다(검증 실패)." };
}

export function reconnectReserve(data: WorkspacePlanningData, id: string, costId: string, costLabel?: string): PlanningEdit {
  const existing = data.reserves.find(reserve => reserve.id === id);
  if (!existing) return { ok: false, message: "준비금을 찾지 못했습니다." };
  if (data.reserves.some(reserve => reserve.costId === costId && reserve.id !== id)) {
    return { ok: false, message: "그 항목에는 이미 준비금이 결합되어 있습니다." };
  }
  return upsertReserve(data, { ...existing, costId, ...(costLabel !== undefined ? { costLabel } : {}) });
}

// ── 요약 파생 ────────────────────────────────────────────────────────────
/** 계획이 전혀 없는 상태(no-op). 헤더의 서버 주장을 막거나 거짓 경보를 울리지 않는다. */
export function isPlanningNoOp(data: WorkspacePlanningData): boolean {
  return data.weeks.length === 0 && data.reserves.length === 0 && data.paydayDay === null;
}

/** 실제 금전 기록이 있는지(준비금·사용액·예산). 예산만 있어도 shared 데이터다. */
export function planningHasFinancialRecords(data: WorkspacePlanningData): boolean {
  return data.weeks.length > 0 || data.reserves.length > 0;
}

export function currentWeekStart(data: WorkspacePlanningData, kstToday: string): string | null {
  return weekStartFor(kstToday, data.weekStartDay);
}

export function weekRangeLabel(weekStart: string): string {
  try {
    return `${weekStart.slice(5).replace("-", "/")} ~ ${planningWeekEnd(weekStart).slice(5).replace("-", "/")}`;
  } catch {
    return weekStart;
  }
}
