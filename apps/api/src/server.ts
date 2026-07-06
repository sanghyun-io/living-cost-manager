import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  const env = loadEnv();
  app = await buildApp({ env });
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: env.PORT
  });
} catch (error) {
  app?.log.error(error);

  if (!app) {
    console.error(error);
  }

  process.exit(1);
}
