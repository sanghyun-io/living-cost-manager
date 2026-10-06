import { z } from "zod";

// A blueprint is intentionally NOT a budget snapshot. Never add account,
// original IDs, amounts, cards, dates, history or renewal state to this contract.

// Unicode hardening (security review 2026-10-06):
// - Validation runs against an NFKC canonical form, so fullwidth look-alikes
//   (１２３ → 123, ＠ → @, ｈｔｔｐ → http) cannot smuggle contact patterns past
//   the filter. Any Unicode decimal digit (\\p{Nd}: Arabic-Indic ٠١٢, Devanagari
//   ०१२, fullwidth digits after NFKC, …) is folded to '0' before the long-number
//   run check, so digit runs are measured across scripts.
// - Invisible formatting is rejected, not stripped: C0/C1 controls (\\p{Cc}) and
//   the entire format-control category (\\p{Cf}: zero-width marks, bidi
//   embeddings U+202A–U+202E, bidi isolates U+2066–U+2069, BOM U+FEFF, soft
//   hyphen, word joiner, interlinear marks). This stops truncation and
//   reordering tricks (e.g. splitting a digit run with a zero-width space).
// - Emoji ZWJ sequences are a deliberate exception inside \\p{Cf}: U+200D is
//   allowed only when it actually joins pictographic characters (👩‍👩‍👧 and
//   ❤️‍🔥 stay writable); a ZWJ next to plain text ("a\u200db") is rejected as
//   an invisible smuggle. Korean letters, middots and emoji carry no Cf and
//   pass unchanged, which is why rejection (not stripping) keeps author text.
// - Max lengths are enforced on the canonical form too, because NFKC can expand
//   a string (﷼ → ريال): raw-length compliance must not smuggle a longer
//   rendered/normalized payload through.
// Accepted text is stored exactly as authored (trimmed): canonicalization is a
// validation view that preserves the author's display choices, not a rewrite.
// This is a defense-in-depth filter for common contact/number/control patterns.
// It does NOT detect every phone number or email, does not defeat homoglyphs
// outside NFKC pairs, and does not anonymize anything — the author's explicit
// review remains the control that keeps personal data out of public blueprints.
const ZWJ = "\u200D";
const FORBIDDEN_UNICODE = /[\p{Cc}\p{Cf}]/u;
const PICTOGRAPHIC_OR_VS16 = /[\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export function canonicalizeTemplateText(value: string): string {
  return value.normalize("NFKC").replace(/\p{Nd}/gu, "0");
}

function zwjOutsideEmojiSequence(canonical: string): boolean {
  if (!canonical.includes(ZWJ)) return false;
  const codepoints = Array.from(canonical);
  for (let index = 0; index < codepoints.length; index++) {
    if (codepoints[index] !== ZWJ) continue;
    const before = codepoints[index - 1] ?? "";
    const after = codepoints[index + 1] ?? "";
    if (!before || !after) return true;
    if (!PICTOGRAPHIC_OR_VS16.test(before) || !PICTOGRAPHIC.test(after)) return true;
  }
  return false;
}

const safeText = (value: string) => {
  const canonical = canonicalizeTemplateText(value);
  // Any control/format character except the ZWJ itself is an instant reject;
  // ZWJ is then judged separately (allowed only inside emoji sequences).
  if (FORBIDDEN_UNICODE.test(canonical.replaceAll(ZWJ, ""))) return false;
  if (zwjOutsideEmojiSequence(canonical)) return false;
  return !/@|https?:\/\/|\d{7,}/i.test(canonical);
};
const label = (max: number, min: boolean) => {
  const base = z.string().trim().max(max).refine(value => canonicalizeTemplateText(value).length <= max, "설계도 텍스트는 너무 깁니다").refine(safeText, "이메일·링크·긴 번호·제어 문자는 설계도에 넣지 마세요");
  return min ? base.refine(value => value.length >= 1, "설계도 텍스트는 비어 있을 수 없습니다") : base;
};
export const templateItemSchema = z.object({
  name: label(80, true),
  category: label(80, true),
  periodMonths: z.number().int().min(1).max(120)
}).strict();
export const templateBlueprintSchema = z.object({
  title: label(80, true),
  description: label(600, false),
  // Public author display name is OPTIONAL (main decision 2026-10-06; matches
  // base 81bc64a and the UI's "빈 설계도" flow): we do not collect creator
  // identity. Blank is legitimate and needs no safety exception; when present
  // the same NFKC/PII-control validation applies as every other field.
  authorLabel: label(80, false),
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
