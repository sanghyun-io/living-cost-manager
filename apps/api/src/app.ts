import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import Fastify from "fastify";

import { type Env, loadEnv } from "./env.js";
import { authPlugin } from "./plugins/auth.js";
import { clearCachedPrismaClient, getPrismaClient } from "./prisma.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { invitationRoutes } from "./routes/invitations.js";
import { marketingRoutes } from "./routes/marketing.js";
import { memberRoutes } from "./routes/members.js";
import { pushRoutes } from "./routes/push.js";
import { snapshotRoutes } from "./routes/snapshot.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { templateRoutes } from "./routes/templates.js";
import { createEmailProvider, type EmailProvider } from "./services/email.js";
import { shouldDisableRequestLogging } from "./services/marketing-metrics.js";
import { isTemplateRequest } from "./services/template-logging.js";
import { configureWebPush } from "./services/push.js";

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
  /**
   * 테스트/운영에서 커스텀 logger 를 주입할 때 쓴다(Fastify 는 인스턴스를
   * `loggerInstance` 로 받는다). 미주입 시 기존 동작 유지.
   */
  logger?: FastifyBaseLogger;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const env = options.env ?? loadEnv();
  const prisma = options.prisma ?? getPrismaClient();
  const app = Fastify({
    ...(options.logger ? { loggerInstance: options.logger } : { logger: env.NODE_ENV !== "test" }),
    // 마케팅 이벤트 수집 경로는 성공/거절/오류 어느 경우에도 요청·본문·쿼리를
    // 기록하지 않는다(IP/UA 가 로그에 남지 않도록). 다른 라우트의 보안 로그는
    // 그대로 유지된다 — predicate 가 해당 경로만 선별한다.
    disableRequestLogging: candidate => shouldDisableRequestLogging(candidate) || isTemplateRequest(candidate)
  });

  app.decorate("prisma", prisma);
  app.decorate("appEnv", env);
  app.decorate("email", createEmailProvider(env, app.log));
  // VAPID 설정(설정돼 있을 때만). 미설정이면 푸시는 비활성으로 동작한다.
  configureWebPush(env);
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
    await api.register(accountRoutes);
    await api.register(workspaceRoutes);
    await api.register(templateRoutes);
    await api.register(invitationRoutes);
    await api.register(memberRoutes);
    await api.register(snapshotRoutes);
    await api.register(pushRoutes);
    // 익명 마케팅 이벤트 수집(default off — env 게이트 안에서만 등록된다).
    await api.register(marketingRoutes);
    api.get("/health", async (_request, reply) => {
      const commitSha = env.RELEASE_SHA ?? env.LCM_COMMIT_SHA ?? "development";
      if (commitSha !== "development") reply.header("X-Release-Sha", commitSha);
      return {
        ok: true,
        releaseId: env.RELEASE_SHA ? `lcm-${env.RELEASE_SHA}` : env.LCM_RELEASE_ID ?? "development",
        commitSha
      };
    });
  };

  if (env.API_BASE_PATH) {
    await app.register(registerApiRoutes, { prefix: env.API_BASE_PATH });
  } else {
    await registerApiRoutes(app);
  }

  return app;
}
