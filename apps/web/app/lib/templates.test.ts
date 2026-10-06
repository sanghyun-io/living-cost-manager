import { describe, expect, test } from "vitest";
import { TEMPLATE_SCENARIOS } from "@living-cost-manager/shared";
import { buildTemplateBudget, persistTemplateProfile } from "./templates";
import { ACTIVE_USER_KEY, USERS_KEY } from "./storage";
import { getUserDataKey } from "./users";
const blueprint = TEMPLATE_SCENARIOS[0];
function fixture(fail?: string) {
  const data = new Map<string, string>([[USERS_KEY, JSON.stringify([{ id: "original", name: "Original" }])], [ACTIVE_USER_KEY, "original"], [getUserDataKey("original"), '{"financial":"DO NOT CHANGE"}']]);
  return { data, storage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { if (key === fail) throw new Error("quota"); data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } as Storage };
}
describe("template application never overwrites a personal profile", () => {
  test("unset values are not zero; only explicit numeric values are accepted", () => {
    expect(() => buildTemplateBudget(blueprint, ["", "100", "100"], "0")).toThrow();
    expect(() => buildTemplateBudget(blueprint, ["0", "0", "0"], "")).toThrow();
    expect(buildTemplateBudget(blueprint, ["0", "0", "0"], "0").fixedCosts.every(item => item.amount === 0)).toBe(true);
    expect(() => buildTemplateBudget(blueprint, ["2147483648", "0", "0"], "0")).toThrow();
  });
  test("every apply creates fresh local IDs, unknown schedules and reset review state", () => {
    const first = buildTemplateBudget(blueprint, ["120000", "0", "0"], "2000000");
    const second = buildTemplateBudget(blueprint, ["120000", "0", "0"], "2000000");
    expect(first.fixedCosts[0].id).not.toBe(second.fixedCosts[0].id);
    expect(first.categories[0].id).not.toBe(second.categories[0].id);
    expect(first.cards).toEqual([]);
    expect(first.fixedCosts[0]).toMatchObject({ billingAnchorDate: null, isEndOfMonth: false, renewalStatus: "unreviewed", potentialMonthlySavings: 0, confirmedMonthlySavings: 0, paymentMethodId: "other", paymentOptionId: "" });
  });
  test("preserves original bytes and creates a separate profile with a reload-safe return pointer", () => {
    const { storage, data } = fixture();
    const original = data.get(getUserDataKey("original"));
    const result = persistTemplateProfile(storage, blueprint, buildTemplateBudget(blueprint, ["1", "2", "3"], "0"));
    expect(result.user.templateReturnId).toBe("original");
    expect(data.get(ACTIVE_USER_KEY)).toBe(result.user.id);
    expect(data.get(getUserDataKey("original"))).toBe(original);
    expect(JSON.parse(data.get(USERS_KEY)!).length).toBe(2);
  });
  test.each([USERS_KEY, ACTIVE_USER_KEY])("quota at %s leaves original active/data and cleans our new profile", key => {
    const { storage, data } = fixture(key); const before = new Map(data);
    expect(() => persistTemplateProfile(storage, blueprint, buildTemplateBudget(blueprint, ["1", "2", "3"], "0"))).toThrow();
    expect(data).toEqual(before);
  });
  test("refuses malformed user registry rather than discarding it", () => {
    const { storage, data } = fixture(); data.set(USERS_KEY, '{"corrupt":true}');
    expect(() => persistTemplateProfile(storage, blueprint, buildTemplateBudget(blueprint, ["1", "2", "3"], "0"))).toThrow();
    expect(data.get(ACTIVE_USER_KEY)).toBe("original");
  });
  test("failed explicit disconnect does not publish a new active pointer or change the original budget", () => {
    const { storage, data } = fixture(); const before = new Map(data);
    expect(() => persistTemplateProfile(storage, blueprint, buildTemplateBudget(blueprint, ["1", "2", "3"], "0"), () => { throw new Error("disconnect failed"); })).toThrow();
    expect(data).toEqual(before);
  });
  test("racing profile/registry changes are not rolled back to a stale registry", () => {
    const { storage, data } = fixture(); const original = data.get(getUserDataKey("original"));
    const registry = JSON.stringify([{ id: "original", name: "Original" }, { id: "external", name: "External" }]);
    expect(() => persistTemplateProfile(storage, blueprint, buildTemplateBudget(blueprint, ["1", "2", "3"], "0"), () => { data.set(USERS_KEY, registry); data.set(ACTIVE_USER_KEY, "external"); })).toThrow();
    expect(data.get(ACTIVE_USER_KEY)).toBe("external"); expect(data.get(USERS_KEY)).toBe(registry);
    expect(data.get(getUserDataKey("original"))).toBe(original);
    expect([...data.keys()].some(key => key.includes("template-"))).toBe(false);
  });
});
