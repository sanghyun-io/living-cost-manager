import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
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
  // 보안 응답 헤더. 이 API 는 JSON 만 반환하므로(브라우저가 렌더할 문서 없음)
  // CSP 를 가장 엄격하게(default-src 'none') 둔다. HSTS 는 운영에서만 켠다
  // (로컬/테스트의 평문 HTTP 에서 HSTS 를 주면 이후 접속이 깨질 수 있음).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    hsts:
      env.NODE_ENV === "production"
        ? { maxAge: 60 * 60 * 24 * 180, includeSubDomains: true }
        : false,
    // 크로스 오리진 리소스 정책: SPA(별도 origin)가 API 를 fetch 하므로
    // cross-origin 을 허용해야 한다. CORS 화이트리스트가 실제 접근을 통제한다.
    crossOriginResourcePolicy: { policy: "cross-origin" }
  });
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    // @fastify/cors defaults to "GET,HEAD,POST", which rejects the snapshot PUT
    // and member/invitation PATCH/DELETE preflight requests from the browser.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
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
