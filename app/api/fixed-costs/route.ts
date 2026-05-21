const fixedCosts = [
  { name: "월세", categoryId: "housing", paymentMethodId: "bank-transfer", paymentOptionId: "auto-transfer", amount: 650000, billingDay: 25 },
  { name: "통신비", categoryId: "telecom", paymentMethodId: "credit-card", paymentOptionId: "", amount: 79000, billingDay: 10 },
  { name: "보험료", categoryId: "insurance", paymentMethodId: "bank-transfer", paymentOptionId: "auto-transfer", amount: 155000, billingDay: 15 },
  { name: "구독 서비스", categoryId: "subscription", paymentMethodId: "credit-card", paymentOptionId: "", amount: 35000, billingDay: 5 },
  { name: "교통 정기권", categoryId: "transport", paymentMethodId: "debit-card", paymentOptionId: "", amount: 120000, billingDay: 1 }
];

export const dynamic = "force-static";

const categories = [
  { id: "housing", label: "주거" },
  { id: "telecom", label: "통신" },
  { id: "insurance", label: "보험" },
  { id: "subscription", label: "구독" },
  { id: "transport", label: "교통" },
  { id: "other", label: "기타" }
];

const cards: Array<{ id: string; label: string }> = [];

const paymentMethods = [
  { id: "cash", label: "현금" },
  { id: "bank-transfer", label: "계좌이체" },
  { id: "debit-card", label: "체크카드" },
  { id: "credit-card", label: "신용카드" },
  { id: "other", label: "기타" }
];

const paymentOptions = [
  { id: "auto-transfer", label: "자동이체", paymentMethodId: "bank-transfer" },
  { id: "manual-transfer", label: "수동이체", paymentMethodId: "bank-transfer" },
  { id: "scheduled-transfer", label: "예약이체", paymentMethodId: "bank-transfer" },
  { id: "cms-giro", label: "CMS/지로", paymentMethodId: "bank-transfer" }
];

export function GET() {
  const monthlyTotal = fixedCosts.reduce((sum, item) => sum + item.amount, 0);

  return Response.json({
    items: fixedCosts,
    categories,
    cards,
    paymentMethods,
    paymentOptions,
    monthlyTotal,
    annualTotal: monthlyTotal * 12
  });
}
