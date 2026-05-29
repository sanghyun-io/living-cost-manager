import { describe, expect, test } from "vitest";
import { buildMonthlyReport, type SnapshotHistoryEntry } from "./index.js";

function entry(p: Partial<SnapshotHistoryEntry> & { id: string; createdAt: string }): SnapshotHistoryEntry {
  return {
    monthlyIncome: p.monthlyIncome ?? 3000000,
    fixedCostMonthlyTotal: p.fixedCostMonthlyTotal ?? 0,
    fixedCostCount: p.fixedCostCount ?? 0,
    ...p
  };
}

describe("buildMonthlyReport", () => {
  test("데이터 없으면 안내 헤드라인", () => {
    const r = buildMonthlyReport([]);
    expect(r.current).toBeNull();
    expect(r.deltaAmount).toBeNull();
    expect(r.headline).toContain("데이터가 없");
  });

  test("한 달치만 있으면 비교 없음", () => {
    const r = buildMonthlyReport([
      entry({ id: "a", createdAt: "2026-05-10T00:00:00.000Z", fixedCostMonthlyTotal: 100000 })
    ]);
    expect(r.current?.month).toBe("2026-05");
    expect(r.previous).toBeNull();
    expect(r.deltaAmount).toBeNull();
  });

  test("월별 마지막 동기화를 대표값으로, 전월 대비 증가", () => {
    const r = buildMonthlyReport([
      entry({ id: "apr1", createdAt: "2026-04-05T00:00:00.000Z", fixedCostMonthlyTotal: 100000 }),
      entry({ id: "apr2", createdAt: "2026-04-28T00:00:00.000Z", fixedCostMonthlyTotal: 200000 }),
      entry({ id: "may1", createdAt: "2026-05-20T00:00:00.000Z", fixedCostMonthlyTotal: 250000 })
    ]);
    expect(r.current?.month).toBe("2026-05");
    expect(r.previous?.month).toBe("2026-04");
    expect(r.previous?.fixedCostMonthlyTotal).toBe(200000);
    expect(r.deltaAmount).toBe(50000);
    expect(r.deltaPercent).toBe(25);
    expect(r.headline).toContain("늘었어요");
    expect(r.headline).toContain("+25%");
  });

  test("전월 대비 감소", () => {
    const r = buildMonthlyReport([
      entry({ id: "a", createdAt: "2026-04-15T00:00:00.000Z", fixedCostMonthlyTotal: 200000 }),
      entry({ id: "b", createdAt: "2026-05-15T00:00:00.000Z", fixedCostMonthlyTotal: 150000 })
    ]);
    expect(r.deltaAmount).toBe(-50000);
    expect(r.deltaPercent).toBe(-25);
    expect(r.headline).toContain("줄었어요");
  });

  test("동일하면 같다고 표시", () => {
    const r = buildMonthlyReport([
      entry({ id: "a", createdAt: "2026-04-15T00:00:00.000Z", fixedCostMonthlyTotal: 200000 }),
      entry({ id: "b", createdAt: "2026-05-15T00:00:00.000Z", fixedCostMonthlyTotal: 200000 })
    ]);
    expect(r.deltaAmount).toBe(0);
    expect(r.headline).toContain("같아요");
  });

  test("직전 달 0이면 deltaPercent null", () => {
    const r = buildMonthlyReport([
      entry({ id: "a", createdAt: "2026-04-15T00:00:00.000Z", fixedCostMonthlyTotal: 0 }),
      entry({ id: "b", createdAt: "2026-05-15T00:00:00.000Z", fixedCostMonthlyTotal: 100000 })
    ]);
    expect(r.deltaAmount).toBe(100000);
    expect(r.deltaPercent).toBeNull();
  });
});
