import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { isPushConfigured, saveSubscription, deleteSubscription } from "../services/push.js";

const subscriptionBodySchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

const unsubscribeBodySchema = z.object({
  endpoint: z.string().url()
});

export async function pushRoutes(app: FastifyInstance) {
  // VAPID 공개키 — 프론트가 PushManager.subscribe 에 쓴다. 비활성 시 enabled:false.
  app.get("/push/public-key", async () => {
    const enabled = isPushConfigured(app.appEnv);
    return {
      enabled,
      publicKey: enabled ? app.appEnv.VAPID_PUBLIC_KEY : null
    };
  });

  // 구독 등록(로그인 필요). 푸시 미설정이면 503.
  app.post("/push/subscriptions", { preHandler: app.authenticate }, async (request, reply) => {
    if (!isPushConfigured(app.appEnv)) {
      throw app.httpErrors.serviceUnavailable("Push is not configured");
    }
    const parsed = subscriptionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest("Invalid subscription");
    }
    await saveSubscription(app.prisma, request.user.sub, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth
    });
    return reply.code(201).send({ ok: true });
  });

  // 구독 해지(로그인 필요). 본인 소유 endpoint 만 삭제.
  app.delete("/push/subscriptions", { preHandler: app.authenticate }, async (request) => {
    const parsed = unsubscribeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw app.httpErrors.badRequest("Invalid request");
    }
    const removed = await deleteSubscription(app.prisma, request.user.sub, parsed.data.endpoint);
    return { ok: true, removed };
  });
}
