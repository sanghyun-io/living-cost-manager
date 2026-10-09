import { Button, Group, Menu, Text, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
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
        {!saveError ? <Text className="save-status" size="xs" c="dimmed">
          {saveLabel}
        </Text> : null}
        {serverSession ? (
          <Button variant="default" onClick={onOpenData}>
            동기화 관리
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
        <Menu position="bottom-end" withinPortal>
          <Menu.Target><Button variant="subtle" color="gray">도구</Button></Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{serverSession?.workspace?.name ?? currentUserName ?? LOCAL_USER_NAME}</Menu.Label>
            <Menu.Item onClick={onOpenTemplates}>템플릿</Menu.Item>
            <Menu.Item onClick={onOpenCoach}>지출 코치</Menu.Item>
            <Menu.Item component="a" href="/guide/">사용 안내</Menu.Item>
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
