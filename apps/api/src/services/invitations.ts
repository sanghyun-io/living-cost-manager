import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  Prisma,
  PrismaClient,
  User,
  WorkspaceInvitation,
  WorkspaceInvitationRole
} from "@prisma/client";
import type {
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto
} from "@living-cost-manager/shared";

import { toWorkspaceMemberDto } from "./membership.js";

const invitationTokenBytes = 32;
const invitationTtlMs = 7 * 24 * 60 * 60 * 1000;

export type CreatedInvitation = WorkspaceInvitationDto & {
  token: string;
};

type WorkspaceInvitationWithWorkspace = WorkspaceInvitation & {
  workspace: {
    id: string;
    name: string;
  };
};

export class InvitationConflictError extends Error {
  constructor(message = "Invitation conflict") {
    super(message);
    this.name = "InvitationConflictError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createInvitationToken(): string {
  return randomBytes(invitationTokenBytes).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifyInvitationToken(token: string, tokenHash: string): boolean {
  const candidateHash = hashInvitationToken(token);
  const candidate = Buffer.from(candidateHash, "hex");
  const expected = Buffer.from(tokenHash, "hex");

  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
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
  role: WorkspaceInvitationRole
): Promise<CreatedInvitation> {
  const normalizedEmail = normalizeEmail(email);
  const invitee = await prisma.user.findUnique({
    where: {
      email: normalizedEmail
    },
    select: {
      id: true
    }
  });

  if (invitee) {
    const existingMember = await prisma.workspaceMember.findUnique({
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

  const existingInvitation = await prisma.workspaceInvitation.findFirst({
    where: {
      workspaceId,
      email: normalizedEmail,
      acceptedAt: null,
      expiresAt: {
        gt: new Date()
      }
    },
    select: {
      id: true
    }
  });

  if (existingInvitation) {
    throw new InvitationConflictError("Invitation already exists");
  }

  const token = createInvitationToken();
  const invitation = await prisma.workspaceInvitation.create({
    data: {
      workspaceId,
      email: normalizedEmail,
      role,
      tokenHash: hashInvitationToken(token),
      expiresAt: new Date(Date.now() + invitationTtlMs)
    }
  });

  return {
    ...toWorkspaceInvitationDto(invitation),
    token
  };
}

export async function listPendingInvitationsForEmail(
  prisma: PrismaClient,
  email: string
): Promise<WorkspaceInvitationDto[]> {
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: normalizeEmail(email),
      acceptedAt: null,
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
  invitation: WorkspaceInvitationWithWorkspace,
  user: User
): Promise<{ workspace: WorkspaceDto; member: WorkspaceMemberDto }> {
  return prisma.$transaction(async (tx) => {
    const existingMember = await tx.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId: user.id
        }
      },
      select: {
        id: true
      }
    });

    if (existingMember) {
      throw new InvitationConflictError("User is already a workspace member");
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

    await tx.workspaceInvitation.update({
      where: {
        id: invitation.id
      },
      data: {
        acceptedAt: new Date()
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
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as Prisma.PrismaClientKnownRequestError).code === "P2002"
  );
}
