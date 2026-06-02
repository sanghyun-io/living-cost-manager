import type { ReactNode } from "react";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import "@mantine/core/styles.css";
import "./globals.css";
import { theme } from "./theme";

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
    <html lang="ko" {...mantineHtmlProps}>
      <head>
        {/* 라이트/다크 색상 스킴에 맞춰 상태바 색을 분리한다(Mantine 기본 body 색 기준). */}
        <meta name="theme-color" content="#f4f7f6" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#161b1a" media="(prefers-color-scheme: dark)" />
        <link rel="manifest" href="./manifest.webmanifest" />
        <link rel="icon" href="./icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="./icon.svg" />
        <ColorSchemeScript defaultColorScheme="light" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="light">
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
