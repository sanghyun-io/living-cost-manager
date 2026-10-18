import { describe, expect, test } from "vitest";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import {
  addCivilDays,
  clampDayToMonth,
  isoWeekdayOf,
  kstCivilDateString,
  paydayOccurrences,
  parseCivilDate,
  weekStartFor
} from "../app/lib/planningTime";
import {
  addWeekSpent,
  canonicalPlanning,
  commitPlanningWrite,
  isPlanningNoOp,
  parseKrwInput,
  planningHash,
  planningStorageKey,
  readPlanningCache,
  removeReserve,
  restorePlanningRaw,
  reconnectReserve,
  serializePlanning,
  setPaydayDay,
  setWeekBudget,
  setWeekSpent,
  upsertReserve,
  PLANNING_MAX_WEEKS
} from "../app/lib/planningStorage";
import { getUserDataKey } from "../app/lib/users";
import { combinePlanningStorageState } from "../app/lib/syncStatus";
import { MAX_KRW } from "../app/lib/planningStorage";

// 메모리 저장소(StringStorage) — quota/readback 시나리오를 주입 가능하게 만든다.
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    _map: map
  };
}

describe("planningTime — KST civil date & UTC calendar math", () => {
  test("한국 시간 날짜는 호스트 타임존과 무관하게 고정 해석된다(자정 경계 포함)", () => {
    const boundary = new Date("2026-10-09T14:59:59Z"); // KST 10/09 23:59:59
    const after = new Date("2026-10-09T15:00:00Z");    // KST 10/10 00:00:00
    for (const zone of ["UTC", "America/New_York", "Pacific/Kiritimati", "Asia/Seoul"]) {
      process.env.TZ = zone;
      expect(kstCivilDateString(boundary)).toBe("2026-10-09");
      expect(kstCivilDateString(after)).toBe("2026-10-10");
    }
    process.env.TZ = "Asia/Seoul";
  });

  test("parseCivilDate는 실제 달력 날짜만 수용한다", () => {
    expect(parseCivilDate("2026-02-30")).toBeNull();
    expect(parseCivilDate("2028-02-29")).not.toBeNull(); // 2028 윤년
    expect(parseCivilDate("2027-02-29")).toBeNull();
    expect(parseCivilDate("2026-13-01")).toBeNull();
    expect(parseCivilDate("9999-12-31")).not.toBeNull();
  });

  test("weekStartFor는 weekStartDay 요일을 정확히 따른다(기본 월요일)", () => {
    // 2026-10-19 is a Monday.
    expect(weekStartFor("2026-10-19", 1)).toBe("2026-10-19");
    expect(weekStartFor("2026-10-25", 1)).toBe("2026-10-19"); // Sunday still in Mon-week
    expect(weekStartFor("2026-10-25", 7)).toBe("2026-10-25"); // Sunday-start week
    expect(isoWeekdayOf("2026-10-19")).toBe(1);
    expect(isoWeekdayOf("2026-10-25")).toBe(7);
    expect(weekStartFor("2026-10-19", 9)).toBeNull();
  });

  test("addCivilDays는 월/년 경계와 범위를 safely 처리한다", () => {
    expect(addCivilDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCivilDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCivilDays("2026-10-19", -7)).toBe("2026-10-12");
    expect(addCivilDays("9999-12-25", 7)).toBeNull(); // 주 상한을 넘는 증분은 거부
    expect(addCivilDays("2026-02-28", 2)).toBe("2026-03-02"); // 2026 is not leap
    expect(addCivilDays("2028-02-28", 2)).toBe("2028-03-01"); // 2028 is leap
  });

  test("급여일 29/30/31은 해당 월 말일로 clamp되고 모든 발생을 센다", () => {
    expect(clampDayToMonth(2027, 2, 31)).toBe(28);
    expect(clampDayToMonth(2028, 2, 31)).toBe(29);
    expect(clampDayToMonth(2026, 4, 31)).toBe(30);
    const occurrences = paydayOccurrences("2028-01-01", "2028-05-01", 31);
    expect(occurrences).toEqual(["2028-01-31", "2028-02-29", "2028-03-31", "2028-04-30"]);
  });

  test("급여일 발생은 창 밖 날짜를 포함하지 않는다(월 1회 이상 기간은 전체 열거)", () => {
    // 15일 급여일, 약 한 달 남짓 창에서는 정확히 2회(단기 주기에 2 발생)
    expect(paydayOccurrences("2026-10-10", "2026-12-05", 15)).toEqual(["2026-10-15", "2026-11-15"]);
    expect(paydayOccurrences("2026-12-16", "2027-01-10", 15)).toEqual([]);
  });
});

describe("planningStorage — scope-safe cache & pure edits", () => {
  test("계획 키는 가계부 데이터 키와 반드시 분리된다(구버전 예산 경로 오염 금지)", () => {
    const profile = "ledger:[\"acct\",\"ws\"]";
    expect(planningStorageKey(profile)).not.toContain(getUserDataKey(profile));
    expect(planningStorageKey(profile)).toBe("living-cost-manager:planning:" + encodeURIComponent(profile) + ":v1");
  });

  test("미러링된 신규 키/모르는 schemaVersion 은 거부(corrupt)되고 원본 raw 는 보존된다", () => {
    const storage = memoryStorage({
      [planningStorageKey("p1")]: JSON.stringify({ schemaVersion: 1, paydayDay: null, weekStartDay: 1, weeks: [], reserves: [], hackerField: 1 })
    });
    const mirror = readPlanningCache(storage, "p1");
    expect(mirror.status).toBe("corrupt");
    if (mirror.status === "corrupt") expect(mirror.raw).toContain("hackerField");

    const future = memoryStorage({
      [planningStorageKey("p2")]: JSON.stringify({ schemaVersion: 2, paydayDay: null, weekStartDay: 1, weeks: [], reserves: [] })
    });
    expect(readPlanningCache(future, "p2").status).toBe("corrupt");
    const junk = memoryStorage({ [planningStorageKey("p3")]: "{not json" });
    expect(readPlanningCache(junk, "p3").status).toBe("corrupt");
  });

  test("손상 캐시는 commit 가드로 덮어쓰지 않으며, 정상 쓰기는 읽기 되돌림까지 확인한다", () => {
    const storage = memoryStorage();
    const data = createDefaultWorkspacePlanningData();
    // missing 캐시에 대한 쓰기는 expectedRaw null 에서만 성립
    const first = commitPlanningWrite(storage, "p", data, null);
    expect(first.ok).toBe(true);
    const tampered = commitPlanningWrite(storage, "p", data, "stale-raw");
    expect(tampered).toEqual({ ok: false, reason: "concurrent" });
    // 저장소 읽기 되돌림 불일치
    const flaky = memoryStorage();
    const original = flaky.setItem.bind(flaky);
    let writes = 0;
    flaky.setItem = (key, value) => {
      writes += 1;
      original(key, value);
      if (writes === 2) flaky._map.set(key, value + "!"); // 저장 직후 달라진 것처럼
    };
    expect(commitPlanningWrite(flaky, "p", data, null).ok).toBe(true);
    expect(commitPlanningWrite(flaky, "p", { ...data, paydayDay: 5 }, serializePlanning(data))).toEqual({ ok: false, reason: "readback" });
  });

  test("quota 실패 시 write 는 fail-closed, rollback 은 원시 값/결로를 복원한다", () => {
    const storage = memoryStorage();
    const quotaStorage = {
      ...storage,
      setItem: () => { throw new Error("QuotaExceededError"); }
    };
    const failed = commitPlanningWrite(quotaStorage, "p", createDefaultWorkspacePlanningData(), null);
    expect(failed).toEqual({ ok: false, reason: "quota" });
    restorePlanningRaw(storage, "p", "raw-before");
    expect(storage.getItem(planningStorageKey("p"))).toBe("raw-before");
    restorePlanningRaw(storage, "p", null);
    expect(storage.getItem(planningStorageKey("p"))).toBeNull();
  });

  test("parseKrwInput: 공백≠0, 쉼표 허용, NaN·음수·범위 초과 거부", () => {
    expect(parseKrwInput("").ok).toBe(false);
    expect(parseKrwInput("1,000")).toEqual({ ok: true, value: 1000 });
    expect(parseKrwInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseKrwInput("-5").ok).toBe(false);
    expect(parseKrwInput("1e5").ok).toBe(false);
    expect(parseKrwInput("Infinity").ok).toBe(false);
    expect(parseKrwInput(String(MAX_KRW))).toEqual({ ok: true, value: MAX_KRW });
    expect(parseKrwInput(String(MAX_KRW + 1)).ok).toBe(false);
  });

  test("예산 null 과 0 은 서로 다른 진실이고, 사용액 0 은 타임스탬프와 짝을 이룬다", () => {
    const base = createDefaultWorkspacePlanningData();
    const withZero = setWeekBudget(base, "2026-10-19", 0);
    expect(withZero.ok).toBe(true);
    if (withZero.ok) expect(withZero.data.weeks[0].budgetAmount).toBe(0);
    const unset = setWeekSpent(base, "2026-10-19", 0, "2026-10-19T10:00:00Z");
    expect(unset.ok).toBe(true);
    if (unset.ok) {
      expect(unset.data.weeks[0].spentAmount).toBe(0);
      expect(unset.data.weeks[0].recordedAt).not.toBeNull();
    }
  });

  test("주 시작이 weekStartDay 와 다른 편집은 거부된다", () => {
    const data = createDefaultWorkspacePlanningData(); // Monday
    expect(setWeekBudget(data, "2026-10-20", 50000).ok).toBe(false); // Tuesday
  });

  test("지출 추가는 합산이고 누적 상한 초과 시 기록하지 않으며 오래된 주는 지우지 않는다", () => {
    let data = createDefaultWorkspacePlanningData();
    const first = addWeekSpent(data, "2026-10-19", 30000, "2026-10-19T01:00:00Z");
    expect(first.ok).toBe(true);
    if (first.ok) {
      data = first.data;
      expect(data.weeks[0].spentAmount).toBe(30000); // 첫 입력은 곧 총액 기록
    }
    const second = addWeekSpent(data, "2026-10-19", 20000, "2026-10-19T02:00:00Z");
    expect(second.ok && second.data.weeks[0].spentAmount).toBe(50000);
    const overflow = addWeekSpent(data, "2026-10-19", MAX_KRW, "2026-10-19T03:00:00Z");
    expect(overflow.ok).toBe(false); // 합산이 범위를 넘으면 기록하지 않음
    if (overflow.ok === false) expect(overflow.message).toContain("범위");
    // 다른 주는 그대로 유지(자동 삭제 없음)
    const otherWeek = addWeekSpent(data, "2026-10-26", 1000, "2026-10-26T01:00:00Z");
    expect(otherWeek.ok && otherWeek.data.weeks.length).toBe(2);
  });

  test("520주 상한: 새 주 추가는 거절하고 기존 기록은 삭제하지 않는다", () => {
    const weeks = Array.from({ length: PLANNING_MAX_WEEKS }, (_, index) => ({
      weekStart: addCivilDays("2026-10-19", index * 7)!,
      budgetAmount: 1000,
      spentAmount: null,
      recordedAt: null
    }));
    const data: WorkspacePlanningData = { schemaVersion: 1, paydayDay: null, weekStartDay: 1, weeks, reserves: [] };
    const overflow = setWeekBudget(data, addCivilDays("2026-10-19", PLANNING_MAX_WEEKS * 7)!, 1000);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.message).toContain("520");
    // 기존 주 편집은 계속 허용
    expect(setWeekBudget(data, weeks[0].weekStart, 2000).ok).toBe(true);
  });

  test("예산 미설정 지우기는 내용 없는 주만 제거하고 사용액이 있는 주는 남긴다", () => {
    let data = createDefaultWorkspacePlanningData();
    const spentWeek = addWeekSpent(data, "2026-10-19", 5000, "2026-10-19T01:00:00Z");
    if (spentWeek.ok) data = spentWeek.data;
    const budgetThenClear = setWeekBudget(data, "2026-10-19", 40000);
    if (budgetThenClear.ok) {
      const cleared = setWeekBudget(budgetThenClear.data, "2026-10-19", null);
      expect(cleared.ok && cleared.data.weeks[0]?.budgetAmount).toBe(null);
      expect(cleared.ok && cleared.data.weeks[0]?.spentAmount).toBe(5000); // 사용액 보존
    }
    const emptyWeek = setWeekBudget(createDefaultWorkspacePlanningData(), "2026-10-26", 40000);
    if (emptyWeek.ok) {
      const removed = setWeekBudget(emptyWeek.data, "2026-10-26", null);
      expect(removed.ok && removed.data.weeks.length).toBe(0); // 빈 자리만 삭제
    }
  });

  test("준비금: 기록값에는 recordedAt 필수, 항목 중복 불가, costLabel 없이도 orphan 보존", () => {
    const base = createDefaultWorkspacePlanningData();
    const missingStamp = upsertReserve(base, { costId: "cost-1", savedAmount: 1000, targetAmount: null, targetDueDate: null, recordedAt: null });
    expect(missingStamp.ok).toBe(false);
    const ok = upsertReserve(base, { costId: "cost-1", savedAmount: 1000, targetAmount: 120000, targetDueDate: "2027-01-15", recordedAt: "2026-10-19T00:00:00Z" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const duplicate = upsertReserve(ok.data, { id: "reserve-2", costId: "cost-1", savedAmount: null, targetAmount: null, targetDueDate: null, recordedAt: null });
      expect(duplicate.ok).toBe(false);
      const reconnected = reconnectReserve(ok.data, ok.data.reserves[0].id, "cost-9", "이전 항목");
      expect(reconnected.ok && reconnected.data.reserves[0].costId).toBe("cost-9");
      expect(reconnected.ok && reconnected.data.reserves[0].costLabel).toBe("이전 항목");
    }
    const removed = removeReserve(ok.ok ? ok.data : base, "reserve-cost-1");
    expect(removed.ok && removed.data.reserves.length).toBe(0);
  });

  test("canonical화: 주 오름차순·키 순서 고정으로 해시가 재배열에 불변하다", () => {
    const a: WorkspacePlanningData = {
      schemaVersion: 1, paydayDay: 25, weekStartDay: 1,
      weeks: [
        { weekStart: "2026-10-26", budgetAmount: 100, spentAmount: null, recordedAt: null },
        { weekStart: "2026-10-19", budgetAmount: 200, spentAmount: null, recordedAt: null }
      ],
      reserves: []
    };
    const b = canonicalPlanning({ ...a, weeks: [...a.weeks].reverse() });
    expect(planningHash(a)).toBe(planningHash(b));
    expect(serializePlanning(a)).toBe(serializePlanning(b));
  });

  test("no-op 계획 판정: 기본값만 no-op, 급여일/예산/준비금 하나라도 있으면 활성", () => {
    expect(isPlanningNoOp(createDefaultWorkspacePlanningData())).toBe(true);
    const withPayday = setPaydayDay(createDefaultWorkspacePlanningData(), 25);
    expect(withPayday.ok && isPlanningNoOp(withPayday.data)).toBe(false);
  });
});

describe("combinePlanningStorageState — 헤더의 기기·서버 저장 주장", () => {
  const none = { saveError: false, savePending: false, active: false, serverDirty: false, serverUnknown: false };
  test("no-op 계획은 가계부 상태를 흔들지 않는다(거짓 경보 금지)", () => {
    expect(combinePlanningStorageState("server-saved", none)).toBe("server-saved");
    expect(combinePlanningStorageState("device-saved", none)).toBe("device-saved");
  });
  test("기기·서버 저장됨은 계획까지 확인됐을 때만 성립한다", () => {
    expect(combinePlanningStorageState("server-saved", { ...none, active: true, serverDirty: true })).toBe("device-dirty");
    expect(combinePlanningStorageState("server-saved", { ...none, active: true, serverUnknown: true })).toBe("server-unknown");
    expect(combinePlanningStorageState("server-saved", { ...none, active: true })).toBe("server-saved");
  });
  test("계획 로컬 쓰기 실패는 로딩/차단 상태보다 우선한다", () => {
    expect(combinePlanningStorageState("checking", { ...none, saveError: true })).toBe("save-failed");
    expect(combinePlanningStorageState("conflict", { ...none, saveError: true })).toBe("save-failed");
    expect(combinePlanningStorageState("server-saved", { ...none, savePending: true })).toBe("saving");
  });
  test("가계부 저장 실패는 계획 대기보다 심각하다(오염 금지)", () => {
    expect(combinePlanningStorageState("save-failed", { ...none, savePending: true })).toBe("save-failed");
  });
  test("게스트(서버 없음)는 계획 사용여부와 무관하게 기기 저장만 주장", () => {
    expect(combinePlanningStorageState("device-saved", { ...none, active: true })).toBe("device-saved");
  });
});
