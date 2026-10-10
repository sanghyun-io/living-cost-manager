import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getProductTourState, putProductTourState } from "../services/product-tour.js";

const bodySchema = z.object({ version: z.literal(1), status: z.enum(["completed", "skipped"]) }).strict();

export async function productTourRoutes(app: FastifyInstance) {
  // authenticate checks current User + tokenVersion; no workspace role/payment
  // gate. Email confirmation remains mandatory on existing cloud/share routes,
  // but is unnecessary for this user's own minimal UI preference.
  app.get("/onboarding/product-tour", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      return await getProductTourState(app.prisma, request.user.sub);
    } catch {
      // Missing migration/DB failure is NOT unseen. Never expose SQL or data.
      throw app.httpErrors.internalServerError("Product tour state unavailable");
    }
  });

  app.put("/onboarding/product-tour", {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest("Invalid product tour state");
    try {
      return await putProductTourState(app.prisma, request.user.sub, parsed.data.status);
    } catch {
      throw app.httpErrors.internalServerError("Product tour state unavailable");
    }
  });
}
