import { guides } from "./content";
import { absoluteUrl, publicMetadata, SITE_NAME } from "./site";
import { StructuredData } from "./structured-data";
import { PricingPreview } from "./pricing-preview";
import styles from "./guide.module.css";

const title = "구독·고정비 갱신 관리, 다음 결제 전에 정리하세요";
const description = "반복 지출의 기준일과 다음 결제, 유지·해지·변경 결정을 한곳에 정리하세요. 월환산 비용과 30일 청구액, 예상 절감과 확인 절감을 구분하는 생활비 고정비 관리자 안내입니다.";
export const metadata = publicMetadata(title, description, "/guide/");

export default function GuideHome() {
  return <>
    <StructuredData data={{ "@context": "https://schema.org", "@type": "WebPage", name: title, description, url: absoluteUrl("/guide/"), inLanguage: "ko-KR", about: { "@type": "SoftwareApplication", name: SITE_NAME, applicationCategory: "FinanceApplication", operatingSystem: "Web browser", url: absoluteUrl("/"), description: "반복 지출의 금액과 기준일, 갱신 결정과 절감 기록을 정리하는 로컬 중심 대시보드" } }} />
    <p className={styles.eyebrow}>구독 · 정기 결제 · 생활비 고정비 관리</p>
    <h1>{title}</h1>
    <p className={styles.lead}>매달 나가는 돈뿐 아니라, 곧 갱신되는 연간 구독까지. 고정비의 금액과 기준일을 등록하고 다음 결제 전에 유지할지, 해지할지, 바꿀지 기록하세요.</p>
    <p>생활비 고정비 관리자는 반복 지출과 갱신 결정을 정리하는 로컬 중심 대시보드입니다. 로컬 기능은 로그인 없이 시작할 수 있습니다.</p>
    <a className={styles.cta} href="/">내 고정비 정리 시작하기</a>
    <section className={styles.section} aria-labelledby="benefits">
      <h2 id="benefits">금액, 일정, 다음 행동을 함께 봅니다</h2>
      <div className={styles.cards}>
        <div className={styles.card}><h3>월 예산과 실제 청구 구분</h3><p>월환산 비용으로 지출 규모를 비교하고, 등록한 일정에 따른 향후 30일 청구액으로 가까운 결제를 준비합니다.</p></div>
        <div className={styles.card}><h3>갱신 결정을 기록</h3><p>유지·해지 예정·변경 검토·완료를 구분해 다음 행동을 정리합니다. 실제 해지는 구독 사업자에서 진행합니다.</p></div>
        <div className={styles.card}><h3>계획과 확인을 구분</h3><p>예상 절감과 직접 확인한 절감을 따로 기록합니다. 해지 계획을 실제 절감 실적으로 오해하지 않도록 돕습니다.</p></div>
      </div>
    </section>
    <section className={styles.section} aria-labelledby="start">
      <h2 id="start">처음에는 고정비 한 개부터</h2>
      <ol><li>대시보드에서 빈 공간으로 시작하거나 별도 샘플 공간을 살펴보세요.</li><li>실제 이용 중인 구독의 금액, 반복 주기, 청구 기준 날짜를 입력하세요.</li><li>다음 결제일을 확인하고 유지·해지 예정·변경 검토 중 결정을 기록하세요.</li><li>사업자에서 해지나 변경 결과를 확인한 뒤 완료와 확인 절감을 기록하세요.</li></ol>
      <p className={styles.note}>기준일이 없으면 일정 미확인입니다. 카드 대금 결제일과 구독 청구일은 다르므로 사업자 결제 내역에서 날짜를 확인하세요.</p>
    </section>
    <section className={styles.section} aria-labelledby="guides">
      <h2 id="guides">고정비를 정리할 때 필요한 안내</h2>
      {guides.map((guide) => <article key={guide.slug} className={styles.section}><h3><a href={`/guide/${guide.slug}/`}>{guide.title}</a></h3><p>{guide.description}</p></article>)}
    </section>
    <PricingPreview />
    <section className={styles.section} aria-labelledby="scope">
      <h2 id="scope">내 데이터는 어디에 저장되나요?</h2>
      <p>로컬 데이터는 현재 브라우저에 저장됩니다. 브라우저 데이터를 지우거나 기기를 바꾸기 전에 전체 백업을 내보내세요. 서버 기능은 계정과 워크스페이스를 사용하며 수동으로 기준본을 맞춘 뒤 자동 업로드를 켤 수 있습니다.</p>
      <p>자동 업로드는 페이지가 열린 동안만 동작하고 새 세션에서는 기본 꺼짐입니다. 기기 간 자동 병합이나 백그라운드 양방향 동기화는 아닙니다.</p>
      <p><a href="/guide/faq/">로그인, 해지, 일정, 백업에 관한 자주 묻는 질문 읽기</a></p>
    </section>
  </>;
}
