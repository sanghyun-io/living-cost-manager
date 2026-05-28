import { z } from "zod";

const idSchema = z.string().min(1);

export const workspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const invitationRoleSchema = z.enum(["editor", "viewer"]);
export const workspaceInvitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const workspaceDtoSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  role: workspaceRoleSchema,
});

export const workspaceMemberDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  email: z.string().email(),
  name: z.string().min(1),
  role: workspaceRoleSchema,
});

export const workspaceInvitationDtoSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  email: z.string().email(),
  role: invitationRoleSchema,
  status: workspaceInvitationStatusSchema,
  expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable(),
});

export const createInvitationRequestSchema = z.object({
  email: z.string().email(),
  role: invitationRoleSchema.default("viewer"),
});

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(1),
});

export const updateMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
});

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type InvitationRole = z.infer<typeof invitationRoleSchema>;
export type WorkspaceInvitationStatus = z.infer<
  typeof workspaceInvitationStatusSchema
>;
export type WorkspaceDto = z.infer<typeof workspaceDtoSchema>;
export type WorkspaceMemberDto = z.infer<typeof workspaceMemberDtoSchema>;
export type WorkspaceInvitationDto = z.infer<
  typeof workspaceInvitationDtoSchema
>;
export type CreateInvitationRequestInput = z.input<
  typeof createInvitationRequestSchema
>;
export type CreateInvitationRequest = z.output<
  typeof createInvitationRequestSchema
>;
export type AcceptInvitationRequest = z.infer<
  typeof acceptInvitationRequestSchema
>;
export type UpdateMemberRoleRequest = z.infer<
  typeof updateMemberRoleRequestSchema
>;
