import type { Metadata } from "next";

// Verified against the Cloudflare Pages project and production APP_BASE_URL.
// Keep canonical, social and crawler URLs on this single base.
export const SITE_URL = "https://living-cost-manager.gamja.top";
export const SITE_NAME = "생활비 고정비 관리자";
export const absoluteUrl = (path: string) => new URL(path, SITE_URL).toString();

export function publicMetadata(title: string, description: string, path: string): Metadata {
  return {
    title: `${title} | ${SITE_NAME}`,
    description,
    alternates: { canonical: absoluteUrl(path) },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "ko_KR",
      siteName: SITE_NAME,
      title,
      description,
      url: absoluteUrl(path),
      images: [{ url: absoluteUrl("/guide/social.png"), width: 1200, height: 630, alt: "Living Cost Manager — Fixed costs, renewal dates, review decisions" }]
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [absoluteUrl("/guide/social.png")]
    }
  };
}
