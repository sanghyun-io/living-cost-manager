import { describe, expect, test } from "vitest";
import { createDefaultWorkspacePlanningData, type WorkspacePlanningData } from "@living-cost-manager/shared";
import { buildLivingCostBackup, parseLivingCostBackup } from "../app/lib/backup";
import { DEFAULT_CATEGORIES, createFixedCost } from "../app/lib/budget";
import { DEFAULT_CARDS } from "../app/lib/cards";

const budget = {
  monthlyIncome: 3_000_000,
  categories: DEFAULT_CATEGORIES,
  cards: DEFAULT_CARDS,
  fixedCosts: [createFixedCost({
    id: "cost-1", name: "넷플릭스", categoryId: "subscription", paymentMethodId: "credit-card",
    paymentOptionId: "main-credit-card", amount: 17000, periodMonths: 1, billingDay: 25
  })]
};

const planning: WorkspacePlanningData = {
  schemaVersion: 1,
  paydayDay: 25,
  weekStartDay: 1,
  weeks: [
    { weekStart: "2026-10-19", budgetAmount: 100000, spentAmount: 45000, recordedAt: "2026-10-22T10:00:00Z" },
    { weekStart: "2026-10-26", budgetAmount: null, spentAmount: null, recordedAt: null }
  ],
  reserves: [
    { id: "reserve-cost-1", costId: "cost-1", savedAmount: 30000, targetAmount: null, targetDueDate: null, recordedAt: "2026-10-19T00:00:00Z" },
    // orphan: cost 가 없어도 라벨과 기록 유지
    { id: "reserve-gone", costId: "cost-deleted", savedAmount: 120000, targetAmount: 600000, targetDueDate: "2027-01-15", recordedAt: "2026-10-19T00:00:00Z", costLabel: "자동차보험" }
  ]
};

describe("LCM 백업 버전 계약", () => {
  test("planning 생략 = 기존 LCM1 바이트 포맷(가계부 복구 사본 경로 불변)", () => {
    const text = buildLivingCostBackup(budget);
    expect(text.startsWith("LCM1\n")).toBe(true);
    expect(text).not.toContain("[planning]");
    const parsed = parseLivingCostBackup(text);
    expect(parsed.planning).toBeNull(); // "계획 없음 ≠ 계획 비움"
    expect(parsed.fixedCosts[0].name).toBe("넷플릭스");
  });

  test("planning 포함 = LCM2. 구버전 클라이언트는 마법헤더로 거부해야 한다(가계부만 조용히 복원 금지)", () => {
    const text = buildLivingCostBackup({ ...budget, planning });
    expect(text.split("\n")[0]).toBe("LCM2"); // LCM1-only 파서는 "Unsupported backup format"
    // 빈 계획(기본값)도 명시 포함 — "계획 정보 없음"과 "계획 비움"을 구분 가능하게.
    const empty = buildLivingCostBackup({ ...budget, planning: createDefaultWorkspacePlanningData() });
    expect(empty.startsWith("LCM2\n")).toBe(true);
    expect(parseLivingCostBackup(empty).planning).toEqual(createDefaultWorkspacePlanningData());
  });

  test("LCM2 왕복: 예산·준비금·orphan·라벨까지 손실 없이, 서버 CAS 필드/타 스코프 필드는 들어가지 않는다", () => {
    const text = buildLivingCostBackup({ ...budget, planning });
    const planningSection = text.split("[planning]\n")[1];
    for (const forbidden of ["revision", "workspaceId", "ownerUid", "expectedSnapshotVersion"]) {
      expect(planningSection).not.toContain(forbidden);
    }
    const parsed = parseLivingCostBackup(text);
    expect(parsed.planning).not.toBeNull();
    expect(parsed.planning?.paydayDay).toBe(25);
    expect(parsed.planning?.weeks).toHaveLength(2);
    expect(parsed.planning?.weeks[1]).toEqual({ weekStart: "2026-10-26", budgetAmount: null, spentAmount: null, recordedAt: null });
    expect(parsed.planning?.reserves).toHaveLength(2);
    const orphan = parsed.planning?.reserves.find(r => r.id === "reserve-gone");
    expect(orphan?.costLabel).toBe("자동차보험");
    expect(orphan?.targetDueDate).toBe("2027-01-15");
    expect(parsed.fixedCosts[0].id).toBe("cost-1");
  });

  test("LCM2 계획 섹션 손상/누락/모르는 버전은 명시 거부(조용한 계획 손실 금지)", () => {
    const good = buildLivingCostBackup({ ...budget, planning });
    const dropped = good.replace(/\[planning\]\njson\t[^\n]*/, "");
    expect(() => parseLivingCostBackup(dropped)).toThrow(/planning/);
    const corrupt = good.replace(/\[planning\]\njson\t[^\n]*/, "[planning]\njson\t{broken");
    expect(() => parseLivingCostBackup(corrupt)).toThrow(/planning/);
    const future = good.replace('"schemaVersion":1', '"schemaVersion":2');
    expect(() => parseLivingCostBackup(future)).toThrow(/planning/);
    const unknownKey = good.replace('"paydayDay":25', '"paydayDay":25,"foreignField":1');
    expect(() => parseLivingCostBackup(unknownKey)).toThrow(/planning/);
  });

  test("LCM1 파일의 계획 없음은 빈 계획으로 해석되지 않는다", () => {
    const legacy = buildLivingCostBackup(budget);
    const parsed = parseLivingCostBackup(legacy);
    expect(parsed.planning).toBeNull();
  });
});
