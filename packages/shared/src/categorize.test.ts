import { describe, expect, test } from "vitest";
import { DEFAULT_CATEGORY_KEYWORD_RULES, suggestCategoryId } from "./index.js";

describe("suggestCategoryId", () => {
  test("기본 사전으로 흔한 고정비 이름을 분류한다", () => {
    expect(suggestCategoryId("월세")).toBe("housing");
    expect(suggestCategoryId("아파트 관리비")).toBe("housing");
    expect(suggestCategoryId("휴대폰 요금제")).toBe("telecom");
    expect(suggestCategoryId("실손보험")).toBe("insurance");
    expect(suggestCategoryId("넷플릭스")).toBe("subscription");
    expect(suggestCategoryId("Spotify Premium")).toBe("subscription");
    expect(suggestCategoryId("지하철 정기권")).toBe("transport");
    expect(suggestCategoryId("영어 학원")).toBe("education");
  });

  test("대소문자/공백에 무관하게 매칭한다", () => {
    expect(suggestCategoryId("  NETFLIX  ")).toBe("subscription");
    expect(suggestCategoryId("KT 인터넷")).toBe("telecom");
  });

  test("매칭이 없으면 null 을 반환한다(기타로 강제하지 않음)", () => {
    expect(suggestCategoryId("고양이 모래")).toBeNull();
    expect(suggestCategoryId("무명 지출")).toBeNull();
  });

  test("빈 문자열/공백은 null", () => {
    expect(suggestCategoryId("")).toBeNull();
    expect(suggestCategoryId("   ")).toBeNull();
  });

  test("더 긴 키워드가 우선한다", () => {
    // "유튜브프리미엄"과 "유튜브"가 모두 subscription 이라 결과는 같지만,
    // 길이 우선 로직이 동작함을 별도 사전으로 검증한다.
    const rules = [
      { categoryId: "short", keywords: ["유튜브"] },
      { categoryId: "long", keywords: ["유튜브프리미엄"] },
    ];
    expect(suggestCategoryId("유튜브프리미엄 결제", { rules })).toBe("long");
    expect(suggestCategoryId("유튜브 채널", { rules })).toBe("short");
  });

  test("사용자 커스텀 카테고리 라벨이 이름에 포함되면 우선한다", () => {
    const categories = [{ id: "custom-pet", label: "반려동물" }];
    expect(suggestCategoryId("반려동물 사료", { categories })).toBe("custom-pet");
  });

  test("커스텀 라벨이 사전 키워드보다 우선한다", () => {
    // 이름에 사전 키워드(구독)와 커스텀 라벨(구독박스)이 모두 들어가면
    // 라벨 매칭을 우선한다.
    const categories = [{ id: "custom-box", label: "구독박스" }];
    expect(suggestCategoryId("이달의 구독박스", { categories })).toBe("custom-box");
  });

  test("기본 사전 규칙은 모두 알려진 categoryId 를 가리킨다", () => {
    const known = new Set(["housing", "telecom", "insurance", "subscription", "transport", "education"]);
    for (const rule of DEFAULT_CATEGORY_KEYWORD_RULES) {
      expect(known.has(rule.categoryId)).toBe(true);
      expect(rule.keywords.length).toBeGreaterThan(0);
    }
  });
});
