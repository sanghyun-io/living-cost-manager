import { faqs } from "../content";
import { absoluteUrl, publicMetadata } from "../site";
import { StructuredData } from "../structured-data";
import styles from "../guide.module.css";

const title = "고정비·구독 갱신 관리 자주 묻는 질문";
const description = "로그인 없이 쓰는 로컬 대시보드, 구독 해지, 결제일 계산, 절감 기록, 데이터 백업과 서버 업로드에 관한 답변입니다.";
export const metadata = publicMetadata(title, description, "/guide/faq/");

export default function FaqPage() {
  return <>
    <nav aria-label="현재 위치" className={styles.breadcrumbs}><a href="/guide/">사용 안내</a> / 자주 묻는 질문</nav>
    <h1>{title}</h1>
    <p className={styles.lead}>{description}</p>
    <StructuredData data={{ "@context": "https://schema.org", "@type": "FAQPage", url: absoluteUrl("/guide/faq/"), inLanguage: "ko-KR", mainEntity: faqs.map(({ question, answer }) => ({ "@type": "Question", name: question, acceptedAnswer: { "@type": "Answer", text: answer } })) }} />
    {faqs.map(({ question, answer }, index) => <section key={question} className={styles.section} aria-labelledby={`question-${index + 1}`}><h2 id={`question-${index + 1}`}>{question}</h2><p>{answer}</p></section>)}
    <section className={styles.section}><h2>실제 정리 순서가 궁금하다면</h2><ul><li><a href="/guide/billing-dates/">결제일과 청구액 계산 안내</a></li><li><a href="/guide/renewal-checklist/">구독 갱신 점검 체크리스트</a></li><li><a href="/guide/backup-and-sync/">백업과 동기화 안내</a></li></ul><a className={styles.cta} href="/">대시보드 열기</a></section>
  </>;
}
