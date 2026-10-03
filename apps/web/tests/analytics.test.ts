import "fake-indexeddb/auto";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { AnalyticsEventInput as AnalyticsEvent } from "@living-cost-manager/shared";
import {
  ANALYTICS_MAX_EVENTS,
  clearEvents,
  flushPendingEvents,
  getDailySummary,
  getEvents,
  localDateKey,
  summarizeByDay,
  track
} from "../app/lib/analytics";

// 온디바이스 애널리틱스 클라이언트. fake-indexeddb 가 전역 indexedDB 를
// 대체하므로 실제 저장·트리밍 경로를 node 에서 검증할 수 있다.
// window 가 없는 환경이라 track() 의 lifecycle 바인딩(pagehide 등)만 건너뛴다.

function pageView(timestamp: number): AnalyticsEvent {
  return { type: "app.page_view", timestamp, data: { path: "/test" } };
}

function at(daysAgo: number, hour = 9): number {
  const day = new Date();
  day.setHours(hour, 0, 0, 0);
  day.setDate(day.getDate() - daysAgo);
  return day.getTime();
}

afterEach(async () => {
  // 저장소·큐·타이머를 시험 간에 완전 초기화 (모듈 싱글톤 상태 격리).
  await clearEvents();
});

describe("track / flushPendingEvents", () => {
  test("flush 시 이벤트가 IndexedDB 에 저장되고 타임스탬프 오름차순으로 읽힌다", async () => {
    track(pageView(2_000));
    track(pageView(1_000));
    await flushPendingEvents();

    const events = await getEvents();
    expect(events.map((event) => event.timestamp)).toEqual([1_000, 2_000]);
    expect(events[0].data).toEqual({});
  });

  test("아직 flush 되지 않은 큐 이벤트도 getEvents 에 합쳐진다 (대시보드 실시간성)", async () => {
    track(pageView(1_000));
    const beforeFlush = await getEvents();
    expect(beforeFlush).toHaveLength(1);

    await flushPendingEvents();
    const afterFlush = await getEvents();
    // 큐가 비워졌으므로 중복 없이 여전히 1개.
    expect(afterFlush).toHaveLength(1);
  });

  test("여러 이벤트를 한 배치로 쓴다 — flush 후 개별 add 없이 저장된다", async () => {
    for (let i = 0; i < 10; i += 1) {
      track({ type: "export.csv", timestamp: 1_000 + i, data: {} });
    }
    await flushPendingEvents();
    const events = await getEvents();
    expect(events).toHaveLength(10);
    expect(events.every((event) => event.type === "export.csv")).toBe(true);
  });

  test("스키마에 맞지 않는 이벤트는 저장되지 않는다", async () => {
    track({ type: "budget.item_edit", timestamp: 1, data: {} } as unknown as AnalyticsEvent);
    track({ type: "auth.login", timestamp: 1, data: { method: "oauth" } } as unknown as AnalyticsEvent);
    track(pageView(1)); // 유효한 이벤트는 함께 섞어 폐기 대상만 확인
    await flushPendingEvents();

    const events = await getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("app.page_view");
  });

  test("미지의 data 키는 저장 전에 strip 된다 (개인정보 최소화)", async () => {
    track({
      type: "budget.card_create",
      timestamp: 5,
      data: { label: "신한 카드", leakedNote: "비밀 메모" }
    } as AnalyticsEvent);
    await flushPendingEvents();

    const events = await getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({});
  });
});

describe("clearEvents", () => {
  test("queued pre-clear flushes cannot consume newly tracked events", async () => {
    track(pageView(111));
    const queued = flushPendingEvents();
    const cleared = clearEvents();
    track(pageView(222));
    await Promise.all([queued, cleared]);
    await flushPendingEvents();
    expect((await getEvents()).map((event) => event.timestamp)).toEqual([222]);
  });
  test("an in-flight failed write cannot requeue events erased during the write", async () => {
    // Start a real transaction, erase while it is outstanding, then abort it.
    const original = IDBDatabase.prototype.transaction;
    let cleared: Promise<void> | undefined;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(function (this: IDBDatabase, ...args) {
      const tx = original.apply(this, args);
      cleared = clearEvents();
      queueMicrotask(() => tx.abort());
      return tx;
    });
    try {
      track(pageView(111));
      await flushPendingEvents();
      await cleared;
      await flushPendingEvents();
      expect(await getEvents()).toEqual([]);
      track(pageView(222));
      await flushPendingEvents();
      expect((await getEvents()).map((event) => event.timestamp)).toEqual([222]);
    } finally {
      spy.mockRestore();
    }
  });
  test("저장된 이벤트와 미작성 큐를 모두 비운다", async () => {
    track(pageView(1_000));
    await flushPendingEvents();
    track(pageView(2_000)); // 큐에만 있는 상태

    await clearEvents();

    expect(await getEvents()).toEqual([]);
  });

  test("삭제 후 새 track 은 정상 동작한다", async () => {
    track(pageView(1_000));
    await flushPendingEvents();
    await clearEvents();

    track(pageView(3_000));
    await flushPendingEvents();
    const events = await getEvents();
    expect(events.map((event) => event.timestamp)).toEqual([3_000]);
  });
});

test("legacy stored financial and free-text fields are sanitized on read/export", async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lcm-analytics", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("events", "readwrite");
      const store = tx.objectStore("events");
      store.add({ type: "budget.fixed_cost_add", timestamp: 1, data: { categoryId: "private", amount: 99000, note: "secret" } });
      store.add({ type: "sync.push", timestamp: 2, data: { workspaceId: "private" } });
      store.add({ type: "app.page_view", timestamp: 3, data: { path: "/?token=secret" } });
      store.add({ type: "share.invite", timestamp: 4, data: { role: "free text" } });
      store.add({ type: "unknown", timestamp: 5, data: { secret: "secret" } });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const events = await getEvents();
    expect(events).toHaveLength(4);
    expect(events.every((event) => Object.keys(event.data).length === 0)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private|secret|99000|free text/);
  } finally {
    db.close();
  }
});

describe("getDailySummary / summarizeByDay", () => {
  test("로컬 날짜 단위로 총합과 타입별 개수를 집계한다", async () => {
    track(pageView(at(2)));
    track({ type: "export.csv", timestamp: at(2, 18), data: {} });
    track({ type: "coach.request", timestamp: at(0, 10), data: {} });
    await flushPendingEvents();

    const summary = await getDailySummary();
    const dayAgo2 = localDateKey(at(2));
    const today = localDateKey(at(0));

    expect(summary.map((entry) => entry.date)).toEqual([dayAgo2, today]);
    expect(summary[0]).toEqual({
      date: dayAgo2,
      total: 2,
      byType: { "app.page_view": 1, "export.csv": 1 }
    });
    expect(summary[1]).toEqual({
      date: today,
      total: 1,
      byType: { "coach.request": 1 }
    });
  });

  test("순수 집계 함수는 날짜 오름차순 · 빈 입력 안전", () => {
    expect(summarizeByDay([])).toEqual([]);

    const rows = summarizeByDay([pageView(at(1)), pageView(at(3))]);
    expect(rows.map((row) => row.total)).toEqual([1, 1]);
    expect(rows[0].date < rows[1].date).toBe(true);
  });
});

describe("ring buffer (최대 1,000개)", () => {
  test("상한을 넘는 이벤트는 가장 오래된 것부터 버려진다", async () => {
    const base = 1_700_000_000_000;
    // MAX_events + 5: 큐 상한(1,000)에서 한 번 자동 flush, 나머지 5개는 수동 flush.
    for (let i = 0; i < ANALYTICS_MAX_EVENTS + 5; i += 1) {
      track(pageView(base + i));
    }
    await flushPendingEvents();

    const events = await getEvents();
    expect(events).toHaveLength(ANALYTICS_MAX_EVENTS);
    // 가장 오래된 5개(base+0..4)가 사라지고 최신이 남아야 한다.
    expect(events[0].timestamp).toBe(base + 5);
    expect(events[events.length - 1].timestamp).toBe(base + ANALYTICS_MAX_EVENTS + 4);
  });
});
