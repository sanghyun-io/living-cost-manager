import { NumberInput, Progress, Text, Title } from "@mantine/core";

interface HeroPanelProps {
  monthlyIncome: number;
  expenseRate: number;
  hasServerWorkspace: boolean;
  onIncomeChange: (value: number) => void;
}

export function HeroPanel({ monthlyIncome, expenseRate, hasServerWorkspace, onIncomeChange }: HeroPanelProps) {
  // Keep small text at the normal readable contrast; the progress bar carries color.
  const rateColor = "var(--text)";

  return (
    <section className="hero">
      <div className="hero-strip">
        <div className="hero-left">
           <Title order={1} size={28} fw={700}>
             고정비와 다음 결제
          </Title>
          <p className="hero-copy">
             다가오는 납부를 확인하고, 금액과 갱신 계획을 수정하세요.
          </p>
          <p className="local-note inline-note">
            {hasServerWorkspace
               ? "서버 연결 중 · 데이터 관리에서 동기화 상태를 확인하세요."
               : "이 브라우저에 저장됩니다. 백업과 기기 간 이동은 데이터 관리에서 확인하세요."}
          </p>
        </div>
        <div className="hero-right" aria-label="이번 달 고정비 요약">
          <NumberInput
            label="월 수입"
            id="monthly-income"
            size="md"
            radius="sm"
            min={0}
            thousandSeparator=","
            allowDecimal={false}
            allowNegative={false}
            hideControls
            value={monthlyIncome}
            onChange={(value) => onIncomeChange(typeof value === "number" ? value : 0)}
          />
          <Text size="sm">
            수입 대비 월 환산 고정비{" "}
            <Text span fw={700} className="tnum" c={rateColor}>
              {expenseRate}%
            </Text>
          </Text>
          <Progress
            value={Math.min(expenseRate, 100)}
            color={expenseRate > 80 ? "rose" : expenseRate > 60 ? "amber" : "blue"}
            size={4}
            radius="xs"
            aria-label="수입 대비 월 환산 고정비 비율"
          />
        </div>
      </div>
    </section>
  );
}
