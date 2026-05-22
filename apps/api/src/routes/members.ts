import { updateMemberRoleRequestSchema } from "@living-cost-manager/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  findWorkspaceMemberDto,
  isLastWorkspaceOwner,
  listWorkspaceMembers,
  requireWorkspaceOwner,
  requireWorkspaceRole
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

      const existingMember = await findWorkspaceMemberDto(
        app.prisma,
        workspaceId,
        memberId
      );

      if (!existingMember) {
        throw app.httpErrors.notFound("Workspace member not found");
      }

      if (
        existingMember.role === "owner" &&
        parsedBody.data.role !== "owner" &&
        (await isLastWorkspaceOwner(app.prisma, workspaceId, memberId))
      ) {
        throw app.httpErrors.conflict("Cannot change the last owner");
      }

      const updatedMember = await app.prisma.workspaceMember.update({
        where: {
          id: memberId
        },
        data: {
          role: parsedBody.data.role
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
        id: updatedMember.id,
        workspaceId: updatedMember.workspaceId,
        userId: updatedMember.userId,
        email: updatedMember.user.email,
        name: updatedMember.user.name,
        role: updatedMember.role
      };
    }
  );

  app.delete(
    "/workspaces/:workspaceId/members/:memberId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { workspaceId, memberId } = parseMemberParams(request.params);

      await requireWorkspaceOwner(app, request.user.sub, workspaceId);

      const existingMember = await findWorkspaceMemberDto(
        app.prisma,
        workspaceId,
        memberId
      );

      if (!existingMember) {
        throw app.httpErrors.notFound("Workspace member not found");
      }

      if (await isLastWorkspaceOwner(app.prisma, workspaceId, memberId)) {
        throw app.httpErrors.conflict("Cannot remove the last owner");
      }

      await app.prisma.workspaceMember.delete({
        where: {
          id: memberId
        }
      });

      return reply.code(204).send();
    }
  );
}
