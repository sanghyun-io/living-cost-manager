import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
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
  EMAIL_VERIFICATION_TTL: z.coerce.number().int().positive().default(60 * 60 * 24) // 24h
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): Env {
  return envSchema.parse(source);
}
