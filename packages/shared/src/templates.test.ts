import { describe, expect, test } from "vitest";
import { TEMPLATE_SCENARIOS, templateBlueprintSchema, templatePublishSchema } from "./templates.js";
describe("strict blueprint contract", () => {
  test("three original presets contain only an unset financial structure", () => {
    expect(TEMPLATE_SCENARIOS).toHaveLength(3);
    for (const blueprint of TEMPLATE_SCENARIOS) expect(templateBlueprintSchema.parse(blueprint)).toEqual(blueprint);
  });
  test.each(["id", "originalId", "userId", "workspaceId", "email", "monthlyIncome", "amount", "cards", "history", "billingDay", "isEndOfMonth", "billingAnchorDate", "renewalStatus", "potentialMonthlySavings", "confirmedMonthlySavings"])("rejects %s at root and item, not silently stripping", field => {
    const blueprint = TEMPLATE_SCENARIOS[0];
    expect(templateBlueprintSchema.safeParse({ ...blueprint, [field]: "private" }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, items: [{ ...blueprint.items[0], [field]: "private" }] }).success).toBe(false);
  });
  test.each(["person@example.com", "https://private.example", "1234567890123456"])("refuses obvious contact/number pattern %s in prepared labels", name => {
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], authorLabel: name }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], items: [{ name, category: "기타", periodMonths: 1 }] }).success).toBe(false);
  });
  test("bounds item counts, label lengths and integer periods", () => {
    const blueprint = TEMPLATE_SCENARIOS[0];
    expect(templateBlueprintSchema.safeParse({ ...blueprint, items: [] }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, items: Array(41).fill(blueprint.items[0]) }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, title: "a".repeat(81) }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, items: [{ ...blueprint.items[0], periodMonths: 1.5 }] }).success).toBe(false);
  });
  test("requires both explicit publication confirmations", () => {
    expect(templatePublishSchema.safeParse({ revision: 1, reviewed: true, rightsConfirmed: true }).success).toBe(true);
    expect(templatePublishSchema.safeParse({ revision: 1, reviewed: false, rightsConfirmed: true }).success).toBe(false);
    expect(templatePublishSchema.safeParse({ revision: 1, reviewed: true }).success).toBe(false);
  });
});
