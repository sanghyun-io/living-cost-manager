import type { ReactNode } from "react";
import styles from "./guide.module.css";

export default function GuideLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#guide-content">본문 바로가기</a>
      <header className={styles.header}>
        <a className={styles.brand} href="/guide/">생활비 고정비 관리자</a>
        <nav className={styles.nav} aria-label="공개 안내">
          <a href="/guide/">사용 안내</a>
          <a href="/guide/faq/">자주 묻는 질문</a>
          <a href="/">대시보드 열기</a>
        </nav>
      </header>
      <main id="guide-content" className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        <p>생활비 고정비 관리자 · 반복 지출과 갱신 결정을 정리하는 로컬 중심 도구</p>
        <p>결제·해지는 해당 사업자에서 직접 확인하세요. <a href="/guide/backup-and-sync/">데이터 백업 안내</a></p>
      </footer>
    </div>
  );
}
