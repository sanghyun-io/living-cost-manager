import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema
} from "@living-cost-manager/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  findUserForAuthenticatedRequest,
  InvalidInvitationError,
  InvitationConflictError,
  isTransactionConflictError,
  isUniqueConstraintError,
  listPendingInvitationsForEmail,
  WorkspaceInvitationAuthorizationError
} from "../services/invitations.js";
import { normalizeEmail } from "../services/email.js";
import { requireWorkspaceOwner } from "../services/membership.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

const invitationParamsSchema = z.object({
  invitationId: z.string().min(1)
});

function parseWorkspaceId(params: unknown): string {
  return workspaceParamsSchema.parse(params).workspaceId;
}

function parseInvitationId(params: unknown): string {
  return invitationParamsSchema.parse(params).invitationId;
}

function normalizeCreateInvitationBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("email" in body)) {
    return body;
  }

  const candidate = body as Record<string, unknown>;

  if (typeof candidate.email !== "string") {
    return body;
  }

  return {
    ...candidate,
    email: normalizeEmail(candidate.email)
  };
}

export async function invitationRoutes(app: FastifyInstance) {
  app.post(
    "/workspaces/:workspaceId/invitations",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const workspaceId = parseWorkspaceId(request.params);

      await requireWorkspaceOwner(app, request.user.sub, workspaceId);

      const parsedBody = createInvitationRequestSchema.safeParse(
        normalizeCreateInvitationBody(request.body)
      );

      if (!parsedBody.success) {
        throw app.httpErrors.badRequest("Invalid request body");
      }

      try {
        const invitation = await createWorkspaceInvitation(
          app.prisma,
          workspaceId,
          parsedBody.data.email,
          parsedBody.data.role,
          request.user.sub
        );

        return reply.code(201).send(invitation);
      } catch (error) {
        if (error instanceof WorkspaceInvitationAuthorizationError) {
          throw app.httpErrors.forbidden("Forbidden");
        }

        if (
          error instanceof InvitationConflictError ||
          isUniqueConstraintError(error) ||
          isTransactionConflictError(error)
        ) {
          throw app.httpErrors.conflict("Invitation conflict");
        }

        throw error;
      }
    }
  );

  app.get("/invitations", { preHandler: app.authenticate }, async (request) => {
    const user = await findUserForAuthenticatedRequest(app.prisma, request.user.sub);

    if (!user) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    return listPendingInvitationsForEmail(app.prisma, user.email);
  });

  app.post(
    "/invitations/:invitationId/accept",
    { preHandler: app.authenticate },
    async (request) => {
      const invitationId = parseInvitationId(request.params);
      const parsedBody = acceptInvitationRequestSchema.safeParse(request.body);

      if (!parsedBody.success) {
        throw app.httpErrors.badRequest("Invalid request body");
      }

      const user = await findUserForAuthenticatedRequest(app.prisma, request.user.sub);

      if (!user) {
        throw app.httpErrors.unauthorized("Invalid token");
      }

      try {
        return await acceptWorkspaceInvitation(
          app.prisma,
          invitationId,
          parsedBody.data.token,
          user
        );
      } catch (error) {
        if (error instanceof InvalidInvitationError) {
          throw app.httpErrors.notFound("Invitation not found");
        }

        if (error instanceof InvitationConflictError || isUniqueConstraintError(error)) {
          throw app.httpErrors.conflict("Invitation conflict");
        }

        if (isTransactionConflictError(error)) {
          throw app.httpErrors.conflict("Invitation conflict");
        }

        throw error;
      }
    }
  );
}
