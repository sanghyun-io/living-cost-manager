import { PrismaClient } from "@prisma/client";
import webpush from "web-push";
import { afterAll, describe, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";
import { resolveApiTestDatabaseUrl } from "./test-database.js";

const databaseUrl = resolveApiTestDatabaseUrl();
const runId = `push-test-${Date.now()}`;

// 유효한 형식의 VAPID 키쌍을 테스트용으로 생성한다(setVapidDetails 가 형식 검증).
const vapid = webpush.generateVAPIDKeys();

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters",
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: "mailto:test@example.com"
});
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = await buildApp({ env, prisma });

// 푸시 미설정 앱(VAPID 없음) — 비활성 동작 검증용.
const envNoPush = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  JWT_SECRET: "test-secret-with-at-least-32-characters"
});
const appNoPush = await buildApp({ env: envNoPush, prisma });

async function registerUser(name: string): Promise<{ token: string; userId: string }> {
  const email = `${runId}-${name}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    headers: { "content-type": "application/json" },
    payload: { email, password: "password123", name }
  });
  const body = res.json();
  return { token: body.accessToken, userId: body.user.id };
}

function authHeaders(token: string) {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

function subscription(endpoint: string) {
  return { endpoint, keys: { p256dh: "test-p256dh-key", auth: "test-auth-key" } };
}

afterAll(async () => {
  await prisma.pushSubscription.deleteMany({ where: { endpoint: { contains: runId } } });
  await prisma.user.deleteMany({ where: { email: { contains: runId } } });
  await app.close();
  await appNoPush.close();
  await prisma.$disconnect();
});

describe("push subscription routes", () => {
  test("GET /push/public-key 는 설정 시 enabled+publicKey 반환", async () => {
    const res = await app.inject({ method: "GET", url: "/push/public-key" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ enabled: boolean; publicKey: string | null }>();
    expect(body.enabled).toBe(true);
    expect(body.publicKey).toBe(vapid.publicKey);
  });

  test("GET /push/public-key 는 미설정 시 enabled:false", async () => {
    const res = await appNoPush.inject({ method: "GET", url: "/push/public-key" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ enabled: boolean; publicKey: string | null }>();
    expect(body.enabled).toBe(false);
    expect(body.publicKey).toBeNull();
  });

  test("로그인 사용자는 구독을 등록할 수 있다(201) + DB 저장", async () => {
    const user = await registerUser("owner");
    const endpoint = `https://push.example.com/${runId}-ep1`;
    const res = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: authHeaders(user.token),
      payload: subscription(endpoint)
    });
    expect(res.statusCode).toBe(201);
    const stored = await prisma.pushSubscription.findUnique({ where: { endpoint } });
    expect(stored?.userId).toBe(user.userId);
  });

  test("같은 endpoint 재등록은 upsert(중복 생성 안 함)", async () => {
    const user = await registerUser("resub");
    const endpoint = `https://push.example.com/${runId}-ep-dup`;
    expect((await app.inject({ method: "POST", url: "/push/subscriptions", headers: authHeaders(user.token), payload: subscription(endpoint) })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/push/subscriptions", headers: authHeaders(user.token), payload: subscription(endpoint) })).statusCode).toBe(201);
    const count = await prisma.pushSubscription.count({ where: { endpoint } });
    expect(count).toBe(1);
  });

  test("인증 없으면 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: { "content-type": "application/json" },
      payload: subscription(`https://push.example.com/${runId}-noauth`)
    });
    expect(res.statusCode).toBe(401);
  });

  test("푸시 미설정 앱에서는 503", async () => {
    const user = await registerUser("noPush");
    const res = await appNoPush.inject({
      method: "POST",
      url: "/push/subscriptions",
      headers: authHeaders(user.token),
      payload: subscription(`https://push.example.com/${runId}-503`)
    });
    expect(res.statusCode).toBe(503);
  });

  test("본인 구독을 해지할 수 있다", async () => {
    const user = await registerUser("del");
    const endpoint = `https://push.example.com/${runId}-del`;
    await app.inject({ method: "POST", url: "/push/subscriptions", headers: authHeaders(user.token), payload: subscription(endpoint) });
    const res = await app.inject({
      method: "DELETE",
      url: "/push/subscriptions",
      headers: authHeaders(user.token),
      payload: { endpoint }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ removed: number }>().removed).toBe(1);
    expect(await prisma.pushSubscription.findUnique({ where: { endpoint } })).toBeNull();
  });
});
