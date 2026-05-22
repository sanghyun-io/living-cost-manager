import { updateMemberRoleRequestSchema } from "@living-cost-manager/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  deleteWorkspaceMember,
  isMembershipTransactionConflictError,
  LastOwnerConflictError,
  listWorkspaceMembers,
  requireWorkspaceOwner,
  requireWorkspaceRole,
  updateWorkspaceMemberRole,
  WorkspaceMemberNotFoundError
} from "../services/membership.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

const memberParamsSchema = z.object({
  workspaceId: z.string().min(1),
  memberId: z.string().min(1)
});

function parseWorkspaceId(params: unknown): string {
  return workspaceParamsSchema.parse(params).workspaceId;
}

function parseMemberParams(params: unknown): { workspaceId: string; memberId: string } {
  return memberParamsSchema.parse(params);
}

export async function memberRoutes(app: FastifyInstance) {
  app.get(
    "/workspaces/:workspaceId/members",
    { preHandler: app.authenticate },
    async (request) => {
      const workspaceId = parseWorkspaceId(request.params);

      await requireWorkspaceRole(app, request.user.sub, workspaceId, [
        "owner",
        "editor",
        "viewer"
      ]);

      return listWorkspaceMembers(app.prisma, workspaceId);
    }
  );

  app.patch(
    "/workspaces/:workspaceId/members/:memberId",
    { preHandler: app.authenticate },
    async (request) => {
      const { workspaceId, memberId } = parseMemberParams(request.params);

      await requireWorkspaceOwner(app, request.user.sub, workspaceId);

      const parsedBody = updateMemberRoleRequestSchema.safeParse(request.body);

      if (!parsedBody.success) {
        throw app.httpErrors.badRequest("Invalid request body");
      }

      try {
        return await updateWorkspaceMemberRole(
          app.prisma,
          workspaceId,
          memberId,
          parsedBody.data.role
        );
      } catch (error) {
        if (error instanceof WorkspaceMemberNotFoundError) {
          throw app.httpErrors.notFound("Workspace member not found");
        }

        if (
          error instanceof LastOwnerConflictError ||
          isMembershipTransactionConflictError(error)
        ) {
          throw app.httpErrors.conflict("Cannot change the last owner");
        }

        throw error;
      }
    }
  );

  app.delete(
    "/workspaces/:workspaceId/members/:memberId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { workspaceId, memberId } = parseMemberParams(request.params);

      await requireWorkspaceOwner(app, request.user.sub, workspaceId);

      try {
        await deleteWorkspaceMember(app.prisma, workspaceId, memberId);
      } catch (error) {
        if (error instanceof WorkspaceMemberNotFoundError) {
          throw app.httpErrors.notFound("Workspace member not found");
        }

        if (
          error instanceof LastOwnerConflictError ||
          isMembershipTransactionConflictError(error)
        ) {
          throw app.httpErrors.conflict("Cannot remove the last owner");
        }

        throw error;
      }

      return reply.code(204).send();
    }
  );
}
