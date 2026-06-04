import { PrismaClient } from "@prisma/client";
import webpush from "web-push";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { runDueReminders, type SendFn } from "../src/jobs/send-due-reminders.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const runId = `duejob-test-${Date.now()}`;

const vapid = webpush.generateVAPIDKeys();
const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters",
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: "mailto:test@example.com"
});
const envNoPush = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = await buildApp({ env, prisma });

// 고정 기준 시각: 2026-06-05 09:00 로컬. 내일(D-1) = billingDay 6.
const NOW = new Date(2026, 5, 5, 9, 0, 0);
const TOMORROW_DAY = 6;

type TestUser = { userId: string; token: string; workspaceId: string };

async function registerUser(name: string): Promise<TestUser> {
  const email = `${runId}-${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    headers: { "content-type": "application/json" },
    payload: { email, password: "password123", name }
  });
  const body = res.json<{ accessToken: string; user: { id: string }; workspace: { id: string } }>();
  return { userId: body.user.id, token: body.accessToken, workspaceId: body.workspace.id };
}

async function addSubscription(user: TestUser, suffix: string): Promise<string> {
  const endpoint = `https://push.example.com/${runId}-${user.userId}-${suffix}`;
  await prisma.pushSubscription.create({
    data: { userId: user.userId, endpoint, p256dh: "p256dh-key", auth: "auth-key" }
  });
  return endpoint;
}

async function addFixedCost(
  workspaceId: string,
  id: string,
  name: string,
  amount: number,
  billingDay: number
): Promise<void> {
  // category 는 FK 제약이 있으므로 먼저 만든다.
  await prisma.category.upsert({
    where: { workspaceId_id: { workspaceId, id: "cat-default" } },
    create: { workspaceId, id: "cat-default", label: "기타" },
    update: {}
  });
  await prisma.fixedCost.create({
    data: {
      workspaceId,
      id,
      name,
      categoryId: "cat-default",
      paymentMethodId: "bank-transfer",
      amount,
      periodMonths: 1,
      billingDay,
      isEndOfMonth: false
    }
  });
}

// 항상 성공(구독 수만큼 sent)을 흉내내는 sendFn.
const sendOk: SendFn = vi.fn(async (_p, _e, _u, _payload) => ({ sent: 1, pruned: 0 }));
// 모든 구독이 만료된 상황(sent:0, pruned:1).
const sendAllStale: SendFn = vi.fn(async () => ({ sent: 0, pruned: 1 }));

afterAll(async () => {
  await prisma.pushDelivery.deleteMany({ where: { user: { email: { contains: runId } } } });
  await prisma.fixedCost.deleteMany({ where: { workspace: { members: { some: { user: { email: { contains: runId } } } } } } });
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { contains: runId } } });
  await prisma.user.deleteMany({ where: { email: { contains: runId } } });
  await app.close();
  await prisma.$disconnect();
});

// runDueReminders 는 "모든 구독 사용자"를 순회하므로, 테스트 간 데이터가 누적되면
// targetedUsers 등 전역 카운트가 오염된다. 각 테스트 전에 이 파일이 만든
// (runId 범위) 데이터를 외래키 순서로 정리해 격리한다.
async function cleanupTestData() {
  await prisma.pushDelivery.deleteMany({ where: { user: { email: { contains: runId } } } });
  await prisma.fixedCost.deleteMany({
    where: { workspace: { members: { some: { user: { email: { contains: runId } } } } } }
  });
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { contains: runId } } });
  await prisma.user.deleteMany({ where: { email: { contains: runId } } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupTestData();
});

describe("runDueReminders", () => {
  test("D-1 항목이 있는 구독 사용자에게 1건 발송 + 이력 생성", async () => {
    const user = await registerUser("due");
    await addSubscription(user, "ep");
    await addFixedCost(user.workspaceId, "rent", "월세", 650000, TOMORROW_DAY);

    const result = await runDueReminders(prisma, env, NOW, sendOk);

    expect(result.targetedUsers).toBe(1);
    expect(result.pushesSent).toBe(1);
    expect(sendOk).toHaveBeenCalledTimes(1);
    // payload 가 묶음 빌더 결과인지(단일 항목 문구)
    const payloadArg = (sendOk as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(payloadArg.body).toContain("월세");
    // 이력 1건
    const deliveries = await prisma.pushDelivery.count({ where: { userId: user.userId } });
    expect(deliveries).toBe(1);
  });

  test("같은 날 재실행하면 dedupe 로 건너뛴다(재발송 안 함)", async () => {
    const user = await registerUser("dedupe");
    await addSubscription(user, "ep");
    await addFixedCost(user.workspaceId, "rent", "월세", 650000, TOMORROW_DAY);

    const first = await runDueReminders(prisma, env, NOW, sendOk);
    expect(first.pushesSent).toBe(1);

    vi.clearAllMocks();
    const second = await runDueReminders(prisma, env, NOW, sendOk);
    expect(second.skippedDuplicate).toBe(1);
    expect(second.pushesSent).toBe(0);
    expect(sendOk).not.toHaveBeenCalled();
  });

  test("D-1 이 아닌 항목(D-3)만 있으면 발송하지 않는다", async () => {
    const user = await registerUser("notdue");
    await addSubscription(user, "ep");
    await addFixedCost(user.workspaceId, "later", "보험", 100000, TOMORROW_DAY + 2);

    const result = await runDueReminders(prisma, env, NOW, sendOk);
    expect(result.targetedUsers).toBe(0);
    expect(sendOk).not.toHaveBeenCalled();
  });

  test("같은 날 여러 항목은 1건으로 묶어 발송", async () => {
    const user = await registerUser("bundle");
    await addSubscription(user, "ep");
    await addFixedCost(user.workspaceId, "rent", "월세", 650000, TOMORROW_DAY);
    await addFixedCost(user.workspaceId, "phone", "통신비", 79000, TOMORROW_DAY);

    const result = await runDueReminders(prisma, env, NOW, sendOk);
    expect(result.targetedUsers).toBe(1);
    expect(sendOk).toHaveBeenCalledTimes(1); // 묶음 → 1회 호출
    const payloadArg = (sendOk as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(payloadArg.body).toContain("729,000원");
  });

  test("모든 구독이 만료(sent:0)면 이력을 되돌려 재발송 가능하게 둔다", async () => {
    const user = await registerUser("stale");
    await addSubscription(user, "ep");
    await addFixedCost(user.workspaceId, "rent", "월세", 650000, TOMORROW_DAY);

    const result = await runDueReminders(prisma, env, NOW, sendAllStale);
    expect(result.prunedSubscriptions).toBe(1);
    expect(result.pushesSent).toBe(0);
    // 이력이 되돌려졌으므로 0건
    const deliveries = await prisma.pushDelivery.count({ where: { userId: user.userId } });
    expect(deliveries).toBe(0);
  });

  test("구독 없는 사용자는 대상에서 제외", async () => {
    const user = await registerUser("nosub");
    await addFixedCost(user.workspaceId, "rent", "월세", 650000, TOMORROW_DAY);

    const result = await runDueReminders(prisma, env, NOW, sendOk);
    expect(result.targetedUsers).toBe(0);
  });

  test("푸시 미설정이면 no-op", async () => {
    const result = await runDueReminders(prisma, envNoPush, NOW, sendOk);
    expect(result.pushesSent).toBe(0);
    expect(sendOk).not.toHaveBeenCalled();
  });
});
