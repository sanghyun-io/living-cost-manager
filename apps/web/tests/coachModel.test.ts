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
  test("COACH_MODEL_ID는 WebLLM prebuilt Qwen2.5-0.5B", () => {
    expect(COACH_MODEL_ID).toBe("Qwen2.5-0.5B-Instruct-q4f16_1-MLC");
  });

  test("COACH_MODEL_APPROX_MB는 약 500MB (안내용)", () => {
    expect(COACH_MODEL_APPROX_MB).toBe(500);
    expect(typeof COACH_MODEL_APPROX_MB).toBe("number");
    expect(COACH_MODEL_APPROX_MB).toBeGreaterThan(0);
  });

  test("COACH_MODEL_VRAM_MB는 약 945MB (GPU 메모리)", () => {
    expect(COACH_MODEL_VRAM_MB).toBe(945);
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

  test("유효한 URL은 그대로 반환 (끝 슬래시 제거)", () => {
    expect(getCoachModelBaseUrl("https://models.gamja.top/qwen/")).toBe(
      "https://models.gamja.top/qwen/"
    );
  });

  test("끝 슬래시가 없으면 추가", () => {
    expect(getCoachModelBaseUrl("https://models.gamja.top/qwen")).toBe(
      "https://models.gamja.top/qwen/"
    );
  });

  test("여러 개의 끝 슬래시는 하나로 정규화", () => {
    expect(getCoachModelBaseUrl("https://models.gamja.top/qwen///")).toBe(
      "https://models.gamja.top/qwen/"
    );
  });

  test("앞뒤 공백은 제거", () => {
    expect(getCoachModelBaseUrl("  https://models.gamja.top/qwen  ")).toBe(
      "https://models.gamja.top/qwen/"
    );
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

  test("모델 ID는 Instruct 버전 (지시 따름)", () => {
    expect(COACH_MODEL_ID).toContain("Instruct");
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
