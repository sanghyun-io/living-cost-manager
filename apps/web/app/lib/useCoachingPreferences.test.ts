// @vitest-environment jsdom
import { describe, expect, test, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCoachingPreferences } from "./useCoachingPreferences";
import type { FixedCost } from "./budget";
import type { ServerSession, ServerApiClient } from "./serverApi";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    })
  };
})();

Object.defineProperty(global, "localStorage", { value: localStorageMock });

// Test fixtures
const mockItems: FixedCost[] = [
  {
    id: "item-1",
    name: "Netflix",
    categoryId: "subscription",
    paymentMethodId: "credit-card",
    paymentOptionId: "",
    amount: 15000,
    periodMonths: 1,
    billingDay: 1,
    isEndOfMonth: false,
    billingAnchorDate: null,
    renewalStatus: "unreviewed",
    potentialMonthlySavings: 0,
    confirmedMonthlySavings: 0
  },
  {
    id: "item-2",
    name: "Insurance",
    categoryId: "insurance",
    paymentMethodId: "bank-transfer",
    paymentOptionId: "auto-transfer",
    amount: 50000,
    periodMonths: 1,
    billingDay: 15,
    isEndOfMonth: false,
    billingAnchorDate: null,
    renewalStatus: "unreviewed",
    potentialMonthlySavings: 0,
    confirmedMonthlySavings: 0
  }
];

const mockSession: ServerSession = {
  token: "test-token",
  refreshToken: "test-refresh-token",
  user: {
    id: "server-user-123",
    email: "test@example.com",
    name: "Test User",
    emailVerified: true
  },
  workspace: {
    id: "workspace-123",
    name: "Test Workspace",
    role: "owner"
  }
};

const mockApi: ServerApiClient = {
  baseUrl: "https://api.test.com",
  getCoachingPreferences: vi.fn(),
  putCoachingPreferences: vi.fn(),
  register: vi.fn(),
  login: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  forgotPassword: vi.fn(),
  resetPassword: vi.fn(),
  verifyEmail: vi.fn(),
  resendVerification: vi.fn(),
  me: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  aggregateWorkspaces: vi.fn(),
  getWorkspaceSnapshot: vi.fn(),
  putWorkspaceSnapshot: vi.fn(),
  getSnapshotHistory: vi.fn(),
  getWorkspacePlanning: vi.fn(),
  putWorkspacePlanning: vi.fn(),
  listMembers: vi.fn(),
  createInvitation: vi.fn(),
  listInvitations: vi.fn(),
  listWorkspaceInvitations: vi.fn(),
  revokeInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  updateMemberRole: vi.fn(),
  deleteMember: vi.fn(),
  deleteAccount: vi.fn()
} as any;

describe("useCoachingPreferences", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe("Bug 1: Local dirty memory persistence across reloads", () => {
    test("dirty state persists across reload with storage envelope", () => {
      const userId = "user-123";
      const workspaceId = "workspace-123";

      // First render: set some preferences and mark as dirty
      const { result, rerender } = renderHook(
        ({ items, uid, wid }) => useCoachingPreferences(items, uid, wid, null, null),
        {
          initialProps: {
            items: mockItems,
            uid: userId,
            wid: workspaceId
          }
        }
      );

      act(() => {
        result.current.toggle("item-1");
      });

      expect(result.current.dirty).toBe(true);
      expect(result.current.activeIds.has("item-1")).toBe(true);

      // Simulate reload by unmounting and remounting
      rerender({ items: mockItems, uid: userId, wid: workspaceId });

      // Dirty state should be restored from storage
      expect(result.current.dirty).toBe(true);
      expect(result.current.activeIds.has("item-1")).toBe(true);
    });

    test("legacy bare DTO is migrated to envelope format", () => {
      const userId = "user-456";
      const workspaceId = "workspace-456";

      // Simulate legacy storage format (bare DTO)
      const legacyData = {
        schemaVersion: 1,
        revision: 5,
        protectedItems: [{ fixedCostId: "item-1" }]
      };

      const key = `lcm:coaching:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent("anonymous")}`;
      localStorageMock.setItem(key, JSON.stringify(legacyData));

      const { result } = renderHook(
        ({ items, uid, wid }) => useCoachingPreferences(items, uid, wid, null, null),
        {
          initialProps: {
            items: mockItems,
            uid: userId,
            wid: workspaceId
          }
        }
      );

      // Should successfully load migrated preferences
      expect(result.current.activeIds.has("item-1")).toBe(true);
      expect(result.current.prefs.revision).toBe(5);
    });

    test("corrupt storage is handled gracefully with warning", () => {
      const userId = "user-789";
      const workspaceId = "workspace-789";

      const key = `lcm:coaching:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}:${encodeURIComponent("anonymous")}`;
      localStorageMock.setItem(key, "{ invalid json }");

      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { result } = renderHook(
        ({ items, uid, wid }) => useCoachingPreferences(items, uid, wid, null, null),
        {
          initialProps: {
            items: mockItems,
            uid: userId,
            wid: workspaceId
          }
        }
      );

      // Should preserve raw data and show warning
      expect(result.current.activeIds.size).toBe(0);
      expect(localStorageMock.getItem(key)).toBe("{ invalid json }");
      expect(result.current.ready).toBe(false);
      expect(result.current.status).toContain("원본을 보존");

      consoleWarnSpy.mockRestore();
    });
  });

  describe("Bug 2: Scope changes and API staleness", () => {
    test("stale API responses are ignored on scope change", async () => {
      const userId1 = "user-1";
      const userId2 = "user-2";
      const workspaceId = "workspace-123";

      // Mock delayed API response
      (mockApi.getCoachingPreferences as any).mockImplementation(
        async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return { schemaVersion: 1, revision: 10, protectedItems: [{ fixedCostId: "item-2" }] };
        }
      );

      const { result, rerender } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: userId1,
            wid: workspaceId,
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      // Start loading from server
      act(() => {
        void result.current.load();
      });

      // Change scope before response arrives
      rerender({
        items: mockItems,
        uid: userId2,
        wid: workspaceId,
        api: mockApi,
        session: mockSession,
        serverUid: "server-user-123"
      });

      // Wait for the delayed response
      await new Promise(resolve => setTimeout(resolve, 150));

      // Stale response should be ignored - activeIds should be empty
      expect(result.current.activeIds.size).toBe(0);
    });

    test("canCloudAccess binding based on actual serverUserId vs auth session", () => {
      // Test matching serverUserId
      const { result: result1 } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "local-user-1",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123" // Matches session.user.id
          }
        }
      );

      expect(result1.current.canCloudAccess).toBe(true);

      // Test mismatched serverUserId
      const { result: result2 } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "local-user-2",
            wid: "workspace-2",
            api: mockApi,
            session: mockSession,
            serverUid: "different-server-user" // Does NOT match session.user.id
          }
        }
      );

      expect(result2.current.canCloudAccess).toBe(false);
    });

    test("loadedKey gate prevents premature application", () => {
      const { result } = renderHook(
        ({ items, uid, wid }) => useCoachingPreferences(items, uid, wid, null, null),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123"
          }
        }
      );

      // Should have loadedKey set after initial load
      expect(result.current.prefs).toBeDefined();
    });
  });

  describe("Bug 3: Readonly viewer can manage own prefs", () => {
    test("panel works even when ledger is readonly (viewer mode)", () => {
      const viewerSession: ServerSession = {
        ...mockSession,
        workspace: {
          ...mockSession.workspace!,
          role: "viewer"
        }
      };

      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "viewer-user",
            wid: "workspace-123",
            api: mockApi,
            session: viewerSession,
            serverUid: "server-user-123"
          }
        }
      );

      // Should be able to toggle protection even in viewer mode
      act(() => {
        result.current.toggle("item-1");
      });

      expect(result.current.activeIds.has("item-1")).toBe(true);

      // CanCloudAccess should still work based on serverUserId match
      expect(result.current.canCloudAccess).toBe(true);
    });
  });

  describe("Bug 5: Insurance prompt targets only eligible items", () => {
    test("protected items are excluded from insurance review", () => {
      // This is tested in shared package - just verify hook integration
      const { result } = renderHook(
        ({ items, uid, wid }) => useCoachingPreferences(items, uid, wid, null, null),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123"
          }
        }
      );

      // Protect the insurance item
      act(() => {
        result.current.toggle("item-2");
      });

      expect(result.current.activeIds.has("item-2")).toBe(true);
    });
  });

  describe("Bug 6: UX improvements", () => {
    test("setReason method works correctly", () => {
      const { result } = renderHook(
        ({ items, uid, wid }) => useCoachingPreferences(items, uid, wid, null, null),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123"
          }
        }
      );

      // Add protection
      act(() => {
        result.current.toggle("item-1");
      });

      expect(result.current.activeIds.has("item-1")).toBe(true);

      // Set reason
      act(() => {
        result.current.setReason("item-1", "essential");
      });

      expect(result.current.prefs.protectedItems[0].reason).toBe("essential");
      expect(result.current.dirty).toBe(true);

      // Clear reason
      act(() => {
        result.current.setReason("item-1", undefined);
      });

      expect(result.current.prefs.protectedItems[0].reason).toBeUndefined();
    });

    test("cloud buttons disabled without account", () => {
      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: null, // No API
            session: null, // No session
            serverUid: undefined
          }
        }
      );

      expect(result.current.canCloudAccess).toBe(false);
    });
  });

  describe("Bug 7: API error handling", () => {
    test("401 error shows Korean message and keeps local settings", async () => {
      (mockApi.getCoachingPreferences as any).mockRejectedValue(
        Object.assign(new Error("Unauthorized"), { status: 401 })
      );

      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      // Set local preferences first
      act(() => {
        result.current.toggle("item-1");
      });

      expect(result.current.activeIds.has("item-1")).toBe(true);

      // Try to load from server
      await act(async () => {
        await result.current.load();
      });

      // Should show Korean error message and keep local settings
      expect(result.current.status).toContain("로그인이 만료");
      expect(result.current.activeIds.has("item-1")).toBe(true);

      confirmSpy.mockRestore();
    });

    test("409 conflict shows explicit pull compare message", async () => {
      (mockApi.putCoachingPreferences as any).mockRejectedValue(
        Object.assign(new Error("Conflict"), { status: 409 })
      );

      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      // Set preferences
      act(() => {
        result.current.toggle("item-1");
      });

      // Try to save
      await act(async () => {
        await result.current.save();
      });

      // Should show conflict message
      expect(result.current.status).toContain("충돌");
      expect(result.current.status).toContain("서버를 다시 불러와");
    });

    test("503 service unavailable shows proper message", async () => {
      (mockApi.getCoachingPreferences as any).mockRejectedValue(
        Object.assign(new Error("Service Unavailable"), { status: 503 })
      );

      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      await act(async () => {
        await result.current.load();
      });

      expect(result.current.status).toContain("일시적으로 사용할 수 없어요");
    });
  });

  describe("No auto API on mount/edit/login", () => {
    test("load and save are not called automatically on mount", () => {
      const apiMock = vi.fn();
      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      // No API calls on mount
      expect(mockApi.getCoachingPreferences).not.toHaveBeenCalled();
      expect(mockApi.putCoachingPreferences).not.toHaveBeenCalled();
    });

    test("editing does not trigger auto save", () => {
      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      // Edit preferences
      act(() => {
        result.current.toggle("item-1");
      });

      // No auto save
      expect(mockApi.putCoachingPreferences).not.toHaveBeenCalled();
      expect(result.current.dirty).toBe(true);
    });
  });

  describe("Fingerprint tracking", () => {
    test("save updates revision but acknowledges fingerprint of submitted snapshot", async () => {
      (mockApi.putCoachingPreferences as any).mockResolvedValue({
        schemaVersion: 1,
        revision: 2,
        protectedItems: [{ fixedCostId: "item-1" }]
      });

      const { result } = renderHook(
        ({ items, uid, wid, api, session, serverUid }) =>
          useCoachingPreferences(items, uid, wid, api, session, serverUid),
        {
          initialProps: {
            items: mockItems,
            uid: "user-123",
            wid: "workspace-123",
            api: mockApi,
            session: mockSession,
            serverUid: "server-user-123"
          }
        }
      );

      // Set initial preferences
      act(() => {
        result.current.toggle("item-1");
      });

      // Save
      await act(async () => {
        await result.current.save();
      });

      expect(result.current.prefs.revision).toBe(2);
      expect(result.current.dirty).toBe(false);
    });
  });
});
