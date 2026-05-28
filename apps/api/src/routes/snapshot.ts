import { workspaceSnapshotSchema } from "@living-cost-manager/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireWorkspaceRole } from "../services/membership.js";
import {
  getWorkspaceSnapshot,
  isSnapshotVersionConflictError,
  isSnapshotWriteValidationError,
  replaceWorkspaceSnapshot
} from "../services/snapshot.js";

const snapshotParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

function parseWorkspaceId(params: unknown): string {
  return snapshotParamsSchema.parse(params).workspaceId;
}

function hasConsistentWorkspaceIds(snapshot: {
  workspaceId: string;
  categories: Array<{ workspaceId: string }>;
  cards: Array<{ workspaceId: string }>;
  fixedCosts: Array<{ workspaceId: string }>;
}): boolean {
  return (
    snapshot.categories.every((category) => category.workspaceId === snapshot.workspaceId) &&
    snapshot.cards.every((card) => card.workspaceId === snapshot.workspaceId) &&
    snapshot.fixedCosts.every((fixedCost) => fixedCost.workspaceId === snapshot.workspaceId)
  );
}

export async function snapshotRoutes(app: FastifyInstance) {
  app.get(
    "/workspaces/:workspaceId/snapshot",
    { preHandler: app.authenticate },
    async (request) => {
      const workspaceId = parseWorkspaceId(request.params);

      await requireWorkspaceRole(app, request.user.sub, workspaceId, [
        "owner",
        "editor",
        "viewer"
      ]);

      return getWorkspaceSnapshot(app.prisma, workspaceId);
    }
  );

  app.put(
    "/workspaces/:workspaceId/snapshot",
    { preHandler: app.authenticate },
    async (request) => {
      const workspaceId = parseWorkspaceId(request.params);

      await requireWorkspaceRole(app, request.user.sub, workspaceId, [
        "owner",
        "editor"
      ]);

      const parsedBody = workspaceSnapshotSchema.safeParse(request.body);

      if (!parsedBody.success) {
        throw app.httpErrors.badRequest("Invalid request body");
      }

      if (parsedBody.data.workspaceId !== workspaceId) {
        throw app.httpErrors.badRequest("Workspace ID mismatch");
      }

      if (!hasConsistentWorkspaceIds(parsedBody.data)) {
        throw app.httpErrors.badRequest("Workspace ID mismatch");
      }

      try {
        return await replaceWorkspaceSnapshot(app.prisma, parsedBody.data);
      } catch (error) {
        if (isSnapshotVersionConflictError(error)) {
          // 동시 편집 충돌: 클라이언트가 보낸 syncVersion 이 서버보다 뒤처짐.
          // 409 + 현재 버전을 실어 클라이언트가 최신을 다시 받아가게 한다.
          throw app.httpErrors.conflict(
            `Snapshot version conflict (current: ${error.currentVersion})`
          );
        }

        if (isSnapshotWriteValidationError(error)) {
          throw app.httpErrors.badRequest("Invalid snapshot");
        }

        throw error;
      }
    }
  );
}
