import { createHash, randomBytes } from "node:crypto";

import {
  Prisma,
  type PrismaClient,
  type User,
  type WorkspaceInvitation,
  type WorkspaceInvitationRole
} from "@prisma/client";
import type {
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto
} from "@living-cost-manager/shared";

import { toWorkspaceMemberDto } from "./membership.js";
import { normalizeEmail } from "./email.js";

const invitationTokenBytes = 32;
const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;

export type CreatedInvitation = WorkspaceInvitationDto & {
  token: string;
};

export class InvitationConflictError extends Error {
  constructor(message = "Invitation conflict") {
    super(message);
    this.name = "InvitationConflictError";
  }
}

export class InvalidInvitationError extends Error {
  constructor(message = "Invitation not found") {
    super(message);
    this.name = "InvalidInvitationError";
  }
}

export class WorkspaceInvitationAuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "WorkspaceInvitationAuthorizationError";
  }
}

export function createInvitationToken(): string {
  return randomBytes(invitationTokenBytes).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function toWorkspaceInvitationDto(
  invitation: WorkspaceInvitation
): WorkspaceInvitationDto {
  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    acceptedAt: invitation.acceptedAt?.toISOString() ?? null
  };
}

export async function findUserForAuthenticatedRequest(
  prisma: PrismaClient,
  userId: string
): Promise<User | null> {
  return prisma.user.findUnique({
    where: {
      id: userId
    }
  });
}

export async function createWorkspaceInvitation(
  prisma: PrismaClient,
  workspaceId: string,
  email: string,
  role: WorkspaceInvitationRole,
  actorUserId: string
): Promise<CreatedInvitation> {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();

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
        throw new WorkspaceInvitationAuthorizationError();
      }

      const invitee = await tx.user.findUnique({
        where: {
          email: normalizedEmail
        },
        select: {
          id: true
        }
      });

      if (invitee) {
        const existingMember = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId,
              userId: invitee.id
            }
          },
          select: {
            id: true
          }
        });

        if (existingMember) {
          throw new InvitationConflictError("User is already a workspace member");
        }
      }

      const expiredPendingInvitation = await tx.workspaceInvitation.findFirst({
        where: {
          workspaceId,
          email: normalizedEmail,
          status: "pending",
          expiresAt: {
            lte: now
          }
        },
        select: {
          id: true
        }
      });

      if (expiredPendingInvitation) {
        await tx.workspaceInvitation.updateMany({
          where: {
            workspaceId,
            email: normalizedEmail,
            status: "pending",
            expiresAt: {
              lte: now
            }
          },
          data: {
            status: "expired"
          }
        });
      }

      const token = createInvitationToken();
      const invitation = await tx.workspaceInvitation.create({
        data: {
          workspaceId,
          email: normalizedEmail,
          role,
          status: "pending",
          tokenHash: hashInvitationToken(token),
          expiresAt: new Date(Date.now() + invitationTtlMs)
        }
      });

      return {
        ...toWorkspaceInvitationDto(invitation),
        token
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

export async function listPendingInvitationsForEmail(
  prisma: PrismaClient,
  email: string
): Promise<WorkspaceInvitationDto[]> {
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: normalizeEmail(email),
      acceptedAt: null,
      status: "pending",
      expiresAt: {
        gt: new Date()
      }
    },
    orderBy: {
      createdAt: "asc"
    }
  });

  return invitations.map(toWorkspaceInvitationDto);
}

export async function acceptWorkspaceInvitation(
  prisma: PrismaClient,
  invitationId: string,
  token: string,
  user: User
): Promise<{ workspace: WorkspaceDto; member: WorkspaceMemberDto }> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const tokenHash = hashInvitationToken(token);
    const invitationWhere = {
      id: invitationId,
      email: normalizeEmail(user.email),
      status: "pending" as const,
      acceptedAt: null,
      expiresAt: {
        gt: now
      },
      tokenHash
    };
    const invitation = await tx.workspaceInvitation.findFirst({
      where: invitationWhere,
      include: {
        workspace: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!invitation) {
      throw new InvalidInvitationError();
    }

    const claim = await tx.workspaceInvitation.updateMany({
      where: invitationWhere,
      data: {
        acceptedAt: now,
        status: "accepted"
      }
    });

    if (claim.count !== 1) {
      throw new InvalidInvitationError();
    }

    const member = await tx.workspaceMember.create({
      data: {
        workspaceId: invitation.workspaceId,
        userId: user.id,
        role: invitation.role
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

    return {
      workspace: {
        id: invitation.workspace.id,
        name: invitation.workspace.name,
        role: member.role
      },
      member: toWorkspaceMemberDto(member)
    };
  });
}

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

export function isTransactionConflictError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  );
}
