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
  isEndOfMonth: boolean;
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
    billingDay: fixedCost.billingDay,
    isEndOfMonth: fixedCost.isEndOfMonth
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
    billingDay: fixedCost.billingDay,
    isEndOfMonth: fixedCost.isEndOfMonth
  };
}

export function isSnapshotWriteValidationError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    ["P2002", "P2003"].includes(error.code)
  );
}

// 낙관적 잠금 충돌: 클라이언트가 보낸 syncVersion 이 서버 현재 값과 다름.
// 라우트에서 409 Conflict 로 변환한다. currentVersion 을 실어 클라이언트가
// 최신 스냅샷을 다시 받아갈지 판단할 수 있게 한다.
export class SnapshotVersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super("Snapshot version conflict");
    this.name = "SnapshotVersionConflictError";
  }
}

export function isSnapshotVersionConflictError(
  error: unknown
): error is SnapshotVersionConflictError {
  return error instanceof SnapshotVersionConflictError;
}

export async function getWorkspaceSnapshot(
  prisma: PrismaClient | Prisma.TransactionClient,
  workspaceId: string
): Promise<WorkspaceSnapshot> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: {
      id: workspaceId
    },
    select: {
      id: true,
      monthlyIncome: true,
      syncVersion: true,
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
          billingDay: true,
          isEndOfMonth: true
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
          billingDay: true,
          isEndOfMonth: true
        }
      }
    }
  });

  return {
    workspaceId: workspace.id,
    syncVersion: workspace.syncVersion,
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
  return prisma.$transaction(async (tx) => {
    // 낙관적 잠금: syncVersion 이 클라이언트가 보낸 값과 일치할 때만 갱신하고
    // 버전을 1 올린다. 조건부 updateMany 의 count 로 충돌을 원자적으로 감지한다
    // (동시 PUT 중 하나만 통과). count 가 0 이면 버전이 이미 바뀐 것이므로 충돌.
    const updated = await tx.workspace.updateMany({
      where: {
        id: snapshot.workspaceId,
        syncVersion: snapshot.syncVersion
      },
      data: {
        monthlyIncome: snapshot.monthlyIncome,
        syncVersion: { increment: 1 }
      }
    });

    if (updated.count === 0) {
      const current = await tx.workspace.findUniqueOrThrow({
        where: { id: snapshot.workspaceId },
        select: { syncVersion: true }
      });
      throw new SnapshotVersionConflictError(current.syncVersion);
    }

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

    return getWorkspaceSnapshot(tx, snapshot.workspaceId);
  });
}
