import { ActionIcon, Button, Group, Text, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { LOCAL_USER_NAME } from "../lib/users";
import { formatSaveTime } from "../lib/formatting";
import type { ServerSession } from "../lib/serverApi";
import type { ReactNode } from 'react';

interface AppHeaderProps {
  ledgerControls?: ReactNode;
  saveError: string;
  onRetrySave: () => void;
  onExportUnsaved: () => void;
  recoveryRequired: boolean;
  lastSavedAt: Date | null;
  serverSession: ServerSession | null;
  currentUserName: string | undefined;
  onOpenData: () => void;
  onOpenAuth: () => void;
  onOpenCoach: () => void;
  onOpenTemplates: () => void;
  /** Combines server logout + local logout (wrapped in page). */
  onServerLogout: () => void;
}

export function AppHeader({
  ledgerControls,
  saveError,
  onRetrySave,
  onExportUnsaved,
  recoveryRequired,
  lastSavedAt,
  serverSession,
  currentUserName,
  onOpenData,
  onOpenAuth,
  onOpenCoach,
  onOpenTemplates,
  onServerLogout
}: AppHeaderProps) {
  const saveLabel = saveError || (lastSavedAt ? "이 브라우저에 저장됨 " + formatSaveTime(lastSavedAt) : "브라우저 저장 대기");
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light", { getInitialValueInEffect: true });

  return (
    <header className="app-header-shell">
      <Group className="app-header" justify="flex-end" gap="sm" wrap="wrap">
        <Text fw={700} className="app-brand">생활비 관리자</Text>
        <a className="guide-link" href="/guide/">사용 안내</a>
        <Button variant="subtle" color="gray" onClick={onOpenTemplates}>템플릿</Button>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label="색상 모드 전환"
          onClick={() => setColorScheme(computed === "dark" ? "light" : "dark")}
        >
          <span aria-hidden="true">{computed === "dark" ? "☀" : "☾"}</span>
        </ActionIcon>
        <Text className="save-status" size="xs" c={saveError ? "rose" : "dimmed"} role={saveError ? "alert" : undefined}>
          {saveLabel}
        </Text>
        {saveError ? <Group gap="xs">
          <Button onClick={onRetrySave} disabled={recoveryRequired}>브라우저 저장 재시도</Button>
          <Button variant="default" onClick={onExportUnsaved}>{recoveryRequired ? "현재 편집 내용 내보내기" : "미저장 데이터 내보내기"}</Button>
          {recoveryRequired ? <Text size="xs">손상 원본은 아래 ‘저장 원본 내보내기’로 별도 보관하세요.</Text> : null}
        </Group> : null}
        {serverSession ? (
          <Button variant="default" onClick={onOpenData}>
            서버 연결됨 · 동기화 관리
          </Button>
        ) : (
          <>
            <Button variant="default" onClick={onOpenData}>
              데이터 관리
            </Button>
            <Button
              variant="subtle"
              onClick={onOpenAuth}
            >
              로그인
            </Button>
          </>
        )}
        <Text size="sm" c="dimmed">{serverSession?.workspace?.name ?? currentUserName ?? LOCAL_USER_NAME}</Text>
        <Button variant="subtle" color="gray" size="xs" onClick={onOpenCoach}>지출 코치</Button>
        {serverSession ? (
          <Button variant="default" onClick={onServerLogout}>
            서버 로그아웃
          </Button>
        ) : null}
      </Group>
      {ledgerControls}
    </header>
  );
}
