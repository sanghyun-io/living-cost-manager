import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";

import { env } from "./env.js";

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV !== "test"
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGIN
  });

  app.get("/health", async () => ({ ok: true }));

  return app;
}
