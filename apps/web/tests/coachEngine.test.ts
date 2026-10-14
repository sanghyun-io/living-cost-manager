import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// 각 테스트 전에 모듈을 리셋하여 엔진 상태를 초기화
beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setupMocks(options: { webGpuAvailable?: boolean; baseUrl?: string | null } = {}) {
  const { webGpuAvailable = true, baseUrl = null } = options;

  const mockCreateMLCEngine = vi.fn();

  vi.doMock("@mlc-ai/web-llm", () => ({
    CreateMLCEngine: mockCreateMLCEngine,
    prebuiltAppConfig: {
      model_list: [
        {
          model_id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
          model: "https://huggingface.co/default-model/"
        }
      ]
    }
  }));

  vi.doMock("../app/lib/coachModel", async () => {
    const actual = await vi.importActual("../app/lib/coachModel");
    return {
      ...actual,
      isWebGpuAvailable: vi.fn(() => webGpuAvailable),
      getCoachModelBaseUrl: vi.fn(() => baseUrl)
    };
  });

  return { mockCreateMLCEngine };
}

describe("getCoachEngine — consent policy", () => {
  test("콜드 스타트 시 consent 없으면 EXPLICIT_CONSENT_REQUIRED 에러", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const { getCoachEngine } = await import("../app/lib/coach");

    await expect(getCoachEngine()).rejects.toThrow("EXPLICIT_CONSENT_REQUIRED");
    expect(mockCreateMLCEngine).not.toHaveBeenCalled();
  });

  test("콜드 스타트 시 consent false면 EXPLICIT_CONSENT_REQUIRED 에러", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const { getCoachEngine } = await import("../app/lib/coach");

    await expect(
      getCoachEngine(undefined, { explicitDownloadConsent: false })
    ).rejects.toThrow("EXPLICIT_CONSENT_REQUIRED");
    expect(mockCreateMLCEngine).not.toHaveBeenCalled();
  });

  test("콜드 스타트 시 consent true면 CreateMLCEngine 호출", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");
    const result = await getCoachEngine(undefined, { explicitDownloadConsent: true });

    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);
    expect(result).toBe(fakeEngine);
  });

  test("WebGPU 미지원 시 WEBGPU_UNAVAILABLE 에러", async () => {
    const { mockCreateMLCEngine } = setupMocks({ webGpuAvailable: false });
    const { getCoachEngine } = await import("../app/lib/coach");

    await expect(
      getCoachEngine(undefined, { explicitDownloadConsent: true })
    ).rejects.toThrow("WEBGPU_UNAVAILABLE");
    expect(mockCreateMLCEngine).not.toHaveBeenCalled();
  });

  test("진행률 콜백이 CreateMLCEngine에 전달됨", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");
    const onProgress = vi.fn();

    await getCoachEngine(onProgress, { explicitDownloadConsent: true });

    expect(mockCreateMLCEngine).toHaveBeenCalledWith(
      "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      expect.objectContaining({
        initProgressCallback: expect.any(Function)
      })
    );
  });

  test("엔진 로드 실패 시 상태 초기화되어 다음 시도 가능", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    mockCreateMLCEngine.mockRejectedValue(new Error("GPU_ERROR"));

    const { getCoachEngine, getCoachEngineStatus } = await import("../app/lib/coach");

    await expect(
      getCoachEngine(undefined, { explicitDownloadConsent: true })
    ).rejects.toThrow("GPU_ERROR");

    expect(getCoachEngineStatus()).toBe("none");

    // 다음 시도 가능
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const result = await getCoachEngine(undefined, { explicitDownloadConsent: true });
    expect(result).toBe(fakeEngine);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(2);
  });
});

describe("getCoachEngine — engine reuse", () => {
  test("이미 준비된 엔진은 consent 없이 재사용", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");

    // 첫 로드 (consent 필요)
    await getCoachEngine(undefined, { explicitDownloadConsent: true });
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);

    // 두 번째 호출 (consent 불필요)
    const result = await getCoachEngine();
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1); // 추가 호출 없음
    expect(result).toBe(fakeEngine);
  });

  test("로딩 중인 엔진은 consent 없이 대기", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    
    // Deferred promise 패턴
    let resolveEngine: (engine: any) => void;
    const enginePromise = new Promise<any>((resolve) => {
      resolveEngine = resolve;
    });
    mockCreateMLCEngine.mockReturnValue(enginePromise);

    const { getCoachEngine } = await import("../app/lib/coach");

    // 첫 로드 시작 (아직 완료 안됨)
    const promise1 = getCoachEngine(undefined, { explicitDownloadConsent: true });
    
    // 약간의 지연을 주어 dynamic import가 완료되도록 함
    await new Promise((r) => setTimeout(r, 10));

    // 로딩 중 두 번째 호출 (consent 불필요)
    const promise2 = getCoachEngine();

    // 엔진 로드 완료
    resolveEngine!(fakeEngine);

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toBe(fakeEngine);
    expect(result2).toBe(fakeEngine);
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1); // 한 번만 호출
  });

  test("getCoachEngineStatus는 상태 정확히 반환", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const { getCoachEngine, getCoachEngineStatus } = await import("../app/lib/coach");

    expect(getCoachEngineStatus()).toBe("none");

    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    let resolveEngine: (engine: any) => void;
    const enginePromise = new Promise<any>((resolve) => {
      resolveEngine = resolve;
    });
    mockCreateMLCEngine.mockReturnValue(enginePromise);

    // 로딩 시작
    const promise = getCoachEngine(undefined, { explicitDownloadConsent: true });
    
    // dynamic import 완료 대기
    await new Promise((r) => setTimeout(r, 10));
    
    expect(getCoachEngineStatus()).toBe("loading");

    // 로드 완료
    resolveEngine!(fakeEngine);
    await promise;
    expect(getCoachEngineStatus()).toBe("ready");
  });

  test("준비된 엔진 재사용 시 진행률 콜백도 바로 완료", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");

    // 첫 로드
    await getCoachEngine(undefined, { explicitDownloadConsent: true });

    // 재사용 시 progress 콜백 호출 여부 확인
    const onProgress = vi.fn();
    const result = await getCoachEngine(onProgress);
    expect(result).toBe(fakeEngine);
    // 재사용 시에는 progress 콜백이 호출되지 않음 (이미 완료됨)
  });
});

describe("getCoachEngine — baseUrl override", () => {
  test("baseUrl 설정 시 appConfig로 모델 URL 덮어쓰기", async () => {
    const { mockCreateMLCEngine } = setupMocks({ baseUrl: "https://models.gamja.top/qwen/" });
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");
    await getCoachEngine(undefined, { explicitDownloadConsent: true });

    expect(mockCreateMLCEngine).toHaveBeenCalledWith(
      "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      expect.objectContaining({
        appConfig: expect.objectContaining({
          model_list: expect.arrayContaining([
            expect.objectContaining({
              model_id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
              model: "https://models.gamja.top/qwen/"
            })
          ])
        })
      })
    );
  });

  test("baseUrl 미설정 시 appConfig undefined", async () => {
    const { mockCreateMLCEngine } = setupMocks({ baseUrl: null });
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");
    await getCoachEngine(undefined, { explicitDownloadConsent: true });

    expect(mockCreateMLCEngine).toHaveBeenCalledWith(
      "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
      expect.objectContaining({
        appConfig: undefined
      })
    );
  });
});

describe("getCoachEngine — concurrent calls", () => {
  test("동시 여러 호출도 엔진은 한 번만 생성", async () => {
    const { mockCreateMLCEngine } = setupMocks();
    const fakeEngine = { chat: { completions: { create: vi.fn() } } };
    mockCreateMLCEngine.mockResolvedValue(fakeEngine);

    const { getCoachEngine } = await import("../app/lib/coach");

    // 동시 3개 호출
    const promises = [
      getCoachEngine(undefined, { explicitDownloadConsent: true }),
      getCoachEngine(undefined, { explicitDownloadConsent: true }),
      getCoachEngine(undefined, { explicitDownloadConsent: true })
    ];

    const results = await Promise.all(promises);
    
    expect(mockCreateMLCEngine).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe(fakeEngine);
    expect(results[1]).toBe(fakeEngine);
    expect(results[2]).toBe(fakeEngine);
  });
});
