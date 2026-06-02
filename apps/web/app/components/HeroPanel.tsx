import { NumberInput, Progress, Text, Title } from "@mantine/core";

interface HeroPanelProps {
  monthlyIncome: number;
  expenseRate: number;
  hasServerWorkspace: boolean;
  onIncomeChange: (value: number) => void;
}

export function HeroPanel({ monthlyIncome, expenseRate, hasServerWorkspace, onIncomeChange }: HeroPanelProps) {
  // Status-colored percent readout: calm teal under 60%, muted amber 60-80%,
  // rose above 80% — a small trustworthy data cue without alarming the user.
  const rateColor = expenseRate > 80 ? "rose.6" : expenseRate > 60 ? "amber.7" : "teal.6";

  return (
    <section className="hero">
      <div className="hero-strip">
        <div className="hero-left">
          <Text className="section-label">고정비 대시보드</Text>
          <Title order={1} size="xl" fw={800}>
            생활비 고정비를 한 화면에서 정리하세요
          </Title>
          <p className="hero-copy">
            매월 또는 몇 개월마다 반복되는 지출을 항목, 납부일, 결제수단별로 모아 보고 월 환산 예산 압박을 바로 확인합니다.
          </p>
          <p className="local-note inline-note">
            {hasServerWorkspace
              ? "서버 계정이 연결되어 있습니다. 변경 후 데이터 관리에서 서버 동기화를 실행하세요."
              : "현재 로그인 없이 로컬 저장 중입니다. 로그인해서 클라우드에 저장하면 기기를 바꿔도 데이터를 이어서 사용할 수 있습니다."}
          </p>
        </div>
        <div className="hero-right" aria-label="이번 달 고정비 요약">
          <NumberInput
            label="월 수입"
            id="monthly-income"
            size="md"
            radius="md"
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
            color={expenseRate > 80 ? "rose" : expenseRate > 60 ? "amber" : "teal"}
            size="md"
            radius="xl"
            aria-label="수입 대비 월 환산 고정비 비율"
          />
        </div>
      </div>
    </section>
  );
}
