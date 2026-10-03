import { expect, test, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runDueReminders } from "../src/jobs/send-due-reminders.js";
import { getWorkspaceSnapshot, replaceWorkspaceSnapshot } from "../src/services/snapshot.js";
import type { Env } from "../src/env.js";

test("reminder job excludes legacy, fractional, wrong-phase annual and zero charges", async () => {
  const base = { id: "cost", name: "Cost", categoryId: "other", amount: 100, billingDay: 6, isEndOfMonth: false, periodMonths: 12 };
  const send = vi.fn(async () => ({ sent: 1, pruned: 0 }));
  const prisma = {
    pushSubscription: { findMany: vi.fn(async () => [{ userId: "user" }]) },
    fixedCost: { findMany: vi.fn(async () => [
      base, { ...base, billingAnchorDate: "2026-07-06" },
      { ...base, billingAnchorDate: "2026-06-06", periodMonths: 0.5 },
      { ...base, billingAnchorDate: "2026-06-06", amount: 0 }
    ]) },
    pushDelivery: { create: vi.fn() }
  };
  const env = { VAPID_PUBLIC_KEY: "public", VAPID_PRIVATE_KEY: "private", VAPID_SUBJECT: "mailto:test@example.com" } as Env;
  await runDueReminders(prisma as unknown as PrismaClient, env, new Date(2026, 5, 5), send);
  expect(send).not.toHaveBeenCalled();
  expect(prisma.pushDelivery.create).not.toHaveBeenCalled();
  prisma.fixedCost.findMany.mockResolvedValue([{ ...base, billingAnchorDate: "2026-06-06" }] as never);
  await runDueReminders(prisma as unknown as PrismaClient, env, new Date(2026, 5, 5), send);
  expect(send).toHaveBeenCalledTimes(1);
});

test("API read and write preserve anchor and renewal fields", async () => {
  const cost = { id: "c", workspaceId: "w", name: "Annual", categoryId: "other", paymentMethodId: "bank-transfer",
    paymentCardId: null, paymentOptionKey: "auto-transfer", amount: 12000, periodMonths: 12, billingDay: 1,
    isEndOfMonth: false, billingAnchorDate: "2026-10-03", renewalStatus: "completed", potentialMonthlySavings: 1000, confirmedMonthlySavings: 400 };
  const tx = {
    workspace: { findUniqueOrThrow: vi.fn(async () => ({ id: "w", monthlyIncome: 1, syncVersion: 1, categories: [], cards: [], fixedCosts: [cost] })), updateMany: vi.fn(async () => ({ count: 1 })) },
    fixedCost: { findMany: vi.fn(async () => [cost]), deleteMany: vi.fn(), createMany: vi.fn() },
    paymentCard: { deleteMany: vi.fn() }, category: { deleteMany: vi.fn() }, backupSnapshot: { create: vi.fn() }
  };
  const prisma = { ...tx, $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as PrismaClient;
  const snapshot = await getWorkspaceSnapshot(prisma, "w");
  expect(snapshot.fixedCosts[0]).toMatchObject({ billingAnchorDate: cost.billingAnchorDate, renewalStatus: "completed", confirmedMonthlySavings: 400 });
  await replaceWorkspaceSnapshot(prisma, snapshot);
  expect(tx.fixedCost.createMany).toHaveBeenCalledWith({ data: [cost] });
});
