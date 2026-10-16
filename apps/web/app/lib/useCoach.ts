"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildInsuranceCheck, buildMonthlyReport, buildSavingsInsights, getUpcomingDues, type MonthlyReport } from "@living-cost-manager/shared";
import {
  COACH_MODEL_APPROX_MB,
  COACH_MODEL_ENABLE_THINKING,
  COACH_MODEL_ID,
  COACH_MODEL_VRAM_MB,
  isWebGpuAvailable,
  setCoachOptIn
} from "./coachModel";
import { streamCoaching, type CoachInput } from "./coach";
import type { CoachStatus } from "../components/modals/CoachModal";
import type { ServerSession, ServerApiClient } from "./serverApi";
import type { BudgetDataApi } from "./useBudgetData";
import { getPageStore, getPageFactory, runExclusiveInference } from "./coachEngine/pageManager";
import { sanitizeCoachError } from "./coachEngine/coachErrors";
import {
  createWorkerCoachEngineFactory,
  type WorkerCoachEngineFactory
} from "./coachEngine/createWebWorkerClient";

interface UseCoachOptions {
  budget: BudgetDataApi;
  serverApi: ServerApiClient | null;
  protectedFixedCostIds?: ReadonlySet<string>;
  coachingPreferencesReady?: boolean;
}

const EMPTY_PROTECTED_IDS: ReadonlySet<string> = new Set();
const PREFERENCES_UNAVAILABLE = "코칭 설정을 확인할 수 없어 추천을 보류했습니다. 내 코칭 설정을 확인해 주세요.";

// CRITICAL: 코치 준비/추론은 페이지 단위 store 에서 단일 모델을 단일 잡으로 관리한다.
// - useSyncExternalStore + 외부 store 로 모달 리마운트와 무관하게 상태가 유지된다.
// - 같은 페이지에서 prepareCoach() 를 동시에 두 번 불러도 single-flight 된다.
// - 모달이 닫혀도 in-flight 작업은 살아있고 header 의 discreet 버튼에 그대로
//   진행률/완료가 반영된다.
//
// CRITICAL — 모듈 상태:
// 페이지 단위 store/factory 는 모듈 레벨에서 관리되지만, 테스트 격리를 위한
// export 는 제거되었다. 테스트는 vi.mock 으로 coachEngine 모듈을 mock 한다.

// prepare factory wrapper. default SDK + worker 생성.
export function createProvisionFactory(): WorkerCoachEngineFactory {
  // enable_thinking 은 chatOpts(ChatConfig) 가 아닌 chat completion 요청의
  // extra_body 로 전달된다 (ChatOptions 타입에는 없는 GenerationConfig 필드).
  // 따라서 chatOpts 는 두지 않고 generateSegment 의 chat.completions.create
  // 호출 시점에 extra_body 로 같이 보낸다.
  return createWorkerCoachEngineFactory({
    modelId: COACH_MODEL_ID,
    enableThinking: COACH_MODEL_ENABLE_THINKING
  });
}

/**
 * On-device AI coach — PREPARATION (background) + COACHING (explicit).
 *
 * CRITICAL POLICY:
 * - PREPARATION: 모달 '동의하고 AI 준비' 버튼으로 시작, 그 뒤 모달 닫아도 계속.
 *         같은 모델 ID / window 가 살아있는 동안 결과는 store 에 유지되어 헤더
 *         버튼 / 모달 재오픈에서 다시 보여진다. 실패/워커사망/취소 시
 *         store 가 권한을 리셋 → 다음 시작은 새 동의가 필요하다.
 * - COACHING: 준비 완료 후 모달 '코칭 보기' (헤더 버튼은 모달만 열어주며
 *         자동 시작 금지. 모달에서만 명시적 클릭). 실행 중 모달 닫으면
 *         출력을 폐기하지만 워커는 죽이지 않는다.
 * - PROTECTED: 보호 항목(절대 건드리면 안되는 항목명/사유/원본 예산 텍스트) 는
 *         엔진에 절대 전달되지 않는다. 격려 패러프레이즈에 필요한 정보만
 *         mainthread 의 selectCoachSegments 결과로 만들어진다.
 */
export function useCoach({ budget, serverApi, protectedFixedCostIds = EMPTY_PROTECTED_IDS, coachingPreferencesReady = true }: UseCoachOptions) {
  const preferencesReadyRef = useRef(coachingPreferencesReady);
  preferencesReadyRef.current = coachingPreferencesReady;
  const [isCoachModalOpen, setIsCoachModalOpen] = useState(false);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>("idle");
  const [coachProgress, setCoachProgress] = useState(0);
  const [coachProgressText, setCoachProgressText] = useState("");
  const [coachingText, setCoachingText] = useState("");
  const [coachError, setCoachError] = useState("");
  // 서버 동기화 히스토리로 계산한 월간 추세
  const [monthlyReport, setMonthlyReport] = useState<MonthlyReport | null>(null);

  // attempt-scoped consent: 모달을 열 때마다 초기화. 콜드 스타트 download 의
  // 호출 권한만 의미한다.
  const coachAttemptConsentRef = useRef(false);

  // generation tracking: 현재 실행 중인 코칭을 식별
  const currentGenerationRef = useRef(0);
  const monthlyReportGenRef = useRef(0);
  const activeReportScopeRef = useRef<string | null>(null);

  // CRITICAL — Inference serialization:
  // isRunningRef 는 현재 추론이 진행 중인지 추적하지만, old stream 이 unwinding
  // 중인 동안에는 false 로 설정되지 않는다. requestIdentity 로 각 추론 요청을
  // 식별하고, finally 블록에서 현재 요청의 identity 와 일치할 때만 정리한다.
  const isRunningRef = useRef(false);
  const currentRequestIdentityRef = useRef<symbol | null>(null);
  const pendingGenerationsRef = useRef(new Set<number>());

  // 현재 추론 중인 엔진 참조. 모달이 닫혀도 워커는 유지하고 interruptGenerate
  // 만 호출해서 토큰 생성을 멈춘다. 다음 추론은 같은 워커에서 이어갈 수 있다.
  const activeEngineRef = useRef<{ interruptGenerate?: () => void } | null>(null);
  useEffect(() => () => {
    currentGenerationRef.current++;
    activeEngineRef.current?.interruptGenerate?.();
  }, []);

  // 외부 store 구독 (모달/헤더가 같은 상태를 본다).
  const store = getPageStore();
  const idleFallback = useMemo(
    () => ({ state: "idle" as const, modelId: null, jobId: 0, progress: 0, progressText: "", error: null }),
    []
  );
  const prep = useSyncExternalStore(
    store.subscribe.bind(store),
    store.getSnapshot.bind(store),
    () => idleFallback
  );

  const { fixedCosts, monthlyIncome, summary, localScopeKey } = budget;

  // Scope changes invalidate advice, never the already-approved artifact job.
  const scopeFingerprint = useMemo(() => ({
    localScopeKey,
    profileName: budget.profileName
  }), [localScopeKey, budget.profileName]);

  const coachInput = useMemo<CoachInput>(() => {
    const now = new Date();
    const savings = coachingPreferencesReady ? buildSavingsInsights(fixedCosts, { protectedFixedCostIds }).map((s) => ({
      title: s.title,
      monthlySavings: s.monthlySavings,
      targetItemNames: s.items.map(item => item.name)
    })) : [];
    const upcoming = getUpcomingDues(fixedCosts, now, 14)
      .slice(0, 5)
      .map((u) => ({ name: u.item.name, amount: u.item.amount, daysUntil: u.daysUntil }));
    const insurance = coachingPreferencesReady ? buildInsuranceCheck(fixedCosts, monthlyIncome, { protectedFixedCostIds }) : null;

    const eligibleReviewNames = insurance?.canSuggestReview
      ? fixedCosts
          .filter(item => insurance.reviewItemIds.includes(item.id))
          .map(item => item.name)
      : [];

    const hasTrend = monthlyReport?.previous != null && monthlyReport?.deltaAmount != null;
    return {
      monthlyTotal: summary.monthlyExpense,
      previousMonthlyTotal: hasTrend ? monthlyReport!.previous!.fixedCostMonthlyTotal : null,
      deltaAmount: hasTrend ? monthlyReport!.deltaAmount : null,
      deltaPercent: hasTrend ? monthlyReport!.deltaPercent : null,
      monthlyIncome,
      fixedCostCount: fixedCosts.length,
      savings,
      upcoming,
      insuranceHigh: insurance?.canSuggestReview ?? false,
      insuranceReviewItemNames: eligibleReviewNames.length > 0 ? eligibleReviewNames : undefined
    };
  }, [fixedCosts, monthlyIncome, summary.monthlyExpense, monthlyReport, protectedFixedCostIds, coachingPreferencesReady]);

  const inputFingerprint = JSON.stringify([coachingPreferencesReady, coachInput, [...protectedFixedCostIds].sort()]);
  const liveInputKey = JSON.stringify([scopeFingerprint, inputFingerprint]);
  const liveInputRef = useRef(liveInputKey);
  const [outputInputKey, setOutputInputKey] = useState("");
  if (liveInputRef.current !== liveInputKey) {
    liveInputRef.current = liveInputKey;
    currentGenerationRef.current++;
  }

  const coachFallbackHeadline = useMemo(() => {
    if (!coachingPreferencesReady) return "코칭 설정 확인 전에는 개인화 제안을 보류합니다.";
    const rate =
      monthlyIncome > 0 ? Math.round((summary.monthlyExpense / monthlyIncome) * 1000) / 10 : null;
    const rateText = rate !== null ? ` 수입의 ${rate}%예요.` : "";
    return `이번 달 월 환산 고정비는 ${summary.monthlyExpense.toLocaleString("ko-KR")}원, ${fixedCosts.length}건이에요.${rateText}`;
  }, [summary.monthlyExpense, monthlyIncome, fixedCosts.length, coachingPreferencesReady]);

  const coachHasData = fixedCosts.length > 0;

  // CRITICAL — Scope/input 변경 시 코칭 결과만 무효화하고, 준비 작업은 유지한다.
  // input/scope 가 바뀌면 현재 진행 중인 코칭 텍스트만 클리어한다.
  // 준비 작업(모델 다운로드)은 계속 진행되어 재사용 가능하다.
  // 사용자가 명시적으로 취소하거나 실패하지 않는 한 store.reset() 을 호출하지 않는다.
  useEffect(() => {
    currentGenerationRef.current += 1;
    setCoachingText("");
    setCoachError("");
    setCoachStatus("idle");
    activeEngineRef.current?.interruptGenerate?.();
    if (!coachingPreferencesReady) coachAttemptConsentRef.current = false;
    // CRITICAL: isRunningRef 는 현재 요청의 identity 가 일치할 때만 false 로 설정
    // (finally 블록에서 처리). 여기서는 즉시 false 로 설정하지 않는다.
    // CRITICAL: store.reset() 제거 — 입력 변경이 다운로드를 죽이면 안 된다.
  }, [scopeFingerprint, inputFingerprint, coachingPreferencesReady]);

  function blockUnavailablePreferences(): boolean {
    if (coachingPreferencesReady && preferencesReadyRef.current) return false;
    coachAttemptConsentRef.current = false;
    // CRITICAL: isRunningRef 는 현재 요청의 identity 가 일치할 때만 false 로 설정
    setCoachingText("");
    setCoachStatus("error");
    setCoachError(PREFERENCES_UNAVAILABLE);
    return true;
  }

  // Modal close 시 in-flight 준비를 취소하지 않는다 — store 의 결과는 그대로.
  // 단, 코칭 텍스트/에러/세대를 클리어 한다. 진행 중 추론은 interruptGenerate 만
  // 호출해 토큰 생성을 멈추고, 워커 자체는 종료하지 않는다(다음 추론 재사용).
  function closeCoachModal() {
    setIsCoachModalOpen(false);
    coachAttemptConsentRef.current = false;
    currentGenerationRef.current += 1;
    // CRITICAL: isRunningRef 는 현재 요청의 identity 가 일치할 때만 false 로 설정
    // (finally 블록에서 처리). 여기서는 즉시 false 로 설정하지 않는다.
    if (coachStatus === "loading" || coachStatus === "generating") {
      try {
        activeEngineRef.current?.interruptGenerate?.();
      } catch (_err) {
        // 무시 — interrupt 실패는 다음 추론을 막지 않는다.
      }
      activeEngineRef.current = null;
      setCoachStatus("idle");
      setCoachingText("");
      setCoachProgress(0);
      setCoachProgressText("");
    }
  }

  function openCoachModal() {
    setIsCoachModalOpen(true);
    if (blockUnavailablePreferences()) return;
    setCoachError("");
    coachAttemptConsentRef.current = false;
  }

  // 콜드 스타트 동의 화면 = 모델 미준비 + 데이터 있고 + 동의 없음.
  const awaitingConsent = coachingPreferencesReady
    && isWebGpuAvailable()
    && coachHasData
    && prep.state === "idle"
    && !coachAttemptConsentRef.current;

  // 백그라운드 준비 시작 (modal '동의하고 AI 준비' 버튼).
  function confirmConsentAndPrepare() {
    if (blockUnavailablePreferences()) return;
    if (!isWebGpuAvailable()) {
      setCoachStatus("error");
      setCoachError("이 브라우저는 WebGPU를 지원하지 않습니다.");
      return;
    }
    if (!coachHasData) return;
    // 이미 살아있는 모델/스냅샷 → 새 콜드 다운로드 없이 ready 유지.
    if (prep.state === "ready" && prep.modelId === COACH_MODEL_ID) {
      // 모달은 열어둔 채로 둔다.
      return;
    }
    coachAttemptConsentRef.current = true;
    void prepareCoachInternal();
  }

  async function prepareCoachInternal() {
    if (!coachAttemptConsentRef.current) {
      setCoachError("모델 다운로드에 동의가 필요합니다.");
      return;
    }
    if (!isWebGpuAvailable()) {
      setCoachError("이 브라우저는 WebGPU를 지원하지 않습니다.");
      return;
    }
    try {
      const factory: WorkerCoachEngineFactory = getPageFactory(() => createProvisionFactory());
      // 모델 ID 가 다르면 store 가 기존 워커를 정리한다.
      store.beginPreparation({
        modelId: COACH_MODEL_ID,
        explicitDownloadConsent: coachAttemptConsentRef.current,
        factory
      });
      setCoachStatus("loading");
    } catch (err) {
      // 보안: beginPreparation 내부 코드나 SDK 원시 오류가 화면에 그대로 노출되지
      // 않도록 고정 한국어 메시지로 변환한다.
      setCoachError(sanitizeCoachError(err, "prepare"));
      setCoachStatus("error");
    }
  }

  // Modal '다른 작업 계속하기' = 모달만 닫고 준비는 계속.
  function continueWithoutModal() {
    setIsCoachModalOpen(false);
    coachAttemptConsentRef.current = false;
  }

  // 사용자가 명시적으로 '준비 취소'.
  function cancelPreparation() {
    store.cancelPreparation();
    coachAttemptConsentRef.current = false;
    setCoachProgress(0);
    setCoachProgressText("");
    if (prep.state !== "ready") {
      setCoachStatus("idle");
    }
  }

  // Manual retry: 동의 화면을 다시 보여주도록 store 를 reset 한다.
  function retryPreparation() {
    store.reset();
    coachAttemptConsentRef.current = false;
    setCoachError("");
    setCoachProgress(0);
    setCoachProgressText("");
    setCoachStatus("idle");
  }

  // Modal '코칭 보기': 명시적 코칭 생성. 모달 안에서만 가능.
  // CRITICAL — Inference serialization:
  // 각 요청은 고유한 identity 를 가지며, finally 블록에서 현재 identity 와
  // 일치할 때만 isRunningRef 를 false 로 설정한다. old stream 이 unwinding 중인
  // 동안에는 새로운 요청이 시작되지 않는다.
  async function generateCoachingNow() {
    if (blockUnavailablePreferences()) return;
    if (liveInputRef.current !== liveInputKey || store.getSnapshot().state !== "ready" || !coachHasData) return;
    const requestedGeneration = currentGenerationRef.current;
    if (pendingGenerationsRef.current.has(requestedGeneration)) return;
    pendingGenerationsRef.current.add(requestedGeneration);
    try {
      await runExclusiveInference(async () => {
        // A waiting click is not permission to send stale financial input.
        if (currentGenerationRef.current !== requestedGeneration || liveInputRef.current !== liveInputKey || !preferencesReadyRef.current || store.getSnapshot().state !== "ready") return;
        await generateCoachingActive();
      });
    } finally {
      pendingGenerationsRef.current.delete(requestedGeneration);
    }
  }

  async function generateCoachingActive() {
    if (blockUnavailablePreferences()) return;
    if (liveInputRef.current !== liveInputKey) return;
    if (prep.state !== "ready") return;
    if (!coachHasData) return;
    if (isRunningRef.current) return;

    // CRITICAL: 고유한 request identity 생성
    const requestIdentity = Symbol("coaching-request");
    currentRequestIdentityRef.current = requestIdentity;

    const generation = currentGenerationRef.current;
    isRunningRef.current = true;
    setCoachError("");
    setCoachingText("");
    setOutputInputKey(liveInputKey);
    setCoachStatus("generating");
    const engineJobId = store.getSnapshot().jobId;
    let stopSubscription = () => {};
    const workerDisposed = new Promise<void>(resolve => {
      stopSubscription = store.subscribe(snapshot => {
        if (snapshot.jobId === engineJobId && snapshot.state === "ready") return;
        currentGenerationRef.current++;
        // SDK stream RPCs, like reload, can remain unresolved after terminate.
        // Release the queue only AFTER disposal so no live GPU streams overlap.
        void Promise.resolve().then(() => store.whenDisposed()).then(resolve);
      });
    });
    try {
      const factory = getPageFactory(() => createProvisionFactory());
      const engine = factory.getEngine();
      if (!engine) {
        throw new Error("ENGINE_NOT_READY");
      }
      activeEngineRef.current = engine as unknown as { interruptGenerate?: () => void };
      await Promise.race([streamCoaching(
        engine,
        coachInput,
        (full) => {
          if (currentGenerationRef.current === generation) {
            setCoachingText(full);
          }
        },
        { protectedItemNames: fixedCosts.filter(item => protectedFixedCostIds.has(item.id)).map(item => item.name) }
      ), workerDisposed]);
      if (currentGenerationRef.current !== generation) return;
      setCoachStatus("ready");
      setCoachOptIn(true);
    } catch (err) {
      if (currentGenerationRef.current !== generation) return;
      // 보안: streamCoaching/SDK 원시 오류 메시지(URL·스택 포함 가능)는 분류에만
      // 쓰고 화면에는 고정 한국어 메시지만 올린다. 추론 실패는 ready/artifact 를
      // 건드리지 않는다(store 전이 없음, 새 동의·재다운로드 없음).
      setCoachingText("");
      setCoachError(sanitizeCoachError(err, "inference"));
      setCoachStatus("error");
    } finally {
      stopSubscription();
      activeEngineRef.current = null;
      // CRITICAL: 현재 요청의 identity 와 일치할 때만 정리
      if (currentRequestIdentityRef.current === requestIdentity) {
        isRunningRef.current = false;
        currentRequestIdentityRef.current = null;
      }
    }
  }

  // 코칭이 끝나거나 input/scope 가 바뀌면 재실행 (모달 안에서 '다시 코칭' 버튼).
  const runCoaching = generateCoachingNow;

  // 외부 store 의 변화(시작/준비/실패)를 모달 상태에 반영한다.
  useEffect(() => {
    if (prep.state === "preparing") {
      setCoachProgress(prep.progress);
      setCoachProgressText(prep.progressText);
      setCoachStatus("loading");
      setCoachError("");
    } else if (prep.state === "ready") {
      setCoachProgress(1);
      setCoachProgressText("준비됨");
      // 다운로드 끝났지만 코칭 시작 안함 — idle 로 두어 모달 별도 CTA 로
      // 사용자가 명시적으로 코칭 보기를 누르도록 한다.
      if (coachStatus === "loading") {
        setCoachStatus("idle");
      }
    } else if (prep.state === "cancelled") {
      currentGenerationRef.current++;
      setCoachingText("");
      setCoachProgress(0);
      setCoachProgressText("");
      setCoachStatus("idle");
      setCoachError("");
    } else if (prep.state === "error") {
      currentGenerationRef.current++;
      setCoachingText("");
      setCoachStatus("error");
      // prep.error 는 store 전이 경계에서 이미 sanitizeCoachError 를 통과한 고정
      // 메시지다. 재분류하면 고정 문자열이 다른 고정 문자열로 바뀔 수 있으므로
      // (멱등 아님) 그대로 display 한다.
      setCoachError(prep.error || "준비에 실패했어요");
    } else if (prep.state === "idle") {
      setCoachProgress(0);
      setCoachProgressText("");
    }
    // coachStatus 의존성은 모달 본문에 들어갈 현재 상태만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prep.state, prep.progress, prep.progressText, prep.error]);

  // Header 용 정리 상태.
  const headerIndicator: "none" | "preparing" | "ready" | "error" =
    prep.state === "preparing" ? "preparing"
    : prep.state === "ready" ? "ready"
    : prep.state === "error" ? "error"
    : "none";

  const headerProgressLabel = prep.state === "preparing"
    ? `AI 준비 중 ${Math.round((prep.progress || 0) * 100)}%`
    : null;
  const headerReadyLabel = prep.state === "ready" ? "AI 준비 완료 · 코칭 보기" : null;

  function reportScopeOf(session: ServerSession): string | null {
    return session.workspace ? `${session.user.id}|${session.workspace.id}` : null;
  }

  async function refreshMonthlyReport(session: ServerSession) {
    if (!serverApi || !session.workspace) {
      return;
    }
    const scope = reportScopeOf(session);
    const workspaceId = session.workspace.id;
    const gen = monthlyReportGenRef.current;
    try {
      const entries = await serverApi.getSnapshotHistory(workspaceId, session.token, 24);
      if (monthlyReportGenRef.current !== gen || activeReportScopeRef.current !== scope) {
        return;
      }
      setMonthlyReport(buildMonthlyReport(entries));
    } catch {
      // 무시
    }
  }

  function invalidateMonthlyReport(nextSession: ServerSession | null = null) {
    monthlyReportGenRef.current += 1;
    activeReportScopeRef.current = nextSession ? reportScopeOf(nextSession) : null;
    setMonthlyReport(null);
  }

  return {
    isCoachModalOpen,
    setIsCoachModalOpen,
    coachStatus,
    coachProgress,
    coachProgressText,
    coachingText: prep.state === "ready" && outputInputKey === liveInputKey ? coachingText : "",
    coachError,
    coachHasData,
    coachInput,
    coachFallbackHeadline,
    coachAttemptConsent: coachAttemptConsentRef.current,
    awaitingConsent,
    preparation: {
      state: prep.state,
      modelId: prep.modelId,
      jobId: prep.jobId,
      progress: prep.progress,
      progressText: prep.progressText,
      error: prep.error
    },
    headerIndicator,
    headerProgressLabel,
    headerReadyLabel,
    COACH_MODEL_APPROX_MB,
    COACH_MODEL_VRAM_MB,
    COACH_MODEL_ID,
    COACH_MODEL_ENABLE_THINKING,
    monthlyReport,
    runCoaching,
    generateCoachingNow,
    confirmConsentAndPrepare,
    // BACKWARD COMPAT — 일부 테스트가 옛 이름으로 호출한다. 새 흐름에서는
    // confirmConsentAndPrepare 가 동의 후 prepare 까지 함께 진행하지만, 옛
    // 테스트는 engine/stream 이 호출되지 않는지만 확인한다.
    confirmConsentAndRun: confirmConsentAndPrepare,
    continueWithoutModal,
    cancelPreparation,
    retryPreparation,
    openCoachModal,
    closeCoachModal,
    refreshMonthlyReport,
    invalidateMonthlyReport,
    onHeaderOpenCoach: openCoachModal
  } as const;
}

export type CoachApi = ReturnType<typeof useCoach>;
