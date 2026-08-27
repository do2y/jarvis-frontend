import type { ChatErrorCode } from "@/shared/types/chat";

const CHAT_ERROR_FALLBACK: Record<ChatErrorCode, string> = {
  LLM_TIMEOUT: "응답이 지연되고 있어요. 다시 시도해 주세요.",
  LLM_UNAVAILABLE: "지금은 채팅 응답을 사용할 수 없어요. 잠시 후 다시 시도해 주세요.",
  SEARCH_FAILED: "상품을 찾는 중 문제가 발생했어요. 다시 시도해 주세요.",
  INTERNAL: "일시적인 오류가 발생했어요. 다시 시도해 주세요.",
};

const RAW_CHAT_ERROR_PATTERNS = [
  /\b(?:request failed|failed to fetch|network error|internal server error)\b/i,
  /\b(?:service unavailable|bad gateway|gateway timeout|traceback|exception)\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE)\b/,
  /\b(?:HTTP|status code)\b/i,
  /\b[A-Z_]{4,}\b/,
];

function isLikelyUserFacingChatErrorMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  // 이 앱의 사용자 노출 카피는 한국어다. raw 영문 예외·코드명이 새면 기본 문구로 접는다.
  if (!/[가-힣]/.test(trimmed)) return false;
  return !RAW_CHAT_ERROR_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * SSE error 이벤트 문구 정규화.
 *
 * 계약상 message 가 사용자 노출 문구지만, 실제 운영에서는 코드명·HTTP 예외·영문 원문이
 * 섞여 들어올 수 있다. 그 경우 FE 가 코드별 기본 문구로 접어 raw 메시지가 말풍선에
 * 그대로 드러나지 않게 한다.
 */
export function resolveChatErrorMessage(
  code: ChatErrorCode,
  message: string,
): string {
  return isLikelyUserFacingChatErrorMessage(message)
    ? message.trim()
    : CHAT_ERROR_FALLBACK[code];
}

