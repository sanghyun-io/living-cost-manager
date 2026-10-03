import { DELETE_ACCOUNT_CONFLICT_CODE, deleteAccountRequestSchema } from "@living-cost-manager/shared";
import type { FastifyInstance } from "fastify";

import {
  AccountInvalidCredentialsError,
  AccountUserNotFoundError,
  AccountWorkspaceConflictError,
  deleteAccount,
  isAccountTransactionConflictError
} from "../services/account.js";

// Same tight budget as the credential endpoints — this handler verifies an
// argon2 hash, so it is both security-sensitive and comparatively expensive.
const deleteAccountRateLimit = {
  rateLimit: {
    max: 5,
    timeWindow: "1 minute"
  }
};

export async function accountRoutes(app: FastifyInstance) {
  app.delete(
    "/account",
    { preHandler: app.authenticate, config: deleteAccountRateLimit },
    async (request, reply) => {
      const parsed = deleteAccountRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        throw app.httpErrors.badRequest("Invalid request body");
      }

      try {
        await deleteAccount(app.prisma, request.user.sub, parsed.data.password);
      } catch (error) {
        if (
          error instanceof AccountInvalidCredentialsError ||
          error instanceof AccountUserNotFoundError
        ) {
          // Same wording as /auth/login so the response never confirms whether
          // the account still exists.
          throw app.httpErrors.unauthorized("Invalid credentials");
        }

        if (error instanceof AccountWorkspaceConflictError) {
          // Fastify's default error serializer only whitelists
          // statusCode/error/message/code, so the blocking-workspace list is
          // sent as an explicit reply body rather than attached to the error.
          return reply.code(409).send({
            statusCode: 409,
            error: "Conflict",
            message: "Cannot delete account: transfer ownership of your shared workspaces first",
            code: DELETE_ACCOUNT_CONFLICT_CODE,
            // Ids + names only — no member-privacy data leaks in the conflict.
            workspaces: error.workspaces
          });
        }

        if (isAccountTransactionConflictError(error)) {
          throw app.httpErrors.conflict("Concurrent membership change, please retry");
        }

        throw error;
      }

      return reply.code(204).send();
    }
  );
}
