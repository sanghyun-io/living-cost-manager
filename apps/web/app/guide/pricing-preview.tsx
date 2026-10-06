import { servicePricingCopy } from "@living-cost-manager/shared";
import styles from "./guide.module.css";

export function PricingPreview() {
  const copy = servicePricingCopy();
  return <section id="pricing" className={styles.section} aria-labelledby="pricing-title">
    <h2 id="pricing-title">이용 요금 · 유료 서비스 준비 중</h2>
    <p>{copy.free}</p>
    <p className={styles.note}>{copy.availability}</p>
    <div className={styles.cards}>
      <div className={styles.card}><h3>월간 가격안</h3><p>{copy.monthly}</p></div>
      <div className={styles.card}><h3>연간 가격안</h3><p>{copy.annual}</p></div>
    </div>
    <p>{copy.comparison}</p>
    <p>{copy.tax}</p>
    <h3>결제 전에 확인할 수 있도록 준비하는 내용</h3>
    <p>현재 구매·카드 등록·해지 신청을 받지 않습니다. 아래는 향후 안내 방침이며 계약 조건이 아닙니다.</p>
    <ul>
      <li>신청 전에 결제 총액·이용 기간·다음 갱신일·다음 청구액을 표시하는 방침입니다. 지금은 시작일이 없어 갱신일도 미정입니다.</li>
      <li>자동 갱신 동의는 마케팅 수신 동의와 별도로 확인하는 방침입니다. 미리 동의된 상태로 두지 않습니다.</li>
      <li>앞으로의 자동 청구를 멈추는 절차와 청약철회·환불 문의를 구분해 안내하는 방침입니다. 이용 종료일과 환불 조건은 전문가 확인 후 확정합니다.</li>
      <li>결제 실패 시 재시도·유예 기간·이용 권한 처리 방식은 미정입니다. 준비 중인 요금을 이유로 현재 무료 기능을 제한하지 않습니다.</li>
    </ul>
    <p>의견을 보내고 싶다면 <a href="https://gamja.top/#contact">기존 문의 페이지</a>를 이용해 주세요. 계정·카드·결제 정보는 보내지 마세요. 문의만으로 유료 신청이나 마케팅 수신 동의가 되지 않습니다.</p>
  </section>;
}
