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

  const body = response.json<{ accessToken: string } & RegisteredUser>();
  // Snapshot writes are gated behind email verification; mark the freshly
  // registered user verified so these tests exercise the happy path.
  await prisma.user.update({
    where: { id: body.user.id },
    data: { emailVerifiedAt: new Date() }
  });
  return { ...body, token: body.accessToken };
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

function buildSnapshot(workspaceId: string, syncVersion = 0): WorkspaceSnapshot {
  return {
    workspaceId,
    syncVersion,
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
        billingDay: 15,
        isEndOfMonth: false
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
        billingDay: 15,
        billingAnchorDate: null,
        renewalStatus: "unreviewed",
        potentialMonthlySavings: 0,
        confirmedMonthlySavings: 0,
        isEndOfMonth: false
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
        billingDay: 25,
        billingAnchorDate: "2026-01-31",
        renewalStatus: "completed",
        potentialMonthlySavings: 0,
        confirmedMonthlySavings: 10000,
        isEndOfMonth: true
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

async function putRawSnapshot(token: string, workspaceId: string, payload: unknown) {
  return app.inject({
    method: "PUT",
    url: `/workspaces/${workspaceId}/snapshot`,
    headers: authHeaders(token),
    payload
  });
}

async function getSnapshot(token: string, workspaceId: string) {
  return app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/snapshot`,
    headers: authHeaders(token)
  });
}

async function getSnapshotHistory(token: string, workspaceId: string, limit?: number) {
  const query = typeof limit === "number" ? `?limit=${limit}` : "";
  return app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/snapshot/history${query}`,
    headers: authHeaders(token)
  });
}

// Registers a user WITHOUT marking the email verified, to exercise the gate.
async function registerUnverifiedUser(name: string): Promise<RegisteredUser> {
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
  const body = response.json<{ accessToken: string } & RegisteredUser>();
  return { ...body, token: body.accessToken };
}

describe("email verification gate", () => {
  test("미인증 사용자는 snapshot PUT 시 403 + EMAIL_NOT_VERIFIED", async () => {
    const owner = await registerUnverifiedUser("Unverified Owner");
    const res = await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 0));
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code?: string }>().code).toBe("EMAIL_NOT_VERIFIED");
  });

  test("인증 후에는 snapshot PUT 이 통과한다", async () => {
    const owner = await registerTestUser("Verified Owner");
    const res = await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 0));
    expect(res.statusCode).toBe(200);
  });
});

describe("workspace snapshot history", () => {
  test("매 PUT마다 누적되고 요약을 최신순으로 반환한다", async () => {
    const owner = await registerTestUser("History Owner");

    // 두 번 PUT → 백업 2건 누적. 두 번째는 버전 1 로(낙관적 잠금).
    expect((await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 0))).statusCode).toBe(200);
    expect((await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 1))).statusCode).toBe(200);

    const res = await getSnapshotHistory(owner.token, owner.workspace.id);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      entries: Array<{ createdAt: string; monthlyIncome: number; fixedCostMonthlyTotal: number; fixedCostCount: number }>;
    }>();
    expect(body.entries.length).toBe(2);
    // 최신순(createdAt 내림차순)
    expect(body.entries[0].createdAt >= body.entries[1].createdAt).toBe(true);
    // buildSnapshot: monthlyIncome 4_200_000, fixedCosts 2건
    // (insurance 300000/2.5=120000, rent 1200000/1=1200000) → 합 1_320_000.
    expect(body.entries[0].monthlyIncome).toBe(4200000);
    expect(body.entries[0].fixedCostMonthlyTotal).toBe(1320000);
    expect(body.entries[0].fixedCostCount).toBe(2);
  });

  test("limit 파라미터로 개수를 제한한다", async () => {
    const owner = await registerTestUser("History Limit Owner");
    for (let v = 0; v < 3; v += 1) {
      expect((await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, v))).statusCode).toBe(200);
    }
    const res = await getSnapshotHistory(owner.token, owner.workspace.id, 2);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: unknown[] }>().entries.length).toBe(2);
  });

  test("viewer도 history를 읽을 수 있다", async () => {
    const owner = await registerTestUser("History Viewer Owner");
    const viewer = await addWorkspaceMember(owner.workspace.id, "viewer");
    expect((await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 0))).statusCode).toBe(200);

    const res = await getSnapshotHistory(viewer.token, owner.workspace.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ entries: unknown[] }>().entries.length).toBe(1);
  });

  test("비멤버는 history를 읽을 수 없다 (403)", async () => {
    const owner = await registerTestUser("History NonMember Owner");
    const stranger = await registerTestUser("History Stranger");
    const res = await getSnapshotHistory(stranger.token, owner.workspace.id);
    expect(res.statusCode).toBe(403);
  });
});

function expectSanitizedBadRequest(response: Awaited<ReturnType<typeof app.inject>>) {
  expect(response.statusCode).toBe(400);

  const rawBody = response.body;
  expect(rawBody).not.toMatch(/Zod|Prisma|P200\d|foreign key|constraint/i);
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
  test("legacy snapshot without billing fields remains unknown with zero confirmed savings", async () => {
    const owner = await registerTestUser("Legacy owner");
    const snapshot = buildSnapshot(owner.workspace.id);
    for (const cost of snapshot.fixedCosts) {
      delete cost.billingAnchorDate;
      delete cost.renewalStatus;
      delete cost.potentialMonthlySavings;
      delete cost.confirmedMonthlySavings;
    }
    const response = await putSnapshot(owner.token, snapshot);
    expect(response.statusCode).toBe(200);
    for (const cost of response.json<WorkspaceSnapshot>().fixedCosts) {
      expect(cost).toMatchObject({ billingAnchorDate: null, renewalStatus: "unreviewed", potentialMonthlySavings: 0, confirmedMonthlySavings: 0 });
    }
  });

  test("current-version legacy PUT preserves populated billing fields and backup history by ID", async () => {
    const owner = await registerTestUser("Legacy Replacement Owner");
    const snapshot = buildSnapshot(owner.workspace.id);
    Object.assign(snapshot.fixedCosts[0], {
      billingAnchorDate: "2026-02-15",
      renewalStatus: "cancel-planned",
      potentialMonthlySavings: 12000
    });
    expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);

    const legacy = structuredClone(snapshot);
    legacy.syncVersion = 1;
    legacy.monthlyIncome = 4300000;
    legacy.fixedCosts.reverse();
    for (const cost of legacy.fixedCosts) {
      delete cost.billingAnchorDate;
      delete cost.renewalStatus;
      delete cost.potentialMonthlySavings;
      delete cost.confirmedMonthlySavings;
      cost.name += " edited";
    }
    const expectedCosts = snapshot.fixedCosts.map((cost) => ({
      ...cost,
      name: `${cost.name} edited`
    }));
    const response = await putSnapshot(owner.token, legacy);
    expect(response.statusCode).toBe(200);
    const expected = { ...legacy, syncVersion: 2, fixedCosts: expectedCosts };
    expect(response.json()).toEqual(expected);
    expect((await getSnapshot(owner.token, owner.workspace.id)).json()).toEqual(expected);

    const history = await getSnapshotHistory(owner.token, owner.workspace.id);
    expect(history.statusCode).toBe(200);
    const entries = history.json<{ entries: Array<{ id: string }> }>().entries;
    expect(entries).toHaveLength(2);
    const backups = await prisma.backupSnapshot.findMany({
      where: { workspaceId: owner.workspace.id }
    });
    const payloads = backups.map((backup) => backup.payload as unknown as WorkspaceSnapshot);
    expect(payloads).toContainEqual(snapshot);
    expect(payloads).toContainEqual({ ...legacy, fixedCosts: [...expectedCosts].reverse() });
    expect(entries.map((entry) => entry.id).sort()).toEqual(backups.map((backup) => backup.id).sort());
  });

  test("explicit null and zero clear populated billing fields while omitted fields survive", async () => {
    const owner = await registerTestUser("Billing Clear Owner");
    const snapshot = buildSnapshot(owner.workspace.id);
    snapshot.fixedCosts[1].potentialMonthlySavings = 5000;
    expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);

    const replacement = structuredClone(snapshot);
    replacement.syncVersion = 1;
    Object.assign(replacement.fixedCosts[1], {
      billingAnchorDate: null,
      potentialMonthlySavings: 0,
      confirmedMonthlySavings: 0
    });
    delete replacement.fixedCosts[1].renewalStatus;
    const response = await putSnapshot(owner.token, replacement);
    expect(response.statusCode).toBe(200);
    expect(response.json<WorkspaceSnapshot>().fixedCosts[1]).toEqual({
      ...replacement.fixedCosts[1], renewalStatus: "completed"
    });

    replacement.syncVersion = 2;
    replacement.fixedCosts[1].renewalStatus = "unreviewed";
    expect((await putSnapshot(owner.token, replacement)).statusCode).toBe(200);
    expect((await getSnapshot(owner.token, owner.workspace.id)).json()).toEqual({
      ...replacement, syncVersion: 3
    });
  });

  test("partial savings updates validate against the preserved renewal status", async () => {
    const owner = await registerTestUser("Partial Savings Owner");
    const snapshot = buildSnapshot(owner.workspace.id);
    expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);

    const replacement = structuredClone(snapshot);
    replacement.syncVersion = 1;
    delete replacement.fixedCosts[1].renewalStatus;
    replacement.fixedCosts[1].confirmedMonthlySavings = 20000;
    const response = await putSnapshot(owner.token, replacement);
    expect(response.statusCode).toBe(200);
    const expected = response.json<WorkspaceSnapshot>();
    expect(expected.fixedCosts[1]).toEqual({
      ...replacement.fixedCosts[1], renewalStatus: "completed"
    });

    replacement.syncVersion = 2;
    delete replacement.fixedCosts[0].renewalStatus;
    replacement.fixedCosts[0].confirmedMonthlySavings = 500;
    const rejected = await putSnapshot(owner.token, replacement);
    expectSanitizedBadRequest(rejected);
    expect(rejected.json()).toMatchObject({ message: "Invalid snapshot" });
    expect((await getSnapshot(owner.token, owner.workspace.id)).json()).toEqual(expected);
    expect(await prisma.backupSnapshot.count({
      where: { workspaceId: owner.workspace.id }
    })).toBe(2);
  });

  test.each(["keep", "unreviewed", "cancel-planned", "change-review"] as const)(
    "partial renewal change to %s conflicts with preserved confirmed savings and rolls back atomically",
    async (renewalStatus) => {
      const owner = await registerTestUser("Partial Billing Owner");
      const snapshot = buildSnapshot(owner.workspace.id);
      expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);
      const backupsBefore = await prisma.backupSnapshot.findMany({
        where: { workspaceId: owner.workspace.id }
      });

      const replacement = structuredClone(snapshot);
      replacement.syncVersion = 1;
      replacement.monthlyIncome = 9900000;
      replacement.categories[0].label = "Changed";
      replacement.cards[0].label = "Changed";
      replacement.fixedCosts[0].amount = 999;
      replacement.fixedCosts[1].renewalStatus = renewalStatus;
      delete replacement.fixedCosts[1].confirmedMonthlySavings;
      const response = await putSnapshot(owner.token, replacement);
      expectSanitizedBadRequest(response);
      expect(response.json()).toMatchObject({ message: "Invalid snapshot" });
      expect((await getSnapshot(owner.token, owner.workspace.id)).json()).toEqual({
        ...snapshot, syncVersion: 1
      });
      expect(await prisma.backupSnapshot.findMany({
        where: { workspaceId: owner.workspace.id }
      })).toEqual(backupsBefore);

      // Explicitly clearing the conflicting savings makes the same version valid.
      replacement.fixedCosts[1].confirmedMonthlySavings = 0;
      const retry = await putSnapshot(owner.token, replacement);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ ...replacement, syncVersion: 2 });
    }
  );

  test("owner can PUT then GET the same snapshot including decimal period months", async () => {
    const owner = await registerTestUser("Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    // PUT 성공 시 서버가 syncVersion 을 1 올려 돌려준다. 나머지는 그대로.
    const expected = { ...snapshot, syncVersion: 1 };

    const putResponse = await putSnapshot(owner.token, snapshot);
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual(expected);

    const getResponse = await getSnapshot(owner.token, owner.workspace.id);
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(expected);
  });

  test("stale syncVersion is rejected with 409 and the second writer can retry with the latest version", async () => {
    const owner = await registerTestUser("Conflict Owner");
    const base = buildSnapshot(owner.workspace.id); // syncVersion 0

    // 첫 PUT 성공 → 서버 버전 1.
    expect((await putSnapshot(owner.token, base)).statusCode).toBe(200);

    // 같은(낡은) 버전 0 으로 다시 PUT → 충돌 409.
    const conflict = await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 0));
    expect(conflict.statusCode).toBe(409);

    // 최신 버전(1)으로 재시도하면 성공하고 버전이 2 가 된다.
    const retry = await putSnapshot(owner.token, buildSnapshot(owner.workspace.id, 1));
    expect(retry.statusCode).toBe(200);
    expect(retry.json<WorkspaceSnapshot>().syncVersion).toBe(2);
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
    // owner 의 PUT 으로 서버 버전이 1 이 되었다.
    expect(getResponse.json()).toEqual({ ...snapshot, syncVersion: 1 });

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

  test.each([
    [
      "malformed body",
      (snapshot: WorkspaceSnapshot) => ({
        ...snapshot,
        fixedCosts: "not-an-array"
      })
    ],
    [
      "mismatched body",
      (snapshot: WorkspaceSnapshot) => ({
        ...snapshot,
        workspaceId: "different-workspace"
      })
    ],
    [
      "FK-invalid body",
      (snapshot: WorkspaceSnapshot) => ({
        ...snapshot,
        fixedCosts: [
          {
            ...snapshot.fixedCosts[0],
            paymentOptionId: "missing-card"
          }
        ]
      })
    ]
  ])("non-member PUT with %s returns forbidden before body validation", async (_label, makePayload) => {
    const owner = await registerTestUser("Non Member Precedence Owner");
    const nonMember = await registerTestUser("Non Member Precedence User");
    const snapshot = buildSnapshot(owner.workspace.id);

    const response = await putRawSnapshot(
      nonMember.token,
      owner.workspace.id,
      makePayload(snapshot)
    );

    expect(response.statusCode).toBe(403);
  });

  test.each([
    [
      "malformed body",
      (snapshot: WorkspaceSnapshot) => ({
        ...snapshot,
        categories: "not-an-array"
      })
    ],
    [
      "mismatched body",
      (snapshot: WorkspaceSnapshot) => ({
        ...snapshot,
        workspaceId: "different-workspace"
      })
    ],
    [
      "FK-invalid body",
      (snapshot: WorkspaceSnapshot) => ({
        ...snapshot,
        fixedCosts: [
          {
            ...snapshot.fixedCosts[0],
            paymentOptionId: "missing-card"
          }
        ]
      })
    ]
  ])("viewer PUT with %s returns forbidden before body validation", async (_label, makePayload) => {
    const owner = await registerTestUser("Viewer Precedence Owner");
    const viewer = await addWorkspaceMember(owner.workspace.id, "viewer");
    const snapshot = buildSnapshot(owner.workspace.id);

    const response = await putRawSnapshot(
      viewer.token,
      owner.workspace.id,
      makePayload(snapshot)
    );

    expect(response.statusCode).toBe(403);
  });

  test("URL and payload workspace mismatch returns bad request", async () => {
    const owner = await registerTestUser("Mismatch Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    const response = await app.inject({
      method: "PUT",
      url: `/workspaces/${owner.workspace.id}/snapshot`,
      headers: authHeaders(owner.token),
      payload: {
        ...snapshot,
        workspaceId: "different-workspace"
      }
    });

    expectSanitizedBadRequest(response);
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

    expectSanitizedBadRequest(response);

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

    expectSanitizedBadRequest(response);
  });

  test("FK-invalid replacement returns sanitized bad request and rolls back previous snapshot", async () => {
    const owner = await registerTestUser("Rollback Owner");
    const snapshot = buildSnapshot(owner.workspace.id);

    expect((await putSnapshot(owner.token, snapshot)).statusCode).toBe(200);

    // 첫 PUT 으로 서버 버전이 1 이 되었으므로, FK 검증 경로에 도달하려면
    // 낙관적 잠금 충돌(409)이 아닌 최신 버전(1)로 보내야 한다.
    const invalidReplacement: WorkspaceSnapshot = {
      ...snapshot,
      syncVersion: 1,
      monthlyIncome: 9900000,
      fixedCosts: [
        {
          ...snapshot.fixedCosts[0],
          paymentOptionId: "missing-card"
        }
      ]
    };

    const response = await putSnapshot(owner.token, invalidReplacement);
    expectSanitizedBadRequest(response);
    expect(response.json()).toMatchObject({
      message: "Invalid snapshot"
    });

    // 롤백되어 첫 PUT 결과(버전 1)가 유지되어야 한다.
    const afterRollback = await getSnapshot(owner.token, owner.workspace.id);
    expect(afterRollback.statusCode).toBe(200);
    expect(afterRollback.json()).toEqual({ ...snapshot, syncVersion: 1 });
  });
});
