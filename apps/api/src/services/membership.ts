import type { WorkspaceMember, WorkspaceRole } from "@prisma/client";
import type { FastifyInstance } from "fastify";

export async function requireWorkspaceRole(
  app: FastifyInstance,
  userId: string,
  workspaceId: string,
  allowedRoles: readonly WorkspaceRole[]
): Promise<WorkspaceMember> {
  const member = await app.prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId
      }
    }
  });

  if (!member || !allowedRoles.includes(member.role)) {
    throw app.httpErrors.forbidden("Forbidden");
  }

  return member;
}
