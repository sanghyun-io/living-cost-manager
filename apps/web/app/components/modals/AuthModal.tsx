import { Alert, Anchor, Button, Group, PasswordInput, SegmentedControl, Text, TextInput } from "@mantine/core";
import { ModalShell } from "./ModalShell";

interface AuthModalProps {
  opened: boolean;
  hasServerApi: boolean;
  authView: "auth" | "forgot";
  serverAuthMode: "login" | "register";
  serverEmail: string;
  serverPassword: string;
  serverName: string;
  isServerBusy: boolean;
  serverStatus: string;
  serverErrorKind: "auth" | "request" | null;
  // Inline (blur-time) validation surfaced for the login/register form.
  authTouched: { email: boolean; password: boolean };
  authEmailError: string | null;
  authPasswordError: string | null;
  isAuthFormValid: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onBlurField: (field: "email" | "password") => void;
  onModeChange: (mode: "login" | "register") => void;
  onViewChange: (view: "auth" | "forgot") => void;
  onSubmit: () => void;
  onForgotSubmit: () => void;
  onClose: () => void;
}

export function AuthModal({
  opened,
  hasServerApi,
  authView,
  serverAuthMode,
  serverEmail,
  serverPassword,
  serverName,
  isServerBusy,
  serverStatus,
  serverErrorKind,
  authTouched,
  authEmailError,
  authPasswordError,
  isAuthFormValid,
  onEmailChange,
  onPasswordChange,
  onNameChange,
  onBlurField,
  onModeChange,
  onViewChange,
  onSubmit,
  onForgotSubmit,
  onClose
}: AuthModalProps) {
  const title = serverAuthMode === "register" ? "계정 가입" : "로그인";
  const statusEl = serverStatus ? (
    <Alert variant="light" color={serverErrorKind ? "rose" : "teal"} p="xs">
      {serverStatus}
    </Alert>
  ) : null;

  return (
    <ModalShell opened={opened} sectionLabel="클라우드" title={title} onClose={onClose}>
      {hasServerApi ? (
        authView === "forgot" ? (
          <>
            <Text size="sm" c="dimmed">
              가입한 이메일로 비밀번호 재설정 링크를 보내드립니다.
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onForgotSubmit();
              }}
            >
              <TextInput
                label="이메일"
                type="email"
                value={serverEmail}
                onChange={(event) => onEmailChange(event.currentTarget.value)}
                mb="md"
              />
              <Button type="submit" loading={isServerBusy} fullWidth>
                재설정 링크 보내기
              </Button>
            </form>
            <Anchor component="button" type="button" size="sm" onClick={() => onViewChange("auth")}>
              로그인으로 돌아가기
            </Anchor>
            {statusEl}
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              클라우드에 저장하면 다른 기기에서도 데이터를 이어서 사용할 수 있습니다. 브라우저 로컬 저장은 그대로 유지됩니다.
            </Text>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit();
              }}
            >
              <SegmentedControl
                fullWidth
                mb="sm"
                value={serverAuthMode}
                onChange={(value) => onModeChange(value as "login" | "register")}
                data={[
                  { value: "login", label: "로그인" },
                  { value: "register", label: "가입" }
                ]}
              />
              <TextInput
                label="이메일"
                type="email"
                value={serverEmail}
                onChange={(event) => onEmailChange(event.currentTarget.value)}
                onBlur={() => onBlurField("email")}
                error={authTouched.email ? authEmailError : null}
                mb="sm"
              />
              {serverAuthMode === "register" ? (
                <TextInput
                  label="이름"
                  value={serverName}
                  onChange={(event) => onNameChange(event.currentTarget.value)}
                  mb="sm"
                />
              ) : null}
              <PasswordInput
                label="비밀번호"
                value={serverPassword}
                onChange={(event) => onPasswordChange(event.currentTarget.value)}
                onBlur={() => onBlurField("password")}
                error={authTouched.password ? authPasswordError : null}
                description={authTouched.password && authPasswordError ? undefined : "비밀번호는 8자 이상이어야 합니다."}
                mb="md"
              />
              <Button type="submit" loading={isServerBusy} disabled={!isAuthFormValid} fullWidth>
                {serverAuthMode === "register" ? "가입하고 클라우드에 저장" : "로그인"}
              </Button>
            </form>
            <Group gap={4}>
              {serverAuthMode === "login" ? (
                <>
                  <Text size="sm" c="dimmed">계정이 없으신가요?</Text>
                  <Anchor component="button" type="button" size="sm" onClick={() => onModeChange("register")}>
                    가입하기
                  </Anchor>
                  <Anchor component="button" type="button" size="sm" onClick={() => onViewChange("forgot")}>
                    비밀번호를 잊으셨나요?
                  </Anchor>
                </>
              ) : (
                <>
                  <Text size="sm" c="dimmed">이미 계정이 있으신가요?</Text>
                  <Anchor component="button" type="button" size="sm" onClick={() => onModeChange("login")}>
                    로그인하기
                  </Anchor>
                </>
              )}
            </Group>
            {statusEl}
          </>
        )
      ) : (
        <Alert variant="light" color="yellow" title="서버 API URL이 없어 클라우드 저장을 사용할 수 없습니다.">
          이 브라우저에만 저장됩니다. 데이터 관리에서 전체 Export 백업을 보관하세요.
        </Alert>
      )}
    </ModalShell>
  );
}
