import { z } from "zod";

/**
 * Personal UI theme preference contract (single source of truth for API,
 * persistence and frontend). Deliberately a TEXT id list with SQL CHECKs, not
 * a Prisma enum — mirrors the product-tour/renewalStatus precedent so adding a
 * future id is one additive migration, not an enum rewrite.
 */
export const UI_THEME_IDS = ["jade", "aqua", "violet", "raspberry", "tangerine"] as const;

export const uiThemeSchema = z.enum(UI_THEME_IDS);
export type UiTheme = z.infer<typeof uiThemeSchema>;

/**
 * Default for new rows AND the read-side fallback for missing/invalid stored
 * values (legacy/corrupt rows are never mutated by a GET).
 */
export const DEFAULT_UI_THEME: UiTheme = "jade";

/**
 * Request contract for PUT /me/theme: strictly one key. Unknown keys —
 * including a client-supplied `userId` — are rejected (400). Identity always
 * comes from the verified token subject, never from the body.
 */
export const updateThemeRequestSchema = z.object({ uiTheme: uiThemeSchema }).strict();
export type UpdateThemeRequest = z.infer<typeof updateThemeRequestSchema>;

/**
 * Read-side normalization for stored values only: any missing/non-string/
 * unknown id maps to DEFAULT_UI_THEME. This is intentionally NOT for request
 * validation — invalid requests must be rejected via updateThemeRequestSchema,
 * while invalid stored data falls back without a write.
 */
export function normalizeStoredUiTheme(value: unknown): UiTheme {
  return typeof value === "string" && (UI_THEME_IDS as readonly string[]).includes(value)
    ? (value as UiTheme)
    : DEFAULT_UI_THEME;
}
