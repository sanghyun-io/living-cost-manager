export type AppUser = {
  id: string;
  name: string;
};

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
