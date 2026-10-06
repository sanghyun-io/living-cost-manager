import { describe, expect, test } from "vitest";
import { canonicalizeTemplateText, TEMPLATE_SCENARIOS, templateBlueprintSchema, templatePublishSchema } from "./templates.js";
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
  test.each([
    ["fullwidth digits", "\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17"],
    ["arabic-indic digits", "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669"],
    ["devanagari digits", "\u0966\u0967\u0968\u0969\u096A\u096B\u096C"],
    ["mathematical digits", "\u{1D7D8}\u{1D7D9}\u{1D7DA}\u{1D7DB}\u{1D7DC}\u{1D7DD}\u{1D7DE}"],
    ["fullwidth email", "person\uFF20example.com"],
    ["fullwidth url", "\uFF48\uFF54\uFF54\uFF50://evil.example"],
    ["zero-width-split digit run", "123\u200B456\u200B789"],
    ["bidi override marker", "\u202Eabc"],
    ["bidi isolate LRI", "\u2066abc"],
    ["bom mid-text", "x\uFEFFy"],
    ["soft hyphen", "exa\u00ADmple"],
    ["c1 next line", "a\u0085b"],
    ["del control", "a\u007Fb"],
    ["zwj around plain text", "a\u200Db"]
  ])("rejects %s after unicode canonicalization", (_label, value) => {
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], authorLabel: value }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], items: [{ name: value, category: "기타", periodMonths: 1 }] }).success).toBe(false);
  });
  test.each([
    ["korean labels with middots", "월공과금·주거"],
    ["emoji zwj family", "\u{1F469}\u200D\u{1F469}\u200D\u{1F467} 가족"],
    ["emoji presentation zwj", "\u2764\uFE0F\u200D\u{1F525}"],
    ["flag and skin tone (no zwj)", "\u{1F1F0}\u{1F1F7}\u{1F44D}\u{1F3FB}"]
  ])("accepts %s (no false rejects on authored text)", (_label, value) => {
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], authorLabel: value }).success).toBe(true);
  });
  test("author text is preserved verbatim, not silently rewritten to its canonical form", () => {
    const parsed = templateBlueprintSchema.parse({ ...TEMPLATE_SCENARIOS[0], authorLabel: "  \u{1F469}\u200D\u{1F469}\u200D\u{1F467} 가족  " });
    expect(parsed.authorLabel).toBe("\u{1F469}\u200D\u{1F469}\u200D\u{1F467} 가족"); // only the pre-existing trim applies
    const fullwidth = templateBlueprintSchema.parse({ ...TEMPLATE_SCENARIOS[0], authorLabel: "\uFF26\uFF41\uFF4D\uFF49\uFF4C\uFF59" });
    expect(fullwidth.authorLabel).toBe("\uFF26\uFF41\uFF4D\uFF49\uFF4C\uFF59"); // authored display kept…
    expect(canonicalizeTemplateText(fullwidth.authorLabel)).toBe("Family"); // …canonical form is validation-only
  });
  test("max length is enforced on the NFKC canonical form, not just the raw payload", () => {
    expect("\uFDFC".repeat(30).length).toBe(30); // raw form fits under 80…
    expect(canonicalizeTemplateText("\uFDFC".repeat(30)).length).toBeGreaterThan(80); // …canonical expansion does not
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], title: "\uFDFC".repeat(30) }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], title: "\uFDFC".repeat(20) }).success).toBe(true);
  });
  test("author display name is optional (blank allowed) while other labels stay required", () => {
    const blueprint = TEMPLATE_SCENARIOS[0];
    expect(templateBlueprintSchema.safeParse({ ...blueprint, authorLabel: "" }).success).toBe(true);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, authorLabel: "   " }).success).toBe(true); // trims to blank, not min(1) failure
    const parsed = templateBlueprintSchema.parse({ ...blueprint, authorLabel: "  " });
    expect(parsed.authorLabel).toBe("");
    expect(templateBlueprintSchema.safeParse({ ...blueprint, title: "" }).success).toBe(false);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, items: [{ name: "", category: "기타", periodMonths: 1 }] }).success).toBe(false);
    // Optional does not mean unvalidated: non-empty author text still passes the unicode/PII filter.
    expect(templateBlueprintSchema.safeParse({ ...blueprint, authorLabel: "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}" }).success).toBe(true);
    expect(templateBlueprintSchema.safeParse({ ...blueprint, authorLabel: "person\uFF20example.com" }).success).toBe(false);
  });
  test("leading/trailing whitespace-class controls are removed by trim, interior ones rejected", () => {
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], title: "\uFEFF독립 생활" }).success).toBe(true); // trimmed away
    expect(templateBlueprintSchema.safeParse({ ...TEMPLATE_SCENARIOS[0], title: "독립\u200B\uFEFF\u200B생활" }).success).toBe(false);
  });
});
