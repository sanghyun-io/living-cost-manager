import { describe, expect, test } from "vitest";
import { compareServicePrices, previewServicePrice, SERVICE_PRICING, servicePricingCopy } from "../src/servicePricing.js";

describe("LCM preparation pricing", () => {
  test("quotes exact integer KRW totals, not the annual monthly equivalent", () => {
    expect(previewServicePrice({ planId: "monthly" })).toMatchObject({ totalAmount: 990, periodMonths: 1, currency: "KRW" });
    expect(previewServicePrice({ planId: "annual" })).toMatchObject({ totalAmount: 9900, periodMonths: 12, currency: "KRW" });
    for (const planId of ["monthly", "annual"]) expect(Number.isSafeInteger(previewServicePrice({ planId }).totalAmount)).toBe(true);
  });

  test("annual price versus twelve monthly payments saves exactly one sixth, not 20%", () => {
    expect(compareServicePrices()).toEqual({ monthlyForYear: 11880, annualTotal: 9900, annualMonthlyEquivalent: 825, annualSavings: 1980, discountFraction: 1 / 6 });
  });

  test.each([
    null, undefined, [], {}, { planId: "toString" }, { planId: "free" }, { planId: 1 },
    { planId: "monthly", amount: 1 }, { planId: "annual", totalAmount: 825 },
    { planId: "monthly", currency: "USD" }, { planId: "monthly", discount: 100 },
    { planId: "annual", checkoutEnabled: true }, { planId: "annual", consent: true }
  ])("rejects invalid IDs and client-authoritative fields: %j", (request) => {
    expect(() => previewServicePrice(request)).toThrow();
  });

  test("preview cannot enable payment, claim consent, or grant paid access", () => {
    for (const planId of ["monthly", "annual"]) {
      const preview = previewServicePrice({ planId });
      expect(preview).toMatchObject({ availability: "planned", checkoutEnabled: false, taxTreatment: "vat-inclusive-assumption-unverified" });
      expect(preview).not.toHaveProperty("entitlement");
      expect(preview).not.toHaveProperty("consent");
      expect(Object.isFrozen(preview)).toBe(true);
    }
    expect(Object.isFrozen(SERVICE_PRICING)).toBe(true);
    expect(Object.isFrozen(SERVICE_PRICING.monthly)).toBe(true);
    expect(Object.isFrozen(SERVICE_PRICING.annual)).toBe(true);
  });

  test.each(["monthly", 990, true, ["monthly"], [{ planId: "monthly" }]])("rejects primitive or array requests: %j", request => {
    expect(() => previewServicePrice(request)).toThrow();
  });

  test("rejects own __proto__ and other unknown own keys", () => {
    const ownProto = JSON.parse('{"planId":"monthly","__proto__":{"checkoutEnabled":true}}');
    expect(Object.hasOwn(ownProto, "__proto__")).toBe(true);
    expect(() => previewServicePrice(ownProto)).toThrow();
    for (const key of ["constructor", "prototype", "toString"]) {
      expect(() => previewServicePrice({ planId: "annual", [key]: true })).toThrow();
    }
    expect(() => previewServicePrice(Object.create({ planId: "monthly" }))).toThrow();
    expect(() => previewServicePrice({ planId: "annual", [Symbol("amount")]: 1 })).toThrow();
  });

  test("guide and FAQ share factual price, availability and tax copy", () => {
    expect(servicePricingCopy()).toMatchObject({ monthly: "월 990원", annual: "연 9,900원" });
    expect(servicePricingCopy().comparison).toContain("월별 결제 금액이 아닙니다");
    expect(servicePricingCopy().availability).toContain("현재 구매할 수 없습니다");
    expect(servicePricingCopy().tax).toContain("가격안");
  });
});
