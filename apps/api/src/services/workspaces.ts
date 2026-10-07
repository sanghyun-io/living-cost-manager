import { Prisma, type PrismaClient } from "@prisma/client";
import {
  createWorkspaceRequestSchema, aggregateWorkspacesRequestSchema, renameWorkspaceRequestSchema,
  kstThirtyDayWindow, summarizeWorkspaceBudget, sumWorkspaceBudgets,
  type CreateWorkspaceRequest, type AggregateWorkspacesRequest, type AggregateWorkspacesResponse,
  type RenameWorkspaceRequest, type WorkspaceDto,
} from "@living-cost-manager/shared";
import { AccountWorkspaceAuthorizationError } from "./account.js";
import { getWorkspaceSnapshot } from "./snapshot.js";

export async function createUserWorkspace(prisma: PrismaClient, userId: string, input: CreateWorkspaceRequest) {
  const { name, initialBudget: budget } = createWorkspaceRequestSchema.parse(input);
  return prisma.$transaction(async tx => {
    const workspace = await tx.workspace.create({ data: {
      name, monthlyIncome: budget.monthlyIncome,
      members: { create: { userId, role: "owner" } },
    } });
    const workspaceId = workspace.id;
    if (budget.categories.length) await tx.category.createMany({ data: budget.categories.map(category => ({ ...category, workspaceId })) });
    if (budget.cards.length) await tx.paymentCard.createMany({ data: budget.cards.map(card => ({ ...card, workspaceId })) });
    if (budget.fixedCosts.length) await tx.fixedCost.createMany({ data: budget.fixedCosts.map(cost => ({
      id: cost.id, workspaceId, name: cost.name, categoryId: cost.categoryId,
      paymentMethodId: cost.paymentMethodId,
      paymentCardId: cost.paymentMethodId === "credit-card" ? cost.paymentOptionId || null : null,
      paymentOptionKey: cost.paymentMethodId === "credit-card" ? null : cost.paymentOptionId || null,
      amount: cost.amount, periodMonths: cost.periodMonths, billingDay: cost.billingDay,
      isEndOfMonth: cost.isEndOfMonth, billingAnchorDate: cost.billingAnchorDate ?? null,
      renewalStatus: cost.renewalStatus ?? "unreviewed", potentialMonthlySavings: cost.potentialMonthlySavings ?? 0,
      confirmedMonthlySavings: cost.confirmedMonthlySavings ?? 0,
    })) });
    const snapshot = await getWorkspaceSnapshot(tx, workspaceId);
    await tx.backupSnapshot.create({ data: { workspaceId, payload: snapshot as Prisma.InputJsonValue } });
    return { workspace: { id: workspaceId, name, role: "owner" } satisfies WorkspaceDto, snapshot };
  });
}

export async function renameUserWorkspace(prisma: PrismaClient, userId: string, workspaceId: string, input: RenameWorkspaceRequest): Promise<WorkspaceDto> {
  const { name } = renameWorkspaceRequestSchema.parse(input);
  return prisma.$transaction(async tx => {
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } });
    if (member?.role !== "owner") throw new AccountWorkspaceAuthorizationError();
    await tx.workspace.update({ where: { id: workspaceId }, data: { name } });
    return { id: workspaceId, name, role: "owner" };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function aggregateUserWorkspaces(prisma: PrismaClient, userId: string, input: AggregateWorkspacesRequest, asOf = new Date()): Promise<AggregateWorkspacesResponse> {
  const { workspaceIds } = aggregateWorkspacesRequestSchema.parse(input);
  const { fromDate, untilDateExclusive } = kstThirtyDayWindow(asOf);
  return prisma.$transaction(async tx => {
    // Check ALL memberships before any financial reads. RepeatableRead gives
    // one consistent membership + finance snapshot; revocations committed
    // before this snapshot are denied. In-flight requests may finish against
    // their already-authorized snapshot (no cross-statement mixed versions).
    const members = await tx.workspaceMember.findMany({ where: { userId, workspaceId: { in: workspaceIds }, role: { in: ["owner", "editor", "viewer"] } }, select: { workspaceId: true, role: true } });
    if (members.length !== workspaceIds.length) throw new AccountWorkspaceAuthorizationError();
    const rows = await tx.workspace.findMany({ where: { id: { in: workspaceIds } }, select: {
      id: true, name: true, syncVersion: true, monthlyIncome: true,
      fixedCosts: { select: { amount: true, periodMonths: true, billingAnchorDate: true, isEndOfMonth: true } },
    } });
    if (rows.length !== workspaceIds.length) throw new AccountWorkspaceAuthorizationError();
    const byId = new Map(rows.map(row => [row.id, row]));
    const roles = new Map(members.map(member => [member.workspaceId, member.role]));
    const workspaces = workspaceIds.map(id => {
      const row = byId.get(id)!;
      return { id, name: row.name, role: roles.get(id)!, syncVersion: row.syncVersion,
        ...summarizeWorkspaceBudget(row.monthlyIncome, row.fixedCosts, asOf) };
    });
    return { currency: "KRW", timeZone: "Asia/Seoul", asOf: asOf.toISOString(), fromDate, untilDateExclusive,
      workspaces, totals: sumWorkspaceBudgets(workspaces) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
