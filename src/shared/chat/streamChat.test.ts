import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@/shared/types/chat";
import {
  emitChunk,
  StreamInterruptedError,
  streamChat,
} from "./streamChat";

/**
 * SSE 프레임 파싱 — 계약 CH-2 §와이어 포맷.
 *
 * 회귀 방지 대상은 "한 프레임의 문제가 턴 전체를 죽이지 않는다"이다.
 * 종전엔 JSON.parse 가 read 루프 밖으로 던져, 깨진 프레임 뒤에 오던 정상 이벤트
 * (done·products.ready 포함)를 영영 못 읽었다. 화면에는 이미 답변이 찍혀 있는데
 * 그 위에 오류 말풍선이 씌워지는 증상으로 나타난다.
 */
describe("emitChunk", () => {
  it("data: 한 줄을 payload.type 이벤트로 옮긴다", () => {
    const onEvent = vi.fn();
    emitChunk('data: {"type":"token","data":{"text":"안녕"}}', onEvent);

    expect(onEvent).toHaveBeenCalledWith({
      type: "token",
      data: { text: "안녕" },
    });
  });

  it("깨진 JSON 은 던지지 않고 흘려보낸다 — 뒤따르는 정상 프레임을 살리기 위해", () => {
    const onEvent = vi.fn();

    expect(() => emitChunk("data: {깨진", onEvent)).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("깨진 프레임 다음의 정상 프레임은 그대로 전달된다", () => {
    const events: ChatEvent[] = [];
    const collect = (e: ChatEvent) => events.push(e);

    emitChunk("data: {깨진", collect);
    emitChunk('data: {"type":"done","data":{"finishReason":"stop"}}', collect);

    expect(events).toEqual([
      { type: "done", data: { finishReason: "stop" } },
    ]);
  });

  it("data: 줄이 없는 청크(주석·하트비트)는 무시한다", () => {
    const onEvent = vi.fn();
    emitChunk(": keep-alive", onEvent);
    emitChunk("", onEvent);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("여러 data: 줄은 이어붙여 한 이벤트로 읽는다(SSE 규격)", () => {
    const onEvent = vi.fn();
    emitChunk('data: {"type":"token",\ndata: "data":{"text":"ab"}}', onEvent);

    expect(onEvent).toHaveBeenCalledWith({
      type: "token",
      data: { text: "ab" },
    });
  });
});

function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("streamChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("마지막 done 프레임이 구분자 없이 끝나도 종결 이벤트로 읽는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSseResponse([
          'data: {"type":"done","data":{"finishReason":"stop"}}',
        ]),
      ),
    );

    const events: ChatEvent[] = [];

    await expect(
      streamChat(
        "https://example.com/chat",
        "ticket",
        { sessionId: "session-1", threadId: "thread-1" },
        (event) => events.push(event),
      ),
    ).resolves.toBeUndefined();

    expect(events).toEqual([
      { type: "done", data: { finishReason: "stop" } },
    ]);
  });

  it("done/error 없이 끝나면 끊긴 스트림으로 보고 실패시킨다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        makeSseResponse([
          'data: {"type":"token","data":{"text":"답변이 오다가"}}\n\n',
        ]),
      ),
    );

    const events: ChatEvent[] = [];

    await expect(
      streamChat(
        "https://example.com/chat",
        "ticket",
        { sessionId: "session-1", threadId: "thread-1" },
        (event) => events.push(event),
      ),
    ).rejects.toBeInstanceOf(StreamInterruptedError);

    expect(events).toEqual([
      { type: "token", data: { text: "답변이 오다가" } },
    ]);
  });
});
