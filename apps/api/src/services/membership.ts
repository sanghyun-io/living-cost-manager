import {
  Prisma,
  type PrismaClient,
  type WorkspaceMember,
  type WorkspaceRole
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { WorkspaceMemberDto } from "@living-cost-manager/shared";

type WorkspaceMemberWithUser = WorkspaceMember & {
  user: {
    email: string;
    name: string;
  };
};

export class LastOwnerConflictError extends Error {
  constructor(message = "Cannot remove the last owner") {
    super(message);
    this.name = "LastOwnerConflictError";
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  constructor(message = "Workspace member not found") {
    super(message);
    this.name = "WorkspaceMemberNotFoundError";
  }
}

export class WorkspaceMemberAuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "WorkspaceMemberAuthorizationError";
  }
}

export function toWorkspaceMemberDto(
  member: WorkspaceMemberWithUser
): WorkspaceMemberDto {
  return {
    id: member.id,
    workspaceId: member.workspaceId,
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    role: member.role
  };
}

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

export async function requireWorkspaceOwner(
  app: FastifyInstance,
  userId: string,
  workspaceId: string
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(app, userId, workspaceId, ["owner"]);
}

export async function listWorkspaceMembers(
  prisma: PrismaClient,
  workspaceId: string
): Promise<WorkspaceMemberDto[]> {
  const members = await prisma.workspaceMember.findMany({
    where: {
      workspaceId
    },
    include: {
      user: {
        select: {
          email: true,
          name: true
        }
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  return members.map(toWorkspaceMemberDto);
}

export async function findWorkspaceMemberDto(
  prisma: PrismaClient,
  workspaceId: string,
  memberId: string
): Promise<WorkspaceMemberDto | null> {
  const member = await prisma.workspaceMember.findFirst({
    where: {
      id: memberId,
      workspaceId
    },
    include: {
      user: {
        select: {
          email: true,
          name: true
        }
      }
    }
  });

  return member ? toWorkspaceMemberDto(member) : null;
}

export async function isLastWorkspaceOwner(
  prisma: PrismaClient,
  workspaceId: string,
  memberId: string
): Promise<boolean> {
  const member = await prisma.workspaceMember.findFirst({
    where: {
      id: memberId,
      workspaceId
    },
    select: {
      role: true
    }
  });

  if (member?.role !== "owner") {
    return false;
  }

  const ownerCount = await prisma.workspaceMember.count({
    where: {
      workspaceId,
      role: "owner"
    }
  });

  return ownerCount <= 1;
}

export async function updateWorkspaceMemberRole(
  prisma: PrismaClient,
  workspaceId: string,
  memberId: string,
  role: WorkspaceRole,
  actorUserId: string
): Promise<WorkspaceMemberDto> {
  return prisma.$transaction(
    async (tx) => {
      const actorMembership = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: actorUserId
          }
        },
        select: {
          role: true
        }
      });

      if (actorMembership?.role !== "owner") {
        throw new WorkspaceMemberAuthorizationError();
      }

      const member = await tx.workspaceMember.findFirst({
        where: {
          id: memberId,
          workspaceId
        },
        include: {
          user: {
            select: {
              email: true,
              name: true
            }
          }
        }
      });

      if (!member) {
        throw new WorkspaceMemberNotFoundError();
      }

      if (member.role === "owner" && role !== "owner") {
        const ownerCount = await tx.workspaceMember.count({
          where: {
            workspaceId,
            role: "owner"
          }
        });

        if (ownerCount <= 1) {
          throw new LastOwnerConflictError("Cannot change the last owner");
        }
      }

      const updatedMember = await tx.workspaceMember.update({
        where: {
          id: memberId
        },
        data: {
          role
        },
        include: {
          user: {
            select: {
              email: true,
              name: true
            }
          }
        }
      });

      return toWorkspaceMemberDto(updatedMember);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function deleteWorkspaceMember(
  prisma: PrismaClient,
  workspaceId: string,
  memberId: string,
  actorUserId: string
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const actorMembership = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: actorUserId
          }
        },
        select: {
          role: true
        }
      });

      if (actorMembership?.role !== "owner") {
        throw new WorkspaceMemberAuthorizationError();
      }

      const member = await tx.workspaceMember.findFirst({
        where: {
          id: memberId,
          workspaceId
        },
        select: {
          role: true
        }
      });

      if (!member) {
        throw new WorkspaceMemberNotFoundError();
      }

      if (member.role === "owner") {
        const ownerCount = await tx.workspaceMember.count({
          where: {
            workspaceId,
            role: "owner"
          }
        });

        if (ownerCount <= 1) {
          throw new LastOwnerConflictError();
        }
      }

      await tx.workspaceMember.delete({
        where: {
          id: memberId
        }
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export function isMembershipTransactionConflictError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  );
}
