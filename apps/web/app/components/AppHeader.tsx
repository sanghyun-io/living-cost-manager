import { ActionIcon, Badge, Button, Group, Text, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";
import { LOCAL_USER_NAME } from "../lib/users";
import { formatSaveTime } from "../lib/formatting";
import type { ServerSession } from "../lib/serverApi";

interface AppHeaderProps {
  saveError: string;
  lastSavedAt: Date | null;
  serverSession: ServerSession | null;
  currentUserName: string | undefined;
  onOpenData: () => void;
  onOpenAuth: () => void;
  /** Combines server logout + local logout (wrapped in page). */
  onServerLogout: () => void;
}

export function AppHeader({
  saveError,
  lastSavedAt,
  serverSession,
  currentUserName,
  onOpenData,
  onOpenAuth,
  onServerLogout
}: AppHeaderProps) {
  const saveLabel = saveError || (lastSavedAt ? "저장됨 " + formatSaveTime(lastSavedAt) : "브라우저 저장 대기");
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light", { getInitialValueInEffect: true });

  return (
    <Group component="header" className="app-header" justify="flex-end" gap="sm" wrap="wrap">
      <ActionIcon
        variant="default"
        size="lg"
        aria-label="색상 모드 전환"
        onClick={() => setColorScheme(computed === "dark" ? "light" : "dark")}
      >
        {computed === "dark" ? "☀️" : "🌙"}
      </ActionIcon>
      <Badge variant="light" color={saveError ? "rose" : "gray"} size="lg" radius="sm">
        {saveLabel}
      </Badge>
      {serverSession ? (
        <Button variant="light" color="teal" onClick={onOpenData}>
          서버 연결됨 · 동기화 관리
        </Button>
      ) : (
        <>
          <Button variant="default" onClick={onOpenData}>
            데이터 관리
          </Button>
          <Button onClick={onOpenAuth}>클라우드에 저장하기</Button>
        </>
      )}
      <Text fw={700}>{currentUserName ?? LOCAL_USER_NAME}</Text>
      {serverSession ? (
        <Button variant="default" onClick={onServerLogout}>
          서버 로그아웃
        </Button>
      ) : null}
    </Group>
  );
}
