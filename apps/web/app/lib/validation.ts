// Client-side pre-submit validation mirroring the shared Zod schemas
// (registerRequestSchema etc.): email format, password min 8, name min 1.
// Each returns a friendly Korean message, or null when the input is valid.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): string | null {
  if (!email.trim()) {
    return "이메일을 입력해주세요.";
  }
  if (!EMAIL_PATTERN.test(email.trim())) {
    return "올바른 이메일 형식이 아닙니다.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) {
    return "비밀번호를 입력해주세요.";
  }
  if (password.length < 8) {
    return "비밀번호는 8자 이상이어야 합니다.";
  }
  return null;
}

export function validateName(name: string): string | null {
  if (!name.trim()) {
    return "이름을 입력해주세요.";
  }
  return null;
}

// Blur-time (inline) error messages for the login/register form. These differ
// slightly in copy from the submit-time validators above ("해 주세요" spacing),
// which is intentional: they were tuned for the inline Alert style.
export function authEmailMessage(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) {
    return "이메일을 입력해 주세요.";
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return "올바른 이메일 형식이 아닙니다.";
  }
  return null;
}

export function authPasswordMessage(password: string): string | null {
  if (password.length === 0) {
    return "비밀번호를 입력해 주세요.";
  }
  if (password.length < 8) {
    return "비밀번호는 8자 이상이어야 합니다.";
  }
  return null;
}

export type AuthTouched = { email: boolean; password: boolean };

export const CLEAN_AUTH_TOUCHED: AuthTouched = { email: false, password: false };
