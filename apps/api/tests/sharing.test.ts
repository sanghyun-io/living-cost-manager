import { PrismaClient, type WorkspaceInvitationRole, type WorkspaceRole } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import {
  cleanupAuthTestRecords,
  resolveApiTestDatabaseUrl
} from "./test-database.js";
import {
  createWorkspaceInvitation,
  WorkspaceInvitationAuthorizationError
} from "../src/services/invitations.js";
import {
  deleteWorkspaceMember,
  updateWorkspaceMemberRole,
  WorkspaceMemberAuthorizationError
} from "../src/services/membership.js";

const sharingTestEmailPrefix = "sharing-test-";
const databaseUrl = resolveApiTestDatabaseUrl();
const runId = `${sharingTestEmailPrefix}${Date.now()}`;
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});

const prisma = new PrismaClient({
  datasourceUrl: databaseUrl
});
const app = await buildApp({ env, prisma });

type RegisteredUser = {
  token: string;
  user: {
    id: string;
    email: string;
    name: string;
  };
  workspace: {
    id: string;
    name: string;
    role: string;
  };
};

type InvitationCreateResponse = {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceInvitationRole;
  expiresAt: string;
  acceptedAt: string | null;
  token: string;
};

function hashTestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function registerTestUser(name: string, email?: string): Promise<RegisteredUser> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: email ?? `${runId}-${crypto.randomUUID()}@example.com`,
      password: "password123",
      name
    }
  });

  expect(response.statusCode).toBe(201);

  return response.json<RegisteredUser>();
}

async function addWorkspaceMember(workspaceId: string, role: WorkspaceRole) {
  const member = await registerTestUser(`${role} User`);

  await prisma.workspaceMember.create({
    data: {
      workspaceId,
      userId: member.user.id,
      role
    }
  });

  return member;
}

function authHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`
  };
}

async function createInvitation(
  ownerToken: string,
  workspaceId: string,
  email: string,
  role: WorkspaceInvitationRole = "viewer"
) {
  return app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/invitations`,
    headers: authHeaders(ownerToken),
    payload: {
      email,
      role
    }
  });
}

async function createAcceptedMember(
  owner: RegisteredUser,
  role: WorkspaceInvitationRole = "viewer"
) {
  const invitee = await registerTestUser(`Accepted ${role}`);
  const invitationResponse = await createInvitation(
    owner.token,
    owner.workspace.id,
    invitee.user.email,
    role
  );
  expect(invitationResponse.statusCode).toBe(201);

  const invitation = invitationResponse.json<InvitationCreateResponse>();
  const acceptResponse = await app.inject({
    method: "POST",
    url: `/invitations/${invitation.id}/accept`,
    headers: authHeaders(invitee.token),
    payload: {
      token: invitation.token
    }
  });
  expect(acceptResponse.statusCode).toBe(200);

  return {
    invitee,
    invitation,
    accept: acceptResponse.json<{
      workspace: { id: string; name: string; role: WorkspaceRole };
      member: {
        id: string;
        workspaceId: string;
        userId: string;
        email: string;
        name: string;
        role: WorkspaceRole;
      };
    }>()
  };
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanupAuthTestRecords(prisma, sharingTestEmailPrefix);
});

afterEach(async () => {
  await cleanupAuthTestRecords(prisma, sharingTestEmailPrefix);
});

afterAll(async () => {
  await cleanupAuthTestRecords(prisma, sharingTestEmailPrefix);
  await app.close();
  await prisma.$disconnect();
});

describe("workspace sharing routes", () => {
  test("registered user can list their personal workspace", async () => {
    const owner = await registerTestUser("Workspace List Owner");

    const response = await app.inject({
      method: "GET",
      url: "/workspaces",
      headers: authHeaders(owner.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: owner.workspace.id,
        name: owner.workspace.name,
        role: "owner"
      }
    ]);
  });

  test("user who accepted an invite sees the shared workspace in their workspace list", async () => {
    const owner = await registerTestUser("Workspace Invite Owner");
    const accepted = await createAcceptedMember(owner, "editor");

    const response = await app.inject({
      method: "GET",
      url: "/workspaces",
      headers: authHeaders(accepted.invitee.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.arrayContaining([
        {
          id: accepted.invitee.workspace.id,
          name: accepted.invitee.workspace.name,
          role: "owner"
        },
        {
          id: owner.workspace.id,
          name: owner.workspace.name,
          role: "editor"
        }
      ])
    );
  });

  test("workspace list requires authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/workspaces"
    });

    expect(response.statusCode).toBe(401);
  });

  test("owner can invite a registered user and the user can accept with the assigned role", async () => {
    const owner = await registerTestUser("Sharing Owner");
    const invitee = await registerTestUser("Invitee", `${runId}-Invitee@example.com`);

    const invitationResponse = await createInvitation(
      owner.token,
      owner.workspace.id,
      `  ${invitee.user.email.toUpperCase()}  `,
      "editor"
    );

    expect(invitationResponse.statusCode).toBe(201);
    const invitation = invitationResponse.json<InvitationCreateResponse>();
    expect(invitation).toMatchObject({
      id: expect.any(String),
      workspaceId: owner.workspace.id,
      email: invitee.user.email,
      role: "editor",
      expiresAt: expect.any(String),
      acceptedAt: null,
      token: expect.any(String)
    });

    const storedInvitation = await prisma.workspaceInvitation.findUnique({
      where: {
        id: invitation.id
      }
    });
    expect(storedInvitation).toMatchObject({
      email: invitee.user.email,
      role: "editor",
      status: "pending",
      acceptedAt: null
    });
    expect(storedInvitation?.tokenHash).toEqual(expect.any(String));
    expect(storedInvitation?.tokenHash).not.toBe(invitation.token);
    expect(JSON.stringify(storedInvitation)).not.toContain(invitation.token);

    const acceptResponse = await app.inject({
      method: "POST",
      url: `/invitations/${invitation.id}/accept`,
      headers: authHeaders(invitee.token),
      payload: {
        token: invitation.token
      }
    });

    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json()).toEqual({
      workspace: {
        id: owner.workspace.id,
        name: owner.workspace.name,
        role: "editor"
      },
      member: {
        id: expect.any(String),
        workspaceId: owner.workspace.id,
        userId: invitee.user.id,
        email: invitee.user.email,
        name: invitee.user.name,
        role: "editor"
      }
    });

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: invitee.user.id
        }
      }
    });
    expect(membership?.role).toBe("editor");

    const acceptedInvitation = await prisma.workspaceInvitation.findUnique({
      where: {
        id: invitation.id
      }
    });
    expect(acceptedInvitation).toMatchObject({
      acceptedAt: expect.any(Date),
      status: "accepted"
    });
  });

  test("owner, editor, and viewer can list members", async () => {
    const owner = await registerTestUser("List Owner");
    const editor = await createAcceptedMember(owner, "editor");
    const viewer = await createAcceptedMember(owner, "viewer");

    for (const token of [owner.token, editor.invitee.token, viewer.invitee.token]) {
      const response = await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspace.id}/members`,
        headers: authHeaders(token)
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: owner.workspace.id,
            userId: owner.user.id,
            email: owner.user.email,
            name: owner.user.name,
            role: "owner"
          }),
          expect.objectContaining({
            workspaceId: owner.workspace.id,
            userId: editor.invitee.user.id,
            email: editor.invitee.user.email,
            name: editor.invitee.user.name,
            role: "editor"
          }),
          expect.objectContaining({
            workspaceId: owner.workspace.id,
            userId: viewer.invitee.user.id,
            email: viewer.invitee.user.email,
            name: viewer.invitee.user.name,
            role: "viewer"
          })
        ])
      );
    }
  });

  test("editor, viewer, and non-member cannot invite, change, or delete members", async () => {
    const owner = await registerTestUser("Manage Owner");
    const editor = await addWorkspaceMember(owner.workspace.id, "editor");
    const viewer = await addWorkspaceMember(owner.workspace.id, "viewer");
    const nonMember = await registerTestUser("Manage Non Member");
    const target = await addWorkspaceMember(owner.workspace.id, "viewer");
    const targetMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: target.user.id
        }
      }
    });

    for (const user of [editor, viewer, nonMember]) {
      expect(
        (
          await createInvitation(
            user.token,
            owner.workspace.id,
            `${runId}-${crypto.randomUUID()}@example.com`
          )
        ).statusCode
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/workspaces/${owner.workspace.id}/members/${targetMembership.id}`,
            headers: authHeaders(user.token),
            payload: {
              role: "editor"
            }
          })
        ).statusCode
      ).toBe(403);

      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/workspaces/${owner.workspace.id}/members/${targetMembership.id}`,
            headers: authHeaders(user.token)
          })
        ).statusCode
      ).toBe(403);
    }
  });

  test("non-member cannot list members", async () => {
    const owner = await registerTestUser("Private Owner");
    const nonMember = await registerTestUser("Private Non Member");

    const response = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspace.id}/members`,
      headers: authHeaders(nonMember.token)
    });

    expect(response.statusCode).toBe(403);
  });

  test("GET invitations lists only the current user's pending unexpired invitations", async () => {
    const owner = await registerTestUser("Invitations Owner");
    const expiredOwner = await registerTestUser("Expired Invitations Owner");
    const acceptedOwner = await registerTestUser("Accepted Invitations Owner");
    const currentUser = await registerTestUser("Pending Invitee");
    const otherUser = await registerTestUser("Other Invitee");
    const currentInvitationResponse = await createInvitation(
      owner.token,
      owner.workspace.id,
      currentUser.user.email,
      "viewer"
    );
    const otherInvitationResponse = await createInvitation(
      owner.token,
      owner.workspace.id,
      otherUser.user.email,
      "editor"
    );
    const expiredInvitationResponse = await createInvitation(
      expiredOwner.token,
      expiredOwner.workspace.id,
      currentUser.user.email,
      "editor"
    );
    const acceptedInvitationResponse = await createInvitation(
      acceptedOwner.token,
      acceptedOwner.workspace.id,
      currentUser.user.email,
      "viewer"
    );

    expect(currentInvitationResponse.statusCode).toBe(201);
    expect(otherInvitationResponse.statusCode).toBe(201);
    expect(expiredInvitationResponse.statusCode).toBe(201);
    expect(acceptedInvitationResponse.statusCode).toBe(201);

    const currentInvitation = currentInvitationResponse.json<InvitationCreateResponse>();
    const otherInvitation = otherInvitationResponse.json<InvitationCreateResponse>();
    const expiredInvitation = expiredInvitationResponse.json<InvitationCreateResponse>();
    const acceptedInvitation = acceptedInvitationResponse.json<InvitationCreateResponse>();

    await prisma.workspaceInvitation.update({
      where: {
        id: expiredInvitation.id
      },
      data: {
        expiresAt: new Date(Date.now() - 1000)
      }
    });
    await prisma.workspaceInvitation.update({
      where: {
        id: acceptedInvitation.id
      },
      data: {
        acceptedAt: new Date(),
        status: "accepted"
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/invitations",
      headers: authHeaders(currentUser.token)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: currentInvitation.id,
        workspaceId: owner.workspace.id,
        email: currentUser.user.email,
        role: "viewer",
        expiresAt: currentInvitation.expiresAt,
        acceptedAt: null
      }
    ]);
    expect(response.body).not.toContain(currentInvitation.token);
    expect(response.body).not.toContain(otherInvitation.id);
    expect(response.body).not.toContain(expiredInvitation.id);
    expect(response.body).not.toContain(acceptedInvitation.id);
  });

  test("accept rejects wrong email, wrong token, expired invitation, and already accepted invitation", async () => {
    const wrongEmailOwner = await registerTestUser("Wrong Email Owner");
    const wrongTokenOwner = await registerTestUser("Wrong Token Owner");
    const expiredOwner = await registerTestUser("Expired Owner");
    const acceptedOwner = await registerTestUser("Accepted Owner");
    const wrongEmailInvitee = await registerTestUser("Wrong Email Invitee");
    const wrongTokenInvitee = await registerTestUser("Wrong Token Invitee");
    const expiredInvitee = await registerTestUser("Expired Invitee");
    const acceptedInvitee = await registerTestUser("Accepted Invitee");
    const wrongUser = await registerTestUser("Wrong Email User");

    const wrongEmailInvitationResponse = await createInvitation(
      wrongEmailOwner.token,
      wrongEmailOwner.workspace.id,
      wrongEmailInvitee.user.email
    );
    const wrongTokenInvitationResponse = await createInvitation(
      wrongTokenOwner.token,
      wrongTokenOwner.workspace.id,
      wrongTokenInvitee.user.email
    );
    const expiredInvitationResponse = await createInvitation(
      expiredOwner.token,
      expiredOwner.workspace.id,
      expiredInvitee.user.email
    );
    const acceptedInvitationResponse = await createInvitation(
      acceptedOwner.token,
      acceptedOwner.workspace.id,
      acceptedInvitee.user.email
    );

    expect(wrongEmailInvitationResponse.statusCode).toBe(201);
    expect(wrongTokenInvitationResponse.statusCode).toBe(201);
    expect(expiredInvitationResponse.statusCode).toBe(201);
    expect(acceptedInvitationResponse.statusCode).toBe(201);

    const wrongEmailInvitation =
      wrongEmailInvitationResponse.json<InvitationCreateResponse>();
    const wrongTokenInvitation =
      wrongTokenInvitationResponse.json<InvitationCreateResponse>();
    const expiredInvitation =
      expiredInvitationResponse.json<InvitationCreateResponse>();
    const acceptedInvitation =
      acceptedInvitationResponse.json<InvitationCreateResponse>();

    await prisma.workspaceInvitation.update({
      where: {
        id: expiredInvitation.id
      },
      data: {
        expiresAt: new Date(Date.now() - 1000)
      }
    });

    const wrongEmailAccept = await app.inject({
      method: "POST",
      url: `/invitations/${wrongEmailInvitation.id}/accept`,
      headers: authHeaders(wrongUser.token),
      payload: {
        token: wrongEmailInvitation.token
      }
    });
    const wrongTokenAccept = await app.inject({
      method: "POST",
      url: `/invitations/${wrongTokenInvitation.id}/accept`,
      headers: authHeaders(wrongTokenInvitee.token),
      payload: {
        token: "wrong-token"
      }
    });
    const expiredAccept = await app.inject({
      method: "POST",
      url: `/invitations/${expiredInvitation.id}/accept`,
      headers: authHeaders(expiredInvitee.token),
      payload: {
        token: expiredInvitation.token
      }
    });

    const firstAccept = await app.inject({
      method: "POST",
      url: `/invitations/${acceptedInvitation.id}/accept`,
      headers: authHeaders(acceptedInvitee.token),
      payload: {
        token: acceptedInvitation.token
      }
    });
    expect(firstAccept.statusCode).toBe(200);

    const secondAccept = await app.inject({
      method: "POST",
      url: `/invitations/${acceptedInvitation.id}/accept`,
      headers: authHeaders(acceptedInvitee.token),
      payload: {
        token: acceptedInvitation.token
      }
    });

    for (const response of [
      wrongEmailAccept,
      wrongTokenAccept,
      expiredAccept,
      secondAccept
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        message: "Invitation not found"
      });
      expect(response.body).not.toMatch(/tokenHash|acceptedAt|expiresAt|workspaceId/i);
    }

    const rawBody = [
      wrongEmailInvitation,
      wrongTokenInvitation,
      expiredInvitation,
      acceptedInvitation
    ]
      .map((invitation) => invitation.token)
      .join(" ");
    expect(firstAccept.body + secondAccept.body).not.toContain(rawBody);
  });

  test("database prevents duplicate pending invitations for the same workspace and email", async () => {
    const owner = await registerTestUser("DB Invariant Owner");
    const invitee = await registerTestUser("DB Invariant Invitee");
    const firstInvitation = await createInvitation(
      owner.token,
      owner.workspace.id,
      invitee.user.email
    );
    expect(firstInvitation.statusCode).toBe(201);

    await expect(
      prisma.workspaceInvitation.create({
        data: {
          workspaceId: owner.workspace.id,
          email: invitee.user.email,
          role: "viewer",
          tokenHash: hashTestToken(crypto.randomUUID()),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          status: "pending"
        }
      })
    ).rejects.toMatchObject({
      code: "P2002"
    });
  });

  test("accepted invitation history does not block reinviting a removed member", async () => {
    const owner = await registerTestUser("Reinvite Owner");
    const { accept: firstAccept, invitee } = await createAcceptedMember(owner, "viewer");

    const removeResponse = await app.inject({
      method: "DELETE",
      url: `/workspaces/${owner.workspace.id}/members/${firstAccept.member.id}`,
      headers: authHeaders(owner.token)
    });
    expect(removeResponse.statusCode).toBe(204);

    const secondInvitationResponse = await createInvitation(
      owner.token,
      owner.workspace.id,
      invitee.user.email,
      "editor"
    );
    expect(secondInvitationResponse.statusCode).toBe(201);
    const secondInvitation =
      secondInvitationResponse.json<InvitationCreateResponse>();

    const secondAcceptResponse = await app.inject({
      method: "POST",
      url: `/invitations/${secondInvitation.id}/accept`,
      headers: authHeaders(invitee.token),
      payload: {
        token: secondInvitation.token
      }
    });
    expect(secondAcceptResponse.statusCode).toBe(200);
    expect(secondAcceptResponse.json()).toMatchObject({
      member: {
        workspaceId: owner.workspace.id,
        userId: invitee.user.id,
        role: "editor"
      }
    });

    const acceptedInvitationCount = await prisma.workspaceInvitation.count({
      where: {
        workspaceId: owner.workspace.id,
        email: invitee.user.email,
        status: "accepted"
      }
    });
    expect(acceptedInvitationCount).toBe(2);
  });

  test("owner can change member role", async () => {
    const owner = await registerTestUser("Role Owner");
    const { accept } = await createAcceptedMember(owner, "viewer");

    const response = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.workspace.id}/members/${accept.member.id}`,
      headers: authHeaders(owner.token),
      payload: {
        role: "editor"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: accept.member.id,
      workspaceId: owner.workspace.id,
      userId: accept.member.userId,
      role: "editor"
    });
  });

  test("last owner cannot be demoted or removed", async () => {
    const owner = await registerTestUser("Last Owner");
    const ownerMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: owner.user.id
        }
      }
    });

    const demoteResponse = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.workspace.id}/members/${ownerMembership.id}`,
      headers: authHeaders(owner.token),
      payload: {
        role: "editor"
      }
    });
    expect(demoteResponse.statusCode).toBe(409);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/workspaces/${owner.workspace.id}/members/${ownerMembership.id}`,
      headers: authHeaders(owner.token)
    });
    expect(deleteResponse.statusCode).toBe(409);

    const storedOwner = await prisma.workspaceMember.findUnique({
      where: {
        id: ownerMembership.id
      }
    });
    expect(storedOwner?.role).toBe("owner");
  });

  test("concurrent owner demote and remove cannot leave a workspace without owners", async () => {
    const owner = await registerTestUser("Concurrent Owner");
    const secondOwner = await addWorkspaceMember(owner.workspace.id, "owner");
    const ownerMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: owner.user.id
        }
      }
    });
    const secondOwnerMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: secondOwner.user.id
        }
      }
    });

    const [demoteResponse, deleteResponse] = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/workspaces/${owner.workspace.id}/members/${ownerMembership.id}`,
        headers: authHeaders(owner.token),
        payload: {
          role: "viewer"
        }
      }),
      app.inject({
        method: "DELETE",
        url: `/workspaces/${owner.workspace.id}/members/${secondOwnerMembership.id}`,
        headers: authHeaders(owner.token)
      })
    ]);

    const ownerCount = await prisma.workspaceMember.count({
      where: {
        workspaceId: owner.workspace.id,
        role: "owner"
      }
    });

    expect(ownerCount).toBeGreaterThan(0);
    expect([demoteResponse.statusCode, deleteResponse.statusCode]).toContain(409);
  });

  test("duplicate invitation and existing member return conflict", async () => {
    const owner = await registerTestUser("Conflict Owner");
    const pendingInvitee = await registerTestUser("Pending Conflict");
    const memberInvitee = await addWorkspaceMember(owner.workspace.id, "viewer");

    const firstInvitation = await createInvitation(
      owner.token,
      owner.workspace.id,
      pendingInvitee.user.email
    );
    expect(firstInvitation.statusCode).toBe(201);

    const duplicateInvitation = await createInvitation(
      owner.token,
      owner.workspace.id,
      pendingInvitee.user.email
    );
    expect(duplicateInvitation.statusCode).toBe(409);

    const existingMemberInvitation = await createInvitation(
      owner.token,
      owner.workspace.id,
      memberInvitee.user.email
    );
    expect(existingMemberInvitation.statusCode).toBe(409);
  });

  test("malformed non-owner invite and update payloads return forbidden before body validation", async () => {
    const owner = await registerTestUser("Malformed Owner");
    const editor = await addWorkspaceMember(owner.workspace.id, "editor");
    const target = await addWorkspaceMember(owner.workspace.id, "viewer");
    const targetMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: target.user.id
        }
      }
    });

    const inviteResponse = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspace.id}/invitations`,
      headers: authHeaders(editor.token),
      payload: {
        email: "not-an-email",
        role: "owner"
      }
    });
    expect(inviteResponse.statusCode).toBe(403);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.workspace.id}/members/${targetMembership.id}`,
      headers: authHeaders(editor.token),
      payload: {
        role: "not-a-role"
      }
    });
    expect(updateResponse.statusCode).toBe(403);
  });

  test("sharing mutation services re-check actor owner status inside write transactions", async () => {
    const owner = await registerTestUser("Recheck Owner");
    const invitee = await registerTestUser("Recheck Invitee");
    const target = await addWorkspaceMember(owner.workspace.id, "viewer");
    const ownerMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: owner.user.id
        }
      }
    });
    const targetMembership = await prisma.workspaceMember.findUniqueOrThrow({
      where: {
        workspaceId_userId: {
          workspaceId: owner.workspace.id,
          userId: target.user.id
        }
      }
    });

    await prisma.workspaceMember.update({
      where: {
        id: ownerMembership.id
      },
      data: {
        role: "viewer"
      }
    });

    await expect(
      createWorkspaceInvitation(
        prisma,
        owner.workspace.id,
        invitee.user.email,
        "viewer",
        owner.user.id
      )
    ).rejects.toBeInstanceOf(WorkspaceInvitationAuthorizationError);

    await expect(
      updateWorkspaceMemberRole(
        prisma,
        owner.workspace.id,
        targetMembership.id,
        "editor",
        owner.user.id
      )
    ).rejects.toBeInstanceOf(WorkspaceMemberAuthorizationError);

    await expect(
      deleteWorkspaceMember(
        prisma,
        owner.workspace.id,
        targetMembership.id,
        owner.user.id
      )
    ).rejects.toBeInstanceOf(WorkspaceMemberAuthorizationError);
  });
});
