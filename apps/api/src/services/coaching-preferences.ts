import { Prisma, type PrismaClient } from "@prisma/client";
import { coachingPreferencesSchema, putCoachingPreferencesSchema, type CoachingPreferences, type PutCoachingPreferences } from "@living-cost-manager/shared";

export class CoachingPreferencesForbiddenError extends Error {}
export class CoachingPreferencesConflictError extends Error {}
export class CoachingPreferencesInvalidItemError extends Error {}

async function requireMember(tx: Prisma.TransactionClient, userId: string, workspaceId: string) {
  const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { id: true } });
  if (!member) throw new CoachingPreferencesForbiddenError();
}

export async function getCoachingPreferences(prisma: PrismaClient, userId: string, workspaceId: string): Promise<CoachingPreferences> {
  return prisma.$transaction(async tx => {
    await requireMember(tx, userId, workspaceId);
    const row = await tx.userWorkspaceCoachingPreference.findUnique({ where: { userId_workspaceId: { userId, workspaceId } } });
    // No writes, orphan pruning, or revision increments on read.
    return row ? coachingPreferencesSchema.parse({ schemaVersion: 1, revision: row.revision, protectedItems: row.protectedItemsJson })
      : { schemaVersion: 1, revision: 0, protectedItems: [] };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function putCoachingPreferences(prisma: PrismaClient, userId: string, workspaceId: string, input: PutCoachingPreferences): Promise<CoachingPreferences> {
  const parsed = putCoachingPreferencesSchema.parse(input);
  try {
    return await prisma.$transaction(async tx => {
      await requireMember(tx, userId, workspaceId);
      const ids = parsed.protectedItems.map(item => item.fixedCostId);
      const count = await tx.fixedCost.count({ where: { workspaceId, id: { in: ids } } });
      if (count !== ids.length) throw new CoachingPreferencesInvalidItemError();
      const key = { userId, workspaceId };
      if (parsed.expectedRevision === 0) {
        // Do not upsert: simultaneous first saves must conflict, never overwrite.
        await tx.userWorkspaceCoachingPreference.create({ data: { ...key, revision: 1, protectedItemsJson: parsed.protectedItems } });
      } else {
        const changed = await tx.userWorkspaceCoachingPreference.updateMany({
          where: { ...key, revision: parsed.expectedRevision },
          data: { revision: { increment: 1 }, protectedItemsJson: parsed.protectedItems }
        });
        if (changed.count !== 1) throw new CoachingPreferencesConflictError();
      }
      return { schemaVersion: 1, revision: parsed.expectedRevision + 1, protectedItems: parsed.protectedItems };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) throw new CoachingPreferencesConflictError();
    throw error;
  }
}
