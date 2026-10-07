import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  AccountWorkspaceAuthorizationError,
  deleteWorkspace,
  isAccountTransactionConflictError
} from "../services/account.js";
import { listUserWorkspaces } from "../services/membership.js";
import { createWorkspaceRequestSchema, renameWorkspaceRequestSchema, aggregateWorkspacesRequestSchema } from "@living-cost-manager/shared";
import { createUserWorkspace, renameUserWorkspace, aggregateUserWorkspaces } from "../services/workspaces.js";

const workspaceParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

export async function workspaceRoutes(app: FastifyInstance) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw app.httpErrors.badRequest("Invalid workspace request");
    return result.data;
  };
  const mapError = (error: unknown): never => {
    if (error instanceof AccountWorkspaceAuthorizationError) throw app.httpErrors.forbidden("Forbidden");
    if (isAccountTransactionConflictError(error)) throw app.httpErrors.conflict("Concurrent membership change, please retry");
    throw error;
  };
  app.post("/workspaces", { preHandler: app.requireVerifiedEmail, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const input = parse(createWorkspaceRequestSchema, request.body);
    const result = await createUserWorkspace(app.prisma, request.user.sub, input);
    return reply.code(201).send(result);
  });
  app.patch("/workspaces/:workspaceId", { preHandler: app.requireVerifiedEmail }, async request => {
    const { workspaceId } = parse(workspaceParamsSchema, request.params);
    const input = parse(renameWorkspaceRequestSchema, request.body);
    try { return await renameUserWorkspace(app.prisma, request.user.sub, workspaceId, input); }
    catch (error) { return mapError(error); }
  });
  app.post("/workspaces/aggregate", { preHandler: app.authenticate, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async request => {
    const input = parse(aggregateWorkspacesRequestSchema, request.body);
    try { return await aggregateUserWorkspaces(app.prisma, request.user.sub, input); }
    catch (error) { return mapError(error); }
  });
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
