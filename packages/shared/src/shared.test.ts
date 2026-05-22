import { describe, expect, test } from "vitest";
import { fixedCostDtoSchema } from "./budget";
import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  updateMemberRoleRequestSchema,
} from "./workspace";
import { workspaceSnapshotSchema } from "./snapshot";

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
};

describe("shared api contracts", () => {
  test("fixedCostDtoSchema preserves an existing one-decimal period month", () => {
    const parsed = fixedCostDtoSchema.parse(minimalFixedCost);

    expect(parsed.periodMonths).toBe(2.5);
  });

  test("fixedCostDtoSchema rounds period months to one decimal place", () => {
    expect(
      fixedCostDtoSchema.parse({
        ...minimalFixedCost,
        periodMonths: 2.54,
      }).periodMonths,
    ).toBe(2.5);
    expect(
      fixedCostDtoSchema.parse({
        ...minimalFixedCost,
        periodMonths: 2.55,
      }).periodMonths,
    ).toBe(2.6);
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
});
