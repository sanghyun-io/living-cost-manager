import { PrismaClient, type WorkspaceRole } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { DELETE_ACCOUNT_CONFLICT_CODE } from "@living-cost-manager/shared";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import {
  cleanupAuthTestRecords,
  resolveApiTestDatabaseUrl
} from "./test-database.js";

const accountTestEmailPrefix = "account-test-";
const databaseUrl = resolveApiTestDatabaseUrl();
const runId = `${accountTestEmailPrefix}${Date.now()}`;
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});

const prisma = new PrismaClient({
  datasourceUrl: databaseUrl
});
const app = await buildApp({ env, prisma });

const PASSWORD = "password123";

type RegisteredUser = {
  token: string;
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; role: string };
};

async function registerTestUser(name: string): Promise<RegisteredUser> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: `${runId}-${crypto.randomUUID()}@example.com`,
      password: PASSWORD,
      name
    }
  });

  expect(response.statusCode).toBe(201);
  const body = response.json<{ accessToken: string } & RegisteredUser>();
  return { ...body, token: body.accessToken };
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function deleteAccountRequest(token: string, password: string) {
  return app.inject({
    method: "DELETE",
    url: "/account",
    headers: authHeaders(token),
    payload: { password }
  });
}

/** Add a second member directly (mirrors sharing.test.ts fixtures). */
async function addWorkspaceMember(workspaceId: string, role: WorkspaceRole) {
  const member = await registerTestUser(`${role} member`);
  await prisma.workspaceMember.create({
    data: { workspaceId, userId: member.user.id, role }
  });
  return member;
}

async function userRows(userId: string) {
  return {
    user: await prisma.user.findUnique({ where: { id: userId } }),
    memberships: await prisma.workspaceMember.findMany({ where: { userId } })
  };
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanupAuthTestRecords(prisma, accountTestEmailPrefix);
});

afterEach(async () => {
  await cleanupAuthTestRecords(prisma, accountTestEmailPrefix);
});

afterAll(async () => {
  await cleanupAuthTestRecords(prisma, accountTestEmailPrefix);
  await app.close();
  await prisma.$disconnect();
});

describe("DELETE /account", () => {
  test("requires authentication", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/account",
      payload: { password: PASSWORD }
    });

    expect(response.statusCode).toBe(401);
  });

  test("rejects a malformed body with 400 before touching the database", async () => {
    const user = await registerTestUser("Malformed Body");

    const response = await app.inject({
      method: "DELETE",
      url: "/account",
      headers: authHeaders(user.token),
      payload: { password: "short" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: "Invalid request body" });

    const stored = await userRows(user.user.id);
    expect(stored.user).not.toBeNull();
    expect(stored.memberships).toHaveLength(1);
  });

  test("wrong password returns 401 and keeps the account intact", async () => {
    const user = await registerTestUser("Wrong Password");

    const response = await deleteAccountRequest(user.token, "wrong-password");

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ message: "Invalid credentials" });

    const stored = await userRows(user.user.id);
    expect(stored.user).not.toBeNull();
    expect(stored.memberships).toHaveLength(1);
    expect(await prisma.workspace.count({ where: { id: user.workspace.id } })).toBe(1);
  });

  test("solo account deletion hard-deletes the user and cascades every owned row", async () => {
    const user = await registerTestUser("Solo Deletion");

    // Seed server-side data that must vanish with the account: a shared-with-me
    // workspace membership, push rows, and auth tokens.
    const other = await registerTestUser("Other Owner");
    await prisma.workspaceMember.create({
      data: { workspaceId: other.workspace.id, userId: user.user.id, role: "editor" }
    });
    await prisma.pushSubscription.create({
      data: {
        userId: user.user.id,
        endpoint: `https://push.example/${crypto.randomUUID()}`,
        p256dh: "key",
        auth: "auth"
      }
    });
    await prisma.pushDelivery.create({
      data: { userId: user.user.id, dedupeKey: "2026-10-02" }
    });
    await prisma.passwordResetToken.create({
      data: {
        userId: user.user.id,
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.user.id,
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    // Data inside the user's own workspace, to be cascade-removed with it.
    const workspaceData = await prisma.$transaction(async (tx) => {
      const category = await tx.category.create({
        data: { workspaceId: user.workspace.id, id: "cat-del", label: `del-${Date.now()}` }
      });
      const card = await tx.paymentCard.create({
        data: {
          workspaceId: user.workspace.id,
          id: "card-del",
          label: "삭제카드",
          billingDay: 1
        }
      });
      const fixedCost = await tx.fixedCost.create({
        data: {
          workspaceId: user.workspace.id,
          id: "cost-del",
          name: "삭제고정비",
          categoryId: category.id,
          paymentMethodId: "card",
          paymentCardId: card.id,
          amount: 1000,
          billingDay: 1
        }
      });
      const backup = await tx.backupSnapshot.create({
        data: { workspaceId: user.workspace.id, payload: {} }
      });
      return { category, card, fixedCost, backup };
    });

    const response = await deleteAccountRequest(user.token, PASSWORD);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    expect(await prisma.user.findUnique({ where: { id: user.user.id } })).toBeNull();
    expect(
      await prisma.workspace.findUnique({ where: { id: user.workspace.id } })
    ).toBeNull();
    expect(
      await prisma.workspaceMember.findMany({ where: { userId: user.user.id } })
    ).toHaveLength(0);
    expect(
      await prisma.workspaceMember.findMany({
        where: { workspaceId: other.workspace.id, userId: user.user.id }
      })
    ).toHaveLength(0);
    expect(
      await prisma.pushSubscription.findMany({ where: { userId: user.user.id } })
    ).toHaveLength(0);
    expect(
      await prisma.pushDelivery.findMany({ where: { userId: user.user.id } })
    ).toHaveLength(0);
    expect(
      await prisma.passwordResetToken.findMany({ where: { userId: user.user.id } })
    ).toHaveLength(0);
    expect(
      await prisma.emailVerificationToken.findMany({ where: { userId: user.user.id } })
    ).toHaveLength(0);
    // Workspace-scoped children cascade with the workspace itself.
    expect(
      await prisma.category.findUnique({
        where: { workspaceId_id: { workspaceId: user.workspace.id, id: workspaceData.category.id } }
      })
    ).toBeNull();
    expect(
      await prisma.paymentCard.findUnique({
        where: { workspaceId_id: { workspaceId: user.workspace.id, id: workspaceData.card.id } }
      })
    ).toBeNull();
    expect(
      await prisma.fixedCost.findUnique({
        where: { workspaceId_id: { workspaceId: user.workspace.id, id: workspaceData.fixedCost.id } }
      })
    ).toBeNull();
    expect(
      await prisma.backupSnapshot.findUnique({ where: { id: workspaceData.backup.id } })
    ).toBeNull();

    // The other user's workspace (where the deleted account was only editor) survives.
    expect(
      await prisma.workspace.findUnique({ where: { id: other.workspace.id } })
    ).not.toBeNull();

    // Old access/refresh tokens are dead: authenticate() rejects a missing user.
    const meResponse = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeaders(user.token)
    });
    expect(meResponse.statusCode).toBe(401);

    const refreshResponse = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: user.token }
    });
    expect(refreshResponse.statusCode).toBe(401);
  });

  test("owner of a workspace with other members gets 409 and nothing is deleted", async () => {
    const owner = await registerTestUser("Conflict Owner");
    const editor = await addWorkspaceMember(owner.workspace.id, "editor");
    // A second, solo workspace must not make the whole call go through: the
    // deletion is all-or-nothing.
    const soloSecond = await prisma.workspace.create({
      data: { name: "Conflict Owner Solo" }
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: soloSecond.id, userId: owner.user.id, role: "owner" }
    });

    const response = await deleteAccountRequest(owner.token, PASSWORD);

    expect(response.statusCode).toBe(409);
    const body = response.json<{
      message: string;
      code: string;
      workspaces: Array<{ id: string; name: string }>;
    }>();
    expect(body.code).toBe(DELETE_ACCOUNT_CONFLICT_CODE);
    expect(body.workspaces).toEqual(
      expect.arrayContaining([{ id: owner.workspace.id, name: owner.workspace.name }])
    );
    // No member-privacy leak: only workspace id/name are enumerated.
    expect(response.body).not.toContain(editor.user.email);
    expect(response.body).not.toContain(editor.user.id);

    expect((await userRows(owner.user.id)).user).not.toBeNull();
    expect(
      await prisma.workspace.findUnique({ where: { id: owner.workspace.id } })
    ).not.toBeNull();
    expect(
      await prisma.workspace.findUnique({ where: { id: soloSecond.id } })
    ).not.toBeNull();
  });

  test("member-only (editor/viewer) deletions remove the membership and personal workspace only", async () => {
    const owner = await registerTestUser("Shared Workspace Owner");
    const member = await addWorkspaceMember(owner.workspace.id, "viewer");

    const response = await deleteAccountRequest(member.token, PASSWORD);

    expect(response.statusCode).toBe(204);

    expect(await prisma.user.findUnique({ where: { id: member.user.id } })).toBeNull();
    // The member's own (solo-owned) personal workspace is gone…
    expect(
      await prisma.workspace.findUnique({ where: { id: member.workspace.id } })
    ).toBeNull();
    // …but the shared workspace and its owner's membership survive.
    const sharedWorkspace = await prisma.workspace.findUnique({
      where: { id: owner.workspace.id }
    });
    expect(sharedWorkspace).not.toBeNull();
    const remainingMembers = await prisma.workspaceMember.findMany({
      where: { workspaceId: owner.workspace.id }
    });
    expect(remainingMembers).toHaveLength(1);
    expect(remainingMembers[0].userId).toBe(owner.user.id);
  });

  test("deleting an account leaves other owners' invitations intact", async () => {
    const owner = await registerTestUser("Invitation Owner");
    const member = await addWorkspaceMember(owner.workspace.id, "editor");
    await prisma.workspaceInvitation.create({
      data: {
        workspaceId: member.workspace.id,
        email: `${runId}-invitee@example.com`,
        role: "viewer",
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });

    const response = await deleteAccountRequest(member.token, PASSWORD);
    expect(response.statusCode).toBe(204);

    // Pending invitations on the deleted member's own workspace cascade away;
    // the other owner's workspace data is untouched.
    expect(
      await prisma.workspaceInvitation.findMany({
        where: { workspaceId: member.workspace.id }
      })
    ).toHaveLength(0);
    expect(
      await prisma.workspace.findUnique({ where: { id: owner.workspace.id } })
    ).not.toBeNull();
  });
});

describe("DELETE /workspaces/:workspaceId", () => {
  test("requires authentication", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/workspaces/does-not-matter"
    });
    expect(response.statusCode).toBe(401);
  });

  test("non-owner (editor/viewer/stranger) gets 403 and the workspace survives", async () => {
    const owner = await registerTestUser("WsDelete Owner");
    const editor = await addWorkspaceMember(owner.workspace.id, "editor");
    const stranger = await registerTestUser("WsDelete Stranger");

    for (const token of [editor.token, stranger.token]) {
      const response = await app.inject({
        method: "DELETE",
        url: `/workspaces/${owner.workspace.id}`,
        headers: authHeaders(token)
      });
      expect(response.statusCode).toBe(403);
      expect(
        await prisma.workspace.findUnique({ where: { id: owner.workspace.id } })
      ).not.toBeNull();
    }
  });

  test("owner can delete a workspace; members and children cascade", async () => {
    const owner = await registerTestUser("WsDelete Solo Owner");
    const editor = await addWorkspaceMember(owner.workspace.id, "editor");
    const category = await prisma.category.create({
      data: { workspaceId: owner.workspace.id, id: "cat-ws", label: `ws-${Date.now()}` }
    });
    await prisma.fixedCost.create({
      data: {
        workspaceId: owner.workspace.id,
        id: "cost-ws",
        name: "카드 삭제 고정비",
        categoryId: category.id,
        paymentMethodId: "card",
        amount: 2000,
        billingDay: 3
      }
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/workspaces/${owner.workspace.id}`,
      headers: authHeaders(owner.token)
    });

    expect(response.statusCode).toBe(204);
    expect(
      await prisma.workspace.findUnique({ where: { id: owner.workspace.id } })
    ).toBeNull();
    expect(
      await prisma.workspaceMember.findMany({ where: { workspaceId: owner.workspace.id } })
    ).toHaveLength(0);
    expect(
      await prisma.category.findMany({ where: { workspaceId: owner.workspace.id } })
    ).toHaveLength(0);
    expect(
      await prisma.fixedCost.findMany({ where: { workspaceId: owner.workspace.id } })
    ).toHaveLength(0);

    // Both users still exist with their personal workspaces intact.
    expect(await prisma.user.findUnique({ where: { id: editor.user.id } })).not.toBeNull();
    expect(
      await prisma.workspace.findUnique({ where: { id: editor.workspace.id } })
    ).not.toBeNull();
  });

  test("deleting a shared workspace does not delete the remaining members' accounts", async () => {
    const owner = await registerTestUser("Shared WsDelete Owner");
    const editor = await addWorkspaceMember(owner.workspace.id, "editor");

    const response = await app.inject({
      method: "DELETE",
      url: `/workspaces/${owner.workspace.id}`,
      headers: authHeaders(owner.token)
    });

    expect(response.statusCode).toBe(204);

    // Both accounts survive. The owner loses every membership (their only
    // workspace was the deleted one); the editor keeps their own personal
    // workspace membership.
    expect(await prisma.user.findUnique({ where: { id: owner.user.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: editor.user.id } })).not.toBeNull();
    expect(
      await prisma.workspaceMember.count({ where: { userId: owner.user.id } })
    ).toBe(0);
    const editorMemberships = await prisma.workspaceMember.findMany({
      where: { userId: editor.user.id }
    });
    expect(editorMemberships).toHaveLength(1);
    expect(editorMemberships[0].workspaceId).toBe(editor.workspace.id);
  });
});
