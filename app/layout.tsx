import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "생활비 고정비 관리자",
  description: "생활비 고정비를 한눈에 정리하는 로컬 대시보드"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
