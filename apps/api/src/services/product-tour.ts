import type { PrismaClient } from "@prisma/client";

export type ProductTourWriteStatus = "completed" | "skipped";
type StoredState = { version: number; status: ProductTourWriteStatus; updatedAt: Date };
export type ProductTourState = {
  version: 1;
  status: "unseen" | ProductTourWriteStatus;
  updatedAt: string | null;
};

function serialize(row: StoredState): ProductTourState {
  return { version: 1, status: row.status, updatedAt: row.updatedAt.toISOString() };
}

export async function getProductTourState(prisma: PrismaClient, userId: string): Promise<ProductTourState> {
  const row = await prisma.userProductTourState.findUnique({
    where: { userId_version: { userId, version: 1 } },
    select: { version: true, status: true, updatedAt: true }
  });
  return row ? serialize(row as StoredState) : { version: 1, status: "unseen", updatedAt: null };
}

export async function putProductTourState(
  prisma: PrismaClient, userId: string, status: ProductTourWriteStatus
): Promise<ProductTourState> {
  // One atomic statement: ON CONFLICT locks the row and evaluates against the
  // latest committed value. A stale skip can never overwrite completion.
  // No-op replays preserve the original timestamp. Parameters are never SQL identifiers.
  const [row] = await prisma.$queryRaw<StoredState[]>`
    INSERT INTO "UserProductTourState" ("userId", "version", "status", "updatedAt")
    VALUES (${userId}, 1, ${status}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "version") DO UPDATE SET
      "status" = CASE WHEN "UserProductTourState"."status" = 'completed'
        THEN 'completed' ELSE EXCLUDED."status" END,
      "updatedAt" = CASE WHEN "UserProductTourState"."status" = 'completed'
        OR "UserProductTourState"."status" = EXCLUDED."status"
        THEN "UserProductTourState"."updatedAt" ELSE EXCLUDED."updatedAt" END
    RETURNING "version", "status", "updatedAt"
  `;
  if (!row) throw new Error("Product tour write returned no state");
  return serialize(row);
}
