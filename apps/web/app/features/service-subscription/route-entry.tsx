import type { Metadata } from "next";
import { SubscriptionPage } from "./subscription-page";

export const metadata: Metadata = {
  title: "구독 관리 | 생활비관리",
  robots: { index: false, follow: false },
  alternates: { canonical: "https://living-cost-manager.gamja.top/subscription/" }
};
// Archived route entry. Not a Next route in the free public release.
export default function Page() { return <SubscriptionPage />; }
