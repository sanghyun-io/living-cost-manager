import { Prisma, type PrismaClient } from "@prisma/client";
import { createDefaultWorkspacePlanningData, putWorkspacePlanningSchema, type PutWorkspacePlanning, type WorkspacePlanning } from "@living-cost-manager/shared";
import { getWorkspaceSnapshot } from "./snapshot.js";
import { planningArchive } from "./planning-storage.js";

export class PlanningForbiddenError extends Error {}
export class PlanningConflictError extends Error {}

async function authorize(tx: Prisma.TransactionClient, userId: string, workspaceId: string, write: boolean) {
  // Lock the membership while writing: role revocation cannot race past authorization.
  const members = write
    ? await tx.$queryRaw<Array<{ role: string }>>`SELECT "role" FROM "WorkspaceMember" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${userId} FOR SHARE`
    : await tx.workspaceMember.findMany({ where: { workspaceId, userId }, select: { role: true } });
  const role = members[0]?.role;
  if (!role || (write && role !== "owner" && role !== "editor")) throw new PlanningForbiddenError();
  if (write) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) throw new PlanningForbiddenError();
  }
}

export async function getWorkspacePlanning(prisma: PrismaClient, userId: string, workspaceId: string): Promise<WorkspacePlanning> {
  return prisma.$transaction(async tx => {
    await authorize(tx, userId, workspaceId, false);
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { syncVersion: true, planningState: true } });
    const stored = planningArchive(workspace.planningState).planning;
    return { workspaceId, revision: stored?.revision ?? 0, currentSnapshotVersion: workspace.syncVersion, data: stored?.data ?? createDefaultWorkspacePlanningData() };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function putWorkspacePlanning(prisma: PrismaClient, userId: string, workspaceId: string, input: PutWorkspacePlanning): Promise<WorkspacePlanning> {
  const parsed = putWorkspacePlanningSchema.parse(input);
  try {
    return await prisma.$transaction(async tx => {
      await authorize(tx, userId, workspaceId, true);
      // Same lock as snapshot PUT: archives always pair a coherent budget + planning.
      const rows = await tx.$queryRaw<Array<{ syncVersion: number }>>`SELECT "syncVersion" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
      const snapshotVersion = rows[0]?.syncVersion;
      if (snapshotVersion !== parsed.expectedSnapshotVersion) throw new PlanningConflictError();
      const existing = await tx.workspacePlanningState.findUnique({ where: { workspaceId } });
      planningArchive(existing); // corrupt stored values must not be silently overwritten
      if ((existing?.revision ?? 0) !== parsed.expectedRevision) throw new PlanningConflictError();
      const revision = parsed.expectedRevision + 1;
      if (existing) {
        const result = await tx.workspacePlanningState.updateMany({ where: { workspaceId, revision: parsed.expectedRevision }, data: { revision, payloadJson: parsed.data } });
        if (result.count !== 1) throw new PlanningConflictError();
      } else {
        try { await tx.workspacePlanningState.create({ data: { workspaceId, revision, payloadJson: parsed.data } }); }
        catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new PlanningConflictError();
          throw error;
        }
      }
      const snapshot = await getWorkspaceSnapshot(tx, workspaceId);
      await tx.backupSnapshot.create({ data: { workspaceId, payload: { ...snapshot, planning: { revision, data: parsed.data } } as Prisma.InputJsonValue } });
      return { workspaceId, revision, currentSnapshotVersion: snapshotVersion, data: parsed.data };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (
      error.code === "P2034" ||
      // PostgreSQL serialization/deadlock raised by a raw locking query is P2010.
      (error.code === "P2010" && (error.meta?.code === "40001" || error.meta?.code === "40P01"))
    )) throw new PlanningConflictError();
    throw error;
  }
}
