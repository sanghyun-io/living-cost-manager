import { notFound } from "next/navigation";
import { guides } from "../content";
import { absoluteUrl, publicMetadata } from "../site";
import { StructuredData } from "../structured-data";
import styles from "../guide.module.css";

export const dynamicParams = false;
export function generateStaticParams() { return guides.map(({ slug }) => ({ slug })); }

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const guide = guides.find((item) => item.slug === slug);
  if (!guide) notFound();
  return publicMetadata(guide.title, guide.description, `/guide/${slug}/`);
}

export default async function GuidePage({ params }: Props) {
  const { slug } = await params;
  const guide = guides.find((item) => item.slug === slug);
  if (!guide) notFound();
  return <>
    <nav aria-label="현재 위치" className={styles.breadcrumbs}><a href="/guide/">사용 안내</a> / {guide.title}</nav>
    <StructuredData data={{ "@context": "https://schema.org", "@graph": [
      { "@type": "Article", headline: guide.title, description: guide.description, inLanguage: "ko-KR", mainEntityOfPage: absoluteUrl(`/guide/${slug}/`), articleBody: [guide.summary, ...guide.sections.flatMap((section) => [section.title, ...section.paragraphs, ...(section.steps ?? [])])].join("\n") },
      { "@type": "BreadcrumbList", itemListElement: [ { "@type": "ListItem", position: 1, name: "사용 안내", item: absoluteUrl("/guide/") }, { "@type": "ListItem", position: 2, name: guide.title, item: absoluteUrl(`/guide/${slug}/`) } ] }
    ] }} />
    <article>
      <h1>{guide.title}</h1>
      <p className={styles.lead}>{guide.summary}</p>
      <nav aria-label="이 글의 목차" className={styles.note}><strong>이 글에서 확인할 내용</strong><ol>{guide.sections.map((section, index) => <li key={section.title}><a href={`#section-${index + 1}`}>{section.title}</a></li>)}</ol></nav>
      {guide.sections.map((section, index) => <section key={section.title} className={styles.section} aria-labelledby={`section-${index + 1}`}>
        <h2 id={`section-${index + 1}`}>{section.title}</h2>
        {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {section.steps && <ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
      </section>)}
    </article>
    <section className={styles.section} aria-labelledby="related"><h2 id="related">함께 읽을 안내</h2><ul>{guides.filter((item) => item.slug !== slug).map((item) => <li key={item.slug}><a href={`/guide/${item.slug}/`}>{item.title}</a></li>)}<li><a href="/guide/faq/">자주 묻는 질문</a></li></ul><a className={styles.cta} href="/">대시보드에서 내 고정비 정리하기</a></section>
  </>;
}
