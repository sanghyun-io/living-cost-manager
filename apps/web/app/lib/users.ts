export type AppUser = {
  id: string;
  name: string;
};

export type StartupServerUser = {
  email: string;
  name: string;
};

export const LOCAL_USER_NAME = "로컬 사용자";

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

export function resolveStartupUser(input: {
  users: AppUser[];
  activeUserId: string | null;
  serverUser: StartupServerUser | null;
}): { user: AppUser; users: AppUser[] } {
  const serverDisplayName = input.serverUser?.name || input.serverUser?.email;
  const selectedUser = serverDisplayName
    ? createUser(serverDisplayName)
    : input.users.find((user) => user.id === input.activeUserId) ?? createUser(LOCAL_USER_NAME);

  return {
    user: selectedUser,
    users: mergeUsers(input.users, selectedUser)
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
