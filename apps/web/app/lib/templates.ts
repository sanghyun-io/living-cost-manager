import { templateBlueprintSchema, type TemplateBlueprint } from "@living-cost-manager/shared";
import type { LocalBudgetSnapshot } from "./snapshot";
import { ACTIVE_USER_KEY, USERS_KEY } from "./storage";
import { getUserDataKey, getUserErasureKey, type AppUser } from "./users";

export function buildTemplateBudget(input: TemplateBlueprint, amounts: string[], income: string, id = () => crypto.randomUUID()): LocalBudgetSnapshot {
  const blueprint = templateBlueprintSchema.parse(input);
  const parseAmount = (value: string) => {
    if (!/^\d{1,10}$/.test(value) || Number(value) > 2147483647) throw new Error("모든 금액과 월 수입을 직접 입력하세요. 실제 0원인 경우에만 0을 입력하세요.");
    return Number(value);
  };
  if (amounts.length !== blueprint.items.length) throw new Error("항목별 금액을 확인하세요.");
  const categories = [...new Set(blueprint.items.map(item => item.category))].map(label => ({ id: id(), label }));
  return {
    monthlyIncome: parseAmount(income), categories, cards: [],
    fixedCosts: blueprint.items.map((item, i) => ({
      id: id(), name: item.name, categoryId: categories.find(category => category.label === item.category)!.id,
      amount: parseAmount(amounts[i]), periodMonths: item.periodMonths, paymentMethodId: "other", paymentOptionId: "",
      billingDay: 1, isEndOfMonth: false, billingAnchorDate: null, renewalStatus: "unreviewed",
      potentialMonthlySavings: 0, confirmedMonthlySavings: 0
    }))
  };
}

// Write the new data before publishing its pointer. Existing financial keys
// are never touched. Roll back only our changed registry keys on failure.
export function persistTemplateProfile(storage: Storage, blueprint: TemplateBlueprint, budget: LocalBudgetSnapshot, beforeSwitch?: () => void): { user: AppUser; users: AppUser[]; returnId: string | null } {
  const previousUsers = storage.getItem(USERS_KEY);
  const previousActive = storage.getItem(ACTIVE_USER_KEY);
  const users: AppUser[] = JSON.parse(previousUsers ?? "[]");
  if (!Array.isArray(users) || users.some(user => !user || typeof user.id !== "string" || typeof user.name !== "string")) throw new Error("공간 목록을 읽을 수 없습니다. 원본을 보존하고 데이터 관리를 확인하세요.");
  const user: AppUser = { id: "template-" + crypto.randomUUID(), name: templateBlueprintSchema.parse(blueprint).title, ...(previousActive ? { templateReturnId: previousActive } : {}) };
  const key = getUserDataKey(user.id);
  if (storage.getItem(key) !== null) throw new Error("새 공간 ID 충돌");
  const nextUsers = [...users.filter(entry => !storage.getItem(getUserErasureKey(entry.id))), user];
  const nextUsersJson = JSON.stringify(nextUsers);
  let dataWritten = false, usersWritten = false;
  try {
    storage.setItem(key, JSON.stringify(budget)); dataWritten = true;
    if (storage.getItem(USERS_KEY) !== previousUsers) throw new Error("공간 목록이 바뀌었습니다. 다시 확인하세요.");
    storage.setItem(USERS_KEY, nextUsersJson); usersWritten = true;
    if (storage.getItem(ACTIVE_USER_KEY) !== previousActive) throw new Error("활성 공간이 바뀌었습니다. 다시 확인하세요.");
    beforeSwitch?.();
    if (storage.getItem(ACTIVE_USER_KEY) !== previousActive) throw new Error("활성 공간이 바뀌었습니다. 다시 확인하세요.");
    if (storage.getItem(USERS_KEY) !== nextUsersJson) throw new Error("공간 목록이 바뀌었습니다. 다시 확인하세요.");
    storage.setItem(ACTIVE_USER_KEY, user.id);
  } catch (error) {
    // Never roll another tab's newer registry back to our stale copy.
    if (usersWritten && storage.getItem(USERS_KEY) === nextUsersJson) { if (previousUsers === null) storage.removeItem(USERS_KEY); else storage.setItem(USERS_KEY, previousUsers); }
    const liveUsers = JSON.parse(storage.getItem(USERS_KEY) ?? "[]");
    if (dataWritten && storage.getItem(ACTIVE_USER_KEY) !== user.id && Array.isArray(liveUsers) && !liveUsers.some(entry => entry?.id === user.id)) storage.removeItem(key);
    throw error;
  }
  return { user, users: nextUsers, returnId: previousActive };
}
