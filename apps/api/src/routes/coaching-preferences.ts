import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { putCoachingPreferencesSchema } from "@living-cost-manager/shared";
import { getCoachingPreferences, putCoachingPreferences, CoachingPreferencesForbiddenError, CoachingPreferencesConflictError, CoachingPreferencesInvalidItemError } from "../services/coaching-preferences.js";

const paramsSchema = z.object({ workspaceId: z.string().min(1).max(200) }).strict();
const querySchema = z.object({}).strict();

export async function coachingPreferenceRoutes(app: FastifyInstance) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw app.httpErrors.badRequest("Invalid coaching preferences request");
    return parsed.data;
  };
  const mapError = (error: unknown): never => {
    if (error instanceof CoachingPreferencesForbiddenError) throw app.httpErrors.forbidden("Forbidden");
    if (error instanceof CoachingPreferencesInvalidItemError) throw app.httpErrors.badRequest("Protected items must belong to the current workspace");
    if (error instanceof CoachingPreferencesConflictError || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034"))
      throw app.httpErrors.conflict("Preferences changed; load and reconcile manually before saving");
    // Never expose SQL, stored private values or infrastructure errors to clients.
    throw app.httpErrors.serviceUnavailable("Coaching preferences unavailable; keep local preferences");
  };
  const config = { rateLimit: { max: 120, timeWindow: "1 minute", hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => `coaching-preferences:${request.user.sub}` } };
  app.get("/workspaces/:workspaceId/coaching-preferences", { preHandler: app.authenticate, config }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { workspaceId } = parse(paramsSchema, request.params);
    parse(querySchema, request.query);
    try { return await getCoachingPreferences(app.prisma, request.user.sub, workspaceId); }
    catch (error) { return mapError(error); }
  });
  app.put("/workspaces/:workspaceId/coaching-preferences", { preHandler: app.authenticate, config, bodyLimit: 256 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { workspaceId } = parse(paramsSchema, request.params);
    parse(querySchema, request.query);
    const input = parse(putCoachingPreferencesSchema, request.body);
    try { return await putCoachingPreferences(app.prisma, request.user.sub, workspaceId, input); }
    catch (error) { return mapError(error); }
  });
}
