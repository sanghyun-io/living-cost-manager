// Shared types for page.tsx and its extracted components.
// Grouped prop bundles (SyncProps, SharingProps, DataModalProps) are added here
// as those components are extracted (Tasks 7-9).
import type { InvitationRole, WorkspaceInvitationDto, WorkspaceMemberDto } from "@living-cost-manager/shared";
import type { Category, FixedCost } from "./budget";
import type { PaymentCard } from "./cards";
import type { CreatedInvitation, ServerSession } from "./serverApi";

// Local in-memory budget shape held by the Home component. Structurally
// equivalent to lib/snapshot.ts's LocalBudgetSnapshot (kept as a distinct alias
// for now to avoid a premature merge).
export type BudgetSnapshot = {
  monthlyIncome: number;
  fixedCosts: FixedCost[];
  categories: Category[];
  cards: PaymentCard[];
};

// Grouped props for the sharing (members + invitations) section of DataModal.
export interface SharingProps {
  serverSession: ServerSession | null;
  members: WorkspaceMemberDto[];
  invitations: WorkspaceInvitationDto[];
  acceptTokens: Record<string, string>;
  inviteEmail: string;
  inviteRole: InvitationRole;
  visibleCreatedInvitation: CreatedInvitation | null;
  canManageCurrentWorkspace: boolean;
  isServerBusy: boolean;
  onAcceptTokenChange: (invitationId: string, value: string) => void;
  onAcceptInvitation: (invitationId: string) => void;
  onRefreshSharing: () => void;
  onCreateInvitation: () => void;
  onInviteEmailChange: (value: string) => void;
  onInviteRoleChange: (role: InvitationRole) => void;
  onUpdateMemberRole: (memberId: string, role: WorkspaceMemberDto["role"]) => void;
  onDeleteMember: (memberId: string) => void;
}
