import { PrismaClient, type WorkspaceRole } from "@prisma/client";
import type { WorkspaceSnapshot } from "@living-cost-manager/shared";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import {
  cleanupAuthTestRecords,
  resolveApiTestDatabaseUrl
} from "./test-database.js";

const snapshotTestEmailPrefix = "snapshot-test-";
const databaseUrl = resolveApiTestDatabaseUrl();
const runId = `${snapshotTestEmailPrefix}${Date.now()}`;
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

async function registerTestUser(name: string): Promise<RegisteredUser> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: `${runId}-${crypto.randomUUID()}@example.com`,
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

function buildSnapshot(workspaceId: string): WorkspaceSnapshot {
  return {
    workspaceId,
    monthlyIncome: 4200000,
    categories: [
      {
        id: "housing",
        workspaceId,
        label: "Housing"
      },
      {
        id: "utilities",
        workspaceId,
        label: "Utilities"
      }
    ],
    cards: [
      {
        id: "main-card",
        workspaceId,
        label: "Main Card",
        billingDay: 15
      }
    ],
    fixedCosts: [
      {
        id: "insurance",
        workspaceId,
        name: "Insurance",
        categoryId: "utilities",
        paymentMethodId: "credit-card",
        paymentOptionId: "main-card",
        amount: 300000,
        periodMonths: 2.5,
        billingDay: 15
      },
      {
        id: "rent",
        workspaceId,
        name: "Rent",
        categoryId: "housing",
        paymentMethodId: "bank-transfer",
        paymentOptionId: "auto-transfer",
        amount: 1200000,
        periodMonths: 1,
        billingDay: 25
      }
    ]
  };
}

async function putSnapshot(token: string, snapshot: WorkspaceSnapshot) {
  return app.inject({
    method: "PUT",
    url: `/workspaces/${snapshot.workspaceId}/snapshot`,
    headers: authHeaders(token),
    payload: snapshot
  });
}

async function getSnapshot(token: string, workspaceId: string) {
  return app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/snapshot`,
    headers: authHeaders(token)
  });
}

beforeAll(async () => {
  await prisma.$connect();
  await cleanupAuthTestRecords(prisma, snapshotTestEmailPrefix);
});

afterEach(async () => {
  await cleanupAuthTestRecords(prisma, snapshotTestEmailPrefix);
});

afterAll(async () => {
  await cleanupAuthTestRecords(prisma, snapshotTestEmailPrefix);
  await app.close();
  await prisma.$disconnect();
});

describe("workspace snapshot routes", () => {
  test("owner can PUT then GET the same snapshot including decimal period months", async () => {
    const owner = await registerTestUser("Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const putResponse = await putSnapshot(owner.token, snapshot);
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual(snapshot);

    const getResponse = await getSnapshot(owner.token, owner.workspace.id);
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(snapshot);
  });

  test("credit-card payment option is stored as paymentCardId and round-trips", async () => {
    const owner = await registerTestUser("Card Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const putResponse = await putSnapshot(owner.token, snapshot);
    expect(putResponse.statusCode).toBe(200);

    const stored = await prisma.fixedCost.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: owner.workspace.id,
          id: "insurance"
        }
      }
    });

    expect(stored).toMatchObject({
      paymentMethodId: "credit-card",
      paymentCardId: "main-card",
      paymentOptionKey: null
    });

    const getResponse = await getSnapshot(owner.token, owner.workspace.id);
    expect(getResponse.json<WorkspaceSnapshot>().fixedCosts).toContainEqual(
      snapshot.fixedCosts[0]
    );
  });

  test("non-card payment option is stored as paymentOptionKey and round-trips", async () => {
    const owner = await registerTestUser("Transfer Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const putResponse = await putSnapshot(owner.token, snapshot);
    expect(putResponse.statusCode).toBe(200);

    const stored = await prisma.fixedCost.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: owner.workspace.id,
          id: "rent"
        }
      }
    });

    expect(stored).toMatchObject({
      paymentMethodId: "bank-transfer",
      paymentCardId: null,
      paymentOptionKey: "auto-transfer"
    });

    const getResponse = await getSnapshot(owner.token, owner.workspace.id);
    expect(getResponse.json<WorkspaceSnapshot>().fixedCosts).toContainEqual(
      snapshot.fixedCosts[1]
    );
  });

  test("viewer can GET but cannot PUT", async () => {
    const owner = await registerTestUser("Viewer Workspace Owner");
    const viewer = await addWorkspaceMember(owner.workspace.id, "viewer");
    const snapshot = buildSnapshot(owner.workspace.id);

    expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);

    const getResponse = await getSnapshot(viewer.token, owner.workspace.id);
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(snapshot);

    const putResponse = await putSnapshot(viewer.token, snapshot);
    expect(putResponse.statusCode).toBe(403);
  });

  test("non-member cannot GET or PUT", async () => {
    const owner = await registerTestUser("Member Workspace Owner");
    const nonMember = await registerTestUser("Non Member");
    const snapshot = buildSnapshot(owner.workspace.id);

    expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);

    const getResponse = await getSnapshot(nonMember.token, owner.workspace.id);
    expect(getResponse.statusCode).toBe(403);

    const putResponse = await putSnapshot(nonMember.token, snapshot);
    expect(putResponse.statusCode).toBe(403);
  });

  test("URL and payload workspace mismatch returns bad request", async () => {
    const owner = await registerTestUser("Mismatch Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const response = await app.inject({
      method: "PUT",
      url: "/workspaces/different-workspace/snapshot",
      headers: authHeaders(owner.token),
      payload: snapshot
    });

    expect(response.statusCode).toBe(400);
  });

  test("nested workspace mismatch returns bad request without writing child rows", async () => {
    const owner = await registerTestUser("Nested Mismatch Owner");
    const other = await registerTestUser("Other Workspace Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const response = await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspace.id}/snapshot`,
      headers: authHeaders(owner.token),
      payload: {
        ...snapshot,
        fixedCosts: [],
        cards: [
          {
            ...snapshot.cards[0],
            workspaceId: other.workspace.id
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);

    const otherCards = await prisma.paymentCard.findMany({
      where: {
        workspaceId: other.workspace.id
      }
    });

    expect(otherCards).toEqual([]);
  });

  test("invalid periodMonths returns bad request", async () => {
    const owner = await registerTestUser("Invalid Period Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const response = await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspace.id}/snapshot`,
      headers: authHeaders(owner.token),
      payload: {
        ...snapshot,
        fixedCosts: [
          {
            ...snapshot.fixedCosts[0],
            periodMonths: 2.54
          }
        ]
      }
    });

    expect(response.statusCode).toBe(400);
  });
});
