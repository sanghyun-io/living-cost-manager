// Friendly Korean copy for server failures (moved out of page.tsx during the
// hooks refactor; wording is unchanged).
import { isEmailNotVerifiedError, isServerAuthFailure, ServerApiError } from "./serverApi";

export function getErrorMessage(error: unknown) {
  if (error instanceof ServerApiError) {
    const mapped = mapServerErrorMessage(error);
    if (mapped) {
      return mapped;
    }
  }
  return error instanceof Error ? error.message : "서버 요청에 실패했습니다.";
}

// Map server-side English/technical messages (and bare status codes) to friendly
// Korean copy so developer messages like "Invalid request body" never surface to users.
export function mapServerErrorMessage(error: ServerApiError): string | null {
  if (error.status === 400) {
    return "입력값을 확인해주세요.";
  }
  if (error.status === 409) {
    return "이미 가입된 이메일입니다.";
  }
  if (error.status === 429) {
    return "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
  }
  if (error.status >= 500) {
    return "서버에 일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.";
  }
  return null;
}

export function getServerSyncErrorMessage(error: unknown) {
  if (isEmailNotVerifiedError(error)) {
    return "이메일 인증 후에 클라우드 저장(동기화)을 사용할 수 있습니다. 가입 시 받은 인증 메일의 링크를 확인해 주세요.";
  }
  if (isServerAuthFailure(error)) {
    return "서버 세션이 만료되었거나 권한이 없습니다. 다시 로그인해 주세요.";
  }

  return getErrorMessage(error);
}
