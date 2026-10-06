import { z } from "zod";

// A blueprint is intentionally NOT a budget snapshot. Never add account,
// original IDs, amounts, cards, dates, history or renewal state to this contract.
const safeText = (value: string) => !/[\u0000-\u001f\u007f]|@|https?:\/\/|\d{7,}/i.test(value);
const label = z.string().trim().min(1).max(80).refine(safeText, "이메일·링크·긴 번호·제어 문자는 설계도에 넣지 마세요");
export const templateItemSchema = z.object({
  name: label,
  category: label,
  periodMonths: z.number().int().min(1).max(120)
}).strict();
export const templateBlueprintSchema = z.object({
  title: label,
  description: z.string().trim().max(600).refine(safeText),
  authorLabel: z.string().trim().max(80).refine(safeText),
  items: z.array(templateItemSchema).min(1).max(40)
}).strict();
export type TemplateBlueprint = z.infer<typeof templateBlueprintSchema>;
export const templateWriteSchema = z.object({ blueprint: templateBlueprintSchema }).strict();
export const templateUpdateSchema = templateWriteSchema.extend({ revision: z.number().int().positive() }).strict();
export const templatePublishSchema = z.object({ revision: z.number().int().positive(), reviewed: z.literal(true), rightsConfirmed: z.literal(true) }).strict();
export type OwnedTemplate = { id: string; revision: number; blueprint: TemplateBlueprint; published: boolean };
export const ownedTemplatesSchema = z.array(z.object({ id: z.string().min(1).max(100), revision: z.number().int().positive(), blueprint: templateBlueprintSchema, published: z.boolean() }).strict()).max(20);
export const templatePublishedSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string() }).strict();
export const sharedTemplateSchema = z.object({ blueprint: templateBlueprintSchema }).strict();
export const savedTemplateSchema = z.object({ id: z.string().min(1).max(100), revision: z.number().int().positive(), blueprint: templateBlueprintSchema, published: z.boolean().optional() }).strict();
export const TEMPLATE_SCENARIOS: TemplateBlueprint[] = [
  { title: "독립 생활 시작", description: "주거·공과금·통신을 빠뜨리지 않고 직접 금액을 채우는 고정비 설계도입니다.", authorLabel: "생활비 관리자", items: [
    { name: "주거 비용", category: "주거", periodMonths: 1 }, { name: "공과금", category: "주거", periodMonths: 1 }, { name: "통신 비용", category: "통신", periodMonths: 1 }
  ] },
  { title: "가족 생활비 정리", description: "가족의 반복 지출을 분류하는 시작점입니다. 공유 계정이나 개인 데이터를 포함하지 않습니다.", authorLabel: "생활비 관리자", items: [
    { name: "주거 비용", category: "주거", periodMonths: 1 }, { name: "보험 비용", category: "보험", periodMonths: 1 }, { name: "교육 비용", category: "교육", periodMonths: 1 }, { name: "교통 비용", category: "교통", periodMonths: 1 }
  ] },
  { title: "구독·연간 결제 점검", description: "월간 구독과 연간 결제를 따로 입력합니다. 월 환산액과 실제 청구액은 다릅니다.", authorLabel: "생활비 관리자", items: [
    { name: "월간 구독", category: "구독", periodMonths: 1 }, { name: "연간 구독", category: "구독", periodMonths: 12 }, { name: "업무 도구", category: "기타", periodMonths: 1 }
  ] }
];
