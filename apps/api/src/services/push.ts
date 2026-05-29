import webpush from "web-push";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { Env } from "../env.js";

// VAPID 3종이 모두 있어야 푸시가 활성화된다. 하나라도 없으면 비활성(graceful).
export function isPushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

// 프로세스 전역으로 web-push VAPID 를 설정한다(설정돼 있을 때만). 부팅 시 1회 호출.
export function configureWebPush(env: Env): boolean {
  if (!isPushConfigured(env)) {
    return false;
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT as string,
    env.VAPID_PUBLIC_KEY as string,
    env.VAPID_PRIVATE_KEY as string
  );
  return true;
}

export type SubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * 구독을 저장한다. endpoint 가 unique 이므로 같은 endpoint 가 다시 오면
 * (같은 브라우저 재구독) 소유자/키를 갱신한다(upsert).
 */
export async function saveSubscription(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
  input: SubscriptionInput
): Promise<void> {
  await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth
    },
    update: {
      userId,
      p256dh: input.p256dh,
      auth: input.auth
    }
  });
}

/** endpoint 로 구독을 삭제한다. 본인 소유만 지우도록 userId 도 조건에 건다. */
export async function deleteSubscription(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
  endpoint: string
): Promise<number> {
  const result = await prisma.pushSubscription.deleteMany({
    where: { userId, endpoint }
  });
  return result.count;
}

/**
 * 한 사용자의 모든 구독에 푸시를 보낸다(발송 스케줄러 단계에서 사용).
 * 만료/무효(404·410) 구독은 자동 정리한다. 비활성(미설정) 시 아무것도 안 함.
 */
export async function sendPushToUser(
  prisma: PrismaClient,
  env: Env,
  userId: string,
  payload: { title: string; body: string; url?: string }
): Promise<{ sent: number; pruned: number }> {
  if (!isPushConfigured(env)) {
    return { sent: 0, pruned: 0 };
  }
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  const staleEndpoints: string[] = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      sent += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        staleEndpoints.push(sub.endpoint);
      }
      // 그 외 에러는 무시(일시적). 다음 발송에서 재시도.
    }
  }

  if (staleEndpoints.length > 0) {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: { in: staleEndpoints } }
    });
  }

  return { sent, pruned: staleEndpoints.length };
}
