// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { DataModal } from "../app/components/modals/DataModal";
import type { DataModalProps } from "../app/lib/pageTypes";
import type {
  InvitationRole,
  UserDto,
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceInvitationStatus,
  WorkspaceMemberDto,
  WorkspaceRole
} from "@living-cost-manager/shared";
import type { ServerSession } from "../app/lib/serverApi";

// Minimal mantine mock for modal rendering
vi.mock("@mantine/core", async () => {
  const actual = await vi.importActual<typeof import("@mantine/core")>("@mantine/core");
  return {
    ...actual,
    Modal: ({ children, opened }: { children: React.ReactNode; opened: boolean }) =>
      opened ? React.createElement("div", { "data-testid": "modal" }, children) : null,
  };
});

import { MantineProvider } from "@mantine/core";

function renderModal(ui: React.ReactElement) {
  return render(React.createElement(MantineProvider, null, ui));
}

// Typed fixture helpers — produce values that exactly satisfy the shared
// zod-derived DTOs. Tests below override only the fields that matter, so the
// rest stay valid by construction. No `as any`, no `// @ts-ignore`.
function makeUserDto(overrides: Partial<UserDto> = {}): UserDto {
  return {
    id: "user-1",
    email: "test@example.com",
    name: "Test",
    emailVerified: true,
    ...overrides
  };
}

function makeWorkspaceDto(
  overrides: Partial<WorkspaceDto> & { role?: WorkspaceRole } = {}
): WorkspaceDto {
  return {
    id: "ws-1",
    name: "Test Ledger",
    role: "owner",
    ...overrides
  };
}

function makeServerSession(
  overrides: Partial<ServerSession> = {}
): ServerSession {
  return {
    token: "test-access-token",
    refreshToken: "test-refresh-token",
    user: makeUserDto(),
    workspace: makeWorkspaceDto(),
    ...overrides
  };
}

function makeMember(
  overrides: Partial<WorkspaceMemberDto> & { role?: WorkspaceRole } = {}
): WorkspaceMemberDto {
  return {
    id: "m1",
    workspaceId: "ws-1",
    userId: "user-2",
    email: "member@example.com",
    name: "Member",
    role: "editor",
    ...overrides
  };
}

function makeInvitation(
  overrides: Partial<WorkspaceInvitationDto> & {
    role?: InvitationRole;
    status?: WorkspaceInvitationStatus;
  } = {}
): WorkspaceInvitationDto {
  return {
    id: "inv-1",
    workspaceId: "ws-1",
    email: "invited@example.com",
    role: "viewer",
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    acceptedAt: null,
    ...overrides
  };
}

const createMockProps = (overrides: Partial<DataModalProps> = {}): DataModalProps => ({
  marketingConsent: {
    consent: { enabled: false, scope: null, browserOptOut: false },
    consentError: "",
    setEnabled: vi.fn()
  },
  importPreview: null,
  importMessage: "",
  onApplyImport: vi.fn(),
  onCancelImport: vi.fn(),
  opened: true,
  hasServerApi: true,
  importFileRef: { current: null },
  backupFileRef: { current: null },
  onClose: vi.fn(),
  onExportTemplate: vi.fn(),
  onImportTemplate: vi.fn(),
  onExportBackup: vi.fn(),
  onImportBackup: vi.fn(),
  sync: {
    autoSyncEnabled: false,
    canEnableAutoSync: false,
    onAutoSyncChange: vi.fn(),
    serverSession: null,
    syncStateView: { label: "로컬 전용", description: "", tone: "warning" },
    displayedSyncState: "local-only",
    lastServerSyncedAt: null,
    localSnapshotSummary: { monthlyIncome: 0, fixedCostCount: 0, monthlyExpense: 0, categoryCount: 0, cardCount: 0 },
    serverSnapshotSummary: null,
    serverSnapshot: null,
    serverWorkspaces: [],
    currentWorkspaceRole: null,
    canUploadServerSnapshot: false,
    isServerBusy: false,
    serverStatus: "",
    serverErrorKind: null,
    changeCurrentPassword: "",
    changeNewPassword: "",
    showUploadButton: false,
    showLoadButton: false,
    onServerLogout: vi.fn(),
    onResendVerification: vi.fn(),
    onChangePassword: vi.fn(),
    onChangeCurrentPassword: vi.fn(),
    onChangeNewPassword: vi.fn(),
    onCheckServer: vi.fn(),
    onSyncNow: vi.fn(),
    onLoadSnapshot: vi.fn(),
    onStayLocal: vi.fn(),
    onOpenAuth: vi.fn(),
    onExportBackup: vi.fn(),
    onOpenDeleteAccount: vi.fn()
  },
  sharing: {
    serverSession: null,
    members: [],
    invitations: [],
    sentInvitations: [],
    acceptTokens: {},
    inviteEmail: "",
    inviteRole: "viewer",
    visibleCreatedInvitation: null,
    canManageCurrentWorkspace: false,
    isServerBusy: false,
    onAcceptTokenChange: vi.fn(),
    onAcceptInvitation: vi.fn(),
    onRefreshSharing: vi.fn(),
    onCreateInvitation: vi.fn(),
    onInviteEmailChange: vi.fn(),
    onInviteRoleChange: vi.fn(),
    onUpdateMemberRole: vi.fn(),
    onDeleteMember: vi.fn(),
    onRevokeInvitation: vi.fn()
  },
  planning: {
    hasWorkspace: false,
    isViewer: false,
    canUpload: false,
    saveError: "",
    isBusy: false,
    serverSupport: "unknown",
    serverConfirmed: false,
    planningActive: false,
    serverDirty: false,
    hasRemoteDivergence: false,
    conflict: false,
    lastPlanningSyncedAt: null,
    statusMessage: "",
    localSummary: { weekCount: 0, reserveCount: 0, paydayDay: null },
    remoteStaged: null,
    onCheck: vi.fn(),
    onUpload: vi.fn(),
    onUploadOverwrite: vi.fn(),
    onAdoptRemote: vi.fn(),
    onCloseComparison: vi.fn(),
    onRetrySave: vi.fn()
  },
  ...overrides
});

describe("DataModal Cleanup UI", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("Guest Mode (no server session)", () => {
    test("shows compact local mode message and 1-line CTA", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      // local-mode message and login CTA both live inside ServerSyncPanel when API is configured.
      expect(screen.getByText("로컬 모드")).toBeDefined();
      expect(screen.getByText(/이 기기에만 저장됩니다/)).toBeDefined();
      expect(screen.getByText("다른 기기에서도 사용하려면 로그인하세요.")).toBeDefined();
    });

    test("has login CTA button", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByText("로그인")).toBeDefined();
    });

    test("no-API mode shows brief warning without exposing API URL jargon", () => {
      const props = createMockProps({ hasServerApi: false });
      renderModal(React.createElement(DataModal, props));
      // No need for users to see technical API URL jargon when API is not configured.
      expect(screen.queryByText(/API\s?URL/i)).toBeNull();
      // Brief notice still readable.
      expect(screen.getByText("이 기기에만 저장됩니다")).toBeDefined();
      expect(screen.getByText(/브라우저 데이터를 삭제하면.*사라집니다.*전체 백업을 보관하세요/)).toBeDefined();
    });

    test("no-API mode never suggests login when sync is unreachable", () => {
      const props = createMockProps({ hasServerApi: false });
      renderModal(React.createElement(DataModal, props));
      // Login would be misleading when the API isn't reachable; no login button should appear.
      expect(screen.queryByText("로그인")).toBeNull();
      expect(screen.queryByText(/다른 기기에서도 사용하려면 로그인하세요/)).toBeNull();
    });

    test("export/import buttons have Korean labels", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      // Look for buttons with "내보내기" or "가져오기"
      const buttons = screen.getAllByRole("button");
      const exportButtons = buttons.filter(b => b.getAttribute("aria-label")?.includes("내보내기"));
      const importButtons = buttons.filter(b => b.getAttribute("aria-label")?.includes("가져오기"));
      expect(exportButtons.length).toBeGreaterThanOrEqual(2); // CSV and LCM export
      expect(importButtons.length).toBeGreaterThanOrEqual(2); // CSV and LCM import
    });

    test("file inputs have unique accessible labels", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByLabelText("CSV 파일 가져오기")).toBeDefined();
      expect(screen.getByLabelText("전체 백업 파일 가져오기")).toBeDefined();
    });
  });

  describe("Signed In with Workspace", () => {
    test("manual save button always visible", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          displayedSyncState: "synced",
          showUploadButton: false // Even when false, button should still show
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByText("서버에 저장")).toBeDefined();
    });

    test("manual save button visible when showUploadButton is true", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          displayedSyncState: "needs-decision",
          showUploadButton: true
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByText("이 기기 데이터 저장")).toBeDefined();
    });

    test("read-only viewer cannot save but can check status", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession({
            workspace: makeWorkspaceDto({ role: "owner" })
          }),
          currentWorkspaceRole: "viewer",
          canUploadServerSnapshot: false,
          displayedSyncState: "synced",
          showLoadButton: true
        }
      });
      renderModal(React.createElement(DataModal, props));
      const saveButton = screen.getByText("서버에 저장");
      expect(saveButton).toBeDefined();
      expect((saveButton.closest("button") as HTMLButtonElement).disabled).toBe(true);
      const checkButton = screen.getByText("저장 상태 확인");
      expect(checkButton).toBeDefined();
      expect((checkButton.closest("button") as HTMLButtonElement).disabled).toBe(false);
      const loadButton = screen.getByText("서버에서 불러오기");
      expect(loadButton).toBeDefined();
      expect((loadButton.closest("button") as HTMLButtonElement).disabled).toBe(false);
    });

    test("manual save callback fires once when signed-synced", () => {
      const onSyncNow = vi.fn();
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          displayedSyncState: "synced",
          showUploadButton: false,
          canUploadServerSnapshot: true,
          onSyncNow
        }
      });
      renderModal(React.createElement(DataModal, props));
      const saveButton = screen.getByText("서버에 저장");
      fireEvent.click(saveButton);
      expect(onSyncNow).toHaveBeenCalledTimes(1);
    });

    test("check server callback fires from tertiary button", () => {
      const onCheckServer = vi.fn();
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          displayedSyncState: "synced",
          onCheckServer
        }
      });
      renderModal(React.createElement(DataModal, props));
      fireEvent.click(screen.getByText("저장 상태 확인"));
      expect(onCheckServer).toHaveBeenCalledTimes(1);
    });

    test("needs-decision renders local + server comparison", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          displayedSyncState: "needs-decision",
          localSnapshotSummary: { monthlyIncome: 1000000, fixedCostCount: 3, monthlyExpense: 500000, categoryCount: 4, cardCount: 2 },
          serverSnapshotSummary: { monthlyIncome: 800000, fixedCostCount: 2, monthlyExpense: 400000, categoryCount: 3, cardCount: 1 }
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByText("이 브라우저")).toBeDefined();
      expect(screen.getByText("서버 데이터")).toBeDefined();
    });

    test("busy state disables sync actions but preserves check button", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          displayedSyncState: "synced",
          isServerBusy: true,
          canUploadServerSnapshot: true
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect((screen.getByText("서버에 저장").closest("button") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText("저장 상태 확인").closest("button") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText("이 기기에서만 사용").closest("button") as HTMLButtonElement).disabled).toBe(true);
    });

    test("account delete entry accessible", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        }
      });
      renderModal(React.createElement(DataModal, props));
      // Find and click 계정 설정 to expand
      const settingsButton = screen.getByText("계정 설정");
      fireEvent.click(settingsButton);
      expect(screen.getByText("계정 삭제…")).toBeDefined();
    });

    test("auto-upload indicator visible outside account settings when autoSyncEnabled is true", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          autoSyncEnabled: true,
          canEnableAutoSync: true
        }
      });
      renderModal(React.createElement(DataModal, props));
      // Indicator must be reachable before expanding account settings (account settings collapse is closed by default).
      const indicator = screen.getByTestId("auto-upload-indicator");
      expect(indicator).toBeDefined();
      expect(indicator.textContent).toBe("자동 업로드 켜짐");
      // No PUT trigger: server-side handlers must not be invoked by the indicator itself.
      expect(props.sync.onSyncNow).not.toHaveBeenCalled();
      expect(props.sync.onAutoSyncChange).not.toHaveBeenCalled();
    });

    test("auto-upload indicator stays visible after account settings are expanded", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          autoSyncEnabled: true,
          canEnableAutoSync: true
        }
      });
      renderModal(React.createElement(DataModal, props));
      const settingsButton = screen.getByText("계정 설정");
      fireEvent.click(settingsButton);
      // Indicator must remain visible even after the collapse opens (it lives outside the collapse).
      expect(screen.getByTestId("auto-upload-indicator")).toBeDefined();
      expect(screen.getByText("자동 업로드 켜짐")).toBeDefined();
    });

    test("auto-upload indicator is absent when autoSyncEnabled is false", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          autoSyncEnabled: false,
          canEnableAutoSync: true
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect(screen.queryByTestId("auto-upload-indicator")).toBeNull();
      expect(screen.queryByText("자동 업로드 켜짐")).toBeNull();
    });

    test("account settings toggle exposes aria-expanded pointing at the settings panel", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        }
      });
      renderModal(React.createElement(DataModal, props));
      const settingsButton = screen.getByText("계정 설정").closest("button") as HTMLButtonElement;
      expect(settingsButton).toBeDefined();
      expect(settingsButton.getAttribute("aria-expanded")).toBe("false");
      const controlsId = settingsButton.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();
      expect(document.getElementById(controlsId!)).not.toBeNull();
      fireEvent.click(settingsButton);
      expect(settingsButton.getAttribute("aria-expanded")).toBe("true");
    });
  });

  describe("Import Preview", () => {
    test("always visible when present", () => {
      const props = createMockProps({
        importPreview: {
          currentCount: 5,
          targetCount: 10,
          currentAmount: 100000,
          targetAmount: 200000
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByText("가져오기 미리보기")).toBeDefined();
      expect(screen.getByText(/현재 5개/)).toBeDefined();
      expect(screen.getByText(/가져올 10개/)).toBeDefined();
      expect(screen.getByText("교체 적용")).toBeDefined();
      expect(screen.getByText("취소")).toBeDefined();
    });

    test("cancel callback works", () => {
      const onCancel = vi.fn();
      const props = createMockProps({
        importPreview: {
          currentCount: 5,
          targetCount: 10,
          currentAmount: 100000,
          targetAmount: 200000
        },
        onCancelImport: onCancel
      });
      renderModal(React.createElement(DataModal, props));
      fireEvent.click(screen.getByText("취소"));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("Sharing Panel", () => {
    test("details closed by default", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        },
        sharing: {
          ...createMockProps().sharing,
          serverSession: makeServerSession(),
          members: [makeMember({ id: "m1", name: "Member One", email: "m1@example.com", role: "editor" })]
        }
      });
      renderModal(React.createElement(DataModal, props));
      // Summary text should be visible.
      const summary = screen.getByText("공유 관리");
      expect(summary).toBeDefined();
      // The details element should NOT be open.
      const detailsEl = summary.closest("details") as HTMLDetailsElement | null;
      expect(detailsEl).not.toBeNull();
      expect(detailsEl!.open).toBe(false);
    });

    test("all collapsible sections start closed (privacy + sharing + settings)", async () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        },
        sharing: {
          ...createMockProps().sharing,
          serverSession: makeServerSession()
        }
      });
      renderModal(React.createElement(DataModal, props));
      // Marketing notice body not expanded — check via details.open
      const marketingSummary = screen.getByText("개인정보·사용통계");
      const marketingDetails = marketingSummary.closest("details") as HTMLDetailsElement | null;
      expect(marketingDetails!.open).toBe(false);
      // Sharing details closed
      const sharingSummary = screen.getByText("공유 관리");
      const sharingDetails = sharingSummary.closest("details") as HTMLDetailsElement | null;
      expect(sharingDetails!.open).toBe(false);
      // Account settings collapse closed by default — Mantine Collapse sets aria-hidden + inert on the inner Box.
      // Click the toggle to verify body becomes visible; this exercises the closed-by-default contract.
      const settingsButton = screen.getByText("계정 설정");
      const settingsToggle = settingsButton.closest("button") as HTMLButtonElement;
      expect(settingsToggle).toBeDefined();
      // The delete button exists in the DOM inside a Mantine Collapse, but the Collapse container
      // must hide it via aria-hidden + inert when closed.
      const deleteButton = screen.getByText("계정 삭제…").closest("button") as HTMLButtonElement;
      // Walk up to find the Mantine Collapse Box (the one with aria-hidden)
      let collapseEl: HTMLElement | null = deleteButton;
      while (collapseEl && collapseEl.getAttribute("aria-hidden") === null) {
        collapseEl = collapseEl.parentElement;
      }
      expect(collapseEl).not.toBeNull();
      expect(collapseEl!.getAttribute("aria-hidden")).toBe("true");
      // Clicking 계정 설정 should reveal the body.
      fireEvent.click(settingsToggle);
      // Check the actual ancestor that hid the action, not the button itself.
      await waitFor(() => expect(collapseEl!.getAttribute("aria-hidden")).not.toBe("true"));
      expect(settingsToggle.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("button", { name: "계정 삭제…" })).toBeDefined();
    });

    test("auto-opens when pending invitations exist", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        },
        sharing: {
          ...createMockProps().sharing,
          serverSession: makeServerSession(),
          invitations: [makeInvitation({ id: "inv1", email: "invited@example.com", workspaceId: "ws-1" })]
        }
      });
      renderModal(React.createElement(DataModal, props));
      // When pending invitations exist, the details auto-opens and the received-invitation section is rendered.
      expect(screen.getByText("받은 초대")).toBeDefined();
      const summary = screen.getByText("공유 관리");
      const detailsEl = summary.closest("details") as HTMLDetailsElement | null;
      expect(detailsEl!.open).toBe(true);
    });

    test("accept invitation callback fires once with current token", () => {
      const onAcceptInvitation = vi.fn();
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        },
        sharing: {
          ...createMockProps().sharing,
          serverSession: makeServerSession(),
          invitations: [makeInvitation({ id: "inv1", email: "invited@example.com", workspaceId: "ws-1" })],
          onAcceptInvitation
        }
      });
      renderModal(React.createElement(DataModal, props));
      fireEvent.click(screen.getByText("수락"));
      expect(onAcceptInvitation).toHaveBeenCalledTimes(1);
      expect(onAcceptInvitation).toHaveBeenCalledWith("inv1");
    });

    test("signed session without workspace still surfaces received invitations and accepts once", () => {
      const onAcceptInvitation = vi.fn();
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession({ workspace: null })
        },
        sharing: {
          ...createMockProps().sharing,
          serverSession: makeServerSession({ workspace: null }),
          invitations: [makeInvitation({ id: "inv2", email: "guest@example.com", workspaceId: "w2", role: "editor" })],
          onAcceptInvitation
        }
      });
      renderModal(React.createElement(DataModal, props));
      // The received-invitation section must remain visible when no workspace is selected yet.
      expect(screen.getByText("받은 초대")).toBeDefined();
      expect(screen.getByText("guest@example.com")).toBeDefined();
      // Server upload affordances stay gated by workspace scope.
      expect(screen.queryByText("서버에 저장")).toBeNull();
      expect(screen.queryByText("저장 상태 확인")).toBeNull();
      fireEvent.click(screen.getByText("수락"));
      expect(onAcceptInvitation).toHaveBeenCalledTimes(1);
      expect(onAcceptInvitation).toHaveBeenCalledWith("inv2");
    });

    test("sharing details fold closed after last invitation is accepted (no extra UI state)", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession()
        },
        sharing: {
          ...createMockProps().sharing,
          serverSession: makeServerSession(),
          invitations: []
        }
      });
      renderModal(React.createElement(DataModal, props));
      const summary = screen.getByText("공유 관리");
      const detailsEl = summary.closest("details") as HTMLDetailsElement | null;
      expect(detailsEl).not.toBeNull();
      expect(detailsEl!.open).toBe(false);
    });
  });

  describe("Marketing Consent", () => {
    test("collapsed by default", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      // Summary visible but content not expanded
      expect(screen.getByText("개인정보·사용통계")).toBeDefined();
    });

    test("shows all required notice on first open", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      const summary = screen.getByText("개인정보·사용통계");
      fireEvent.click(summary);
      // All key info should be visible when opened
      const content = screen.getByLabelText("개인정보·사용통계");
      expect(content.textContent).toContain("서비스 개선");
      expect(content.textContent).toContain("90일");
      expect(content.textContent).toContain("GPC/DNT");
      expect(content.textContent).toContain("인프라");
    });

    test("checkbox respects GPC/DNT", () => {
      const props = createMockProps({
        marketingConsent: {
          consent: { enabled: false, scope: null, browserOptOut: true },
          consentError: "",
          setEnabled: vi.fn()
        }
      });
      renderModal(React.createElement(DataModal, props));
      const summary = screen.getByText("개인정보·사용통계");
      fireEvent.click(summary);
      const checkbox = screen.getByTestId("marketing-consent") as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
    });
  });

  describe("Analytics Dashboard", () => {
    test("diagnostic AnalyticsDashboard is absent", () => {
      const props = createMockProps();
      renderModal(React.createElement(DataModal, props));
      // Should NOT find Analytics Dashboard title
      expect(screen.queryByText("개인 기기에서 확인하는 통계")).toBeNull();
      expect(screen.queryByText("내 브라우저 기록")).toBeNull();
    });
  });

  describe("Server Status Messages", () => {
    test("success message shortened", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          serverStatus: "서버 데이터를 불러왔습니다. 이전 데이터 복구 백업: backup-key-123",
          serverErrorKind: null
        }
      });
      renderModal(React.createElement(DataModal, props));
      // Should show shortened version
      expect(screen.getByText("서버 데이터를 불러왔어요. 이전 내용은 이 기기에 복구용으로 보관했습니다.")).toBeDefined();
    });

    test("error messages preserved", () => {
      const props = createMockProps({
        sync: {
          ...createMockProps().sync,
          serverSession: makeServerSession(),
          serverStatus: "인증이 만료되었습니다. 다시 로그인해 주세요.",
          serverErrorKind: "auth"
        }
      });
      renderModal(React.createElement(DataModal, props));
      expect(screen.getByText("인증이 만료되었습니다. 다시 로그인해 주세요.")).toBeDefined();
    });
  });
});
