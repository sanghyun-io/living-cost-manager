import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AccountWorkspaceAuthorizationError,
  deleteWorkspace,
  isAccountTransactionConflictError
} from "../services/account.js";
import { listUserWorkspaces } from "../services/membership.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

export async function workspaceRoutes(app: FastifyInstance) {
  app.get("/workspaces", { preHandler: app.authenticate }, async (request) => {
    return listUserWorkspaces(app.prisma, request.user.sub);
  });

  // Owner-only hard delete. Prisma cascades clean up members, invitations,
  // categories, cards, fixed costs and backup snapshots.
  app.delete(
    "/workspaces/:workspaceId",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { workspaceId } = workspaceParamsSchema.parse(request.params);

      try {
        await deleteWorkspace(app.prisma, request.user.sub, workspaceId);
      } catch (error) {
        if (error instanceof AccountWorkspaceAuthorizationError) {
          throw app.httpErrors.forbidden("Forbidden");
        }

        if (isAccountTransactionConflictError(error)) {
          throw app.httpErrors.conflict("Concurrent membership change, please retry");
        }

        throw error;
      }

      return reply.code(204).send();
    }
  );
}
