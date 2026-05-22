import type { PrismaClient } from "@prisma/client";

export const authTestEmailPrefix = "auth-test-";

function isTestIsolatedDatabaseUrl(databaseUrl: string): boolean {
  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, "").toLowerCase();
  const schemaName = parsedUrl.searchParams.get("schema")?.toLowerCase() ?? "";

  return hasTestMarker(databaseName) || hasTestMarker(schemaName);
}

function hasTestMarker(value: string): boolean {
  return /(^|[_-])test($|[_-])/.test(value);
}

export function resolveApiTestDatabaseUrl(): string {
  const databaseUrl =
    process.env.API_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Set API_TEST_DATABASE_URL to a test-isolated PostgreSQL database before running API DB tests."
    );
  }

  if (!isTestIsolatedDatabaseUrl(databaseUrl)) {
    throw new Error(
      "Refusing to run API DB tests because the database URL is not test-isolated."
    );
  }

  return databaseUrl;
}

export async function cleanupAuthTestRecords(
  prisma: PrismaClient,
  emailPrefix = authTestEmailPrefix
) {
  const users = await prisma.user.findMany({
    where: {
      email: {
        startsWith: emailPrefix
      }
    },
    select: {
      id: true,
      memberships: {
        select: {
          workspaceId: true
        }
      }
    }
  });
  const userIds = users.map((user) => user.id);
  const workspaceIds = [
    ...new Set(
      users.flatMap((user) =>
        user.memberships.map((membership) => membership.workspaceId)
      )
    )
  ];

  if (workspaceIds.length > 0) {
    await prisma.workspace.deleteMany({
      where: {
        id: {
          in: workspaceIds
        }
      }
    });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIds
        }
      }
    });
  }
}
