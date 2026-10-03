import { z } from "zod";

/**
 * Account deletion contract (GDPR / 개인정보보호법 right-to-erasure).
 *
 * DELETE /v1/account hard-deletes the authenticated user. The password must be
 * re-confirmed in the request body because deletion is irreversible. A
 * successful deletion answers 204 No Content, so there is no success payload to
 * type beyond "no body"; the failure contract the SPA has to branch on is the
 * 409 conflict (still owning workspaces that have other members).
 */

export const deleteAccountRequestSchema = z.object({
  // Same bounds as the login/change-password schemas. Fastify's body limit is
  // the real DoS guard; capping here would permanently lock out accounts whose
  // original password exceeded the cap.
  password: z.string().min(8)
});

// Stable machine-readable code on the 409 body so the SPA can distinguish
// "transfer ownership first" from a generic conflict, the same way it does
// EMAIL_NOT_VERIFIED for the verification gate.
export const DELETE_ACCOUNT_CONFLICT_CODE = "WORKSPACE_HAS_OTHER_MEMBERS";

export const deleteAccountConflictSchema = z.object({
  statusCode: z.literal(409),
  error: z.string(),
  message: z.string(),
  code: z.literal(DELETE_ACCOUNT_CONFLICT_CODE)
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;
export type DeleteAccountConflict = z.infer<typeof deleteAccountConflictSchema>;

// 204 No Content: the client promise resolves without a body. Named type so
// serverApi.deleteAccount() and the tests share one contract name.
export type DeleteAccountResponse = void;

// DELETE /v1/workspaces/:id — owner-only hard delete, children removed via
// Prisma cascade. 204 No Content on success, so no body type either.
export type DeleteWorkspaceResponse = void;
