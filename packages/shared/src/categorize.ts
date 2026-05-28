// 고정비 이름에서 카테고리를 추천하는 규칙 기반 분류기.
// 외부 의존성 없는 순수 함수로, web/api/테스트가 공유한다.
//
// 반환하는 categoryId 는 web 의 DEFAULT_CATEGORIES id 와 일치한다
// (housing / telecom / insurance / subscription / transport / education).
// "기타(other)"는 추천하지 않는다 — 매칭이 없으면 null 을 반환해
// 호출 측이 "추천 없음"을 구분할 수 있게 한다.

export type CategoryKeywordRule = {
  categoryId: string;
  /** 소문자로 비교되는 키워드. 부분 일치(substring)로 매칭한다. */
  keywords: string[];
};

// 기본 사전. 한국에서 흔한 고정비 이름을 커버한다.
// 키워드는 모두 소문자로 둔다(매칭 시 입력도 소문자로 정규화).
export const DEFAULT_CATEGORY_KEYWORD_RULES: CategoryKeywordRule[] = [
  {
    categoryId: "housing",
    keywords: [
      "월세", "전세", "관리비", "임대", "주거", "아파트", "오피스텔", "보증금",
      "rent", "lease",
    ],
  },
  {
    categoryId: "telecom",
    keywords: [
      "통신", "휴대폰", "핸드폰", "폰요금", "요금제", "인터넷", "와이파이", "wifi",
      "skt", "kt", "lg유플러스", "lgu", "유플러스", "알뜰폰", "데이터",
    ],
  },
  {
    categoryId: "insurance",
    keywords: [
      "보험", "실비", "실손", "암보험", "생명보험", "손해보험", "연금", "공제",
      "insurance",
    ],
  },
  {
    categoryId: "subscription",
    keywords: [
      "구독", "넷플릭스", "netflix", "유튜브", "youtube", "유튜브프리미엄",
      "디즈니", "disney", "왓챠", "watcha", "티빙", "tving", "웨이브", "wavve",
      "스포티파이", "spotify", "멜론", "지니", "벅스", "애플뮤직", "apple music",
      "icloud", "구글원", "google one", "노션", "notion", "챗gpt", "chatgpt",
      "프리미엄", "멤버십", "쿠팡와우", "쿠팡플레이",
    ],
  },
  {
    categoryId: "transport",
    keywords: [
      "교통", "지하철", "버스", "정기권", "기후동행", "대중교통", "택시",
      "주유", "기름값", "주차", "하이패스", "ktx", "srt", "기차", "따릉이",
    ],
  },
  {
    categoryId: "education",
    keywords: [
      "교육", "학원", "강의", "인강", "수업", "수강", "등록금", "학비", "도서",
      "온라인강의", "클래스", "튜터", "과외",
    ],
  },
];

export type CategorizeOptions = {
  /**
   * 사용자 정의 카테고리(라벨/ID). 사전 키워드보다 먼저, 라벨이 이름에
   * 직접 포함되면 해당 카테고리를 우선 추천한다. 커스텀 카테고리를 만든
   * 사용자가 동일 이름을 입력할 때 자연스럽게 매칭되도록 한다.
   */
  categories?: ReadonlyArray<{ id: string; label: string }>;
  /** 키워드 사전 오버라이드. 기본값은 DEFAULT_CATEGORY_KEYWORD_RULES. */
  rules?: ReadonlyArray<CategoryKeywordRule>;
};

/**
 * 고정비 이름에서 categoryId 를 추천한다. 매칭이 없으면 null.
 *
 * 매칭 우선순위:
 *   1. 사용자 카테고리 라벨이 이름에 포함되면 그 카테고리
 *   2. 키워드 사전에서 가장 긴 키워드가 매칭되는 카테고리
 *      (긴 키워드 우선 → "유튜브프리미엄"이 "유튜브"보다 우선되는 식)
 */
export function suggestCategoryId(
  name: string,
  options: CategorizeOptions = {},
): string | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  // 1) 사용자 카테고리 라벨 직접 매칭 (기본 카테고리 라벨은 제외 — 그건 사전이 담당)
  const categories = options.categories ?? [];
  let labelMatch: { id: string; length: number } | null = null;
  for (const category of categories) {
    const label = category.label.trim().toLowerCase();
    if (label.length > 0 && normalized.includes(label)) {
      if (!labelMatch || label.length > labelMatch.length) {
        labelMatch = { id: category.id, length: label.length };
      }
    }
  }
  if (labelMatch) {
    return labelMatch.id;
  }

  // 2) 키워드 사전 매칭 (가장 긴 키워드 우선)
  const rules = options.rules ?? DEFAULT_CATEGORY_KEYWORD_RULES;
  let best: { id: string; length: number } | null = null;
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      const kw = keyword.trim().toLowerCase();
      if (kw.length > 0 && normalized.includes(kw)) {
        if (!best || kw.length > best.length) {
          best = { id: rule.categoryId, length: kw.length };
        }
      }
    }
  }

  return best ? best.id : null;
}
