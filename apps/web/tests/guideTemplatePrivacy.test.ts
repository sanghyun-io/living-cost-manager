import { describe, expect, test } from "vitest";
import { faqs, guides } from "../app/guide/content";

const guide = guides.find(({ slug }) => slug === "templates")!;
const faq = faqs.find(({ question }) => question === "템플릿 공유 링크에 금액이나 결제일도 포함되나요?")!;
const article = [guide.summary, ...guide.sections.flatMap(({ paragraphs }) => paragraphs)].join(" ");

describe("public template storage guidance", () => {
  test("article and FAQ do not promise browser-only or never-server storage", () => {
    for (const text of [article, faq.answer, guide.description]) {
      expect(text).not.toMatch(/입력값은 브라우저에만|입력한 값은 서버로 전송되거나 공개되지|입력한 금액과 수입은 서버로 전송되지/);
      expect(text).toContain("로그인 상태에서는");
      expect(text).toContain("수입");
      expect(text).toContain("서버에");
      expect(text).toContain("게스트 상태에서는");
      expect(text).toContain("브라우저에 저장");
    }
  });

  test("published structure excludes financial and source identity fields, not free-text review", () => {
    const boundary = guide.sections[0].paragraphs[1];
    for (const field of ["금액", "월 수입", "납부일", "카드", "원본 계정 및 가계부 ID"]) {
      expect(boundary).toContain(field);
      expect(faq.answer).toContain(field);
      expect(guide.description).toContain(field.replace("월 ", ""));
    }
    expect(boundary).toContain("담는 필드가 없습니다");
    expect(boundary).toContain("공유 설계도에 저장되지 않습니다");
    expect(guide.sections[0].paragraphs[0]).toContain("자유 문구");
    expect(faq.answer).toContain("공개 문구에 개인정보를 적지 마세요");
  });

  test("account ledger creation sends both amounts and income without replacing existing ledgers", () => {
    const application = guide.sections.find(({ title }) => title.startsWith("새 공간에 적용"))!;
    expect(application.paragraphs[0]).toContain("금액과 월 수입은 새 가계부 생성 요청으로 서버에 전송·저장");
    expect(application.paragraphs[0]).toContain("기존 가계부는 교체하지 않습니다");
    expect(application.paragraphs[0]).toContain("공유 설계도와 계정에 저장하는 가계부는 별개");
  });

  test("later guest transfer requires backup/import and chosen upload, not login alone", () => {
    const application = guide.sections.find(({ title }) => title.startsWith("새 공간에 적용"))!;
    expect(application.paragraphs[1]).toContain("자동으로 계정 가계부에 합쳐지지는 않습니다");
    expect(application.paragraphs[1]).toContain("전체 백업을 내보내고");
    expect(application.paragraphs[1]).toContain("백업을 가져온 뒤 수동 업로드를 선택");
    expect(application.paragraphs[1]).toContain("현재 데이터를 교체");
    expect(application.paragraphs[1]).toContain("자동 업로드는 별도로 켜야");
    expect(faq.answer).toContain("로그인만으로 자동 이전되지 않지만");
    expect(faq.answer).toContain("업로드를 선택하면 서버에 전송·저장");
  });

  test("template copying does not grant its creator private ledger access", () => {
    expect(article).toContain("작성자가 상대방의 가계부나 입력한 금액·수입을 볼 수 있는 권한을 얻지는 않습니다");
    expect(article).toContain("가계부 공유 권한은 별도로 관리");
    expect(faq.answer).toContain("작성자에게 상대방 가계부의 조회 권한이 생기지 않습니다");
  });
});
