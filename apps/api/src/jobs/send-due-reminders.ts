import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildDueReminderPayload,
  computeNextDueDate,
  dueReminderDedupeKey,
  getDaysUntilDue,
  type ReminderItem
} from "@living-cost-manager/shared";

import { loadEnv, type Env } from "../env.js";
import { getPrismaClient, clearCachedPrismaClient } from "../prisma.js";
import { isPushConfigured, sendPushToUser } from "../services/push.js";

// 발송 정책(#35): D-1(납부 하루 전), 같은 날 도래 항목은 사용자별 1건으로 묶음.
const DUE_WITHIN_DAYS = 1;

export type SendFn = (
  prisma: PrismaClient,
  env: Env,
  userId: string,
  payload: { title: string; body: string; url?: string }
) => Promise<{ sent: number; pruned: number }>;

export type DueReminderResult = {
  // D-1 도래 항목을 가진 사용자 수(묶음 대상).
  targetedUsers: number;
  // 실제로 푸시를 보낸(구독 1개 이상 발송 성공) 건수 합.
  pushesSent: number;
  // dedupe 로 건너뛴 사용자 수(이미 같은 날 발송됨).
  skippedDuplicate: number;
  // 만료/무효로 정리된 구독 수.
  prunedSubscriptions: number;
};

/**
 * D-1 납부 임박 사용자에게 묶음 리마인더 푸시를 보낸다.
 *
 * - now 와 sendFn 을 주입받아 결정적/테스트 가능하게 한다.
 * - 사용자별 dedupeKey(도래일 단위)로 중복 발송을 방지한다. 같은 날 재실행해도
 *   PushDelivery unique(userId, dedupeKey) 위반(P2002)이면 건너뛴다.
 */
export async function runDueReminders(
  prisma: PrismaClient,
  env: Env,
  now: Date,
  sendFn: SendFn = sendPushToUser
): Promise<DueReminderResult> {
  const result: DueReminderResult = {
    targetedUsers: 0,
    pushesSent: 0,
    skippedDuplicate: 0,
    prunedSubscriptions: 0
  };

  if (!isPushConfigured(env)) {
    // 푸시 미설정이면 조용히 종료(no-op). 운영에선 VAPID 가 주입돼 있어야 함.
    return result;
  }

  // 구독이 있는 사용자만 대상으로 한다(없으면 보낼 곳이 없음).
  const subscribedUserIds = (
    await prisma.pushSubscription.findMany({
      distinct: ["userId"],
      select: { userId: true }
    })
  ).map((row) => row.userId);

  if (subscribedUserIds.length === 0) {
    return result;
  }

  for (const userId of subscribedUserIds) {
    // 이 사용자가 속한 워크스페이스들의 고정비 전부.
    const fixedCosts = await prisma.fixedCost.findMany({
      where: { workspace: { members: { some: { userId } } } },
      select: {
        id: true,
        name: true,
        amount: true,
        periodMonths: true,
        billingDay: true,
        isEndOfMonth: true,
        categoryId: true
      }
    });

    // D-1 항목만 추린다.
    const dueTomorrow = fixedCosts.filter(
      (fc) => getDaysUntilDue(fc, now) === DUE_WITHIN_DAYS
    );

    if (dueTomorrow.length === 0) {
      continue;
    }

    result.targetedUsers += 1;

    // 묶음이므로 dedupeKey 는 도래일(내일) 단위. 모든 D-1 항목은 같은 도래일.
    const dueDate = computeNextDueDate(dueTomorrow[0], now);
    const dedupeKey = dueReminderDedupeKey(dueDate);

    // 먼저 이력을 선점(create)한다. unique 위반이면 이미 발송됨 → skip.
    try {
      await prisma.pushDelivery.create({ data: { userId, dedupeKey } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        result.skippedDuplicate += 1;
        continue;
      }
      throw error;
    }

    const items: ReminderItem[] = dueTomorrow.map((fc) => ({
      id: fc.id,
      name: fc.name,
      amount: fc.amount
    }));
    const payload = buildDueReminderPayload(items);
    if (!payload) {
      continue;
    }

    try {
      const { sent, pruned } = await sendFn(prisma, env, userId, payload);
      result.pushesSent += sent;
      result.prunedSubscriptions += pruned;
      // 발송 성공 구독이 0개면(모두 만료) 이력을 되돌려, 구독 복구 후 재발송 가능케 한다.
      if (sent === 0) {
        await prisma.pushDelivery.deleteMany({ where: { userId, dedupeKey } });
        result.skippedDuplicate += 0; // 명시: 되돌림은 dedupe 카운트가 아님
      }
    } catch (error) {
      // 발송 자체 실패 시 이력을 되돌려 다음 실행에서 재시도 가능하게 한다.
      await prisma.pushDelivery.deleteMany({ where: { userId, dedupeKey } });
      throw error;
    }
  }

  return result;
}

// ── 스크립트 진입점 ───────────────────────────────────────────────────────
// systemd oneshot(#37)에서 `node dist/jobs/send-due-reminders.js` 로 실행.
// 한 번 실행 후 종료한다. import 로 쓰일 때는(테스트) 실행되지 않는다.
const isDirectRun = process.argv[1]?.endsWith("send-due-reminders.js") ?? false;

if (isDirectRun) {
  const env = loadEnv();
  const prisma = getPrismaClient();
  try {
    const result = await runDueReminders(prisma, env, new Date());
    // 운영 로그(journalctl 로 확인). 한 줄 JSON.
    console.log(
      JSON.stringify({ job: "send-due-reminders", at: new Date().toISOString(), ...result })
    );
  } catch (error) {
    console.error("[send-due-reminders] failed:", error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    clearCachedPrismaClient(prisma);
  }
}
