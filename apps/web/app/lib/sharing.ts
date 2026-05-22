import type { InvitationRole, WorkspaceMemberDto, WorkspaceRole } from "@living-cost-manager/shared";

export const workspaceRoleLabels: Record<WorkspaceRole, string> = {
  owner: "소유자",
  editor: "편집자",
  viewer: "보기 전용"
};

export const invitationRoleLabels: Record<InvitationRole, string> = {
  editor: "편집자",
  viewer: "보기 전용"
};

export function canManageSharing(currentRole: WorkspaceRole | null | undefined): boolean {
  return currentRole === "owner";
}

export function canSyncWorkspace(currentRole: WorkspaceRole | null | undefined): boolean {
  return currentRole === "owner" || currentRole === "editor";
}

export function findCurrentMember(
  members: WorkspaceMemberDto[],
  userId: string | null | undefined
): WorkspaceMemberDto | null {
  if (!userId) {
    return null;
  }

  return members.find((member) => member.userId === userId) ?? null;
}
