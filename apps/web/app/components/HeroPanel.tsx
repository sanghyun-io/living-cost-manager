import { formatNumberInput } from "../lib/formatting";

interface HeroPanelProps {
  monthlyIncome: number;
  expenseRate: number;
  progressWidth: string;
  hasServerWorkspace: boolean;
  onIncomeChange: (value: string) => void;
}

export function HeroPanel({ monthlyIncome, expenseRate, progressWidth, hasServerWorkspace, onIncomeChange }: HeroPanelProps) {
  return (
    <section className="hero">
      <div>
        <p className="section-label">고정비 대시보드</p>
        <h1>생활비 고정비를 한 화면에서 정리하세요</h1>
        <p className="hero-copy">
          매월 또는 몇 개월마다 반복되는 지출을 항목, 납부일, 결제수단별로 모아 보고 월 환산 예산 압박을 바로 확인합니다.
        </p>
        <p className="local-note inline-note">
          {hasServerWorkspace
            ? "서버 계정이 연결되어 있습니다. 변경 후 데이터 관리에서 서버 동기화를 실행하세요."
            : "현재 로그인 없이 로컬 저장 중입니다. 로그인해서 클라우드에 저장하면 기기를 바꿔도 데이터를 이어서 사용할 수 있습니다."}
        </p>
      </div>
      <div className="summary-panel" aria-label="이번 달 고정비 요약">
        <label htmlFor="monthly-income">월 수입</label>
        <input
          id="monthly-income"
          inputMode="numeric"
          min="0"
          type="text"
          value={formatNumberInput(monthlyIncome)}
          onChange={(event) => onIncomeChange(event.target.value)}
        />
        <p>수입 대비 월 환산 고정비 {expenseRate}%</p>
        <div className="income-progress" aria-label="수입 대비 월 환산 고정비 비율">
          <div className="income-progress-fill" style={{ width: progressWidth }} />
        </div>
      </div>
    </section>
  );
}
