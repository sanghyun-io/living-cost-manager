import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "생활비 고정비 관리자",
  description: "생활비 고정비를 한눈에 정리하는 로컬 대시보드",
  applicationName: "생활비 고정비 관리자",
  appleWebApp: {
    capable: true,
    title: "생활비"
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <meta name="theme-color" content="#f8fafc" />
        <link rel="manifest" href="./manifest.webmanifest" />
        <link rel="icon" href="./icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="./icon.svg" />
      </head>
      <body>{children}</body>
    </html>
  );
}
