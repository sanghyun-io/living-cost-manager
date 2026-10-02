import { useState } from "react";
import { Alert, Button, PasswordInput, Text } from "@mantine/core";
import { ModalShell } from "./ModalShell";

interface ResetPasswordModalProps {
  opened: boolean;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  /**
   * Resolves true when the reset succeeded (the modal then clears its draft,
   * mirroring the old page-level behavior). On failure the typed value stays.
   */
  onSubmit: (password: string) => Promise<boolean>;
  onClose: () => void;
}

export function ResetPasswordModal({
  opened,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  onSubmit,
  onClose
}: ResetPasswordModalProps) {
  const [resetPasswordValue, setResetPasswordValue] = useState("");

  async function handleSubmit() {
    const ok = await onSubmit(resetPasswordValue);
    if (ok) {
      setResetPasswordValue("");
    }
  }

  return (
    <ModalShell opened={opened} sectionLabel="클라우드" title="비밀번호 재설정" onClose={onClose}>
      <Text size="sm" c="dimmed">
        새 비밀번호를 입력하세요. (최소 8자)
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <PasswordInput
          label="새 비밀번호"
          value={resetPasswordValue}
          onChange={(event) => setResetPasswordValue(event.currentTarget.value)}
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
