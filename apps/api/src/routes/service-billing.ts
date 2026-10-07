import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  serviceBillingQuoteRequestSchema, serviceBillingPrepareRequestSchema, serviceBillingConfirmRequestSchema,
  serviceBillingChargeRequestSchema, serviceBillingCancelRequestSchema, serviceBillingRefundRequestSchema,
  serviceBillingMockExecutionRequestSchema, serviceBillingIdempotencyKeySchema
} from "@living-cost-manager/shared";
import { ServiceBillingError, ServiceBillingService } from "../services/service-billing.js";
import type { ServiceBillingProvider } from "../services/service-billing-provider.js";
import { parseBillingConfiguration } from "../services/service-billing-config.js";

declare module "fastify" { interface FastifyInstance { serviceBilling: ServiceBillingService } }

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  // Strict own keys also reject __proto__ (which Zod intentionally ignores).
  if (!result.success || !body || typeof body !== "object" || Array.isArray(body) ||
    unsafeKeys(body)) {
    throw new ServiceBillingError("INVALID_BILLING_REQUEST", 400);
  }
  return result.data;
}
function unsafeKeys(value: object): boolean {
  return Reflect.ownKeys(value).some(k => k === "__proto__" || k === "constructor" || k === "prototype" ||
    (typeof k === "string" && (value as Record<string, unknown>)[k] !== null && typeof (value as Record<string, unknown>)[k] === "object" &&
      unsafeKeys((value as Record<string, object>)[k]!)));
}
function parameter(request: FastifyRequest, key: string) {
  const value = (request.params as Record<string, string>)[key];
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ServiceBillingError("INVALID_BILLING_REQUEST", 400);
  return value;
}
export async function serviceBillingRoutes(root: FastifyInstance, options: { provider?: ServiceBillingProvider; clock?: () => Date } = {}) {
  // Unregistered means 404 for every path/method (including readiness,
  // callbacks and unknown paths), without constructing a service/provider.
  if (root.appEnv.SERVICE_PAID_FEATURES_PUBLISHED !== "true") return;
  const config = parseBillingConfiguration(root.appEnv);
  const testFixture = root.appEnv.NODE_ENV === "test";
  if (!testFixture && (root.appEnv.SERVICE_BILLING_MODE !== "live" || !config.enabled ||
    !config.capabilities.issueInstrument || !config.capabilities.charge || !config.capabilities.renew)) return;
  root.decorate("serviceBilling", new ServiceBillingService(root.prisma, root.appEnv, options.clock, options.provider));
  await root.register(async app => {
    const service = root.serviceBilling;
    // No request/provider payload or original exception is logged. The route
    // scope handles unknown errors without leaking tokens/DB queries/signatures.
    app.setErrorHandler((error, _request, reply) => {
      const known = error instanceof ServiceBillingError;
      const status = known ? error.statusCode : (error as { statusCode?: number }).statusCode;
      const safeStatus = status && status >= 400 && status < 500 ? status : 503;
      const code = known ? error.code : safeStatus === 401 ? "UNAUTHORIZED" : safeStatus === 403 ? "FORBIDDEN" :
        safeStatus === 429 ? "BILLING_RATE_LIMITED" : safeStatus === 400 || safeStatus === 413 ? "INVALID_BILLING_REQUEST" : "BILLING_UNAVAILABLE";
      reply.code(known ? error.statusCode : safeStatus).send({ statusCode: known ? error.statusCode : safeStatus, code, message: code });
    });
    // Coarse pre-auth backstop (not a low quota on a shared proxy socket).
    // createRateLimit deliberately avoids rateLimit()'s request-wide "already
    // ran" sentinel, which otherwise silently skips a second post-auth limiter.
    const coarseCheck = app.createRateLimit({ max: 10_000, timeWindow: "1 minute", keyGenerator: () => "billing-coarse" });
    const userCheck = app.createRateLimit({ max: 60, timeWindow: "1 minute", keyGenerator: request => request.user.sub });
    app.addHook("onRequest", async request => {
      const result = await coarseCheck(request);
      if (!result.isAllowed && result.isExceeded) throw new ServiceBillingError("BILLING_RATE_LIMITED", 429);
    });
    const perUser = async (request: FastifyRequest) => {
      const result = await userCheck(request);
      if (!result.isAllowed && result.isExceeded) throw new ServiceBillingError("BILLING_RATE_LIMITED", 429);
    };
    const read = { preHandler: [app.authenticate, perUser] };
    const write = { bodyLimit: 4096, preHandler: [app.requireVerifiedEmail, perUser] };
    app.get("/readiness", async () => service.readiness());
    app.get("/subscription", read, request => service.subscription(request.user.sub));
    app.post("/quotes", write, request => service.createQuote(request.user.sub, parse(serviceBillingQuoteRequestSchema, request.body).planId));
    app.post("/instruments/prepare", write, request => service.prepare(request.user.sub, parse(serviceBillingPrepareRequestSchema, request.body).quoteId));
    app.post("/instruments/:id/confirm", write, request => service.confirm(request.user.sub, parameter(request, "id"), parse(serviceBillingConfirmRequestSchema, request.body).billingKey));
    app.post("/charges", write, request => service.charge(request.user.sub, parse(serviceBillingChargeRequestSchema, request.body)));
    app.get("/attempts/:id", read, request => service.poll(request.user.sub, parameter(request, "id")));
    app.get("/attempts/by-idempotency/:key", read, request => {
      const key = serviceBillingIdempotencyKeySchema.safeParse(parameter(request, "key"));
      if (!key.success) throw new ServiceBillingError("INVALID_BILLING_REQUEST", 400);
      return service.byIdempotency(request.user.sub, key.data);
    });
    app.get("/instruments/:id", read, request => service.instrumentDto(request.user.sub, parameter(request, "id")));
    app.post("/instruments/:id/revoke", write, request => {
      parse(serviceBillingMockExecutionRequestSchema, request.body);
      return service.revokeInstrument(request.user.sub, parameter(request, "id"));
    });
    app.post("/subscription/cancel", write, request => {
      parse(serviceBillingCancelRequestSchema, request.body);
      return service.cancel(request.user.sub);
    });
    app.post("/attempts/:id/refund-requests", write, request => {
      const input = parse(serviceBillingRefundRequestSchema, request.body);
      return service.requestRefund(request.user.sub, parameter(request, "id"), input.idempotencyKey, input.reasonCode);
    });
    // Local simulation controls, not provider merchant APIs. requireMock() is
    // checked before dispatch, and rejects NODE_ENV=production unconditionally.
    app.post("/mock/renew", write, request => {
      parse(serviceBillingMockExecutionRequestSchema, request.body);
      return service.renewMock(request.user.sub);
    });
    app.post("/mock/refund-requests/:id/execute", write, async request => {
      parse(serviceBillingMockExecutionRequestSchema, request.body);
      const id = parameter(request, "id");
      await service.executeMockRefund(request.user.sub, id);
      return service.refundDto(request.user.sub, id);
    });
    // Parser override is encapsulated in ONLY this webhook subtree. Normal
    // billing/auth JSON routes retain Fastify's normal parser and body limit.
    await app.register(async webhook => {
      webhook.removeContentTypeParser("application/json");
      webhook.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 16_384 }, (_request, raw, done) => done(null, raw));
      webhook.post("/webhooks/portone", { bodyLimit: 16_384 }, async (request, reply) => {
        if (service.mode === "mock" || !service.provider) throw new ServiceBillingError("WEBHOOK_NOT_CONFIGURED", 404);
        if (!Buffer.isBuffer(request.body)) throw new ServiceBillingError("INVALID_WEBHOOK_CONTENT_TYPE", 415);
        const headers: Record<string, string> = {};
        for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
          const value = request.headers[name];
          if (typeof value !== "string" || !value || value.length > 2048) throw new ServiceBillingError("INVALID_WEBHOOK_SIGNATURE", 400);
          headers[name] = value;
        }
        return reply.code(202).send(await service.acceptPortOneWebhook(request.body, headers));
      });
    });
  }, { prefix: "/service-billing" });
}
