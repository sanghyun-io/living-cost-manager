import { describe, expect, test } from "vitest";
import { aggregateWorkspacesRequestSchema, kstThirtyDayWindow, summarizeWorkspaceBudget, sumWorkspaceBudgets } from "@living-cost-manager/shared";
import { guides } from "../app/guide/content";

const guide = guides.find(({ slug }) => slug === "backup-and-sync")!;
const section = guide.sections.find(({ title }) => title === "첫 가계부와 기존 가계부 선택")!;
const text = section.paragraphs.join(" ");
const steps = section.steps!.join(" ");

describe("free public ledger guidance and retained calculations", () => {
  test("guide exposes first owned ledger and preserves existing/shared access without aggregation", () => {
    expect(guide.title).toContain("가계부 선택");
    expect(text).toContain("소유 가계부 1개");
    expect(text).toContain("공유받은 가계부는 이 수에 포함되지 않습니다");
    expect(text).toContain("조회·편집·내보내기");
    expect(text).toContain("기존 가계부의 데이터와 공유 권한은 유지");
    expect(JSON.stringify(guide)).not.toMatch(/합산|최대 20개|목적별/);
  });

  test("creation and explicit selection match existing control labels and permissions", () => {
    expect(text).toContain("첫 가계부 생성은 이메일 확인 후");
    expect(text).toContain("이름 변경은 이메일 확인을 마친 소유자만");
    expect(steps).toContain("‘새 가계부’");
    expect(steps).toContain("‘현재 가계부’에서 이용할 가계부를 직접 선택");
    expect(steps).toContain("실제 금액과 월 수입");
    expect(text).toContain("이미 소유 가계부가 있으면 추가 생성하지 않습니다");
  });

  test("duplicate ledger IDs are distinct from duplicate expenses and income is excluded", () => {
    expect(aggregateWorkspacesRequestSchema.parse({ workspaceIds: ["a", "b", "a"] }).workspaceIds).toEqual(["a", "b"]);
    const cost = { amount: 10000, periodMonths: 1, isEndOfMonth: false };
    const snapshot = summarizeWorkspaceBudget(3000000, [cost], new Date("2026-10-07T00:00:00Z"));
    const totals = sumWorkspaceBudgets([snapshot, snapshot]);
    expect(totals.monthlyNormalizedExpense).toBe(20000);
    expect(totals).not.toHaveProperty("monthlyIncome");
  });

  test("illustrative monthly and full annual charges agree with the shared calculation", () => {
    const asOf = new Date("2026-10-06T16:00:00Z"); // Already October 7 in KST.
    const a = summarizeWorkspaceBudget(0, [{ amount: 10000, periodMonths: 1, billingAnchorDate: "2026-10-10", isEndOfMonth: false }], asOf);
    const b = summarizeWorkspaceBudget(0, [{ amount: 120000, periodMonths: 12, billingAnchorDate: "2026-10-20", isEndOfMonth: false }], asOf);
    const totals = sumWorkspaceBudgets([a, b]);
    expect(totals.monthlyNormalizedExpense).toBe(20000);
    expect(b.thirtyDayDue).toBe(120000);
    expect(totals.thirtyDayDue).toBe(130000);
  });

  test("KST exclusive end and unknown schedules are not presented as zero verified payments", () => {
    const asOf = new Date("2026-10-06T16:00:00Z");
    expect(kstThirtyDayWindow(asOf)).toMatchObject({ fromDate: "2026-10-07", untilDateExclusive: "2026-11-06" });
    const endDateCost = summarizeWorkspaceBudget(0, [{ amount: 120000, periodMonths: 12, billingAnchorDate: "2026-11-06", isEndOfMonth: false }], asOf);
    expect(endDateCost.thirtyDayDue).toBe(0);
    const unknown = summarizeWorkspaceBudget(0, [{ amount: 10000, periodMonths: 1, isEndOfMonth: false }], asOf);
    expect(sumWorkspaceBudgets([unknown])).toMatchObject({ thirtyDayDue: null, unknownScheduleCount: 1 });
    const mixed = sumWorkspaceBudgets([endDateCost, unknown]);
    expect(mixed).toMatchObject({ thirtyDayDue: 0, unknownScheduleCount: 1, knownScheduleCount: 1 });
  });
});
