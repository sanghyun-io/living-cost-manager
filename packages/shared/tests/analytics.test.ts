import { describe, expect, test } from "vitest";
import {
  ANALYTICS_EVENT_LABELS,
  ANALYTICS_EVENT_TYPES,
  analyticsEventSchema
} from "../src/index.js";

// 온디바이스 애널리틱스 이벤트 스키마 검증.
// 저장/집계 로직은 apps/web(lib/analytics) 것이고, 이곳의 계약은
// "어떤 이벤트가 합법인가" 이다 — union 타입과 zod 스키마가 어긋나면
// 이 테스트와 shared 빌드(_schemaMatchesAnalyticsEvent)가 동시에 잡는다.

function makePageView(overrides: Record<string, unknown> = {}) {
  return { type: "app.page_view", timestamp: 1_700_000_000_000, data: { path: "/" }, ...overrides };
}

describe("analyticsEventSchema — 유효 이벤트", () => {
  test("선언된 모든 이벤트 타입이 파싱된다", () => {
    const valid: unknown[] = [
      { type: "app.page_view", timestamp: 1, data: { path: "/x" } },
      { type: "budget.fixed_cost_add", timestamp: 1, data: { categoryId: "housing", amount: 650000 } },
      { type: "budget.fixed_cost_delete", timestamp: 1, data: { categoryId: "housing" } },
      { type: "budget.category_create", timestamp: 1, data: {} },
      { type: "budget.card_create", timestamp: 1, data: {} },
      { type: "auth.login", timestamp: 1, data: { method: "local" } },
      { type: "auth.login", timestamp: 1, data: { method: "server" } },
      { type: "auth.register", timestamp: 1, data: {} },
      { type: "auth.logout", timestamp: 1, data: {} },
      { type: "sync.push", timestamp: 1, data: { workspaceId: "ws-1" } },
      { type: "sync.pull", timestamp: 1, data: { workspaceId: "ws-1" } },
      { type: "coach.request", timestamp: 1, data: {} },
      { type: "export.csv", timestamp: 1, data: {} },
      { type: "export.backup", timestamp: 1, data: {} },
      { type: "share.invite", timestamp: 1, data: { role: "editor" } },
      { type: "share.accept", timestamp: 1, data: {} }
    ];

    for (const event of valid) {
      expect(analyticsEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });

  test("ANALYTICS_EVENT_TYPES 와 ANALYTICS_EVENT_LABELS 가 union 키와 정확히 일치한다", () => {
    // 라벨 키 집합 = 타입 목록 집합 (대시보드가 타입별 한글 라벨을 보장받는다).
    expect(new Set(Object.keys(ANALYTICS_EVENT_LABELS))).toEqual(new Set(ANALYTICS_EVENT_TYPES));
    expect(ANALYTICS_EVENT_TYPES.length).toBe(15);
  });
});

describe("analyticsEventSchema — 거부 이벤트", () => {
  test("미등록 이벤트 타입은 거부된다", () => {
    expect(analyticsEventSchema.safeParse(makePageView({ type: "budget.item_edit" })).success).toBe(false);
  });

  test("타입에 맞지 않는 data 는 거부된다", () => {
    // Sensitive fields are no longer required (or retained).
    expect(analyticsEventSchema.safeParse({ type: "app.page_view", timestamp: 1, data: {} }).success).toBe(true);
    expect(
      analyticsEventSchema.safeParse({ type: "budget.fixed_cost_add", timestamp: 1, data: { categoryId: "a" } }).success
    ).toBe(true);
    // auth.login method 는 local | server 뿐
    expect(analyticsEventSchema.safeParse({ type: "auth.login", timestamp: 1, data: { method: "oauth" } }).success).toBe(false);
    expect(analyticsEventSchema.safeParse({ type: "sync.push", timestamp: 1, data: {} }).success).toBe(true);
  });

  test("timestamp 가 수가 아니거나 누락되면 거부된다", () => {
    expect(analyticsEventSchema.safeParse({ type: "app.page_view", data: { path: "/" } }).success).toBe(false);
    expect(analyticsEventSchema.safeParse(makePageView({ timestamp: "now" })).success).toBe(false);
  });

  test("data 가 객체가 아니거나 누락되면 거부된다", () => {
    expect(analyticsEventSchema.safeParse({ type: "export.csv", timestamp: 1 }).success).toBe(false);
    expect(analyticsEventSchema.safeParse({ type: "export.csv", timestamp: 1, data: "csv" }).success).toBe(false);
  });
});

describe("analyticsEventSchema — 개인정보 최소화", () => {
  test.each(["budget.fixed_cost_add", "budget.fixed_cost_delete", "sync.push", "sync.pull", "app.page_view", "share.invite"])("%s strips sensitive legacy fields", (type) => {
    const parsed = analyticsEventSchema.parse({ type, timestamp: 1, data: {
      amount: 1000, categoryId: "private", workspaceId: "private", path: "/?secret", role: "free text"
    } });
    expect(parsed.data).toEqual({});
  });
  test("미지의 data 키는 parse 결과에서 strip 된다 (저장소로 새지 않게)", () => {
    const parsed = analyticsEventSchema.parse({
      type: "budget.category_create",
      timestamp: 1,
      data: { secretLabel: "월세 65만", note: "자유 메모" }
    });

    expect(parsed).toEqual({ type: "budget.category_create", timestamp: 1, data: {} });
  });
});
