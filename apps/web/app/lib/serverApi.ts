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
  WorkspaceSnapshot
} from "@living-cost-manager/shared";

export const SERVER_SESSION_STORAGE_KEY = "living-cost-manager:server-session:v1";

export type ServerSession = {
  token: string;
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
  me(token: string): Promise<{ user: UserDto }>;
  listWorkspaces(token: string): Promise<WorkspaceDto[]>;
  getWorkspaceSnapshot(workspaceId: string, token: string): Promise<WorkspaceSnapshot>;
  putWorkspaceSnapshot(workspaceId: string, snapshot: WorkspaceSnapshot, token: string): Promise<WorkspaceSnapshot>;
  listMembers(workspaceId: string, token: string): Promise<WorkspaceMemberDto[]>;
  createInvitation(workspaceId: string, input: CreateInvitationRequest, token: string): Promise<CreatedInvitation>;
  listInvitations(token: string): Promise<WorkspaceInvitationDto[]>;
  acceptInvitation(invitationId: string, tokenValue: string, token: string): Promise<AcceptInvitationResponse>;
  updateMemberRole(workspaceId: string, memberId: string, role: WorkspaceRole, token: string): Promise<WorkspaceMemberDto>;
  deleteMember(workspaceId: string, memberId: string, token: string): Promise<void>;
};

export class ServerApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ServerApiError";
    this.status = status;
  }
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

  return {
    baseUrl,
    async register(input) {
      const response = await request<AuthResponse>("/auth/register", {
        method: "POST",
        body: input
      });

      return {
        token: response.token,
        user: response.user,
        workspace: response.workspace
      };
    },
    async login(input) {
      const response = await request<AuthResponse & { workspace?: WorkspaceDto }>("/auth/login", {
        method: "POST",
        body: input
      });

      return {
        token: response.token,
        user: response.user,
        workspace: response.workspace ?? null
      };
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
    throw new ServerApiError(await readErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || "서버 요청에 실패했습니다.";
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return fallback;
  }

  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const message = typeof body.message === "string" ? body.message : body.error;
    return typeof message === "string" && message.trim().length > 0 ? message.trim() : fallback;
  } catch {
    return fallback;
  }
}
