import { z } from "zod";

// LCM's own service price, not a user's tracked subscription expense.
// This is a preparation catalog, never payment authorization or entitlement.
// Never flip checkoutEnabled alone: merchant/legal/tax/security gates and the
// planned-only copy must be reviewed together before any production checkout.
export const SERVICE_PRICING = Object.freeze({
  version: "lcm-990-9900-preparation-v1",
  currency: "KRW",
  availability: "planned",
  checkoutEnabled: false,
  taxTreatment: "vat-inclusive-assumption-unverified",
  monthly: Object.freeze({ id: "monthly", amount: 990, periodMonths: 1 }),
  annual: Object.freeze({ id: "annual", amount: 9900, periodMonths: 12 })
} as const);

const previewRequestSchema = z.strictObject({ planId: z.enum(["monthly", "annual"]) });

/** Accept only a catalog ID. Client prices/currency/discounts are rejected. */
export function previewServicePrice(input: unknown) {
  // Zod's object parser may ignore a JSON own __proto__ key. Inspect the raw
  // own-key set before parsing so every client-authoritative field fails closed.
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
      !Object.hasOwn(input, "planId") || Reflect.ownKeys(input).length !== 1) {
    throw new TypeError("Price preview requires only an own planId field");
  }
  const { planId } = previewRequestSchema.parse(input);
  const plan = SERVICE_PRICING[planId];
  return Object.freeze({
    catalogVersion: SERVICE_PRICING.version,
    planId,
    currency: SERVICE_PRICING.currency,
    totalAmount: plan.amount,
    periodMonths: plan.periodMonths,
    availability: SERVICE_PRICING.availability,
    checkoutEnabled: SERVICE_PRICING.checkoutEnabled,
    taxTreatment: SERVICE_PRICING.taxTreatment
  });
}

export function compareServicePrices() {
  const monthlyForYear = SERVICE_PRICING.monthly.amount * 12;
  const annualTotal = SERVICE_PRICING.annual.amount;
  return Object.freeze({
    monthlyForYear,
    annualTotal,
    annualMonthlyEquivalent: annualTotal / 12,
    annualSavings: monthlyForYear - annualTotal,
    discountFraction: (monthlyForYear - annualTotal) / monthlyForYear
  });
}

const krw = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;
export function servicePricingCopy() {
  const comparison = compareServicePrices();
  return Object.freeze({
    monthly: `월 ${krw(SERVICE_PRICING.monthly.amount)}`,
    annual: `연 ${krw(SERVICE_PRICING.annual.amount)}`,
    comparison: `월간 요금을 12번 내면 ${krw(comparison.monthlyForYear)}, 연간 요금은 ${krw(comparison.annualTotal)}입니다. 연간 기준 ${krw(comparison.annualSavings)} 차이이며 약 ${(comparison.discountFraction * 100).toFixed(1)}% 낮습니다. 연간 요금의 월환산은 ${krw(comparison.annualMonthlyEquivalent)}이고, 월별 결제 금액이 아닙니다.`,
    availability: "유료 요금은 준비 중이며 현재 구매할 수 없습니다. 카드 등록·결제·자동 갱신은 시작되지 않습니다.",
    tax: "부가세 포함을 기준으로 준비 중인 가격안입니다. 최종 요금과 제공 범위, 세금 처리, 갱신·해지·환불 조건은 확정 후 별도로 안내합니다.",
    free: "현재 로컬 대시보드는 결제 없이 이용할 수 있습니다. 로그인 없이 고정비와 기준일을 등록하고 갱신 결정을 기록해 보세요."
  });
}
