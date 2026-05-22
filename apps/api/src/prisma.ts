import { PrismaClient } from "@prisma/client";

const prismaGlobalKey = "__livingCostManagerPrisma";

const globalForPrisma = globalThis as typeof globalThis & {
  [prismaGlobalKey]?: PrismaClient;
};

export function getPrismaClient(): PrismaClient {
  const cachedClient = globalForPrisma[prismaGlobalKey];

  if (cachedClient) {
    return cachedClient;
  }

  const client = new PrismaClient();

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma[prismaGlobalKey] = client;
  }

  return client;
}

export function clearCachedPrismaClient(client: PrismaClient): void {
  if (globalForPrisma[prismaGlobalKey] === client) {
    delete globalForPrisma[prismaGlobalKey];
  }
}
