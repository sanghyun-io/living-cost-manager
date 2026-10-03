import type { MetadataRoute } from "next";
import { absoluteUrl } from "./guide/site";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  // Allow crawling the dashboard so its noindex metadata can be read.
  return { rules: { userAgent: "*", allow: "/" }, sitemap: absoluteUrl("/sitemap.xml") };
}
