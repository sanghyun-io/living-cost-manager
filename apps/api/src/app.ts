import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

import { type Env, loadEnv } from "./env.js";
import { authPlugin } from "./plugins/auth.js";
import { clearCachedPrismaClient, getPrismaClient } from "./prisma.js";
import { authRoutes } from "./routes/auth.js";
import { invitationRoutes } from "./routes/invitations.js";
import { memberRoutes } from "./routes/members.js";
import { snapshotRoutes } from "./routes/snapshot.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { createEmailProvider, type EmailProvider } from "./services/email.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    appEnv: Env;
    email: EmailProvider;
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
  app.decorate("appEnv", env);
  app.decorate("email", createEmailProvider(env, app.log));
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
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: "1 minute",
    // Disable limiting under test so suites can hammer auth endpoints freely.
    enableDraftSpec: false,
    allowList: env.NODE_ENV === "test" ? () => true : undefined
  });
  await app.register(authPlugin, {
    secret: env.JWT_SECRET,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL,
    refreshTtlSeconds: env.REFRESH_TOKEN_TTL
  });

  const registerApiRoutes = async (api: FastifyInstance) => {
    await api.register(authRoutes);
    await api.register(workspaceRoutes);
    await api.register(invitationRoutes);
    await api.register(memberRoutes);
    await api.register(snapshotRoutes);
    api.get("/health", async () => ({ ok: true }));
  };

  if (env.API_BASE_PATH) {
    await app.register(registerApiRoutes, { prefix: env.API_BASE_PATH });
  } else {
    await registerApiRoutes(app);
  }

  return app;
}
