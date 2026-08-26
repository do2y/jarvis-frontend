import type { ChatEvent, StreamChatBody } from '@/shared/types/chat';

/**
 * SSE 연결 시작 실패(스트림 시작 전 거부). status 와 code 를 담아 호출부가 분기한다.
 * 특히 401(티켓 만료·무효)은 호출부가 티켓 재발급 후 1회 재시도한다(계약 CH-2).
 * 스트림이 시작된 뒤(토큰 수신 중)의 오류는 이 에러가 아니라 SSE `error` 이벤트로 온다.
 *
 * code 를 함께 담는 이유: status 만으로는 계약이 정한 이름(TOKEN_EXPIRED·RATE_LIMITED 등)을
 * 알 수 없어 호출부가 안내 문구를 가려 쓸 수 없다. 본문이 없거나 형식이 다르면 undefined 다.
 */
export class StreamStartError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  constructor(status: number, code?: string, requestId?: string) {
    super(`chat request failed: ${status}${code ? ` (${code})` : ''}`);
    this.name = 'StreamStartError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * 스트림이 `done`/`error` 종결 이벤트 없이 끝난 경우.
 *
 * 계약상 모든 스트림은 둘 중 하나로 끝나야 한다. 연결이 중간에 끊기면 fetch/read 는
 * "정상 종료"처럼 끝날 수 있지만, 화면 입장에서는 반쯤 잘린 실패다.
 */
export class StreamInterruptedError extends Error {
  constructor() {
    super("chat stream ended without terminal event");
    this.name = "StreamInterruptedError";
  }
}

/**
 * 채팅 SSE 스트림 소비 유틸.
 * POST + JSON body이므로 EventSource가 아닌 fetch 스트리밍으로 파싱한다.
 * 자동 재시도 금지(중복 담기 방지) — 실패 시 호출부에서 재시도 버튼 제공.
 * 예외: 401(티켓 만료)만 스트림 시작 전이라 재발급 후 1회 재시도 안전(호출부 처리).
 *
 * 인증은 로그인 AT 가 아니라 세션 발급으로 받은 단명 streamTicket 을 싣는다.
 * URL 도 세션 발급 응답의 llmSseUrl 을 그대로 쓴다(BE 설정값) — 여기서 URL 을 만들지 않는다.
 */
export async function streamChat(
  sseUrl: string,
  ticket: string,
  body: StreamChatBody,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(sseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${ticket}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    // 스트림 시작 전 실패는 envelope 로 온다(계약 CH-2 §실패 응답).
    // 본문이 없거나 JSON 이 아닐 수 있으므로 실패해도 status 만으로 진행한다.
    let code: string | undefined;
    let requestId: string | undefined;
    try {
      const body = await res.json();
      code = body?.error?.code;
      requestId = body?.error?.requestId;
    } catch {
      // 본문 없음·파싱 실패 — status 로만 분기한다
    }
    throw new StreamStartError(res.status, code, requestId);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminalEvent = false;
  const handleEvent = (event: ChatEvent) => {
    if (event.type === 'done' || event.type === 'error') {
      sawTerminalEvent = true;
    }
    onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? ''; // 미완성 조각 보류

    for (const chunk of chunks) emitChunk(chunk, handleEvent);
  }

  // 마지막 조각을 흘려보내지 않는다.
  //
  // 서버가 종료 직전 프레임을 `\n\n` 으로 닫지 않고 끊으면 그 조각이 buffer 에 남는데,
  // 종전엔 루프를 그냥 빠져나가 버렸다. 마지막 프레임은 대개 `done` 이라 —
  // 잃으면 done 절이 실행되지 않아 분석 리포트가 패널에 커밋되지 않고(판매자),
  // zero_result 기본 문구도 채워지지 않는다. 남은 조각도 같은 규칙으로 파싱한다.
  if (buffer) emitChunk(buffer, handleEvent);

  if (!sawTerminalEvent) {
    throw new StreamInterruptedError();
  }
}

/**
 * SSE 청크 하나를 이벤트로 옮긴다.
 *
 * 와이어 포맷: `data: {"type":..., "data":{...}}` 한 줄(구매자·판매자 공통).
 * event: 라인은 없다 — payload 의 type 으로 이벤트를 구분한다.
 *
 * 해석할 수 없는 프레임은 조용히 버린다. 깨진 프레임 하나가 턴 전체를 죽이지 않게
 * 하기 위해서다 — 종전엔 JSON.parse 가 read 루프 밖으로 던져 뒤따라 오던 정상
 * 이벤트(done·products.ready 포함)를 영영 못 읽었고, 호출부는 그걸 스트림 실패로
 * 처리해 이미 화면에 찍힌 답변 위에 오류 말풍선을 씌웠다. 계약이 "모르는 이벤트는
 * 무시"를 이미 명문화하므로(개방형 유니온) 같은 규칙으로 흘려보내는 편이 일관된다.
 */
export function emitChunk(chunk: string, onEvent: (e: ChatEvent) => void): void {
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;

  let event: ChatEvent;
  try {
    event = JSON.parse(data) as ChatEvent;
  } catch {
    return;
  }
  onEvent(event);
}
