export type AppUser = {
  id: string;
  name: string;
  serverUserId?: string;
  templateReturnId?: string;
};

export type StartupServerUser = {
  id?: string;
  email: string;
  name: string;
};

export const LOCAL_USER_NAME = "로컬 사용자";

export function createServerLocalUser(user: StartupServerUser): AppUser {
  return user.id ? { id: "server:" + user.id, name: user.name || user.email, serverUserId: user.id } : createUser(user.name || user.email);
}

export function createUser(name: string): AppUser {
  const cleanName = name.trim();
  const displayName = cleanName.length > 0 ? cleanName : "사용자";

  return {
    id: createUserId(displayName),
    name: displayName
  };
}

export function mergeUsers(users: AppUser[], nextUser: AppUser): AppUser[] {
  const existingUser = users.find((user) => user.id === nextUser.id);
  if (existingUser) {
    return users;
  }

  return [...users, nextUser];
}

export function getUserDataKey(userId: string): string {
  return "living-cost-manager:user:" + encodeURIComponent(userId) + ":v1";
}

export function getUserErasureKey(userId: string): string {
  return getUserDataKey(userId) + ":erased";
}

export function resolveStartupUser(input: {
  users: AppUser[];
  activeUserId: string | null;
  serverUser: StartupServerUser | null;
}): { user: AppUser; users: AppUser[] } {
  const serverDisplayName = input.serverUser?.name || input.serverUser?.email;
  // Bind only the active legacy profile associated with the stored session.
  // Keep its storage key so unsynced edits and recovery copies remain reachable.
  const legacyId = serverDisplayName ? createUser(serverDisplayName).id : null;
  const linked = input.serverUser?.id ? input.users.find((user) => user.serverUserId === input.serverUser!.id) : undefined;
  const legacy = !linked && input.serverUser?.id && input.activeUserId === legacyId
    ? input.users.find((user) => user.id === legacyId && !user.serverUserId) : undefined;
  const migrated = legacy ? { ...legacy, serverUserId: input.serverUser!.id } : undefined;
  const users = migrated ? input.users.map((user) => user.id === migrated.id ? migrated : user) : input.users;
  const selectedUser = serverDisplayName
    ? linked ?? migrated ?? createServerLocalUser(input.serverUser!)
    : input.users.find((user) => user.id === input.activeUserId) ?? createUser(LOCAL_USER_NAME);

  return {
    user: selectedUser,
    users: mergeUsers(users, selectedUser)
  };
}

function createUserId(name: string): string {
  const asciiId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (asciiId.length > 0) {
    return asciiId;
  }

  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }

  return "user-" + hash.toString(36);
}
