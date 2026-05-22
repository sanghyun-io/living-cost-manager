import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";

import { type Env, loadEnv } from "./env.js";
import { clearCachedPrismaClient, getPrismaClient } from "./prisma.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

type BuildAppOptions = {
  env?: Env;
  prisma?: PrismaClient;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const env = options.env ?? loadEnv();
  const prisma = options.prisma ?? getPrismaClient();
  const app = Fastify({
    logger: env.NODE_ENV !== "test"
  });

  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
      clearCachedPrismaClient(prisma);
    }
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGIN
  });

  app.get("/health", async () => ({ ok: true }));

  return app;
}
