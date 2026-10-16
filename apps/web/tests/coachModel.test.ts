import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  COACH_MODEL_ID,
  COACH_MODEL_APPROX_MB,
  COACH_MODEL_VRAM_MB,
  getCoachModelBaseUrl,
  isCoachOptedIn,
  setCoachOptIn,
  isWebGpuAvailable
} from "../app/lib/coachModel";

describe("coachModel — 상수", () => {
  test("COACH_MODEL_ID는 WebLLM prebuilt Qwen3.5-0.8B", () => {
    expect(COACH_MODEL_ID).toBe("Qwen3.5-0.8B-q4f16_1-MLC");
  });

  test("COACH_MODEL_APPROX_MB는 약 453MB (안내용)", () => {
    expect(COACH_MODEL_APPROX_MB).toBe(453);
    expect(typeof COACH_MODEL_APPROX_MB).toBe("number");
    expect(COACH_MODEL_APPROX_MB).toBeGreaterThan(0);
  });

  test("COACH_MODEL_VRAM_MB는 약 1629MB (GPU 메모리)", () => {
    expect(COACH_MODEL_VRAM_MB).toBe(1629.49);
    expect(typeof COACH_MODEL_VRAM_MB).toBe("number");
    expect(COACH_MODEL_VRAM_MB).toBeGreaterThan(0);
  });

  test("VRAM 요구량이 다운로드 크기보다 큼 (실행 시 더 많은 메모리 필요)", () => {
    expect(COACH_MODEL_VRAM_MB).toBeGreaterThan(COACH_MODEL_APPROX_MB);
  });
});

describe("getCoachModelBaseUrl — URL 처리", () => {
  test("undefined 입력 시 null 반환", () => {
    expect(getCoachModelBaseUrl(undefined)).toBeNull();
  });

  test("빈 문자열 입력 시 null 반환", () => {
    expect(getCoachModelBaseUrl("")).toBeNull();
  });

  test("공백만 있는 문자열은 null 반환", () => {
    expect(getCoachModelBaseUrl("   ")).toBeNull();
  });

  test("모델 ID 가 일치하지 않으면 null 반환 (옛 베이스 URL 사고 차단)", () => {
    // CRITICAL: 기존 baseline 의 override 가 새 weights 를 잘못 가리키지 않게
    // 모델 ID 가 URL 경로에 포함되지 않으면 null 로 폴백한다.
    expect(getCoachModelBaseUrl("https://models.gamja.top/qwen/")).toBeNull();
    expect(getCoachModelBaseUrl("https://models.gamja.top/Qwen2.5-0.5B-Instruct-q4f16_1-MLC/")).toBeNull();
  });

  test("모델 ID 가 포함된 유효 URL 은 그대로 반환 (끝 슬래시 유지)", () => {
    expect(getCoachModelBaseUrl(`https://models.gamja.top/${COACH_MODEL_ID}/`)).toBe(
      `https://models.gamja.top/${COACH_MODEL_ID}/`
    );
  });

  test("끝 슬래시가 없으면 추가", () => {
    expect(getCoachModelBaseUrl(`https://models.gamja.top/${COACH_MODEL_ID}`)).toBe(
      `https://models.gamja.top/${COACH_MODEL_ID}/`
    );
  });

  test("여러 개의 끝 슬래시는 하나로 정규화", () => {
    expect(getCoachModelBaseUrl(`https://models.gamja.top/${COACH_MODEL_ID}///`)).toBe(
      `https://models.gamja.top/${COACH_MODEL_ID}/`
    );
  });

  test("앞뒤 공백은 제거", () => {
    expect(
      getCoachModelBaseUrl(`  https://models.gamja.top/${COACH_MODEL_ID}  `)
    ).toBe(`https://models.gamja.top/${COACH_MODEL_ID}/`);
  });
});

describe("isWebGpuAvailable — WebGPU 지원 확인", () => {
  test("navigator.gpu가 있으면 true", () => {
    const originalNavigator = global.navigator;
    
    Object.defineProperty(global, "navigator", {
      value: { gpu: {} },
      writable: true,
      configurable: true
    });
    
    expect(isWebGpuAvailable()).toBe(true);
    
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true
    });
  });

  test("navigator.gpu가 없으면 false", () => {
    const originalNavigator = global.navigator;
    
    Object.defineProperty(global, "navigator", {
      value: {},
      writable: true,
      configurable: true
    });
    
    expect(isWebGpuAvailable()).toBe(false);
    
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true
    });
  });

  test("navigator가 정의되지 않으면 false (SSR)", () => {
    const originalNavigator = global.navigator;
    
    Object.defineProperty(global, "navigator", {
      value: undefined,
      writable: true,
      configurable: true
    });
    
    expect(isWebGpuAvailable()).toBe(false);
    
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true
    });
  });
});

describe("isCoachOptedIn / setCoachOptIn — localStorage opt-in", () => {
  beforeEach(() => {
    // localStorage 모의
    const store: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach((key) => delete store[key]);
      })
    };
    
    Object.defineProperty(global, "window", {
      value: { localStorage: mockLocalStorage },
      writable: true,
      configurable: true
    });
  });

  test("초기 상태는 false", () => {
    expect(isCoachOptedIn()).toBe(false);
  });

  test("setCoachOptIn(true) 후 isCoachOptedIn()은 true", () => {
    setCoachOptIn(true);
    expect(isCoachOptedIn()).toBe(true);
  });

  test("setCoachOptIn(false) 후 isCoachOptedIn()은 false", () => {
    setCoachOptIn(true);
    setCoachOptIn(false);
    expect(isCoachOptedIn()).toBe(false);
  });

  test("window가 정의되지 않으면 (SSR) false 반환", () => {
    const originalWindow = global.window;
    
    // @ts-ignore
    delete global.window;
    
    expect(isCoachOptedIn()).toBe(false);
    
    global.window = originalWindow;
  });

  test("window가 정의되지 않으면 (SSR) setCoachOptIn은 noop", () => {
    const originalWindow = global.window;
    
    // @ts-ignore
    delete global.window;
    
    // 에러가 발생하지 않아야 함
    expect(() => setCoachOptIn(true)).not.toThrow();
    
    global.window = originalWindow;
  });
});

describe("coachModel — 동의 정책 문서화", () => {
  test("모델 ID는 Qwen 계열 (한국어 양호)", () => {
    expect(COACH_MODEL_ID).toContain("Qwen");
  });

  test("모델 ID는 Qwen3.5 시리즈", () => {
    expect(COACH_MODEL_ID).toContain("Qwen3.5");
  });

  test("모델 ID는 양자화 버전 (q4f16)", () => {
    expect(COACH_MODEL_ID).toContain("q4f16");
  });

  test("다운로드 크기와 VRAM 요구량은 안내용 상수", () => {
    // 두 값 모두 양수
    expect(COACH_MODEL_APPROX_MB).toBeGreaterThan(0);
    expect(COACH_MODEL_VRAM_MB).toBeGreaterThan(0);

    // VRAM이 더 큼 (실행 시 추가 메모리 필요)
    expect(COACH_MODEL_VRAM_MB).toBeGreaterThan(COACH_MODEL_APPROX_MB);
  });
});
