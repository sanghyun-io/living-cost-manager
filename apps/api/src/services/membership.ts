import type { PrismaClient, WorkspaceMember, WorkspaceRole } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { WorkspaceMemberDto } from "@living-cost-manager/shared";

type WorkspaceMemberWithUser = WorkspaceMember & {
  user: {
    email: string;
    name: string;
  };
};

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
