import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Non-secret release switch. Delivery/changes use opskv, not an independent
  // runtime .env edit. Publication alone never proves a paid entitlement.
  SERVICE_PAID_FEATURES_PUBLISHED: z.enum(["true", "false"]).default("false"),
  // Declared parameters only; provisioning/delivery must use opskv. No real
  // provider is enabled by these parameters in the phase-one implementation.
  SERVICE_BILLING_MODE: z.enum(["mock", "sandbox", "live"]).optional(),
  SERVICE_BILLING_MOCK_ENABLED: z.enum(["true", "false"]).optional(),
  SERVICE_BILLING_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
  SERVICE_BILLING_KEY_VERSION: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  SERVICE_BILLING_APPROVAL_MANIFEST: z.string().max(16000).optional(),
  PORTONE_LCM_API_SECRET: z.string().min(1).max(2048).optional(),
  PORTONE_LCM_WEBHOOK_SECRETS: z.string().max(4096).optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  RELEASE_SHA: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  LCM_RELEASE_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
  LCM_COMMIT_SHA: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  // Comma-separated list of allowed origins (supports running github.io and the
  // gamja.top domain side by side during the migration).
  CORS_ORIGIN: z
    .string()
    .default("https://living-cost-manager.gamja.top,https://sanghyun-io.github.io")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    ),
  API_BASE_PATH: z
    .string()
    .trim()
    .regex(/^$|^\/[A-Za-z0-9/_-]+$/, "API_BASE_PATH must be empty or start with /")
    .transform((value) => value.replace(/\/+$/, ""))
    .default(""),

  // Reverse-proxy hop trust for client-IP derivation in rate limiting.
  // Security review B1 (2026-10-06): "true" is forbidden — a blanket trust lets
  // any client spoof X-Forwarded-For and mint unlimited limit buckets, and also
  // changes req.ip for every route (auth brute-force caps included).
  //   off      — default; req.ip is the socket peer. Behind nginx/cloudflared this
  //              means anonymous share buckets key on the proxy socket, so they
  //              stay per-token (blast radius of one burst is that one share).
  //   loopback — trust X-Forwarded-For only when the immediate hop is loopback
  //              (nginx/cloudflared on the same host). Enable per instance ONLY
  //              after the read-only checks in docs/templates-security-20261006.md
  //              prove the proxy overwrites client-supplied XFF and the API port
  //              is not otherwise reachable. Until then, do not claim per-client
  //              anonymous separation.
  TRUST_PROXY: z.enum(["off", "loopback"]).default("off"),

  // Frontend base URL used to build password-reset / email-verification links.
  APP_BASE_URL: z.url().default("https://living-cost-manager.gamja.top"),

  // Email sending. Provider auto-selected by available keys unless EMAIL_PROVIDER is set.
  EMAIL_PROVIDER: z.enum(["resend", "smtp", "console"]).optional(),
  EMAIL_FROM: z.string().min(3).default("Living Cost Manager <noreply@gamja.top>"),
  RESEND_API_KEY: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),

  // Web Push(VAPID). All optional — when unset, push is disabled gracefully and
  // server boot is unaffected. VAPID_SUBJECT is a "mailto:..." string.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),

  // Token lifetimes (seconds). access short-lived, refresh long-lived.
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900), // 15m
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(60 * 60 * 24 * 7), // 7d
  PASSWORD_RESET_TTL: z.coerce.number().int().positive().default(60 * 60), // 1h
  EMAIL_VERIFICATION_TTL: z.coerce.number().int().positive().default(60 * 60 * 24), // 24h

  // Marketing event collector (익명 일별 집계). default off.
  // enabled=true 이면서 MARKETING_METRICS_FILE 이 절대경로일 때만 라우트가 등록된다.
  // 절대경로 검증/사유 판정은 resolveMarketingMetricsConfig 가 런타임에 한다 — 여기서는
  // 파싱만 하고, 오설정 하나가 재무 API 전체 부팅을 실패시키지 않도록 collector 만 끈다.
  // 운영자가 명시적으로 true 로 켰는데 파일 경로가 없거나 상대경로면 라우트가 미등록(404)
  // 되고 warn 로그 한 줄만 남는다(경로 값은 노출하지 않는다).
  MARKETING_METRICS_ENABLED: z.string().optional().transform((value) => value === "true"),
  MARKETING_METRICS_FILE: z.string().trim().optional()
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): Env {
  return envSchema.parse(source);
}
