"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildInsuranceCheck, buildMonthlyReport, buildSavingsInsights, getUpcomingDues, type MonthlyReport } from "@living-cost-manager/shared";
import { getCoachEngine, getCoachEngineStatus, streamCoaching, type CoachInput } from "./coach";
import { isCoachOptedIn, isWebGpuAvailable, setCoachOptIn, COACH_MODEL_APPROX_MB, COACH_MODEL_VRAM_MB } from "./coachModel";
import { track } from "./analytics";
import type { CoachStatus } from "../components/modals/CoachModal";
import type { ServerSession, ServerApiClient } from "./serverApi";
import type { BudgetDataApi } from "./useBudgetData";

interface UseCoachOptions {
  budget: BudgetDataApi;
  serverApi: ServerApiClient | null;
  protectedFixedCostIds?: ReadonlySet<string>;
  coachingPreferencesReady?: boolean;
}

const EMPTY_PROTECTED_IDS: ReadonlySet<string> = new Set();
const PREFERENCES_UNAVAILABLE = "코칭 설정을 확인할 수 없어 추천을 보류했습니다. 내 코칭 설정을 확인해 주세요.";

/**
 * On-device AI coach (opt-in, WebGPU).
 *
 * CRITICAL PRIVACY/DOWNLOAD POLICY:
 * - EVERY cold getCoachEngine() call MUST be gated on explicit user consent
 * - Attempt-scoped consent: each modal session requires new consent
 * - In-memory engine reuse is allowed without additional consent
 * - NO automatic model download without positive click
 * - Cache existence does NOT authorize download (cache may be partial/evicted)
 * - Data scope changes (user/workspace switch) invalidate previous coaching
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

  // CRITICAL: Attempt-scoped download consent
  // 이 동의는 모달이 열릴 때마다 초기화되며, 메모리에만 존재한다.
  // useRef를 사용하여 동기적으로 접근 (React state의 비동기 문제 해결)
  const coachAttemptConsentRef = useRef(false);

  // Generation tracking: 현재 실행 중인 코칭 생성을 식별
  // scope/input 변경 시 이전 생성을 무효화하기 위해 사용
  const currentGenerationRef = useRef(0);

  // monthlyReport 요청 세대
  const monthlyReportGenRef = useRef(0);
  const activeReportScopeRef = useRef<string | null>(null);
  // 실행 중 방지
  const isRunningRef = useRef(false);

  const { fixedCosts, monthlyIncome, summary, localScopeKey } = budget;

  // Scope fingerprint: localScopeKey가 변경되면 이전 코칭 무효화
  const scopeFingerprint = useMemo(() => ({
    localScopeKey,
    profileName: budget.profileName
  }), [localScopeKey, budget.profileName]);

  const coachInput = useMemo<CoachInput>(() => {
    const now = new Date();
    const savings = coachingPreferencesReady ? buildSavingsInsights(fixedCosts, { protectedFixedCostIds }).map((s) => ({
      title: s.title,
      monthlySavings: s.monthlySavings,
      // CRITICAL: Pass actionable target names for deterministic coach sentences.
      // insight.items already filtered by protection at shared layer.
      targetItemNames: s.items.map(item => item.name)
    })) : [];
    const upcoming = getUpcomingDues(fixedCosts, now, 14)
      .slice(0, 5)
      .map((u) => ({ name: u.item.name, amount: u.item.amount, daysUntil: u.daysUntil }));
    const insurance = coachingPreferencesReady ? buildInsuranceCheck(fixedCosts, monthlyIncome, { protectedFixedCostIds }) : null;

    // Filter ONLY eligible review items (protected excluded, actually exists in current items)
    // Review targets exclude protected names; neutral upcoming reminders are unchanged.
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

  // Input fingerprint: 코칭 입력이 변경되면 이전 결과 무효화
  const inputFingerprint = JSON.stringify([coachingPreferencesReady, coachInput, [...protectedFixedCostIds].sort()]);
  const liveInputKey = JSON.stringify([scopeFingerprint, inputFingerprint]);
  const liveInputRef = useRef(liveInputKey);
  const [outputInputKey, setOutputInputKey] = useState("");
  // Invalidate during render, before effects: old stream callbacks cannot flash stale advice.
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

  // CRITICAL: Scope/Input 변경 시 이전 코칭 결과 무효화
  useEffect(() => {
    // 세대 증가: 이전 실행 중인 코칭이 있으면 무시됨
    currentGenerationRef.current += 1;
    // 이전 결과 클리어
    setCoachingText("");
    setCoachError("");
    setCoachStatus("idle");
    if (!coachingPreferencesReady) coachAttemptConsentRef.current = false;
    // 실행 중 락 해제
    isRunningRef.current = false;
  }, [scopeFingerprint, inputFingerprint, coachingPreferencesReady]);

  // Scope 변경 시 상태 리셋
  useEffect(() => {
    // 다른 사용자/워크스페이스로 전환 시 완전 초기화
    currentGenerationRef.current += 1;
    setCoachingText("");
    setCoachError("");
    setCoachStatus("idle");
    coachAttemptConsentRef.current = false;
    isRunningRef.current = false;
  }, [scopeFingerprint]);

  /**
   * CRITICAL: 코칭 실행 전 동의 확인
   * - 콜드 스타트(엔진 없음)에만 동의 필요
   * - READY/LOADING 엔진은 동의 없이 재사용 가능
   * - 세대 토큰으로 scope/input 변경 시 무효화 처리
   */
  function blockUnavailablePreferences() {
    // Check the live render too: a callback captured before failure is not permission.
    if (coachingPreferencesReady && preferencesReadyRef.current) return false;
    coachAttemptConsentRef.current = false;
    isRunningRef.current = false;
    setCoachingText("");
    setCoachStatus("error");
    setCoachError(PREFERENCES_UNAVAILABLE);
    return true;
  }

  async function runCoaching() {
    if (blockUnavailablePreferences()) return;
    if (isRunningRef.current) {
      return;
    }

    const generation = currentGenerationRef.current;
    isRunningRef.current = true;

    try {
      track({ type: "coach.request", timestamp: Date.now(), data: {} });

      if (!isWebGpuAvailable()) {
        setCoachStatus("error");
        setCoachError("이 브라우저는 WebGPU를 지원하지 않습니다.");
        return;
      }

      // CRITICAL: 엔진 상태 확인
      const engineStatus = getCoachEngineStatus();

      // 콜드 스타트인지 확인
      const isColdStart = engineStatus === "none";

      // CRITICAL: 콜드 스타트에만 동의 필요
      if (isColdStart && !coachAttemptConsentRef.current) {
        // 동의 대기 상태 - UI가 동의 화면을 표시
        setCoachStatus("idle");
        return;
      }

      // READY/LOADING은 동의 없이 진행 가능
      // 동의됨 - 실제 실행
      await executeCoaching(generation);
    } finally {
      // 현재 세대만 락 해제
      if (currentGenerationRef.current === generation) {
        isRunningRef.current = false;
      }
    }
  }

  /**
   * 실제 코칭 실행 (동의 후에만 호출)
   * @param generation 호출 시점의 세대 토큰
   */
  async function executeCoaching(generation: number) {
    if (blockUnavailablePreferences()) return;
    if (generation !== currentGenerationRef.current) return;
    setOutputInputKey(liveInputKey);
    setCoachError("");
    setCoachingText("");

    try {
      setCoachStatus("loading");

      // CRITICAL: 엔진 상태 확인
      const engineStatus = getCoachEngineStatus();

      // 콜드 스타트인지 확인 (이미 동의된 것은 consent 불필요)
      const isColdStart = engineStatus === "none";

      // 콜드 스타트면 동의 전달 (ref 사용)
      const consent = isColdStart ? { explicitDownloadConsent: coachAttemptConsentRef.current } : undefined;

      // CRITICAL: 이 시점에서만 getCoachEngine 호출 (네트워크 요청)
      const engine = await getCoachEngine((p) => {
        // 현재 세대만 상태 업데이트
        if (currentGenerationRef.current === generation) {
          setCoachProgress(p.progress);
          setCoachProgressText(p.text);
        }
      }, consent);

      // 세대 확인: 엔진 로드 중에 scope/input이 변경되었으면 중단
      if (currentGenerationRef.current !== generation) {
        return; // 이전 세대의 실행, 무시
      }

      // 성공 - 기능 opt-in 설정
      setCoachOptIn(true);

      setCoachStatus("generating");
      await streamCoaching(engine, coachInput, (full) => {
        // 현재 세대만 상태 업데이트
        if (currentGenerationRef.current === generation) {
          setCoachingText(full);
        }
      }, { protectedItemNames: fixedCosts.filter(item => protectedFixedCostIds.has(item.id)).map(item => item.name) });

      // 세대 확인: 스트리밍 중에 scope/input이 변경되었으면 중단
      if (currentGenerationRef.current !== generation) {
        return;
      }

      setCoachStatus("ready");
    } catch (error) {
      // 현재 세대만 에러 처리
      if (currentGenerationRef.current !== generation) {
        return;
      }

      // CRITICAL: 초기화 실패 시 동의 무효화
      // 다음 재시도에서 다시 동의 요청
      coachAttemptConsentRef.current = false;

      setCoachStatus("error");
      const message = error instanceof Error ? error.message : String(error);

      if (message === "WEBGPU_UNAVAILABLE") {
        setCoachError("이 브라우저는 WebGPU를 지원하지 않습니다.");
      } else if (message === "EXPLICIT_CONSENT_REQUIRED") {
        // 동의 없이 콜드 스타트 시도 - 이 상태는 발생하지 않아야 함
        setCoachError("모델 다운로드에 동의가 필요합니다.");
      } else {
        setCoachError("AI 모델을 불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.");
      }
    }
  }

  /**
   * 동의 확정 후 실행
   * CRITICAL: useRef를 사용하여 동의를 동기적으로 설정
   */
  function confirmConsentAndRun() {
    if (blockUnavailablePreferences()) return;
    // 동의 설정 (동기적)
    coachAttemptConsentRef.current = true;
    // 동의 후 즉시 실행
    void runCoaching();
  }

  /**
   * 동의 거부
   * CRITICAL: 모달을 완전히 닫아야 함
   */
  function declineConsent() {
    coachAttemptConsentRef.current = false;
    setCoachStatus("idle");
    // CRITICAL: 모달 닫기
    closeCoachModal();
  }

  /**
   * 코치 모달 열기
   * CRITICAL: 열 때마다 동의 상태 초기화
   */
  function openCoachModal() {
    setIsCoachModalOpen(true);
    if (blockUnavailablePreferences()) return;
    setCoachError("");
    // CRITICAL: 새 모달 세션 시작 - 동의 초기화
    coachAttemptConsentRef.current = false;
    // 기존 생성 결과는 유지 (재생성이 아니면 보여줌)
  }

  /**
   * 코치 모달 닫기
   * CRITICAL: 닫을 때 동의 무효화 + 실행 락 해제
   */
  function closeCoachModal() {
    setIsCoachModalOpen(false);
    // CRITICAL: 모달 닫으면 동의 무효화 (다음 열기 때 다시 물어야 함)
    coachAttemptConsentRef.current = false;
    // 세대 증가: 로딩 중인 작업 무시
    currentGenerationRef.current += 1;
    // CRITICAL: 실행 락 해제
    isRunningRef.current = false;
    // 로딩 중이었다면 상태 초기화
    if (coachStatus === "loading" || coachStatus === "generating") {
      setCoachStatus("idle");
      setCoachProgress(0);
      setCoachProgressText("");
    }
  }

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

  // UI 표시용 동의 상태 (엔진 상태 기반)
  const engineStatus = getCoachEngineStatus();
  const coachAttemptConsent = coachAttemptConsentRef.current;

  // 콜드 스타트 필요 여부 (엔진이 없고 동의도 없음)
  const awaitingConsent = coachingPreferencesReady && engineStatus === "none" && !coachAttemptConsent && coachStatus === "idle" && coachHasData && isWebGpuAvailable();

  return {
    isCoachModalOpen,
    setIsCoachModalOpen,
    coachStatus,
    coachProgress,
    coachProgressText,
    coachingText: outputInputKey === liveInputKey ? coachingText : "",
    coachError,
    coachHasData,
    coachInput,
    coachFallbackHeadline,
    // CRITICAL: 동의 상태 및 상수
    coachAttemptConsent,
    awaitingConsent,
    COACH_MODEL_APPROX_MB,
    COACH_MODEL_VRAM_MB,
    monthlyReport,
    runCoaching,
    confirmConsentAndRun,
    declineConsent,
    openCoachModal,
    closeCoachModal,
    refreshMonthlyReport,
    invalidateMonthlyReport
  };
}

export type CoachApi = ReturnType<typeof useCoach>;
