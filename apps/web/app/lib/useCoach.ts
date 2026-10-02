"use client";

import { useMemo, useRef, useState } from "react";
import { buildInsuranceCheck, buildMonthlyReport, buildSavingsInsights, getUpcomingDues, type MonthlyReport } from "@living-cost-manager/shared";
import { getCoachEngine, streamCoaching, type CoachInput } from "./coach";
import { isCoachOptedIn, isWebGpuAvailable, setCoachOptIn } from "./coachModel";
import type { CoachStatus } from "../components/modals/CoachModal";
import type { ServerSession, ServerApiClient } from "./serverApi";
import type { BudgetDataApi } from "./useBudgetData";

interface UseCoachOptions {
  budget: BudgetDataApi;
  serverApi: ServerApiClient | null;
}

/**
 * On-device AI coach (opt-in, WebGPU). Also owns the monthly trend report
 * computed from server sync history — a best-effort input for coaching — and
 * the trust-boundary guards (generation + scope) that keep a switched
 * user/workspace's stale responses out of the current coach input.
 */
export function useCoach({ budget, serverApi }: UseCoachOptions) {
  const [isCoachModalOpen, setIsCoachModalOpen] = useState(false);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>("idle");
  const [coachProgress, setCoachProgress] = useState(0);
  const [coachProgressText, setCoachProgressText] = useState("");
  const [coachingText, setCoachingText] = useState("");
  const [coachError, setCoachError] = useState("");
  // 서버 동기화 히스토리로 계산한 월간 추세(지난달 대비). 코치의 추세 조각 입력.
  // 동기화 검사 시 best-effort 로 채우며, 히스토리가 없으면 null 로 둔다.
  const [monthlyReport, setMonthlyReport] = useState<MonthlyReport | null>(null);

  // monthlyReport 요청 세대. 로그아웃·세션 무효화·워크스페이스 전환 시 증가시켜
  // 진행 중인 fire-and-forget 히스토리 응답을 무효화한다(stale 결과가 다음
  // 사용자/워크스페이스의 코치 입력으로 새어 들어가는 것을 막는다).
  const monthlyReportGenRef = useRef(0);
  // 현재 활성 "사용자|워크스페이스" 식별자. refreshMonthlyReport 가 응답을 커밋하기
  // 전에 이 값과 대조한다. 세대(숫자)만으로는, caller 가 첫 await 동안 전환이 일어나
  // 세대가 이미 올라간 뒤 stale 한 refresh 를 새로 시작하면 새 세대를 캡처해 가드를
  // 통과하는 경로가 남는다(red-review R2). identity 대조로 그 경로까지 막는다.
  const activeReportScopeRef = useRef<string | null>(null);

  const { fixedCosts, monthlyIncome, summary } = budget;

  // AI 코치 입력 — 결정적 요약(현재 고정비 · 절감 인사이트 · 임박 납부)을 묶는다.
  // 월간 추세(지난달 대비)는 서버 동기화 히스토리(monthlyReport)가 있을 때만 채운다.
  const coachInput = useMemo<CoachInput>(() => {
    const now = new Date();
    const savings = buildSavingsInsights(fixedCosts).map((s) => ({
      title: s.title,
      monthlySavings: s.monthlySavings
    }));
    const upcoming = getUpcomingDues(fixedCosts, now, 14)
      .slice(0, 5)
      .map((u) => ({ name: u.item.name, amount: u.item.amount, daysUntil: u.daysUntil }));
    const insurance = buildInsuranceCheck(fixedCosts, monthlyIncome);
    // 추세는 직전 달이 있을 때만 의미가 있다(첫 달은 previous 가 null).
    const hasTrend = monthlyReport?.previous != null && monthlyReport.deltaAmount != null;
    return {
      monthlyTotal: summary.monthlyExpense,
      previousMonthlyTotal: hasTrend ? monthlyReport!.previous!.fixedCostMonthlyTotal : null,
      deltaAmount: hasTrend ? monthlyReport!.deltaAmount : null,
      deltaPercent: hasTrend ? monthlyReport!.deltaPercent : null,
      monthlyIncome,
      fixedCostCount: fixedCosts.length,
      savings,
      upcoming,
      insuranceHigh: insurance.isHigh
    };
  }, [fixedCosts, monthlyIncome, summary.monthlyExpense, monthlyReport]);

  // 규칙 기반 폴백 한 줄(WebGPU 미지원/에러 시 보조 표시).
  const coachFallbackHeadline = useMemo(() => {
    const rate =
      monthlyIncome > 0 ? Math.round((summary.monthlyExpense / monthlyIncome) * 1000) / 10 : null;
    const rateText = rate !== null ? ` 수입의 ${rate}%예요.` : "";
    return `이번 달 월 환산 고정비는 ${summary.monthlyExpense.toLocaleString("ko-KR")}원, ${fixedCosts.length}건이에요.${rateText}`;
  }, [summary.monthlyExpense, monthlyIncome, fixedCosts.length]);

  const coachHasData = fixedCosts.length > 0;

  // 코칭 생성: 엔진을 (필요시) 로드한 뒤 스트리밍으로 멘트를 만든다.
  async function runCoaching() {
    if (!isWebGpuAvailable()) {
      setCoachStatus("error");
      setCoachError("이 브라우저는 WebGPU를 지원하지 않습니다.");
      return;
    }
    setCoachError("");
    setCoachingText("");
    try {
      setCoachStatus("loading");
      const engine = await getCoachEngine((p) => {
        setCoachProgress(p.progress);
        setCoachProgressText(p.text);
      });
      // 한 번 켜면 opt-in 으로 기억(다음엔 즉시 캐시 로드).
      setCoachOptIn(true);
      setCoachStatus("generating");
      await streamCoaching(engine, coachInput, (full) => setCoachingText(full));
      setCoachStatus("ready");
    } catch (error) {
      setCoachStatus("error");
      const message = error instanceof Error ? error.message : String(error);
      setCoachError(
        message === "WEBGPU_UNAVAILABLE"
          ? "이 브라우저는 WebGPU를 지원하지 않습니다."
          : "AI 모델을 불러오지 못했어요. 네트워크를 확인하고 다시 시도해 주세요."
      );
    }
  }

  // AppHeader 의 코치 버튼: 켜기 + (opt-in & 준비된 경우) 자동 실행.
  function openCoachModal() {
    setIsCoachModalOpen(true);
    setCoachError("");
    // 이미 한 번 켰고(opt-in) 아직 코칭 전이면, 열자마자 자동 실행.
    if (isCoachOptedIn() && isWebGpuAvailable() && coachHasData && coachStatus === "idle") {
      void runCoaching();
    }
  }

  // 이 세션이 속한 "사용자|워크스페이스" 식별자. monthlyReport 가 어느 컨텍스트
  // 것인지 표시하는 scope 키다(계정 전환·워크스페이스 전환 모두 구분).
  function reportScopeOf(session: ServerSession): string | null {
    return session.workspace ? `${session.user.id}|${session.workspace.id}` : null;
  }

  // 동기화 히스토리로 월간 추세를 best-effort 로 갱신한다. 히스토리 조회는
  // 동기화 본류가 아니므로(코치 추세 조각 입력용) 실패해도 조용히 무시한다.
  //
  // ⚠️ fire-and-forget 이라 응답이 늦게 도착하는 사이 로그아웃·계정/워크스페이스
  // 전환이 일어날 수 있다. 그러면 이전 사용자의 추세가 다음 사용자의 코치 입력으로
  // 새어 들어간다(프라이버시 경계 위반). 두 가드로 막는다:
  //  (1) 세대(gen): getSnapshotHistory await 중에 경계 전환이 일어나면 결과 폐기.
  //  (2) scope(identity): 이 요청이 가져온 데이터가 "지금 활성" 사용자·워크스페이스
  //      것일 때만 커밋. caller 가 자기 첫 await(스냅샷 조회 등) 동안 전환이 일어나
  //      세대가 이미 올라간 뒤 refresh 를 새로 시작해 새 세대를 캡처하더라도,
  //      session 의 scope 가 활성 scope 와 다르면 차단된다(red-review R2 갭).
  async function refreshMonthlyReport(session: ServerSession) {
    if (!serverApi || !session.workspace) {
      return;
    }
    const scope = reportScopeOf(session);
    const workspaceId = session.workspace.id;
    const gen = monthlyReportGenRef.current;
    try {
      const entries = await serverApi.getSnapshotHistory(workspaceId, session.token, 24);
      // 응답이 도착하는 사이 신뢰 경계를 넘었으면(세대 변경 또는 활성 scope 불일치)
      // 결과를 버린다. scope 대조가 "stale caller 가 새 세대 캡처" 경로까지 막는다.
      if (monthlyReportGenRef.current !== gen || activeReportScopeRef.current !== scope) {
        return;
      }
      setMonthlyReport(buildMonthlyReport(entries));
    } catch {
      // 히스토리 조회 실패는 무시 — 추세 조각만 빠지고 나머지 코칭은 정상 동작.
    }
  }

  // monthlyReport 를 즉시 비우고 진행 중인 모든 히스토리 응답을 무효화한다.
  // 신뢰 경계 전환(로그아웃·세션무효화·워크스페이스전환) 시점에 호출한다.
  // nextSession 을 주면 이후 그 세션의 응답만 커밋되도록 활성 scope 를 갱신한다
  // (전환 후 새로 시작하는 refresh 는 이 scope 와 일치해야 통과).
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
    coachingText,
    coachError,
    coachHasData,
    coachInput,
    coachFallbackHeadline,
    monthlyReport,
    runCoaching,
    openCoachModal,
    refreshMonthlyReport,
    invalidateMonthlyReport
  };
}

export type CoachApi = ReturnType<typeof useCoach>;
