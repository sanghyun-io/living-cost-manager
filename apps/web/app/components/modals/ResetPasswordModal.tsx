import { Alert, Button, PasswordInput, Text } from "@mantine/core";
import { ModalShell } from "./ModalShell";

interface ResetPasswordModalProps {
  opened: boolean;
  resetPasswordValue: string;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ResetPasswordModal({
  opened,
  resetPasswordValue,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  onPasswordChange,
  onSubmit,
  onClose
}: ResetPasswordModalProps) {
  return (
    <ModalShell opened={opened} sectionLabel="클라우드" title="비밀번호 재설정" onClose={onClose}>
      <Text size="sm" c="dimmed">
        새 비밀번호를 입력하세요. (최소 8자)
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <PasswordInput
          label="새 비밀번호"
          value={resetPasswordValue}
          onChange={(event) => onPasswordChange(event.currentTarget.value)}
          mb="md"
        />
        <Button type="submit" loading={isServerBusy} disabled={resetPasswordValue.length < 8} fullWidth>
          비밀번호 변경
        </Button>
      </form>
      {serverStatus ? (
        <Alert variant="light" color={serverErrorKind ? "rose" : "teal"} p="xs">
          {serverStatus}
        </Alert>
      ) : null}
    </ModalShell>
  );
}
