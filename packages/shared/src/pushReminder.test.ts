import { describe, expect, test } from "vitest";

import {
  buildDueReminderPayload,
  dueReminderDedupeKey,
  type ReminderItem
} from "./pushReminder.js";

function item(id: string, name: string, amount: number): ReminderItem {
  return { id, name, amount };
}

describe("buildDueReminderPayload", () => {
  test("빈 묶음이면 null", () => {
    expect(buildDueReminderPayload([])).toBeNull();
  });

  test("1건이면 단일 문구", () => {
    const payload = buildDueReminderPayload([item("a", "월세", 650000)]);
    expect(payload).not.toBeNull();
    expect(payload!.title).toBe("내일 고정비 알림");
    expect(payload!.body).toBe("월세 650,000원이 내일 빠져나가요");
    expect(payload!.url).toBe("/");
  });

  test("여러 건이면 묶음 문구 + 합계", () => {
    const payload = buildDueReminderPayload([
      item("a", "월세", 650000),
      item("b", "통신비", 79000)
    ]);
    expect(payload).not.toBeNull();
    expect(payload!.title).toBe("내일 고정비 2건");
    expect(payload!.body).toContain("월세, 통신비");
    expect(payload!.body).toContain("729,000원");
  });

  test("6건 이상이면 5건만 나열하고 외 N건", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(`i${i}`, `항목${i}`, 1000));
    const payload = buildDueReminderPayload(items);
    expect(payload!.title).toBe("내일 고정비 7건");
    expect(payload!.body).toContain("외 2건");
    // 합계 7000원
    expect(payload!.body).toContain("7,000원");
  });
});

describe("dueReminderDedupeKey", () => {
  test("도래일 단위(YYYY-MM-DD)로 키 생성, 같은 날은 동일", () => {
    const a = dueReminderDedupeKey(new Date(2026, 5, 6, 9, 0));
    const b = dueReminderDedupeKey(new Date(2026, 5, 6, 23, 59));
    expect(a).toBe("due:2026-06-06");
    expect(a).toBe(b);
  });

  test("다른 날은 다른 키", () => {
    const a = dueReminderDedupeKey(new Date(2026, 5, 6));
    const b = dueReminderDedupeKey(new Date(2026, 5, 7));
    expect(a).not.toBe(b);
  });
});
