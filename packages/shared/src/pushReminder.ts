// 납부 임박(D-1) 푸시 리마인더의 메시지 빌더 — 외부 의존 없는 순수 함수.
// 발송 정책(#35): D-1, 같은 날 여러 항목이면 1건으로 묶음.
//   - 1건: "{항목명} {금액}원이 내일 빠져나가요"
//   - 여러 건: "내일 고정비 {N}건 ₩{합계}이 빠져나가요" (본문에 항목 나열)
// 모든 함수는 기준 시각을 인자로 받는다(Date.now() 미사용) — 결정성/테스트성.

/** 리마인더 묶음에 들어가는 항목 최소 필드. */
export type ReminderItem = {
  id: string;
  name: string;
  amount: number;
};

/** sendPushToUser 가 받는 payload 형태와 동일. */
export type PushReminderPayload = {
  title: string;
  body: string;
  url: string;
};

function won(amount: number): string {
  return `${Math.round(amount).toLocaleString("ko-KR")}원`;
}

/**
 * 같은 날(D-1) 도래하는 항목 묶음을 하나의 푸시 payload 로 만든다.
 * items 가 비어 있으면 null(보낼 것 없음).
 */
export function buildDueReminderPayload(items: ReminderItem[]): PushReminderPayload | null {
  if (items.length === 0) {
    return null;
  }

  if (items.length === 1) {
    const only = items[0];
    return {
      title: "내일 고정비 알림",
      body: `${only.name} ${won(only.amount)}이 내일 빠져나가요`,
      url: "/"
    };
  }

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  // 본문에 항목명을 나열(많으면 잘림 방지로 최대 5개 + 외 N건).
  const MAX_NAMES = 5;
  const names = items.slice(0, MAX_NAMES).map((item) => item.name).join(", ");
  const rest = items.length - MAX_NAMES;
  const nameLine = rest > 0 ? `${names} 외 ${rest}건` : names;

  return {
    title: `내일 고정비 ${items.length}건`,
    body: `${nameLine} — 합계 ${won(total)}이 내일 빠져나가요`,
    url: "/"
  };
}

/**
 * 중복 방지용 dedupeKey. 묶음 발송이므로 "사용자당 발송 대상 날짜" 단위.
 * 같은 날 배치를 재실행해도 동일 키 → 1회만 발송.
 * date 는 발송 대상(도래)일. 로컬 자정 기준 YYYY-MM-DD.
 */
export function dueReminderDedupeKey(dueDate: Date): string {
  const y = dueDate.getFullYear();
  const m = String(dueDate.getMonth() + 1).padStart(2, "0");
  const d = String(dueDate.getDate()).padStart(2, "0");
  return `due:${y}-${m}-${d}`;
}
