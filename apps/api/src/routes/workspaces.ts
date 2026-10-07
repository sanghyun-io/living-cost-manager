import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  // TRUST_PROXY=off means many customers share a Docker/proxy peer. This
  // coarse instance backstop bounds pre-auth JWT/DB work, not customer usage.
  // Neither spoofed headers nor unverified token claims can partition it.
  const surfaceLimit = app.createRateLimit({ max: 1200, timeWindow: "1 minute", keyGenerator: () => "workspaces:surface" });
  const surfaceGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    const check = await surfaceLimit(request);
    if ("isExceeded" in check && check.isExceeded) {
      reply.header("retry-after", String(Math.max(1, Math.ceil(check.ttl / 1000))));
      throw app.httpErrors.tooManyRequests("Workspace request limit reached; try again in about a minute");
    }
  };
  // The plugin appends its preHandler AFTER the route auth preHandler. Only
  // signature/issuer/audience/tokenVersion-validated account IDs reach this
  // key generator; creation also completed the verified-email gate.
  const accountLimit = (max: number) => ({ max, timeWindow: "1 minute", hook: "preHandler" as const, cache: 5000,
    keyGenerator: (request: FastifyRequest) => `workspaces:account:${request.user.sub}` });
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
  app.post("/workspaces", { onRequest: surfaceGuard, preHandler: app.requireVerifiedEmail, config: { rateLimit: accountLimit(20) } }, async (request, reply) => {
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
  app.post("/workspaces/aggregate", { onRequest: surfaceGuard, preHandler: app.authenticate, config: { rateLimit: accountLimit(60) } }, async request => {
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
