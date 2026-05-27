// Shared types for page.tsx and its extracted components.
// Grouped prop bundles (SyncProps, SharingProps, DataModalProps) are added here
// as those components are extracted (Tasks 7-9).
import type { RefObject } from "react";
import type { InvitationRole, WorkspaceDto, WorkspaceInvitationDto, WorkspaceMemberDto, WorkspaceSnapshot } from "@living-cost-manager/shared";
import type { Category, FixedCost } from "./budget";
import type { PaymentCard } from "./cards";
import type { CreatedInvitation, ServerSession } from "./serverApi";
import type { AccountSyncState, BudgetSnapshotSummary, SyncStateView } from "./syncStatus";
import type { workspaceRoleLabels } from "./sharing";

type WorkspaceRole = keyof typeof workspaceRoleLabels;

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

// Grouped props for the server-sync section of DataModal.
export interface SyncProps {
  serverSession: ServerSession | null;
  syncStateView: SyncStateView;
  displayedSyncState: AccountSyncState;
  lastServerSyncedAt: Date | null;
  localSnapshotSummary: BudgetSnapshotSummary;
  serverSnapshotSummary: BudgetSnapshotSummary | null;
  serverSnapshot: WorkspaceSnapshot | null;
  serverWorkspaces: WorkspaceDto[];
  currentWorkspaceRole: WorkspaceRole | null;
  canUploadServerSnapshot: boolean;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  changeCurrentPassword: string;
  changeNewPassword: string;
  // Precomputed in page (avoids the component depending on snapshot builders).
  showUploadButton: boolean;
  showLoadButton: boolean;
  onServerLogout: () => void;
  onResendVerification: () => void;
  onChangePassword: () => void;
  onChangeCurrentPassword: (value: string) => void;
  onChangeNewPassword: (value: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onCheckServer: () => void;
  onSyncNow: () => void;
  onLoadSnapshot: () => void;
  onStayLocal: () => void;
  onOpenAuth: () => void;
  onExportBackup: () => void;
}

// Props for the DataModal container (import/export + server sync + sharing).
export interface DataModalProps {
  hasServerApi: boolean;
  importFileRef: RefObject<HTMLInputElement | null>;
  backupFileRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onExportTemplate: () => void;
  onImportTemplate: (file: File | null) => void;
  onExportBackup: () => void;
  onImportBackup: (file: File | null) => void;
  sync: SyncProps;
  sharing: SharingProps;
}
