import { describe, expect, test } from "vitest";
import {
  acceptInvitationRequestSchema,
  authResponseSchema,
  createInvitationRequestSchema,
  fixedCostDtoSchema,
  loginRequestSchema,
  registerRequestSchema,
  roundPeriodMonths,
  updateMemberRoleRequestSchema,
  workspaceInvitationDtoSchema,
  workspaceSnapshotSchema,
} from "./index.js";
import { z } from "zod";

const minimalFixedCost = {
  id: "cost-1",
  workspaceId: "workspace-1",
  name: "Rent",
  categoryId: "category-1",
  paymentMethodId: "bank-transfer",
  paymentOptionId: "account-1",
  amount: 1000000,
  periodMonths: 2.5,
  billingDay: 1,
  isEndOfMonth: false,
};

describe("shared api contracts", () => {
  test("fixedCostDtoSchema preserves an existing one-decimal period month", () => {
    const parsed = fixedCostDtoSchema.parse(minimalFixedCost);

    expect(parsed.periodMonths).toBe(2.5);
  });

  test("roundPeriodMonths rounds values to one decimal place for callers", () => {
    expect(roundPeriodMonths(2.5)).toBe(2.5);
    expect(roundPeriodMonths(2.54)).toBe(2.5);
    expect(roundPeriodMonths(2.55)).toBe(2.6);
  });

  test("fixedCostDtoSchema rejects period months that are not already rounded", () => {
    expect(() =>
      fixedCostDtoSchema.parse({
        ...minimalFixedCost,
        periodMonths: 2.54,
      }),
    ).toThrow();
  });

  test("fixedCostDtoSchema accepts an empty payment option id", () => {
    const parsed = fixedCostDtoSchema.parse({
      ...minimalFixedCost,
      paymentMethodId: "cash",
      paymentOptionId: "",
    });

    expect(parsed.paymentOptionId).toBe("");
  });

  test("workspaceSnapshotSchema accepts a complete minimal snapshot", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      monthlyIncome: 3000000,
      categories: [
        {
          id: "category-1",
          workspaceId: "workspace-1",
          label: "Housing",
        },
      ],
      cards: [
        {
          id: "card-1",
          workspaceId: "workspace-1",
          label: "Main Card",
          billingDay: 15,
          isEndOfMonth: false,
        },
      ],
      fixedCosts: [
        {
          ...minimalFixedCost,
          paymentMethodId: "credit-card",
          paymentOptionId: "card-1",
        },
      ],
    };

    expect(workspaceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  test("dto schemas can be converted to JSON schema", () => {
    expect(() => z.toJSONSchema(fixedCostDtoSchema)).not.toThrow();
    expect(() => z.toJSONSchema(workspaceSnapshotSchema)).not.toThrow();
  });

  test("fixedCostDtoSchema represents the period month precision in JSON schema", () => {
    const jsonSchema = z.toJSONSchema(fixedCostDtoSchema) as {
      properties?: {
        periodMonths?: {
          minimum?: number;
          maximum?: number;
          multipleOf?: number;
        };
      };
    };

    expect(jsonSchema.properties?.periodMonths).toMatchObject({
      minimum: 1,
      maximum: 120,
      multipleOf: 0.1,
    });
  });

  test("createInvitationRequestSchema rejects owner and defaults missing role to viewer", () => {
    expect(
      createInvitationRequestSchema.parse({
        email: "invitee@example.com",
      }),
    ).toEqual({
      email: "invitee@example.com",
      role: "viewer",
    });

    expect(() =>
      createInvitationRequestSchema.parse({
        email: "owner@example.com",
        role: "owner",
      }),
    ).toThrow();
  });

  test("updateMemberRoleRequestSchema accepts all workspace member roles", () => {
    expect(updateMemberRoleRequestSchema.parse({ role: "owner" })).toEqual({
      role: "owner",
    });
    expect(updateMemberRoleRequestSchema.parse({ role: "editor" })).toEqual({
      role: "editor",
    });
    expect(updateMemberRoleRequestSchema.parse({ role: "viewer" })).toEqual({
      role: "viewer",
    });
  });

  test("acceptInvitationRequestSchema requires a non-empty token", () => {
    expect(() => acceptInvitationRequestSchema.parse({ token: "" })).toThrow();
    expect(acceptInvitationRequestSchema.parse({ token: "token-1" })).toEqual({
      token: "token-1",
    });
  });

  test("workspaceInvitationDtoSchema validates ISO datetime fields", () => {
    const invitation = {
      id: "invitation-1",
      workspaceId: "workspace-1",
      email: "invitee@example.com",
      role: "viewer",
      expiresAt: "2026-05-22T10:00:00.000Z",
      acceptedAt: null,
    };

    expect(workspaceInvitationDtoSchema.parse(invitation)).toEqual(invitation);
    expect(
      workspaceInvitationDtoSchema.parse({
        ...invitation,
        acceptedAt: "2026-05-22T10:30:00.000Z",
      }).acceptedAt,
    ).toBe("2026-05-22T10:30:00.000Z");
    expect(() =>
      workspaceInvitationDtoSchema.parse({
        ...invitation,
        expiresAt: "May 22, 2026",
      }),
    ).toThrow();
  });

  test("auth schemas validate requests and responses", () => {
    expect(
      registerRequestSchema.parse({
        email: "user@example.com",
        password: "password1",
        name: "User",
      }),
    ).toEqual({
      email: "user@example.com",
      password: "password1",
      name: "User",
    });
    expect(() =>
      registerRequestSchema.parse({
        email: "not-an-email",
        password: "short",
        name: "",
      }),
    ).toThrow();

    expect(
      loginRequestSchema.parse({
        email: "user@example.com",
        password: "password1",
      }),
    ).toEqual({
      email: "user@example.com",
      password: "password1",
    });
    expect(() =>
      loginRequestSchema.parse({
        email: "user@example.com",
        password: "short",
      }),
    ).toThrow();

    const response = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
      },
      workspace: {
        id: "workspace-1",
        name: "Home",
        role: "owner",
      },
    };

    expect(authResponseSchema.parse(response)).toEqual(response);
  });
});
