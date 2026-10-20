import { describe, expect, test } from "vitest";
import {
  DEFAULT_UI_THEME,
  UI_THEME_IDS,
  normalizeStoredUiTheme,
  uiThemeSchema,
  updateThemeRequestSchema
} from "./userTheme.js";

describe("user UI theme contract", () => {
  test("ids are the approved five with jade as the default", () => {
    expect(UI_THEME_IDS).toEqual(["jade", "aqua", "violet", "raspberry", "tangerine"]);
    expect(DEFAULT_UI_THEME).toBe("jade");
    expect(UI_THEME_IDS).toContain(DEFAULT_UI_THEME);
  });

  test("every approved id round-trips through the enum", () => {
    for (const id of UI_THEME_IDS) {
      expect(uiThemeSchema.parse(id)).toBe(id);
      expect(normalizeStoredUiTheme(id)).toBe(id);
    }
  });

  test("request contract rejects invalid enum values (reject, never coerce)", () => {
    for (const invalid of ["blue", "JADE", "jade ", "", "planned", "null", "undefined"]) {
      expect(updateThemeRequestSchema.safeParse({ uiTheme: invalid }).success).toBe(false);
    }
    expect(updateThemeRequestSchema.safeParse({}).success).toBe(false);
    expect(updateThemeRequestSchema.safeParse({ uiTheme: null }).success).toBe(false);
    expect(updateThemeRequestSchema.safeParse({ theme: "jade" }).success).toBe(false);
  });

  test("request contract is strict: unknown keys including userId are rejected", () => {
    expect(updateThemeRequestSchema.safeParse({ uiTheme: "jade", userId: "victim" }).success).toBe(false);
    expect(updateThemeRequestSchema.safeParse({ uiTheme: "jade", workspaceId: "ws" }).success).toBe(false);
    expect(updateThemeRequestSchema.safeParse({ uiTheme: "jade", extra: 1 }).success).toBe(false);
  });

  test("stored-value normalization falls back to jade for anything unknown (never throws)", () => {
    for (const corrupt of [null, undefined, 42, {}, [], "legacy-invalid", "", "TANGERINE"]) {
      expect(normalizeStoredUiTheme(corrupt)).toBe(DEFAULT_UI_THEME);
    }
  });

  test("userDtoSchema accepts additive uiTheme and keeps old server payloads valid", async () => {
    const { userDtoSchema } = await import("./auth.js");
    expect(userDtoSchema.safeParse({ id: "u1", email: "u-theme@example.invalid", name: "n", uiTheme: "aqua" }).success).toBe(true);
    // pre-rollout payloads without the field still parse
    expect(userDtoSchema.safeParse({ id: "u1", email: "u-theme@example.invalid", name: "n" }).success).toBe(true);
    expect(userDtoSchema.safeParse({ id: "u1", email: "u-theme@example.invalid", name: "n", uiTheme: "magenta" }).success).toBe(false);
  });
});
