import type { MetadataRoute } from "next";
import { guides } from "./guide/content";
import { absoluteUrl } from "./guide/site";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/guide/", ...guides.map(({ slug }) => `/guide/${slug}/`), "/guide/faq/"].map((path) => ({ url: absoluteUrl(path) }));
}
