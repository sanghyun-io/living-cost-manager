import { Prisma, type PrismaClient } from "@prisma/client";
import type { FixedCostDto, WorkspaceSnapshot } from "@living-cost-manager/shared";

function toFixedCostDto(fixedCost: {
  id: string;
  workspaceId: string;
  name: string;
  categoryId: string;
  paymentMethodId: string;
  paymentCardId: string | null;
  paymentOptionKey: string | null;
  amount: number;
  periodMonths: number;
  billingDay: number;
}): FixedCostDto {
  return {
    id: fixedCost.id,
    workspaceId: fixedCost.workspaceId,
    name: fixedCost.name,
    categoryId: fixedCost.categoryId,
    paymentMethodId: fixedCost.paymentMethodId as FixedCostDto["paymentMethodId"],
    paymentOptionId:
      fixedCost.paymentMethodId === "credit-card"
        ? fixedCost.paymentCardId ?? ""
        : fixedCost.paymentOptionKey ?? "",
    amount: fixedCost.amount,
    periodMonths: fixedCost.periodMonths,
    billingDay: fixedCost.billingDay
  };
}

function toFixedCostCreateData(fixedCost: FixedCostDto) {
  const isCreditCard = fixedCost.paymentMethodId === "credit-card";

  return {
    id: fixedCost.id,
    workspaceId: fixedCost.workspaceId,
    name: fixedCost.name,
    categoryId: fixedCost.categoryId,
    paymentMethodId: fixedCost.paymentMethodId,
    paymentCardId: isCreditCard ? fixedCost.paymentOptionId || null : null,
    paymentOptionKey: isCreditCard ? null : fixedCost.paymentOptionId || null,
    amount: fixedCost.amount,
    periodMonths: fixedCost.periodMonths,
    billingDay: fixedCost.billingDay
  };
}

export function isSnapshotWriteValidationError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003"].includes(error.code)
  );
}

export async function getWorkspaceSnapshot(
  prisma: PrismaClient,
  workspaceId: string
): Promise<WorkspaceSnapshot> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: {
      id: workspaceId
    },
    select: {
      id: true,
      monthlyIncome: true,
      categories: {
        orderBy: {
          id: "asc"
        },
        select: {
          id: true,
          workspaceId: true,
          label: true
        }
      },
      cards: {
        orderBy: {
          id: "asc"
        },
        select: {
          id: true,
          workspaceId: true,
          label: true,
          billingDay: true
        }
      },
      fixedCosts: {
        orderBy: {
          id: "asc"
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          categoryId: true,
          paymentMethodId: true,
          paymentCardId: true,
          paymentOptionKey: true,
          amount: true,
          periodMonths: true,
          billingDay: true
        }
      }
    }
  });

  return {
    workspaceId: workspace.id,
    monthlyIncome: workspace.monthlyIncome,
    categories: workspace.categories,
    cards: workspace.cards,
    fixedCosts: workspace.fixedCosts.map(toFixedCostDto)
  };
}

export async function replaceWorkspaceSnapshot(
  prisma: PrismaClient,
  snapshot: WorkspaceSnapshot
): Promise<WorkspaceSnapshot> {
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: {
        id: snapshot.workspaceId
      },
      data: {
        monthlyIncome: snapshot.monthlyIncome
      }
    });

    await tx.fixedCost.deleteMany({
      where: {
        workspaceId: snapshot.workspaceId
      }
    });
    await tx.paymentCard.deleteMany({
      where: {
        workspaceId: snapshot.workspaceId
      }
    });
    await tx.category.deleteMany({
      where: {
        workspaceId: snapshot.workspaceId
      }
    });

    if (snapshot.categories.length > 0) {
      await tx.category.createMany({
        data: snapshot.categories
      });
    }

    if (snapshot.cards.length > 0) {
      await tx.paymentCard.createMany({
        data: snapshot.cards
      });
    }

    if (snapshot.fixedCosts.length > 0) {
      await tx.fixedCost.createMany({
        data: snapshot.fixedCosts.map(toFixedCostCreateData)
      });
    }

    await tx.backupSnapshot.create({
      data: {
        workspaceId: snapshot.workspaceId,
        payload: snapshot as Prisma.InputJsonValue
      }
    });
  });

  return getWorkspaceSnapshot(prisma, snapshot.workspaceId);
}
