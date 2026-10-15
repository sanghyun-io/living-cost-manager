import { describe, expect, test } from "vitest";
import {
  coachingPreferencesSchema,
  protectedCoachingItemsSchema,
  putCoachingPreferencesSchema,
  getActiveProtectedFixedCostIds,
  type CoachingPreferences,
  type ProtectedCoachingItem
} from "../src/coachingPreferences.js";

describe("coachingPreferences edge cases", () => {
  describe("schema validation boundaries", () => {
    test("empty protectedItems array is valid", () => {
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(true);
    });

    test("revision at max int32 boundary", () => {
      const prefs = { schemaVersion: 1, revision: 2147483647, protectedItems: [] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(true);
    });

    test("revision exceeding max int32 fails", () => {
      const prefs = { schemaVersion: 1, revision: 2147483648, protectedItems: [] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("negative revision fails", () => {
      const prefs = { schemaVersion: 1, revision: -1, protectedItems: [] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("non-integer revision fails", () => {
      const prefs = { schemaVersion: 1, revision: 1.5, protectedItems: [] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("fixedCostId at max length (200 chars)", () => {
      const longId = "a".repeat(200);
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: longId }] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(true);
    });

    test("fixedCostId exceeding max length fails", () => {
      const longId = "a".repeat(201);
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: longId }] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("empty fixedCostId fails", () => {
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: "" }] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("max 1000 items boundary", () => {
      const items = Array.from({ length: 1000 }, (_, i) => ({ fixedCostId: `id-${i}` }));
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: items };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(true);
    });

    test("exceeding 1000 items fails", () => {
      const items = Array.from({ length: 1001 }, (_, i) => ({ fixedCostId: `id-${i}` }));
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: items };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("all three reason enum values are valid", () => {
      for (const reason of ["essential", "contract", "personal"] as const) {
        const prefs = { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: "a", reason }] };
        expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(true);
      }
    });

    test("invalid reason string fails", () => {
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: "a", reason: "invalid" }] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("strict mode rejects unknown fields", () => {
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [], unknownField: true };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("strict mode rejects unknown fields in protectedItem", () => {
      const prefs = { schemaVersion: 1, revision: 0, protectedItems: [{ fixedCostId: "a", unknownField: true }] };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });
  });

  describe("duplicate detection", () => {
    test("duplicate fixedCostId in protectedItems fails", () => {
      const prefs = {
        schemaVersion: 1,
        revision: 0,
        protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "a" }]
      };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(false);
    });

    test("different fixedCostIds pass", () => {
      const prefs = {
        schemaVersion: 1,
        revision: 0,
        protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "b" }]
      };
      expect(coachingPreferencesSchema.safeParse(prefs).success).toBe(true);
    });
  });

  describe("putCoachingPreferencesSchema expectedRevision", () => {
    test("expectedRevision at max int32 - 1 boundary", () => {
      const put = { schemaVersion: 1, expectedRevision: 2147483646, protectedItems: [] };
      expect(putCoachingPreferencesSchema.safeParse(put).success).toBe(true);
    });

    test("expectedRevision exceeding max fails", () => {
      const put = { schemaVersion: 1, expectedRevision: 2147483647, protectedItems: [] };
      expect(putCoachingPreferencesSchema.safeParse(put).success).toBe(false);
    });

    test("negative expectedRevision fails", () => {
      const put = { schemaVersion: 1, expectedRevision: -1, protectedItems: [] };
      expect(putCoachingPreferencesSchema.safeParse(put).success).toBe(false);
    });
  });

  describe("getActiveProtectedFixedCostIds", () => {
    test("filters out orphaned IDs not in current items", () => {
      const prefs: Pick<CoachingPreferences, "protectedItems"> = {
        protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "deleted" }]
      };
      const items = [{ id: "a" }, { id: "b" }];
      const active = getActiveProtectedFixedCostIds(prefs, items);
      expect([...active]).toEqual(["a"]);
    });

    test("returns empty set when no items match", () => {
      const prefs: Pick<CoachingPreferences, "protectedItems"> = {
        protectedItems: [{ fixedCostId: "x" }, { fixedCostId: "y" }]
      };
      const items = [{ id: "a" }, { id: "b" }];
      const active = getActiveProtectedFixedCostIds(prefs, items);
      expect(active.size).toBe(0);
    });

    test("returns all IDs when all match", () => {
      const prefs: Pick<CoachingPreferences, "protectedItems"> = {
        protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "b" }]
      };
      const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const active = getActiveProtectedFixedCostIds(prefs, items);
      expect([...active].sort()).toEqual(["a", "b"]);
    });

    test("handles empty preferences", () => {
      const prefs: Pick<CoachingPreferences, "protectedItems"> = { protectedItems: [] };
      const items = [{ id: "a" }, { id: "b" }];
      const active = getActiveProtectedFixedCostIds(prefs, items);
      expect(active.size).toBe(0);
    });

    test("handles empty items array", () => {
      const prefs: Pick<CoachingPreferences, "protectedItems"> = {
        protectedItems: [{ fixedCostId: "a" }]
      };
      const items: { id: string }[] = [];
      const active = getActiveProtectedFixedCostIds(prefs, items);
      expect(active.size).toBe(0);
    });

    test("preserves original preferences without mutation", () => {
      const prefs: Pick<CoachingPreferences, "protectedItems"> = {
        protectedItems: [{ fixedCostId: "a" }, { fixedCostId: "deleted" }]
      };
      const original = structuredClone(prefs);
      const items = [{ id: "a" }];
      getActiveProtectedFixedCostIds(prefs, items);
      expect(prefs).toEqual(original);
    });
  });
});
