// 코치 모델 준비(백그라운드) 작업 전용 store.
//
// 배경:
// - LCM 코치는 사용자 브라우저(WebGPU)에서 ~453MB 모델을 다운로드/초기화한다.
// - 모달이 닫혀도 준비는 중단되면 안 되고, 같은 페이지에서 '코칭 받기'를 누르기
//   직전까지 사용자가 다른 작업을 할 수 있어야 한다.
// - 모델은 페이지 단위 자원이므로 컴포넌트 리마운트와 무관하게 '현재 페이지에서
//   한 번' 준비되고, 페이지 리로드/새 워커/실패 시에만 다시 동의를 받아야 한다.
//
// 정책
// - Page-level, single-job, model-scoped: 같은 모델 ID 로는 동시에 두 개의
//   prepare를 띄우지 않는다 (single-flight).
// - 명시적 grant { modelId, explicitDownloadConsent: true } 가 있어야 Worker 를
//   띄운다 (콜드 스타트/워커 사망/실패 후 재시도 모두 포함).
// - 모달을 닫아도 in-flight job 은 그대로 둔다. job 결과는 외부 store 에 남아
//   모달 재오픈/Header 버튼에 그대로 노출된다.
// - 사용자가 명시적으로 '준비 취소'를 누르거나 워커가 죽거나 모델이 다른 ID 로
//   바뀌면 store 가 cancelled/error 상태로 전환되고 워커는 terminate된다.
// - ready 상태는 명시적 클릭으로 코칭을 생성하지 않는 한 자동으로 모달을 열거나
//   포커스를 가져가지 않는다.
//
// CRITICAL — Job identity:
// - 각 job 은 고유한 jobId 로 식별된다. jobId 는 증가하는 counter 로, 절대 재사용되지 않는다.
// - cancel/reset/failure 시 jobId 가 바뀌므로, stale callback 이 새 job 의 결과를
//   덮어쓰지 않는다.
// - resolveReady/resolveError 는 jobId AND modelId 를 모두 확인한다.
//
// 외부 store 를 React 가 구독하는 형태(useSyncExternalStore)이며, 모든 transition
// 은 nextJobId 로 식별해 stale callback가 새 결과를 덮어쓰지 않도록 한다.

import { sanitizeCoachError } from "./coachErrors";

export type CoachPreparationState =
  | "idle" // 초기. 워커도 없고 진행 중인 작업도 없음.
  | "preparing" // 다운로드/초기화 진행 중.
  | "ready" // 엔진이 메모리에 살아 있고 재사용 가능.
  | "cancelled" // 사용자가 명시적으로 취소했거나, 다른 모델로 전환하면서 정리됨.
  | "error"; // 다운로드/워커 초기화 실패.

export interface JobSnapshot {
  // 단일 필드 store. 모델 단위로 한 페이지에서 하나의 prepare 만 존재한다.
  state: CoachPreparationState;
  modelId: string | null;
  jobId: number;
  // 0..1 진행률. 모델은 initProgressReport.progress 를 그대로 받아 0..100 정수로
  // 게재(throttle) 한다. 무한히 빠르게 변하지 않도록 마지막 emit 시각을 둔다.
  progress: number;
  progressText: string;
  // 보안: sanitizeCoachError를 거친 값(고정 한국어, 유한 집합)만 들어온다.
  // 원시 SDK/워커 error.message는 분류 판정 직후 버려지고 스냅샷에 보존되지 않는다.
  error: string | null;
}

export const IDLE_SNAPSHOT: JobSnapshot = {
  state: "idle",
  modelId: null,
  jobId: 0,
  progress: 0,
  progressText: "",
  error: null
};

export type ProgressListener = (snapshot: JobSnapshot) => void;
export type Unsubscribe = () => void;

// Progress 가 화면을 spam 하지 않도록 ms 단위로 throttle 한다.
const PROGRESS_THROTTLE_MS = 250;

export interface PreparationStore {
  /** Immutable snapshot; reference stays stable until a transition. */
  getSnapshot(): JobSnapshot;
  /** snapshot 을 구독한다. getSnapshot 결과가 바뀌었을 때만 호출된다. */
  subscribe(listener: ProgressListener): Unsubscribe;
  /**
   * 명시적 grant 후 prepare 작업 이 시작한다.
   * - 같은 모델 ID + preparing 상태면 기존 jobId 그대로 두고 호출은 무시한다.
   * - ready 상태에서 호출하면 새 콜드 다운로드 없이 ready 상태를 유지한다.
   * - 다른 모델 ID 가 들어오면 기존 워커를 terminate 하고 새 job 으로 시작한다.
   */
  beginPreparation(args: {
    modelId: string;
    explicitDownloadConsent: boolean;
    factory: PreparationFactory;
  }): { jobId: number; alreadyReady: boolean };
  /** 모달을 닫아도 외부 store 의 결과를 유지한다. 본문에서 호출하지 않음. */
  /** 사용자가 명시적으로 cancel: 워커를 terminate 하고 cancelled 로 마킹. */
  cancelPreparation(): void;
  /** 외부 store 의 결과를 폐기하고 idle 로 돌아간다 (워커는 terminate). */
  reset(reason?: "scope-change" | "manual-reset"): void;
  /** 작업 완료/실패 시 결과 정리. jobId 가 현재와 다르면 무시한다. */
  resolveReady(jobId: number, modelId: string): void;
  resolveError(jobId: number, modelId: string, error: string): void;
  /** 진행률 보고. throttle 적용. */
  reportProgress(jobId: number, progress: number, text: string): void;
  /** 워커가 강제 종료(클라이언트 측 unload 또는 워커 자체 사망)된 경우 호출됨. */
  reportWorkerDeath(jobId: number, reason: string): void;
  /** 현재 store 가 살아 있는 워커/엔진을 가지고 있는지 확인. */
  hasLiveWorker(): boolean;
  /** Resolves only after the previous worker's bounded disposal finishes. */
  whenDisposed(): Promise<void>;
}

// PreparationFactory 는 외부에서 주입한다. Worker 를 띄우고 Callback 프로토콜로
// initProgress / success / error 를 흘려보낸다. 본 store 는 네트워크/GPU 비용을
// 가지지 않으며, factory 가 권한이 없는 경우(consent 부족 등) 호출되지 않는다.
export interface PreparationFactoryCallbacks {
  onProgress: (progress: number, text: string) => void;
  onReady: () => void;
  onError: (message: string) => void;
  // 워커 자체가 죽었을 때 호출. store 는 이 시점에 권한을 리셋한다.
  onWorkerLost: (message: string) => void;
  /**
   * 명시적 cancel 시 호출: 워커 terminate. 반환은 await 하지 않아도 된다.
   * 반환된 promise 가 resolve된 후에는 onReady/onError 가 호출되지 않아야 한다.
   */
  cancel: () => Promise<void> | void;
  /** 엔진 사용이 끝나고 자원을 풀도록 하는 경우(현재는 사용 안 함). */
  unload?: () => Promise<void> | void;
}

export interface PreparationFactory {
  readonly modelId?: string;
  (callbacks: PreparationFactoryCallbacks): { jobId: number; modelId: string } | null;
}

export function createPreparationStore(): PreparationStore {
  let snapshot: JobSnapshot = { ...IDLE_SNAPSHOT };
  let jobIdCounter = 0;
  let activeFactory: PreparationFactoryCallbacks | null = null;
  let lastProgressEmit = 0;
  let pendingProgress: { progress: number; text: string } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let disposal: Promise<void> | null = null;
  const listeners = new Set<ProgressListener>();

  function notify() {
    // subscribers 가 받는 snapshot 은 매번 복제 (불변성을 유지해 React 가 안전하게 비교).
    for (const listener of listeners) {
      listener(snapshot);
    }
  }

  function setSnapshot(next: Partial<JobSnapshot>) {
    const updated: JobSnapshot = {
      ...snapshot,
      ...next,
      jobId: next.jobId ?? snapshot.jobId
    };
    // useSyncExternalStore 안전을 위해 동일 상태면 동일 참조를 유지.
    if (
      updated.state === snapshot.state &&
      updated.modelId === snapshot.modelId &&
      updated.jobId === snapshot.jobId &&
      updated.progress === snapshot.progress &&
      updated.progressText === snapshot.progressText &&
      updated.error === snapshot.error
    ) {
      return;
    }
    snapshot = updated;
    notify();
  }

  function clearPendingProgressTimer() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingProgress = null;
  }

  function disposeActive() {
    const previous = activeFactory;
    activeFactory = null;
    if (!previous) return;
    try {
      const result = previous.cancel();
      if (result) {
        const queued = Promise.resolve(result).catch(() => undefined);
        disposal = queued;
        void queued.then(() => { if (disposal === queued) disposal = null; });
      }
    } catch { /* worker client still guarantees termination in finally */ }
  }

  return {
    getSnapshot() {
      // useSyncExternalStore 안정성: 상태가 바뀌기 전에는 같은 참조를 반환해야
      // 무한 리렌더가 나지 않는다.
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    beginPreparation({ modelId, explicitDownloadConsent, factory }) {
      // grant 검증: 콜드 시작은 명시적 동의가 필수 (Store 외부 검사에서도 확인하지만
      // store 자체에서도 방어한다).
      if (!explicitDownloadConsent) {
        throw new Error("EXPLICIT_CONSENT_REQUIRED");
      }
      if (factory.modelId && factory.modelId !== modelId) {
        throw new Error("MODEL_GRANT_MISMATCH");
      }

      // 같은 모델 + preparing 상태 → single-flight: 기존 작업을 그대로 둔다.
      if (snapshot.state === "preparing" && snapshot.modelId === modelId) {
        return { jobId: snapshot.jobId, alreadyReady: false };
      }

      // 같은 모델 + ready 상태 → 콜드 다운로드 없이 그대로.
      if (snapshot.state === "ready" && snapshot.modelId === modelId) {
        return { jobId: snapshot.jobId, alreadyReady: true };
      }

      // 다른 모델/실패한 모델의 경우 기존 자원이 있으면 정리.
      disposeActive();
      clearPendingProgressTimer();
      pendingProgress = null;

      // CRITICAL: 새 job 은 반드시 새 jobId 를 가진다. 절대 재사용하지 않는다.
      jobIdCounter += 1;
      const jobId = jobIdCounter;
      const startedAt = Date.now();
      lastProgressEmit = startedAt;

      const callbacks: PreparationFactoryCallbacks = {
        onProgress(progress, text) {
          // CRITICAL: jobId 가 stale 한 경우 무시.
          if (snapshot.jobId !== jobId || snapshot.state !== "preparing") return;
          // throttle: 너무 잦은 emit 은 화면/스피커를 spam 하지 않게.
          const now = Date.now();
          if (now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
            lastProgressEmit = now;
            setSnapshot({ progress, progressText: text });
            pendingProgress = null;
            return;
          }
          pendingProgress = { progress, text };
          if (!pendingTimer) {
            pendingTimer = setTimeout(() => {
              pendingTimer = null;
              if (pendingProgress && snapshot.jobId === jobId && snapshot.state === "preparing") {
                setSnapshot({
                  progress: pendingProgress.progress,
                  progressText: pendingProgress.text
                });
                lastProgressEmit = Date.now();
              }
              pendingProgress = null;
            }, PROGRESS_THROTTLE_MS - (now - lastProgressEmit));
          }
        },
        onReady() {
          // CRITICAL: jobId AND modelId 모두 확인.
          if (snapshot.jobId !== jobId) return;
          if (snapshot.modelId !== modelId) return;
          // CRITICAL: cancelled/error 상태에서는 ready 로 전환하지 않는다.
          if (snapshot.state !== "preparing") return;
          clearPendingProgressTimer();
          setSnapshot({ state: "ready", progress: 1, progressText: "준비됨" });
        },
        onError(message) {
          // CRITICAL: jobId AND modelId 모두 확인.
          if (snapshot.jobId !== jobId) return;
          if (snapshot.modelId !== modelId) return;
          // CRITICAL: cancelled 상태에서는 error 로 전환하지 않는다.
          if (snapshot.state !== "preparing") return;
          clearPendingProgressTimer();
          // 보안: 원시 SDK 오류(URL/스택 포함 가능)는 분류에만 사용하고 스냅샷에는
          // 고정 한국어 메시지만 저장한다.
          setSnapshot({ state: "error", error: sanitizeCoachError(message, "prepare") });
          disposeActive();
        },
        onWorkerLost(message) {
          // CRITICAL: jobId AND modelId 모두 확인.
          if (snapshot.jobId !== jobId) return;
          if (snapshot.modelId !== modelId) return;
          // CRITICAL: cancelled 상태에서는 error 로 전환하지 않는다.
          if (snapshot.state !== "preparing" && snapshot.state !== "ready") return;
          clearPendingProgressTimer();
          setSnapshot({
            state: "error",
            error: sanitizeCoachError(message || "워커 연결이 끊겼습니다", "prepare")
          });
          disposeActive();
        },
        cancel: () => {
          // factory 의 cancel 이 호출돼도 onReady/onError 는 더 이상 store 에
          // 반영되지 않도록 activeFactory 를 먼저 끊는다.
          activeFactory = null;
        },
        async unload() {
          // 외부에서 명시적으로 unload 시 호출. 본 store 는 자원을 가지고 있지
          // 않으므로 activeFactory.cancel 을 호출하는 것과 동일하게 둔다.
          activeFactory = null;
        }
      };
      activeFactory = callbacks;

      setSnapshot({
        state: "preparing",
        modelId,
        jobId,
        progress: 0,
        progressText: "준비 중…",
        error: null
      });

      const start = () => {
        if (snapshot.jobId !== jobId || snapshot.state !== "preparing") return;
        try {
          const started = factory(callbacks);
          if (!started) callbacks.onError("준비를 시작하지 못했습니다.");
        } catch (error) {
          callbacks.onError(error instanceof Error ? error.message : String(error));
        }
      };
      if (disposal) void disposal.then(start);
      else start();
      /* Factory creation is serialized after disposal, but the job identity is
         published immediately so queued cancellation cannot start a worker. */

      return { jobId, alreadyReady: false };
    },

    cancelPreparation() {
      // CRITICAL: 사용자가 명시적으로 취소: 워커를 terminate 하고 cancelled 로 마킹.
      // in-flight job 이 곧 success/error 를 내도 무시되도록 activeFactory 를
      // 미리 끊고, jobId 를 증가시켜 stale callback 을 완전히 차단한다.
      clearPendingProgressTimer();
      pendingProgress = null;

      // CRITICAL: jobId 를 증가시켜 이전 job 의 callback 을 완전히 무효화.
      jobIdCounter += 1;

      setSnapshot({
        state: "cancelled",
        jobId: jobIdCounter,
        progress: 0,
        progressText: "",
        error: null
      });
      disposeActive();
    },

    reset() {
      clearPendingProgressTimer();
      pendingProgress = null;

      // CRITICAL: jobId 를 증가시켜 이전 job 의 callback 을 완전히 무효화.
      jobIdCounter += 1;

      setSnapshot({
        ...IDLE_SNAPSHOT,
        jobId: jobIdCounter
      });
      disposeActive();
    },

    resolveReady(jobId, modelId) {
      // CRITICAL: jobId AND modelId 모두 확인.
      if (snapshot.jobId !== jobId) return;
      if (snapshot.modelId !== modelId) return;
      if (snapshot.state !== "preparing") return;
      clearPendingProgressTimer();
      setSnapshot({ state: "ready", progress: 1, progressText: "준비됨" });
    },

    resolveError(jobId, modelId, error) {
      // CRITICAL: jobId AND modelId 모두 확인.
      if (snapshot.jobId !== jobId) return;
      if (snapshot.modelId !== modelId) return;
      if (snapshot.state !== "preparing") return;
      clearPendingProgressTimer();
      // 보안: 호출자가 원시 오류 문자열을 넘겨도 스냅샷에는 고정 메시지만 들어간다.
      setSnapshot({ state: "error", error: sanitizeCoachError(error, "prepare") });
      disposeActive();
    },

    reportProgress(jobId, progress, text) {
      if (snapshot.jobId !== jobId || snapshot.state !== "preparing") return;
      const now = Date.now();
      if (now - lastProgressEmit >= PROGRESS_THROTTLE_MS) {
        lastProgressEmit = now;
        setSnapshot({ progress, progressText: text });
        pendingProgress = null;
        return;
      }
      pendingProgress = { progress, text };
      if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          if (pendingProgress && snapshot.jobId === jobId && snapshot.state === "preparing") {
            setSnapshot({
              progress: pendingProgress.progress,
              progressText: pendingProgress.text
            });
            lastProgressEmit = Date.now();
          }
          pendingProgress = null;
        }, PROGRESS_THROTTLE_MS - (now - lastProgressEmit));
      }
    },

    reportWorkerDeath(jobId, reason) {
      if (snapshot.jobId !== jobId || (snapshot.state !== "preparing" && snapshot.state !== "ready")) return;
      clearPendingProgressTimer();
      setSnapshot({
        state: "error",
        error: sanitizeCoachError(reason || "워커 연결이 끊겼습니다", "prepare")
      });
      disposeActive();
    },

    hasLiveWorker() {
      return activeFactory !== null;
    },
    whenDisposed() {
      return disposal ?? Promise.resolve();
    }
  };
}
