import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  MARKETING_METRICS_BODY_LIMIT_BYTES,
  MARKETING_METRICS_RATE_LIMIT_KEY,
  MARKETING_METRICS_RATE_LIMIT_MAX,
  MARKETING_METRICS_RATE_LIMIT_WINDOW_MS,
  MARKETING_METRICS_ROUTE_PATH,
  MarketingMetricsCapacityError,
  MarketingMetricsStore,
  MarketingMetricsUnavailableError,
  marketingEventRequestSchema,
  type MarketingMetricsNotice,
  hasPrivacyOptOutSignal,
  resolveMarketingMetricsConfig
} from "../services/marketing-metrics.js";

/**
 * 공개 마케팅 이벤트 수집 엔드포인트.
 *
 * - 인증 불필요(익명 집계), DB 사용 없음, **쓰기 전용**(읽기/통계 엔드포인트가 없다).
 * - 저장 조건: `MARKETING_METRICS_ENABLED=true` 이고 `MARKETING_METRICS_FILE` 이 절대경로.
 *   둘 중 하나라도 만족 못 하면 이 라우트는 아예 등록되지 않는다(404, default off).
 * - collector 초기화 실패(디스크/권한/파손)는 이 라우트만 fail-closed(503) 로 만들고,
 *   나머지 재무 API의 부팅/동작에는 영향을 주지 않는다(격리).
 * - 이 라우트의 요청/본문/쿼리/오류 로그는 app.ts 의 `disableRequestLogging` predicate 로
 *   완전히 무음화된다(저장/거절 모두에서 IP·UA 가 로그에 남지 않는다).
 */
export async function marketingRoutes(app: FastifyInstance): Promise<void> {
  const config = resolveMarketingMetricsConfig(app.appEnv);

  if (!config.enabled || config.filePath === null) {
    // default off 는 정상 상태라 조용히 건너뛴다. enabled 인데 경로가 잘못된 오설정만 알린다.
    if (config.disabledReason && config.disabledReason !== "not_enabled") {
      app.log.warn(
        { reason: "config_invalid", detail: config.disabledReason },
        "marketing metrics collector disabled (misconfigured)"
      );
    }
    return;
  }

  let store: MarketingMetricsStore;
  try {
    store = new MarketingMetricsStore({
      filePath: config.filePath,
      // notices 는 사유 코드/개수만 담는다 — 경로·본문·헤더 값은 여기로 흐르지 않는다.
      onNotice: (notice: MarketingMetricsNotice) => {
        const fields = {
          reason: notice.reason,
          errno: notice.errnoCode,
          droppedDays: notice.droppedDays
        };
        if (notice.level === "error") {
          app.log.error(fields, "marketing metrics collector fail-closed");
        } else {
          app.log.warn(fields, "marketing metrics collector notice");
        }
      }
    });
    await store.initialize();
  } catch {
    // 부팅을 막지 못하게 격리: collector 만 끄고 나머지는 정상 동작한다.
    // (initialize 자체는 throw 하지 않도록 설계됐지만 2차 방어선으로 둥지를 쓴다.)
    app.log.error({ reason: "config_invalid" }, "marketing metrics collector unavailable at startup");
    return;
  }

  app.addHook("onClose", async () => {
    await store.close();
  });

  /**
   * Reject query parameters after the global limiter and JSON parser.
   * Strict body validation precedes GPC/DNT handling in the handler below.
   */
  const guard = async (request: FastifyRequest): Promise<void> => {
    if (request.url.includes("?")) {
      // query string 은 어떤 필드도 실을 수 없다(timestamp/id/우회 시도 거부).
      throw app.httpErrors.badRequest("Query parameters are not allowed");
    }

  };

  /** 집계 엔드포인트 응답은 어떤 캐시에도 머물면 안 된다. */
  const noStore = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header("cache-control", "no-store");
  };

  app.post(
    MARKETING_METRICS_ROUTE_PATH,
    {
      // tiny 고정 상한(유효 본문은 45bytes 내외). 초과하면 handler 도달 전에 413.
      bodyLimit: MARKETING_METRICS_BODY_LIMIT_BYTES,
      logLevel: "silent",
      errorHandler: (error, _request, reply) => {
        const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 503;
        reply.code(status).send({ error: status >= 500 ? "Collection unavailable" : "Invalid request" });
      },
      preValidation: [guard],
      onSend: [noStore],
      config: {
        rateLimit: {
          // IP/UA 기반이 아니라 상수 키 하나로 프로세스 전체 공유 예산만 쓴다
          // → rate limit 저장소에 네트워크 식별자가 쌓이지 않는다.
          max: MARKETING_METRICS_RATE_LIMIT_MAX,
          timeWindow: MARKETING_METRICS_RATE_LIMIT_WINDOW_MS,
          keyGenerator: () => MARKETING_METRICS_RATE_LIMIT_KEY,
          // 전역 allowList(테스트에서 `() => true`)를 이 라우트에서 덮어써 항상 제한한다.
          allowList: () => false
        }
      }
    },
    async (request, reply) => {
      const parsed = marketingEventRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        // 본문의 어떤 값도 메시지에 넣지 않는다(개인정보/본문 유출 방지).
        throw app.httpErrors.badRequest("Invalid event payload");
      }

      if (hasPrivacyOptOutSignal(request.headers)) {
        return reply.code(202).send({ ok: true });
      }

      try {
        await store.record(parsed.data.event);
      } catch (error) {
        if (error instanceof MarketingMetricsCapacityError) {
          // 상한/대기열 초과: 저장소는 건강하지만 이번 이벤트는 거부(파일 미변경).
          throw app.httpErrors.insufficientStorage("Marketing event capacity reached");
        }
        if (error instanceof MarketingMetricsUnavailableError) {
          // 파손/IO/닫힘 → fail-closed. 기존 파일을 덮어쓰지 않는다.
          throw app.httpErrors.serviceUnavailable("Marketing events are not being recorded");
        }
        throw app.httpErrors.serviceUnavailable("Marketing events are not being recorded");
      }

      return reply.code(202).send({ ok: true });
    }
  );
}
