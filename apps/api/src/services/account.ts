import { Prisma, type PrismaClient } from "@prisma/client";
import argon2 from "argon2";

/**
 * Account deletion (GDPR / 개인정보보호법 right-to-erasure).
 *
 * Rules:
 *  - Password re-confirmation is mandatory (the caller authenticated with a
 *    token; erasing a whole account additionally proves possession of the
 *    credentials).
 *  - Workspaces the user owns alone are hard-deleted (Prisma cascade cleans up
 *    members, invitations, categories, cards, fixed costs and backups).
 *  - Workspaces the user owns but that still have OTHER members block the
 *    deletion: ownership must be transferred first (409 upstream).
 *  - Memberships where the user is editor/viewer are simply removed along with
 *    the user (WorkspaceMember has onDelete: Cascade on the user side); the
 *    shared workspace itself and everyone else's data stay untouched.
 *  - Deleting the user row cascades to push subscriptions/deliveries and
 *    password-reset / email-verification tokens. JWTs become dead on the next
 *    authenticate() because the user row (and its tokenVersion) is gone.
 */

export class AccountUserNotFoundError extends Error {
  constructor(message = "User not found") {
    super(message);
    this.name = "AccountUserNotFoundError";
  }
}

export class BillingAccountDeleteBlocked extends Error {
  readonly code = "BillingAccountDeleteBlocked";
  constructor() { super("BillingAccountDeleteBlocked"); }
}

export class AccountInvalidCredentialsError extends Error {
  constructor(message = "Invalid credentials") {
    super(message);
    this.name = "AccountInvalidCredentialsError";
  }
}

export class AccountWorkspaceAuthorizationError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "AccountWorkspaceAuthorizationError";
  }
}

export type BlockingWorkspace = {
  id: string;
  name: string;
};

export class AccountWorkspaceConflictError extends Error {
  readonly workspaces: BlockingWorkspace[];

  constructor(
    workspaces: BlockingWorkspace[],
    message = "Cannot delete account: you still own workspaces shared with other members"
  ) {
    super(message);
    this.name = "AccountWorkspaceConflictError";
    this.workspaces = workspaces;
  }
}

/** P2034 (serialization failure) — a concurrent membership change raced us. */
export function isAccountTransactionConflictError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"
  );
}

type MembershipSnapshot = {
  role: "owner" | "editor" | "viewer";
  workspace: {
    id: string;
    name: string;
    _count: { members: number };
  };
};

export async function deleteAccount(
  prisma: PrismaClient,
  userId: string,
  password: string
): Promise<void> {
  // Password check happens outside the transaction on purpose: argon2.verify is
  // deliberately slow (anti-brute-force) and holding a Serializable transaction
  // open across it would stall membership writers. Ownership is re-checked
  // inside the transaction below.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true }
  });

  if (!user) {
    throw new AccountUserNotFoundError();
  }

  if (!(await argon2.verify(user.passwordHash, password))) {
    throw new AccountInvalidCredentialsError();
  }

  await prisma.$transaction(
    async (tx) => {
      // Same lock order as billing contract creation: user -> contract. A new
      // contract cannot race deletion and resurrect a detached payment subject.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const billing = await tx.serviceSubscriptionContract.findUnique({ where: { userId } });
      if (billing) {
        await tx.$queryRaw`SELECT "id" FROM "ServiceSubscriptionContract" WHERE "id" = ${billing.id} FOR UPDATE`;
        const current = await tx.serviceSubscriptionContract.findUniqueOrThrow({ where: { id: billing.id } });
        const unresolvedAttempt = await tx.servicePaymentAttempt.count({ where: { contractId: billing.id,
          OR: [{ status: { in: ["created", "dispatch_unknown", "manual_review"] } }, { reviewRequired: true }] } });
        const unresolvedRefund = await tx.serviceRefundRecord.count({ where: { attempt: { contractId: billing.id },
          status: { notIn: ["verified", "rejected"] } } });
        const instruments = await tx.serviceBillingInstrument.count({ where: { contractId: billing.id,
          OR: [{ status: { not: "revoked" } }, { ciphertext: { not: null } }, { nonce: { not: null } }, { authTag: { not: null } }, { keyVersion: { not: null } }] } });
        const events = await tx.serviceBillingEventReceipt.count({ where: { attempt: { contractId: billing.id }, processedAt: null } });
        if (unresolvedAttempt || unresolvedRefund || instruments || events ||
          (current.status !== "idle" && (!current.cancelRequested || !current.renewalStopped || current.providerCancellationStatus !== "verified" ||
            current.cancellationVerifiedVersion !== current.version))) {
          throw new BillingAccountDeleteBlocked();
        }
        // Financial records remain; User FK is SET NULL, no email/name copied.
      }
      const memberships = await tx.workspaceMember.findMany({
        where: { userId },
        select: {
          role: true,
          workspace: {
            select: {
              id: true,
              name: true,
              _count: { select: { members: true } }
            }
          }
        }
      });

      // Any other member (owner or not) in an owned workspace blocks deletion
      // until ownership is transferred: hard-deleting that workspace would
      // silently destroy another user's data.
      const blocking = memberships.filter(
        (membership) =>
          membership.role === "owner" && membership.workspace._count.members > 1
      );

      if (blocking.length > 0) {
        throw new AccountWorkspaceConflictError(
          blocking.map((membership) => ({
            id: membership.workspace.id,
            name: membership.workspace.name
          }))
        );
      }

      // Owned workspaces are all solo at this point: remove them wholesale.
      // Cascade cleans categories / cards / fixed costs / backups / invitations
      // and the (only) membership rows.
      const ownedIds = memberships
        .filter((membership: MembershipSnapshot) => membership.role === "owner")
        .map((membership: MembershipSnapshot) => membership.workspace.id);

      if (ownedIds.length > 0) {
        await tx.workspace.deleteMany({ where: { id: { in: ownedIds } } });
      }

      // Editor/viewer memberships are dropped by the user-cascade below, but
      // delete them explicitly first so the intent is visible in this
      // transaction's write set.
      await tx.workspaceMember.deleteMany({ where: { userId } });

      // Hard delete the account itself. Cascades remove push subscriptions /
      // deliveries and password-reset / email-verification tokens.
      await tx.user.delete({ where: { id: userId } });
    },
    {
      // Serializable matches the membership service so a member added to an
      // owned workspace mid-flight fails the deletion closed (P2034) instead
      // of silently wiping another user's data.
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}

/**
 * Owner-only workspace hard delete used by DELETE /v1/workspaces/:workspaceId.
 * The membership re-check lives inside the transaction (same pattern as the
 * membership service).
 */
export async function deleteWorkspace(
  prisma: PrismaClient,
  userId: string,
  workspaceId: string
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const membership = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: { workspaceId, userId }
        },
        select: { role: true }
      });

      if (!membership || membership.role !== "owner") {
        throw new AccountWorkspaceAuthorizationError();
      }

      await tx.workspace.delete({ where: { id: workspaceId } });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable
    }
  );
}
