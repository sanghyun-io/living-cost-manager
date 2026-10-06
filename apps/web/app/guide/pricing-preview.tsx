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
    <p>의견을 보내고 싶다면 <a href="https://gamja.top/#contact">기존 문의 페이지</a>를 이용해 주세요. 계정·카드·결제 정보는 보내지 마세요. 문의만으로 유료 신청이나 마케팅 수신 동의가 되지 않습니다.</p>
  </section>;
}
