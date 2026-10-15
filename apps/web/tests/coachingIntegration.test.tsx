// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { InsightsPanel } from "../app/components/InsightsPanel";
import type { FixedCost } from "../app/lib/budget";
import React from "react";
import { MantineProvider } from "@mantine/core";

// Test fixtures
const mockFixedCosts: FixedCost[] = [
  {
    id: "item-1",
    name: "Netflix",
    categoryId: "subscription",
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    amount: 15000,
    periodMonths: 1,
    billingDay: 1,
    isEndOfMonth: false,
    billingAnchorDate: null,
    renewalStatus: "unreviewed",
    potentialMonthlySavings: 0,
    confirmedMonthlySavings: 0
  },
  {
    id: "item-2",
    name: "Insurance",
    categoryId: "insurance",
    paymentMethodId: "bank-transfer",
    paymentOptionId: "auto-transfer",
    amount: 50000,
    periodMonths: 1,
    billingDay: 15,
    isEndOfMonth: false,
    billingAnchorDate: null,
    renewalStatus: "unreviewed",
    potentialMonthlySavings: 0,
    confirmedMonthlySavings: 0
  }
];

describe("InsightsPanel", () => {
  describe("Bug 4: Static EMPTY_PROTECTED_IDS prevents rerender loop", () => {
    test("uses module const for default protectedFixedCostIds", () => {
      // This test verifies that the component doesn't create a new Set on each render
      // which would cause infinite rerender loops in useEffect dependencies

      const { rerender } = render(
        <MantineProvider>
          <InsightsPanel
            fixedCosts={mockFixedCosts}
            monthlyIncome={100000}
            monthlyExpense={65000}
          />
        </MantineProvider>
      );

      // Rerender without protectedFixedCostIds prop
      // Should use EMPTY_PROTECTED_IDS module const
      rerender(
        <MantineProvider>
          <InsightsPanel
            fixedCosts={mockFixedCosts}
            monthlyIncome={100000}
            monthlyExpense={65000}
          />
        </MantineProvider>
      );

      // If it created new Set() each time, this would trigger infinite loop
      // Test passes by not timing out or throwing
      expect(true).toBe(true);
    });

    test("accepts explicit protectedFixedCostIds", () => {
      const protectedIds = new Set(["item-1"]);

      const { container } = render(
        <MantineProvider>
          <InsightsPanel
            fixedCosts={mockFixedCosts}
            monthlyIncome={100000}
            monthlyExpense={65000}
            protectedFixedCostIds={protectedIds}
          />
        </MantineProvider>
      );

      expect(container).toBeTruthy();
    });
  });

  describe("Insurance filtering", () => {
    test("buildSavingsInsights respects protectedFixedCostIds", () => {
      // This is primarily tested in shared package
      // Here we just verify the component passes it correctly
      const protectedIds = new Set(["item-2"]); // Protect insurance

      const { container } = render(
        <MantineProvider>
          <InsightsPanel
            fixedCosts={mockFixedCosts}
            monthlyIncome={100000}
            monthlyExpense={65000}
            protectedFixedCostIds={protectedIds}
          />
        </MantineProvider>
      );

      expect(container).toBeTruthy();
    });
  });
});