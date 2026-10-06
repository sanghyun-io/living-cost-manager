import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { templateBlueprintSchema, templateWriteSchema, templateUpdateSchema, templatePublishSchema } from "@living-cost-manager/shared";

const params = z.object({ id: z.string().min(1).max(100) }).strict();
const shareParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const SIZE_LIMIT = 100 * 1024;
const QUOTA = 20;
export async function templateRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate, bodyLimit: SIZE_LIMIT, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const verified = { ...auth, preHandler: app.requireVerifiedEmail };
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("X-Robots-Tag", "noindex, nofollow");
  });
  app.get("/templates", auth, async request => {
    const entries = await app.prisma.budgetTemplate.findMany({ where: { userId: request.user.sub }, orderBy: { createdAt: "desc" }, take: QUOTA, include: { share: true } });
    return entries.map(entry => ({ id: entry.id, revision: entry.revision, blueprint: templateBlueprintSchema.parse(entry.blueprint), published: !!entry.share && !entry.share.revokedAt && entry.share.expiresAt > new Date() }));
  });
  app.post("/templates", verified, async (request, reply) => {
    const parsed = templateWriteSchema.safeParse(request.body);
    if (!parsed.success) throw app.httpErrors.badRequest("Invalid blueprint; financial fields are not allowed");
    const entry = await app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${request.user.sub} FOR UPDATE`;
      if (await tx.budgetTemplate.count({ where: { userId: request.user.sub } }) >= QUOTA) throw app.httpErrors.conflict("Template quota (20) reached");
      return tx.budgetTemplate.create({ data: { userId: request.user.sub, blueprint: parsed.data.blueprint } });
    });
    return reply.code(201).send({ id: entry.id, revision: entry.revision, blueprint: entry.blueprint, published: false });
  });
  app.put("/templates/:id", verified, async request => {
    const id = params.safeParse(request.params);
    const input = templateUpdateSchema.safeParse(request.body);
    if (!id.success || !input.success) throw app.httpErrors.badRequest("Invalid template");
    return app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${request.user.sub} FOR UPDATE`;
      const entry = await tx.budgetTemplate.findFirst({ where: { id: id.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      if (entry.revision !== input.data.revision) throw app.httpErrors.conflict("Template changed; reload before saving");
      const updated = await tx.budgetTemplate.update({ where: { id: entry.id }, data: { blueprint: input.data.blueprint, revision: { increment: 1 } } });
      return { id: updated.id, revision: updated.revision, blueprint: updated.blueprint };
    });
  });
  app.post("/templates/:id/publish", verified, async request => {
    const id = params.safeParse(request.params);
    const input = templatePublishSchema.safeParse(request.body);
    if (!id.success || !input.success) throw app.httpErrors.badRequest("Review and rights confirmation required");
    return app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${request.user.sub} FOR UPDATE`;
      const entry = await tx.budgetTemplate.findFirst({ where: { id: id.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      if (entry.revision !== input.data.revision) throw app.httpErrors.conflict("Review the current saved version before publishing");
      const blueprint = templateBlueprintSchema.parse(entry.blueprint);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 90 * 86400000);
      await tx.budgetTemplateShare.upsert({ where: { templateId: entry.id }, create: { templateId: entry.id, token, blueprint, expiresAt }, update: { token, blueprint, expiresAt, revokedAt: null } });
      return { token, expiresAt: expiresAt.toISOString() };
    });
  });
  app.delete("/templates/:id/share", auth, async (request, reply) => {
    const input = params.safeParse(request.params);
    if (!input.success) throw app.httpErrors.badRequest("Invalid template");
    await app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${request.user.sub} FOR UPDATE`;
      const entry = await tx.budgetTemplate.findFirst({ where: { id: input.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      await tx.budgetTemplateShare.updateMany({ where: { templateId: entry.id }, data: { revokedAt: new Date() } });
    });
    return reply.code(204).send();
  });
  app.delete("/templates/:id", auth, async (request, reply) => {
    const input = params.safeParse(request.params);
    if (!input.success) throw app.httpErrors.badRequest("Invalid template");
    await app.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${request.user.sub} FOR UPDATE`;
      const entry = await tx.budgetTemplate.findFirst({ where: { id: input.data.id, userId: request.user.sub } });
      if (!entry) throw app.httpErrors.notFound("Template not found");
      await tx.budgetTemplate.delete({ where: { id: entry.id } });
    });
    return reply.code(204).send();
  });
  app.get("/template-shares/:token", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const input = shareParams.safeParse(request.params);
    if (!input.success) throw app.httpErrors.notFound("Share unavailable");
    const entry = await app.prisma.budgetTemplateShare.findFirst({ where: { token: input.data.token, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (!entry) throw app.httpErrors.notFound("Share unavailable");
    // Explicit public shape, no spreading ORM rows or ownership metadata.
    return { blueprint: templateBlueprintSchema.parse(entry.blueprint) };
  });
}
