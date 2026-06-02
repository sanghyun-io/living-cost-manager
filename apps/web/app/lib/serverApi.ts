import type {
  AuthResponse,
  CreateInvitationRequest,
  InvitationRole,
  LoginRequest,
  RegisterRequest,
  UserDto,
  WorkspaceDto,
  WorkspaceInvitationDto,
  WorkspaceMemberDto,
  WorkspaceRole,
  WorkspaceSnapshot,
  SnapshotHistoryEntry
} from "@living-cost-manager/shared";

// Bumped to v2 because the session now stores a refresh token alongside the
// short-lived access token (`token`). Older v1 sessions are simply ignored.
export const SERVER_SESSION_STORAGE_KEY = "living-cost-manager:server-session:v2";

export type ServerSession = {
  token: string;
  refreshToken: string;
  user: UserDto;
  workspace: WorkspaceDto | null;
};

export type CreatedInvitation = WorkspaceInvitationDto & {
  token?: string;
};

export type AcceptInvitationResponse = {
  workspace: WorkspaceDto;
  member: WorkspaceMemberDto;
};

export type ServerApiClient = {
  readonly baseUrl: string;
  register(input: RegisterRequest): Promise<ServerSession>;
  login(input: LoginRequest): Promise<ServerSession>;
  refresh(refreshToken: string): Promise<ServerSession>;
  logout(token: string): Promise<void>;
  changePassword(currentPassword: string, newPassword: string, token: string): Promise<ServerSession>;
  forgotPassword(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  resendVerification(token: string): Promise<void>;
  me(token: string): Promise<{ user: UserDto }>;
  listWorkspaces(token: string): Promise<WorkspaceDto[]>;
  getWorkspaceSnapshot(workspaceId: string, token: string): Promise<WorkspaceSnapshot>;
  putWorkspaceSnapshot(workspaceId: string, snapshot: WorkspaceSnapshot, token: string): Promise<WorkspaceSnapshot>;
  getSnapshotHistory(workspaceId: string, token: string, limit?: number): Promise<SnapshotHistoryEntry[]>;
  listMembers(workspaceId: string, token: string): Promise<WorkspaceMemberDto[]>;
  createInvitation(workspaceId: string, input: CreateInvitationRequest, token: string): Promise<CreatedInvitation>;
  listInvitations(token: string): Promise<WorkspaceInvitationDto[]>;
  listWorkspaceInvitations(workspaceId: string, token: string): Promise<WorkspaceInvitationDto[]>;
  revokeInvitation(workspaceId: string, invitationId: string, token: string): Promise<void>;
  acceptInvitation(invitationId: string, tokenValue: string, token: string): Promise<AcceptInvitationResponse>;
  updateMemberRole(workspaceId: string, memberId: string, role: WorkspaceRole, token: string): Promise<WorkspaceMemberDto>;
  deleteMember(workspaceId: string, memberId: string, token: string): Promise<void>;
};

export class ServerApiError extends Error {
  readonly status: number;
  // Machine-readable error code from the API body (e.g. "EMAIL_NOT_VERIFIED").
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ServerApiError";
    this.status = status;
    this.code = code;
  }
}

// Stable code the API returns when a write/share endpoint is blocked because the
// caller's email is not yet verified. Kept in sync with the API's
// requireVerifiedEmail preHandler.
export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

export function isServerAuthFailure(error: unknown): boolean {
  // An email-verification block is a 403 but is NOT a session/permission
  // failure — exclude it so callers don't show a "log in again" message.
  if (isEmailNotVerifiedError(error)) {
    return false;
  }
  return error instanceof ServerApiError && (error.status === 401 || error.status === 403);
}

export function isEmailNotVerifiedError(error: unknown): boolean {
  return (
    error instanceof ServerApiError &&
    error.status === 403 &&
    error.code === EMAIL_NOT_VERIFIED_CODE
  );
}

type ClientOptions = {
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
};

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
};

export function getServerApiBaseUrl(value = process.env.NEXT_PUBLIC_API_BASE_URL): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

export function isServerApiAvailable(value = process.env.NEXT_PUBLIC_API_BASE_URL): boolean {
  return getServerApiBaseUrl(value) !== null;
}

export function createServerApiClient(options: ClientOptions = {}): ServerApiClient | null {
  const baseUrl = getServerApiBaseUrl(options.baseUrl ?? process.env.NEXT_PUBLIC_API_BASE_URL);
  if (!baseUrl) {
    return null;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const request = <T>(path: string, requestOptions: RequestOptions = {}) =>
    requestJson<T>(fetchImpl, baseUrl, path, requestOptions);

  const toSession = (response: AuthResponse): ServerSession => ({
    token: response.accessToken,
    refreshToken: response.refreshToken,
    user: response.user,
    workspace: response.workspace ?? null
  });

  return {
    baseUrl,
    async register(input) {
      return toSession(
        await request<AuthResponse>("/auth/register", { method: "POST", body: input })
      );
    },
    async login(input) {
      return toSession(
        await request<AuthResponse>("/auth/login", { method: "POST", body: input })
      );
    },
    async refresh(refreshToken) {
      return toSession(
        await request<AuthResponse>("/auth/refresh", {
          method: "POST",
          body: { refreshToken }
        })
      );
    },
    async logout(token) {
      await request<void>("/auth/logout", { method: "POST", token });
    },
    async changePassword(currentPassword, newPassword, token) {
      return toSession(
        await request<AuthResponse>("/auth/change-password", {
          method: "POST",
          token,
          body: { currentPassword, newPassword }
        })
      );
    },
    async forgotPassword(email) {
      await request<void>("/auth/forgot-password", { method: "POST", body: { email } });
    },
    async resetPassword(token, password) {
      await request<void>("/auth/reset-password", { method: "POST", body: { token, password } });
    },
    async verifyEmail(token) {
      await request<void>("/auth/verify-email", { method: "POST", body: { token } });
    },
    async resendVerification(token) {
      await request<void>("/auth/resend-verification", { method: "POST", token });
    },
    me(token) {
      return request<{ user: UserDto }>("/me", { token });
    },
    listWorkspaces(token) {
      return request<WorkspaceDto[]>("/workspaces", { token });
    },
    getWorkspaceSnapshot(workspaceId, token) {
      return request<WorkspaceSnapshot>("/workspaces/" + encodeURIComponent(workspaceId) + "/snapshot", { token });
    },
    putWorkspaceSnapshot(workspaceId, snapshot, token) {
      return request<WorkspaceSnapshot>("/workspaces/" + encodeURIComponent(workspaceId) + "/snapshot", {
        method: "PUT",
        token,
        body: snapshot
      });
    },
    async getSnapshotHistory(workspaceId, token, limit) {
      const query = typeof limit === "number" ? "?limit=" + limit : "";
      const result = await request<{ entries: SnapshotHistoryEntry[] }>(
        "/workspaces/" + encodeURIComponent(workspaceId) + "/snapshot/history" + query,
        { token }
      );
      return result.entries;
    },
    listMembers(workspaceId, token) {
      return request<WorkspaceMemberDto[]>("/workspaces/" + encodeURIComponent(workspaceId) + "/members", { token });
    },
    createInvitation(workspaceId, input, token) {
      return request<CreatedInvitation>("/workspaces/" + encodeURIComponent(workspaceId) + "/invitations", {
        method: "POST",
        token,
        body: input
      });
    },
    listInvitations(token) {
      return request<WorkspaceInvitationDto[]>("/invitations", { token });
    },
    listWorkspaceInvitations(workspaceId, token) {
      return request<WorkspaceInvitationDto[]>(
        "/workspaces/" + encodeURIComponent(workspaceId) + "/invitations",
        { token }
      );
    },
    async revokeInvitation(workspaceId, invitationId, token) {
      await request<void>(
        "/workspaces/" +
          encodeURIComponent(workspaceId) +
          "/invitations/" +
          encodeURIComponent(invitationId),
        {
          method: "DELETE",
          token
        }
      );
    },
    acceptInvitation(invitationId, tokenValue, token) {
      return request<AcceptInvitationResponse>("/invitations/" + encodeURIComponent(invitationId) + "/accept", {
        method: "POST",
        token,
        body: { token: tokenValue }
      });
    },
    updateMemberRole(workspaceId, memberId, role, token) {
      return request<WorkspaceMemberDto>(
        "/workspaces/" + encodeURIComponent(workspaceId) + "/members/" + encodeURIComponent(memberId),
        {
          method: "PATCH",
          token,
          body: { role }
        }
      );
    },
    async deleteMember(workspaceId, memberId, token) {
      await request<void>("/workspaces/" + encodeURIComponent(workspaceId) + "/members/" + encodeURIComponent(memberId), {
        method: "DELETE",
        token
      });
    }
  };
}

export async function resolveServerSessionWorkspace(
  client: ServerApiClient,
  session: ServerSession
): Promise<ServerSession> {
  const workspaces = await client.listWorkspaces(session.token);
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === session.workspace?.id) ?? workspaces[0] ?? null;

  return {
    ...session,
    workspace: selectedWorkspace
  };
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  options: RequestOptions
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = "Bearer " + options.token;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchImpl(baseUrl + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  if (!response.ok) {
    const { message, code } = await readError(response);
    throw new ServerApiError(message, response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function readError(response: Response): Promise<{ message: string; code: string | null }> {
  const fallback = response.statusText || "서버 요청에 실패했습니다.";
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { message: fallback, code: null };
  }

  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown };
    const rawMessage = typeof body.message === "string" ? body.message : body.error;
    const message =
      typeof rawMessage === "string" && rawMessage.trim().length > 0 ? rawMessage.trim() : fallback;
    const code = typeof body.code === "string" ? body.code : null;
    return { message, code };
  } catch {
    return { message: fallback, code: null };
  }
}
