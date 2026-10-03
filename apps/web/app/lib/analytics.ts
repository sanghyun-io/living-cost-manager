// 온디바이스 애널리틱스 클라이언트.
//
// 프라이버시 계약: 이벤트는 이 브라우저의 IndexedDB(lcm-analytics)에만
// 저장된다. 어떤 네트워크 경로(fetch/XHR/Beacon)도 사용하지 않으며, 서버로
// 전송되지 않는다(AI 코치의 온디바이스 WebGPU 철학과 동일한 원칙).
//
// 성능 계약:
// - track() 은 동기·논블로킹. 이벤트는 메모리 큐에 쌓고 5초 debounce 로
//   IndexedDB 에 배치 쓰신(write) 한다. 쓰기 실패가 앱 흐름에 전파되지 않는다.
// - 큐가 저장 상한(MAX_EVENTS)까지 차면 즉시 배치해 메모리를 bound 한다.
// - 저장소는 ring buffer: 최신 MAX_EVENTS 개만 보관, 초과 시 가장 오래된
//   이벤트부터 삭제한다.

import { analyticsEventSchema, type AnalyticsEventInput } from "@living-cost-manager/shared";

type AnalyticsEvent = ReturnType<typeof analyticsEventSchema.parse>;

export const ANALYTICS_DB_NAME = "lcm-analytics";
export const ANALYTICS_EVENT_STORE = "events";
/** ring buffer 상한 — 이 수를 넘겨 저장하지 않는다. */
export const ANALYTICS_MAX_EVENTS = 1000;
/** track() 후 배치 쓰신까지의 debounce 시간. */
export const ANALYTICS_FLUSH_DELAY_MS = 5000;

const ANALYTICS_DB_VERSION = 1;
// 미작성(pending) 이벤트 상한. store 상한과 같음: 이만큼 쌓이면 예외 없이
// 한 배치로 저장할 수 있고, 메모리 사용도 이벤트 1,000개 이하로 bound 된다.
const MAX_PENDING_EVENTS = ANALYTICS_MAX_EVENTS;

type StoredAnalyticsEvent = AnalyticsEvent & { id?: number };

let dbPromise: Promise<IDBDatabase> | null = null;
let pendingEvents: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// 모든 쓰신/삭제를 직렬화하는 체인 (debounce·auto·pagehide flush 및
// 전체 삭제가 겹쳐도 store count/trim 이 교차하지 않는다).
let flushChain: Promise<void> = Promise.resolve();
let lifecycleBound = false;
let generation = 0;
const ERASURE_EPOCH_KEY = "living-cost-manager:analytics-erasure:v1";
let observedErasureEpoch: string | null = null;
function synchronizeErasure() {
  if (typeof window === "undefined") return;
  try {
    const epoch = window.localStorage.getItem(ERASURE_EPOCH_KEY);
    if (epoch !== observedErasureEpoch) {
      observedErasureEpoch = epoch;
      generation += 1;
      pendingEvents = [];
    }
  } catch { /* Storage-restricted browsers retain the in-tab guard. */ }
}

function isAnalyticsAvailable(): boolean {
  // SSR prerender 및 IndexedDB 미지원 브라우저(구버전 시크릿 모드 등)에서는
  // 애널리틱스를 조용히 비활성화한다(본류 기능에 영향 없음).
  return typeof indexedDB !== "undefined";
}

function openAnalyticsDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(ANALYTICS_DB_NAME, ANALYTICS_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ANALYTICS_EVENT_STORE)) {
          const store = db.createObjectStore(ANALYTICS_EVENT_STORE, {
            keyPath: "id",
            autoIncrement: true,
          });
          // 날짜 집계·트리밍에서 타임스탬프 순회용.
          store.createIndex("timestamp", "timestamp");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  }
  return dbPromise;
}

// 열기 실패는 Promise 캐시를 비워 다음 호출 때 재시도할 수 있게 한다
// (임시 저장소 오류가 영구 장애로 굳지 않게).
async function openAnalyticsDbSafe(): Promise<IDBDatabase | null> {
  try {
    return await openAnalyticsDb();
  } catch {
    dbPromise = null;
    return null;
  }
}

function runWrite(db: IDBDatabase, executor: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(ANALYTICS_EVENT_STORE, "readwrite");
      executor(tx.objectStore(ANALYTICS_EVENT_STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function scheduleFlush() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingEvents();
  }, ANALYTICS_FLUSH_DELAY_MS);
}

// 탭 이탈 시 마지막 배치를 잃지 않도록 리스너를 한 번만 바인딩한다.
function bindLifecycleFlush() {
  if (lifecycleBound || typeof window === "undefined") {
    return;
  }
  lifecycleBound = true;
  const flush = () => void flushPendingEvents();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush();
    }
  });
}

/**
 * 이벤트를 큐에 넣고 5초 debounce 배치 쓰신을 예약한다.
 * 스키마에 맞지 않는 이벤트는 저장하지 않는다(privacy: data 의 미지 키는
 * zod 가 strip 하므로 의도치 않은 필드가 저장소에 들어갈 수 없다).
 */
export function track(event: AnalyticsEventInput | AnalyticsEvent): void {
  synchronizeErasure();
  if (!isAnalyticsAvailable()) {
    return;
  }

  const parsed = analyticsEventSchema.safeParse(event);
  if (!parsed.success) {
    console.warn("[analytics] 스키마 불일치 이벤트 폐기:", parsed.error.issues.map((issue) => issue.path.join(".")).join(", "));
    return;
  }

  bindLifecycleFlush();
  pendingEvents.push(parsed.data as AnalyticsEvent);
  scheduleFlush();

  // 큐가 상한까지 차면 debounce 를 기다리지 않고 즉시 배치(메모리 bound).
  if (pendingEvents.length >= MAX_PENDING_EVENTS) {
    void flushPendingEvents();
  }
}

/**
 * 대기 중인 배치를 즉시 IndexedDB 에 쓰고 ring buffer 상한을 맞춘다.
 * 실패해도 던지지 않는다 — 실패 배치는 큐에 되돌려 다음 플래시에서 재시도.
 * (테스트·대시보드에서도 명시적으로 호출한다.)
 *
 * 동시 호출은 flushChain 으로 직렬화한다. auto-flush(큐 상한)와 debounce/pagehide
 * flush 가 겹치면 두 flush 가 같은 store count 를 보기 전에 trim 을 결판지어
 * 이벤트를 과삭제할 수 있다 — 체인 하나로 쓰신→trim 을 원자적 단위로 만든다.
 */
export function flushPendingEvents(): Promise<void> {
  synchronizeErasure();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const scheduledGeneration = generation;
  const run = flushChain.then(() => scheduledGeneration === generation ? flushNow() : undefined);
  flushChain = run.catch(() => undefined);
  return run;
}

async function flushNow(): Promise<void> {
  synchronizeErasure();
  if (pendingEvents.length === 0 || !isAnalyticsAvailable()) {
    return;
  }

  const batch = pendingEvents;
  const batchGeneration = generation;
  pendingEvents = [];

  const db = await openAnalyticsDbSafe();
  if (!db) {
    requeueAfterFailure(batch, batchGeneration);
    return;
  }

  synchronizeErasure();
  if (batchGeneration !== generation) return;
  try {
    await runWrite(db, (store) => {
      // 한 트랜잭션에 몰아쓰기 = 배치 쓰기 (이벤트당 tx 오픈 비용 제거).
      for (const event of batch) {
        store.add(event);
      }
    });
    synchronizeErasure();
    if (batchGeneration !== generation) { await clearStore(); return; }
    await trimOldestBeyondCap(db);
  } catch {
    requeueAfterFailure(batch, batchGeneration);
  }
}

function requeueAfterFailure(batch: AnalyticsEvent[], batchGeneration: number) {
  synchronizeErasure();
  if (batchGeneration !== generation) return;
  // 되돌림이 상한을 넘으면 가장 최근 것만 유지 (ring buffer semantics 와 일치).
  pendingEvents = [...batch, ...pendingEvents].slice(-MAX_PENDING_EVENTS);
  scheduleFlush();
}

/** store 가 상한을 넘치면 가장 오래된(먼저 삽입된) 이벤트부터 삭제. best-effort. */
async function trimOldestBeyondCap(db: IDBDatabase): Promise<void> {
  try {
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(ANALYTICS_EVENT_STORE, "readonly");
      const request = tx.objectStore(ANALYTICS_EVENT_STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("count failed"));
    });

    const excess = count - ANALYTICS_MAX_EVENTS;
    if (excess <= 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ANALYTICS_EVENT_STORE, "readwrite");
      // primary key(auto id) 오름차순 커서 = 삽입 순서 → 앞의 excess 개가 가장 오래된 것.
      const cursorRequest = tx.objectStore(ANALYTICS_EVENT_STORE).openCursor();
      let removed = 0;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor && removed < excess) {
          cursor.delete();
          removed += 1;
          cursor.continue();
        }
        // 나머지는 요청 없음으로 트랜잭션이 자동으로 커밋·완료된다.
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("cursor failed"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("trim failed"));
      tx.onabort = () => reject(tx.error ?? new Error("trim aborted"));
    });
  } catch {
    // 트리밍 실패로 쓰신 흐름을 깨지 않는다 — 다음 배치 때 다시 시도된다.
  }
}

async function readStoredEvents(): Promise<AnalyticsEvent[]> {
  const db = await openAnalyticsDbSafe();
  if (!db) {
    return [];
  }
  try {
    return await new Promise<AnalyticsEvent[]>((resolve, reject) => {
      const tx = db.transaction(ANALYTICS_EVENT_STORE, "readonly");
      const request = tx.objectStore(ANALYTICS_EVENT_STORE).getAll();
      request.onsuccess = () => {
        const rows = request.result as StoredAnalyticsEvent[];
        resolve(rows.flatMap((event) => {
          const parsed = analyticsEventSchema.safeParse(event);
          return parsed.success ? [parsed.data] : [];
        }));
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  } catch {
    return [];
  }
}

/**
 * 저장된 이벤트 + 아직 안 쓴 큐 이벤트까지 타임스탬프 오름차순으로 반환한다
 * (대시보드가 방금 발생 이벤트를 놓치지 않게).
 */
export async function getEvents(): Promise<AnalyticsEvent[]> {
  synchronizeErasure();
  const readGeneration = generation;
  await flushChain;
  const stored = await readStoredEvents();
  synchronizeErasure();
  if (readGeneration !== generation) return [];
  return [...stored, ...pendingEvents].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * 저장소와 대기 큐를 모두 비운다 (설정 > 애널리틱스 > 전체 삭제).
 * 큐는 즉시, 저장소 삭제는 flush 체인 뒤에 실행된다 — 진행 중인 배치 쓰신이
 * 삭제 후 다시 이벤트를 채우는 경쟁을 체인 순서가 막는다.
 */
export function clearEvents(): Promise<void> {
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(ERASURE_EPOCH_KEY, crypto.randomUUID()); } catch { /* In-tab erasure still runs. */ }
  }
  synchronizeErasure();
  generation += 1;
  pendingEvents = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const run = flushChain.then(clearStore);
  flushChain = run.catch(() => undefined);
  return run;
}

async function clearStore(): Promise<void> {
  if (!isAnalyticsAvailable()) {
    return;
  }
  const db = await openAnalyticsDbSafe();
  if (!db) {
    return;
  }
  try {
    await runWrite(db, (store) => {
      store.clear();
    });
  } catch {
    // 삭제 실패도 본류 파괴 금지 — 다음 진입 때 재시도 가능.
  }
}

/** 일별 집계 행: 로컬 날짜 키·총합·타입별 개수. */
export interface DailySummary {
  /** 로컬 타임존 기준 YYYY-MM-DD. */
  date: string;
  total: number;
  byType: Record<string, number>;
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 이벤트 목록을 로컬 날짜별로 집계 (날짜 오름차순). 순수 함수라 테스트·대시보드 공용. */
export function summarizeByDay(events: ReadonlyArray<Pick<AnalyticsEvent, "type" | "timestamp">>): DailySummary[] {
  const byDate = new Map<string, DailySummary>();
  for (const event of events) {
    const key = localDateKey(event.timestamp);
    const entry = byDate.get(key) ?? { date: key, total: 0, byType: {} };
    entry.total += 1;
    entry.byType[event.type] = (entry.byType[event.type] ?? 0) + 1;
    byDate.set(key, entry);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function getDailySummary(): Promise<DailySummary[]> {
  return summarizeByDay(await getEvents());
}
