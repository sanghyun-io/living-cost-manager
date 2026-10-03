import { z } from "zod";

// 온디바이스 애널리틱스 이벤트 스키마.
//
// 원칙(코치의 WebGPU 철학과 동일): 이벤트는 사용자 브라우저에만 저장된다.
// 이 모듈은 "무엇을 수집하는가"만 정의하고, 전송 레이어는 존재하지 않는다.
// 이벤트 타입별로 data 필드를 좁혀 정의하면, 저장소에 의도치 않은 개인정보
// (이름·메모 등)가 실려 들어가는 것을 zod 파싱 단계에서 원천 차단할 수 있다
// (z.object 는 미지의 키를 기본 strip 한다).

const timestampSchema = z.number().finite();

export const analyticsEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("app.page_view"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("budget.fixed_cost_add"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("budget.fixed_cost_delete"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("budget.category_create"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("budget.card_create"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("auth.login"),
    timestamp: timestampSchema,
    data: z.object({ method: z.enum(["local", "server"]) }),
  }),
  z.object({
    type: z.literal("auth.register"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("auth.logout"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("sync.push"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("sync.pull"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("coach.request"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("export.csv"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("export.backup"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("share.invite"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
  z.object({
    type: z.literal("share.accept"),
    timestamp: timestampSchema,
    data: z.object({}),
  }),
]);

/**
 * Legacy call-site input. Sensitive fields are accepted only for compatibility;
 * analyticsEventSchema strips them before storage, reads and export.
 */
export type AnalyticsEventInput =
  | { type: "app.page_view"; timestamp: number; data: { path: string } }
  | { type: "budget.fixed_cost_add"; timestamp: number; data: { categoryId: string; amount: number } }
  | { type: "budget.fixed_cost_delete"; timestamp: number; data: { categoryId: string } }
  | { type: "budget.category_create"; timestamp: number; data: {} }
  | { type: "budget.card_create"; timestamp: number; data: {} }
  | { type: "auth.login"; timestamp: number; data: { method: "local" | "server" } }
  | { type: "auth.register"; timestamp: number; data: {} }
  | { type: "auth.logout"; timestamp: number; data: {} }
  | { type: "sync.push"; timestamp: number; data: { workspaceId: string } }
  | { type: "sync.pull"; timestamp: number; data: { workspaceId: string } }
  | { type: "coach.request"; timestamp: number; data: {} }
  | { type: "export.csv"; timestamp: number; data: {} }
  | { type: "export.backup"; timestamp: number; data: {} }
  | { type: "share.invite"; timestamp: number; data: { role: string } }
  | { type: "share.accept"; timestamp: number; data: {} };

export type SanitizedAnalyticsEvent = z.infer<typeof analyticsEventSchema>;
export type AnalyticsEvent = SanitizedAnalyticsEvent;

/** 대시보드·설정 UI가 쓰는 이벤트 타입별 한글 라벨 (표시 전용). */
export const ANALYTICS_EVENT_LABELS: Record<AnalyticsEvent["type"], string> = {
  "app.page_view": "화면 방문",
  "budget.fixed_cost_add": "고정비 추가",
  "budget.fixed_cost_delete": "고정비 삭제",
  "budget.category_create": "카테고리 생성",
  "budget.card_create": "카드 등록",
  "auth.login": "로그인",
  "auth.register": "새 사용자/가입",
  "auth.logout": "로그아웃",
  "sync.push": "서버 동기화(올리기)",
  "sync.pull": "서버 데이터 불러오기",
  "coach.request": "AI 코치 요청",
  "export.csv": "CSV 내보내기",
  "export.backup": "전체 백업 내보내기",
  "share.invite": "공유 초대",
  "share.accept": "초대 수락",
};

/** 이벤트 타입 목록 (검증·UI에서 union 의 키를 런타임 값으로 쓸 때). */
export const ANALYTICS_EVENT_TYPES = [
  "app.page_view",
  "budget.fixed_cost_add",
  "budget.fixed_cost_delete",
  "budget.category_create",
  "budget.card_create",
  "auth.login",
  "auth.register",
  "auth.logout",
  "sync.push",
  "sync.pull",
  "coach.request",
  "export.csv",
  "export.backup",
  "share.invite",
  "share.accept",
] as const satisfies readonly AnalyticsEvent["type"][];
