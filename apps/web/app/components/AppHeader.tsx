import { Button, Group, Menu, Text, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { LOCAL_USER_NAME } from "../lib/users";
import { formatSaveTime } from "../lib/formatting";
import type { ServerSession } from "../lib/serverApi";
import type { HeaderStorageView } from "../lib/syncStatus";
import type { ReactNode } from 'react';

interface AppHeaderProps {
  onOpenSettings?: () => void;
  contextLabel?: string;
  ledgerControls?: ReactNode;
  saveError: string;
  onRetrySave: () => void;
  onExportUnsaved: () => void;
  recoveryRequired: boolean;
  lastSavedAt: Date | null;
  serverSession: ServerSession | null;
  currentUserName: string | undefined;
  /**
   * useWorkspaceSync 가 파생한 저장 상태 표시. 없으면(단독 렌더/레거시) 로컬
   * 저장 사실만으로 폴백한다 — 서버를 주장하지 않는다.
   */
  headerStorageView?: HeaderStorageView;
  onOpenData: () => void;
  onOpenAuth: () => void;
  onOpenCoach: () => void;
  /** READY 버튼 전용: 모달을 열고 현재 기준선의 유효한 조언이 있으면 재사용, 없으면 1회 생성. */
  onViewPreparedCoach?: () => void;
  onOpenTemplates: () => void;
  onOpenTour?: () => void;
  /** Combines server logout + local logout (wrapped in page). */
  onServerLogout: () => void;
  /**
   * 백그라운드 코치 준비 상태. "preparing"/"ready" 일 때만 헤더에 진행률/
   * 완료 버튼이 추가된다. 실패도 알리되 idle/cancelled에는 표시하지 않는다.
   */
  coachHeaderIndicator?: "none" | "preparing" | "ready" | "error";
  /** preparing 일 때 표시할 짧은 라벨. 예: "AI 준비 중 42%". */
  coachHeaderProgressLabel?: string | null;
  /** ready 일 때 표시할 짧은 라벨. 예: "AI 준비 완료 · 코칭 보기". */
  coachHeaderReadyLabel?: string | null;
}

export function AppHeader({
  onOpenSettings, contextLabel,
  ledgerControls,
  saveError,
  onRetrySave,
  onExportUnsaved,
  recoveryRequired,
  lastSavedAt,
  serverSession,
  currentUserName,
  headerStorageView,
  onOpenData,
  onOpenAuth,
  onOpenCoach,
  onViewPreparedCoach,
  onOpenTemplates,
  onOpenTour,
  onServerLogout,
  coachHeaderIndicator = "none",
  coachHeaderProgressLabel,
  coachHeaderReadyLabel
}: AppHeaderProps) {
  // 저장 주장은 동기화 파생 상태가 소유한다. 파생값이 없을 때만 로컬 사실
  // (저장 시각/대기)으로 표시하고, 서버 저장 여부는 절대 암시하지 않는다.
  const storage = headerStorageView ?? {
    state: saveError ? "save-failed" as const : lastSavedAt ? "device-saved" as const : "saving" as const,
    label: saveError || (lastSavedAt ? "이 브라우저에 저장됨 " + formatSaveTime(lastSavedAt) : "브라우저 저장 대기"),
    tooltip: "이 브라우저 저장 기준입니다."
  };
  const storageTime = (storage.state === "device-saved" || storage.state === "device-dirty" || storage.state === "server-saved") && lastSavedAt
    ? " " + formatSaveTime(lastSavedAt)
    : "";
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light", { getInitialValueInEffect: true });

  // CRITICAL — 헤더의 discreet 버튼은 모달만 열고, 자동으로 코칭을 시작하지
  // 않는다 (모달 안에서 명시적 클릭이 있어야 stream 이 호출된다). 예외는 READY
  // 버튼 하나: 명시적 클릭이므로 모달을 열고 기존 조언 재사용 또는 1회 생성한다.
  return (
    <header className="app-header-shell">
      <Group className="app-header" justify="flex-end" gap="sm" wrap="wrap">
        <Text fw={700} className="app-brand">{contextLabel ?? '생활비 관리자'}</Text>
        {!saveError ? <Text className="save-status" size="xs" c="dimmed" title={storage.tooltip}>
          {storage.label}
          {storageTime}
        </Text> : null}
        {/* 백그라운드 준비가 살아있는 동안만 표시되는 정적(discreet) 버튼. */}
        {coachHeaderIndicator === "preparing" && coachHeaderProgressLabel ? (
          <Button
            data-coach-header-indicator="preparing"
            size="compact-sm"
            variant="subtle"
            color="teal"
            onClick={onOpenCoach}
            aria-live="polite"
          >
            {coachHeaderProgressLabel}
          </Button>
        ) : null}
        {coachHeaderIndicator === "ready" && coachHeaderReadyLabel ? (
          <Button
            data-coach-header-indicator="ready"
            size="compact-sm"
            variant="light"
            color="teal"
            onClick={onViewPreparedCoach ?? onOpenCoach}
          >
            {coachHeaderReadyLabel}
          </Button>
        ) : null}
        {coachHeaderIndicator === "error" ? (
          <Button
            data-coach-header-indicator="error"
            size="compact-sm"
            variant="subtle"
            color="gray"
            onClick={onOpenCoach}
            aria-live="polite"
          >
            AI 준비 실패 · 확인
          </Button>
        ) : null}
        {/* 진입 라벨은 로그인 여부와 무관하게 '데이터 관리'로 통일한다. */}
        {onOpenSettings ? <Button variant="subtle" onClick={onOpenSettings}>설정</Button> : null}
        <Button data-product-tour="data" variant="default" onClick={onOpenData}>
          데이터 관리
        </Button>
        {!serverSession ? (
          <Button
            data-product-tour="login"
            variant="subtle"
            onClick={onOpenAuth}
          >
            로그인
          </Button>
        ) : null}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><Button data-product-tour-opener variant="subtle" color="gray">도구</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{serverSession?.workspace?.name ?? currentUserName ?? LOCAL_USER_NAME}</Menu.Label>
            <Menu.Item onClick={onOpenTemplates}>템플릿</Menu.Item>
            <Menu.Item onClick={onOpenCoach}>지출 코치</Menu.Item>
            <Menu.Item component="a" href="/guide/">사용 안내</Menu.Item>
            {onOpenTour ? <Menu.Item onClick={onOpenTour}>둘러보기</Menu.Item> : null}
            <Menu.Item onClick={() => setColorScheme(computed === 'dark' ? 'light' : 'dark')}>색상 모드 전환</Menu.Item>
            {serverSession ? <Menu.Item onClick={onServerLogout}>서버 로그아웃</Menu.Item> : null}
          </Menu.Dropdown>
        </Menu>
      </Group>
      {saveError ? <div className="header-save-error">
        <Text role="alert" c="rose">{saveError}</Text>
        <Group gap="xs">
          <Button onClick={onRetrySave} disabled={recoveryRequired}>브라우저 저장 재시도</Button>
          <Button variant="default" onClick={onExportUnsaved}>{recoveryRequired ? '현재 편집 내용 내보내기' : '미저장 데이터 내보내기'}</Button>
        </Group>
        {recoveryRequired ? <Text size="xs">손상 원본은 아래 ‘저장 원본 내보내기’로 별도 보관하세요.</Text> : null}
      </div> : null}
      {ledgerControls}
    </header>
  );
}
