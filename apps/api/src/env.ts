import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CORS_ORIGIN: z.url().default("https://sanghyun-io.github.io"),
  API_BASE_PATH: z
    .string()
    .trim()
    .regex(/^$|^\/[A-Za-z0-9/_-]+$/, "API_BASE_PATH must be empty or start with /")
    .transform((value) => value.replace(/\/+$/, ""))
    .default("")
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv | Record<string, unknown> = process.env): Env {
  return envSchema.parse(source);
}
