import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { putWorkspacePlanningSchema } from "@living-cost-manager/shared";
import { getWorkspacePlanning, putWorkspacePlanning, PlanningForbiddenError, PlanningConflictError } from "../services/planning.js";

const paramsSchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const querySchema = z.object({}).strict();
export async function planningRoutes(app: FastifyInstance) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw app.httpErrors.badRequest("Invalid planning request");
    return result.data;
  };
  const mapError = (error: unknown): never => {
    if (error instanceof PlanningForbiddenError) throw app.httpErrors.forbidden("Forbidden");
    if (error instanceof PlanningConflictError) throw app.httpErrors.conflict("Planning or budget changed; load and reconcile manually before saving");
    throw app.httpErrors.serviceUnavailable("Planning unavailable; keep local financial data");
  };
  const config = { rateLimit: { max: 120, timeWindow: "1 minute", hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `planning:${request.user.sub}` } };
  app.get("/workspaces/:workspaceId/planning", { preHandler: app.authenticate, config }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { workspaceId } = parse(paramsSchema, request.params);
    parse(querySchema, request.query);
    try { return await getWorkspacePlanning(app.prisma, request.user.sub, workspaceId); }
    catch (error) { return mapError(error); }
  });
  app.put("/workspaces/:workspaceId/planning", { preHandler: app.requireVerifiedEmail, config, bodyLimit: 512 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { workspaceId } = parse(paramsSchema, request.params);
    parse(querySchema, request.query);
    const input = parse(putWorkspacePlanningSchema, request.body);
    try { return await putWorkspacePlanning(app.prisma, request.user.sub, workspaceId, input); }
    catch (error) { return mapError(error); }
  });
}
