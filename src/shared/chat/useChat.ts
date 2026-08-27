"use client";

import { useCallback, useEffect, useRef } from "react";
import { track } from "@/shared/analytics/track";
import { ApiError } from "@/shared/api/client";
import {
  streamChat,
  StreamInterruptedError,
  StreamStartError,
} from "@/shared/chat/streamChat";
import {
  clearCachedSession,
  ensureSession,
  refreshTicket,
  SessionClaimPendingError,
  subscribeOwnershipChange,
  subscribeSession,
} from "@/shared/chat/sessionCoordinator";
import { clearChat } from "@/shared/chat/chatPersistence";
import { resolveChatErrorMessage } from "@/shared/chat/errorMessage";
import { getThreadId, newThreadId } from "@/shared/chat/threadId";
import { fetchChatListGroup } from "@/shared/chat/lists";
import { resolveProgressText } from "@/shared/chat/progress";
import { resolveAnalysisReport } from "@/shared/chat/analysisReport";
import type {
  ChatAction,
  ChatChannel,
  ChatEvent,
  ChatScreenContext,
  ChatSession,
  ConditionAction,
  ConditionField,
  SellerPanel,
  SellerReport,
  StreamChatBody,
} from "@/shared/types/chat";
import { removeChip } from "./conditionRemoval";
import { useChatStore } from "./store";

function newId(): string {
  return crypto.randomUUID();
}

/**
 * 중단(abort) 판정 — 사용자가 스스로 끊은 것이라 오류로 표시하지 않는다.
 *
 * 이름으로 보는 이유: fetch 중단은 DOMException("AbortError")로 오지만 axios 경로는
 * CanceledError 로 오고, jsdom·polyfill 환경에서는 DOMException 생성자가 다를 수 있어
 * instanceof 가 어긋난다. 이름은 세 경우 모두에서 안정적이다.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "CanceledError";
}

/**
 * 세션 축출(404) 판정 — 출처가 둘이라 타입도 둘이다.
 * 스트림 fetch 는 StreamStartError(status), 티켓 재발급은 ApiError(code/status).
 */
function isNotFound(err: unknown): boolean {
  if (err instanceof StreamStartError) return err.status === 404;
  if (err instanceof ApiError) {
    return err.status === 404 || err.code === "SESSION_NOT_FOUND";
  }
  return false;
}

/**
 * 스트림 시작 전 거부를 사용자 안내로 옮긴다(계약 CH-2 §실패 응답).
 * 상태별로 재시도가 의미 있는지가 달라 retryable 을 함께 정한다.
 */
function describeStreamStartError(err: StreamStartError): {
  message: string;
  retryable: boolean;
} {
  switch (err.status) {
    case 403:
      // 티켓은 유효하나 scope 불일치(예: 판매자 티켓으로 구매자 스트림).
      // 같은 티켓으로 다시 걸어도 결과가 같다.
      return {
        message: "이 대화를 열 권한이 없어요. 새로고침 후 다시 시도해 주세요.",
        retryable: false,
      };
    case 409:
      // STREAM_IN_PROGRESS — 같은 방에 활성 스트림이 있다.
      // 진행 중인 응답이 끝나야 풀리므로 즉시 재시도는 또 409 다.
      return {
        message: "다른 대화가 진행 중이에요. 잠시 후 다시 시도해 주세요.",
        retryable: false,
      };
    case 429:
      // RATE_LIMITED — 재시도 버튼을 주면 사용자가 눌러 상황을 더 악화시킨다.
      return {
        message: "요청이 많아요. 잠시 후 다시 시도해 주세요.",
        retryable: false,
      };
    case 504:
      // UPSTREAM_TIMEOUT(first-token) — 일시적이라 재시도가 유효하다.
      return {
        message: "응답이 지연되고 있어요. 다시 시도해 주세요.",
        retryable: true,
      };
    default:
      return {
        message: "응답을 받지 못했어요. 다시 시도해 주세요.",
        retryable: true,
      };
  }
}

interface UseChatOptions {
  channel: ChatChannel;
  /** 채널별 액션 후처리(장바구니 invalidate 등). 안내 문구 표시는 공통 처리. */
  onAction?: (action: ChatAction) => void;
  /**
   * 스트림 종료 시 우측 패널 조치(판매자 전용). done.panel 을 그대로 전달한다.
   * replace(패널 교체) / keep(유지) / refresh(목록 재조회). error 로 끝나면 호출되지 않는다.
   */
  onDone?: (panel: SellerPanel | undefined) => void;
  /**
   * 전송 시점의 화면 맥락을 반환하는 함수(사이드 채팅 전용).
   * 값이 아닌 함수로 받는 이유: 사용자가 목록을 이동하며 대화하므로
   * 훅 초기화 시점이 아니라 매 전송 시점의 화면을 실어야 한다.
   */
  getScreenContext?: () => ChatScreenContext | undefined;
}

export function useChat({
  channel,
  onAction,
  onDone,
  getScreenContext,
}: UseChatOptions) {
  // 이 훅이 실제로 "구독"해야 하는 값은 isStreaming 하나다.
  //
  // 종전엔 useChatStore() 를 선택자 없이 호출해 스토어 전체를 구독했다. 그러면
  // token 이벤트마다 갱신되는 messages 까지 이 훅의 구독에 걸려, 스트리밍 한 턴에
  // 수백 번 이 훅을 쓰는 화면(구매자·판매자 챗 페이지 루트)이 통째로 리렌더된다.
  // 정작 훅이 돌려주는 값(send·retry…)은 그대로라 그 리렌더는 아무것도 바꾸지 않는다.
  //
  // 액션은 zustand 에서 생성 시 고정이라 구독 없이 스토어 참조로 꺼내 쓴다 —
  // getState() 로 매번 읽지 않고 여기서 한 번 구조분해해도 동일한 함수 참조다.
  const isStreaming = useChatStore((s) => s.isStreaming);
  const {
    addMessage,
    appendToLastAssistant,
    failLastAssistant,
    setResults,
    addResult,
    settleDraft,
    setConditions,
    setSuggestions,
    setSessionId,
    setStreaming,
    setLane,
    setProgress,
    setAnalysisReport,
    setActiveDraft,
    reset,
  } = useChatStore.getState();

  // 진행 중 요청 취소용
  const abortRef = useRef<AbortController | null>(null);
  // 언마운트 취소 예약 — StrictMode 의 가짜 언마운트를 걸러내기 위해 한 틱 미룬다.
  // (아래 cleanup 주석 참조)
  const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 콜백들은 매 렌더 갱신되도록 ref로 보관(send의 deps를 안정적으로 유지)
  const onActionRef = useRef(onAction);
  const onDoneRef = useRef(onDone);
  const getScreenContextRef = useRef(getScreenContext);
  useEffect(() => {
    onActionRef.current = onAction;
    onDoneRef.current = onDone;
    getScreenContextRef.current = getScreenContext;
  });

  // 스트림 진입 티켓 확보 — 티켓 TTL 이 30~60초로 짧아 매 전송 직전에 확보한다.
  // 발급 자체는 코디네이터가 Web Locks 로 탭 간 단일화한다(접속당 CH-1 1회).
  // sessionId 는 항상 발급 응답값을 쓴다(BE·Redis 발급, sliding TTL) — 클라이언트가 만들지 않는다.
  // 승계 실패가 미해결이면 새 세션 발급을 막는다(allowCreate=false) — 조용히 새로
  // 만들면 화면엔 이전 대화가 있는데 AI 는 기억 못 하는 어긋남이 생긴다.
  const acquireTicket = useCallback((): Promise<ChatSession> => {
    const { sessionId, claimFailure } = useChatStore.getState();
    return ensureSession(channel, sessionId, !claimFailure);
  }, [channel]);

  // 다른 탭이 세션을 발급·갱신하면 이 탭의 표시용 sessionId 도 따라간다.
  // (정본은 코디네이터의 localStorage 캐시 — 여기선 스토어를 동기화만 한다.)
  useEffect(() => {
    return subscribeSession(channel, (s) => {
      setSessionId(s.sessionId);
    });
  }, [channel, setSessionId]);

  // 다른 탭에서 로그인하면 이 탭이 들고 있는 게스트 티켓은 그 순간 무효다
  // (AI 가 403 으로 막는다). 캐시를 비워 두면 다음 전송의 ensureSession 이
  // 회원 신원으로 재발급받아 그대로 통과한다 — 사용자는 아무것도 눈치채지 못한다.
  //
  // 전송을 막고 새로고침을 요구하지 않는 이유: 실제로 깨지는 구간은 방송이
  // 도착하기 전 수십 ms 뿐인데, 막아 두면 멀쩡히 이어질 대화까지 중단시킨다.
  useEffect(() => subscribeOwnershipChange(channel), [channel]);

  // 이 탭의 방 id 를 마운트 시 1회 확보한다(sessionStorage 정본).
  useEffect(() => {
    useChatStore.getState().setThreadId(getThreadId(channel));
  }, [channel]);

  // 언마운트 시 진행 중인 스트림을 끊는다.
  //
  // 없으면 화면을 떠난 뒤에도 fetch 리더가 계속 돌며 onEvent 가 스토어를 갱신한다.
  // 스토어는 모듈 전역(zustand)이라 언마운트로 사라지지 않으므로 조용히 살아남고,
  // 특히 finally 의 setStreaming(false) 가 언마운트 뒤에 도착하는 경우가 문제다 —
  // 다시 채팅에 들어오면 복원된 대화 위에 이전 턴의 token 이 이어붙거나
  // isStreaming 이 true 로 굳어 입력창이 막힌 채로 남는다.
  //
  // abort 는 streamChat 의 fetch 를 AbortError 로 끊고, 그 예외는 run 의 catch 로
  // 떨어진다. 언마운트된 화면에 실패 말풍선을 남기지 않도록 catch 에서 AbortError 를
  // 따로 걸러낸다(사용자가 의도적으로 떠난 것이지 오류가 아니다).
  //
  // ⚠️ StrictMode(dev)는 마운트 → 언마운트 → 재마운트를 한 번 흉내 낸다. 그 가짜
  // 언마운트에서 바로 abort 하면, 같은 마운트 사이클에 시작된 스트림이 첫 프레임도
  // 받기 전에 끊긴다 — 홈에서 ?q= 로 진입하는 경로가 정확히 그렇다(전송 이펙트는
  // ref 가드로 1회만 돌지만, 이 cleanup 은 가드가 없어 그 1회를 죽였다).
  // 증상은 "말풍선은 뜨는데 SSE 요청이 아예 안 나가고 로딩만 도는" 모양이었다.
  //
  // 그래서 즉시 끊지 않고 한 틱 미뤄, 재마운트가 뒤따르면 취소를 철회한다.
  // 진짜 이탈이면 타이머가 그대로 실행돼 종전처럼 스트림이 끊긴다.
  // (프로덕션에는 가짜 언마운트가 없어 동작이 달라지지 않는다 — 한 틱 늦어질 뿐이다.)
  useEffect(() => {
    // 재마운트로 되돌아온 경우: 직전 cleanup 이 걸어 둔 취소 예약을 무른다.
    const pending = abortTimerRef.current;
    if (pending !== null) {
      clearTimeout(pending);
      abortTimerRef.current = null;
    }

    return () => {
      const controller = abortRef.current;
      if (!controller) return;
      abortTimerRef.current = setTimeout(() => {
        abortTimerRef.current = null;
        controller.abort();
        if (abortRef.current === controller) abortRef.current = null;
      }, 0);
    };
  }, []);

  /**
   * 스트림 실행 공통부 — 일반 발화(send)와 승인(confirm)이 공유한다.
   * userText 가 있으면 사용자 말풍선을 추가하고(발화), confirm 은 말풍선 없이 실행만 한다.
   * buildBody 는 발급받은 sessionId·threadId 를 받아 SSE body 를 만든다(신원은 티켓에 있음).
   */
  const run = useCallback(
    async (
      buildBody: (base: {
        sessionId: string;
        threadId: string;
      }) => StreamChatBody,
      userText: string | null,
      /**
       * 이 발화에 딸린 이미지 — 말풍선에 남길 표시용이다(요청 body 는 buildBody 가 만든다).
       * 서버가 되돌려주지 않으므로 여기서 넣어 두지 않으면 화면에서 사라진다.
       */
      userImageUrls?: string[],
    ) => {
      if (useChatStore.getState().isStreaming) return;

      if (userText !== null) {
        addMessage({
          id: newId(),
          role: "user",
          text: userText,
          ...(userImageUrls?.length ? { imageUrls: userImageUrls } : {}),
        });
      }
      // 스트리밍으로 채워질 빈 assistant 메시지 선 추가
      addMessage({ id: newId(), role: "assistant", text: "" });
      setStreaming(true);
      setLane(null);
      setProgress(null);
      // 이전 리포트는 유지(새 스트림이 analysis+replace로 끝날 때만 교체) — done에서 갱신

      // 한 응답 안에서 여러 결과 이벤트가 올 수 있다. 첫 결과가 도착할 때
      // 이전 턴의 결과를 비우고, 그 뒤부터는 누적한다.
      let replacedResults = false;
      const pushResult: typeof addResult = (result) => {
        if (!replacedResults) {
          replacedResults = true;
          setResults([result]);
          return;
        }
        addResult(result);
      };

      // products.ready(경로 B)의 CH-5 조회는 비동기다. 스트림 종료(finally) 전에
      // 완료를 보장하려고 promise 를 모아 두고 스트림 소비 후 함께 기다린다.
      const pendingFetches: Promise<void>[] = [];

      // 분석 리포트 보관함 — 스트림 1회 수명(run 호출당 새로 생긴다).
      // report 수신 즉시 패널에 꽂지 않고 여기 담아 두는 이유는 done 절 주석 참조.
      let pendingReport: SellerReport | null = null;

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        // 1) 티켓 확보(Spring REST) — 코디네이터가 캐시·락으로 탭 간 단일화해 돌려준다.
        //    sessionId 는 서버 발급값을 저장·사용(재발급도 같은 sessionId 를 돌려준다).
        const session = await acquireTicket();
        setSessionId(session.sessionId);

        // threadId(계약 CH-2): 대화 스레드(방) 식별자, 필수.
        // sessionId 는 탭 간 공유되므로 방 구분은 탭별 threadId 가 맡는다(sessionStorage).
        const threadId = getThreadId(channel);
        useChatStore.getState().setThreadId(threadId);

        const body = buildBody({ sessionId: session.sessionId, threadId });

        const onEvent = (e: ChatEvent) => {
          switch (e.type) {
            case "meta":
              // 첫 프레임 — 레인으로 즉시 레이아웃·로딩 준비
              setLane(e.data.lane);
              // 새 분석이 시작되면 이전 리포트를 비운다(스켈레톤부터 다시 시작).
              // 보관함도 함께 턴다 — 이전 스트림이 report 만 보내고 done 없이
              // 끊겼다면 남아 있을 수 있는데, 그게 다음 턴 결과로 새면 안 된다.
              if (e.data.lane === "analysis") {
                setAnalysisReport(null);
                pendingReport = null;
              }
              break;
            case "progress": {
              // 진행 상태(최종 답변 아님). 두 스트림의 페이로드가 다르다 —
              // 구매자 {stage, message?} / 판매자 {text}. 쉐이프를 맞추는 건 후속 과제라
              // 지금은 수신부가 분기한다(계약 CH-2 §progress, 2026-08-05 #289).
              //
              // 구매자는 message 가 없으면 stage 로 자체 문구를 매핑한다 —
              // 서버가 빈 값이면 키 자체를 싣지 않기로 계약이 위임한 지점이다.
              // 문구를 못 구한 경우(모르는 stage + message 없음)는 무시한다 — 계약이
              // "FE 는 모르는 stage 를 무시한다"로 정한 지점이다. null 로 덮으면
              // 직전 단계 문구까지 지워져 진행 표시가 도리어 후퇴한다.
              const text = resolveProgressText(e.data);
              if (text) setProgress(text);
              break;
            }
            case "token":
              // 진행 표시를 지우지 않는다 — publishing 은 근거 token 뒤에 오므로
              // 여기서 지우면 7종 중 그 한 종이 영영 화면에 닿지 못한다(계약 CH-2 §progress).
              // 정리는 done·finally 가 맡는다.
              appendToLastAssistant(e.data.text);
              break;
            case "conditions":
              // AI 추출 조건 칩(제거 가능). 새 턴이 오면 이전 칩을 덮어쓴다.
              setConditions(e.data.chips);
              break;
            case "suggestions":
              // 완화·되돌리기 제안 칩. estCount==0 은 방어적으로 제외.
              setSuggestions(e.data.chips.filter((c) => c.estCount > 0));
              break;
            case "products.ready": {
              // 경로 B — 카드는 SSE에 없다. 각 listId 로 CH-5 를 개별 조회해 패널에 넣는다.
              // listIds 는 항상 배열이다(세트형·니즈별 추천이 여러 묶음일 수 있음, 상한 10).
              // 조회 실패(404 등)는 재시도 버튼이 아니라 안내만 — 답변 자체는 정상 종료됐으므로.
              // 서버가 아직 단수 listId 를 보낸다 — 배열 우선, 없으면 길이 1로 승격
              const listIds =
                e.data.listIds ?? (e.data.listId ? [e.data.listId] : []);
              if (!listIds.length) break;

              pendingFetches.push(
                // 병렬 조회하되 결과는 listIds 순서(=I-21 lists 순서)로 한 번에 넣는다.
                // 개별 push 하면 응답이 빨리 온 묶음이 앞서 붙어 순서가 뒤집힌다.
                Promise.all(
                  listIds.map((id) =>
                    fetchChatListGroup(id).catch(() => null),
                  ),
                ).then((groups) => {
                  const usable = groups.filter(
                    (g): g is NonNullable<typeof g> =>
                      // 카드가 0개라도 드롭이 있었다면 넣는다 — "추천이 다 품절됐다"는
                      // 사실 자체가 안내거리다(200 · items:[] · itemsDropped>0, CH-5).
                      g !== null &&
                      Boolean(g.items.length || g.recommendation?.itemsDropped),
                  );
                  if (usable.length) {
                    pushResult({ kind: "products", groups: usable });
                  }

                  // 404 RESOURCE_NOT_FOUND(listId 만료·미존재)가 대표 사유다.
                  // TTL 만료는 재시도해도 계속 404이므로 "다시 시도"를 권하지 않는다.
                  //
                  // 하나도 못 가져왔으면 패널을 건드리지 않는다 — pushResult 를 부르지
                  // 않았으므로 이전 턴의 카드가 그대로 남는다. 명세가 "오류 화면을 띄우지
                  // 말고 가지고 있던 카드를 그대로 보여주라"고 한 지점이다(CH-5).
                  // 답변 자체는 정상 종료됐으므로 말풍선에도 실패로 표시하지 않는다.
                  if (!usable.length) {
                    appendToLastAssistant(
                      "\n\n추천 카드를 새로 불러오지 못해 이전 결과를 그대로 두었어요.",
                    );
                  } else if (usable.length < listIds.length) {
                    // 일부만 실패 — 가져온 묶음은 이미 패널에 넣었고 빠진 게 있다는 사실만 알린다
                    appendToLastAssistant(
                      "\n\n일부 추천 묶음을 불러오지 못했어요.",
                    );
                  }
                }),
              );
              break;
            }
            case "draft":
              pushResult({ kind: "draft", draft: e.data });
              // 등록 초안이 뜨면 입력창을 초안 모드로 — 딴 주제로 넘어가 초안이
              // 방치되지 않게 한다. 수정 턴에서 새 draft 가 오면 같은 코드가 다시
              // 돌아 draftId·타이머가 함께 갱신된다(별도 분기 불필요).
              if (e.data.op === "create") setActiveDraft(e.data.draftId);
              break;
            case "report":
              // 보관만 하고 화면에 꽂지 않는다 — 커밋 신호는 done{replace} 다.
              // 여기서 바로 반영하면 report 뒤에 error 로 끝나는 스트림에서
              // 실패한 턴의 리포트가 패널에 남는다(계약 §3.2: error 종료 시 폐기).
              pendingReport = e.data;
              break;
            case "action": {
              // 장바구니 담기·삭제·수량변경, 찜 추가·해제, 판매자 수정 결과(계약 CH-2 §action).
              // message 는 AI 가 조립한 사용자 노출 안전 문구다 — 그대로 붙이고
              // 문구를 하드코딩하거나 파싱하지 않는다. 분기는 type·reason 으로만.
              const action = e.data;
              appendToLastAssistant(`\n\n${action.message}`);
              // 수정 결과면 해당 draft 카드를 확정 상태로 잠금
              if (
                action.type === "PRODUCT_UPDATED" ||
                action.type === "PRODUCT_UPDATE_FAILED"
              ) {
                const drafts = useChatStore
                  .getState()
                  .results.filter((r) => r.kind === "draft" && !r.settled);
                // 등록 초안은 productId 가 null 이다(아직 상품이 없으니까) —
                // productId 로만 찾으면 등록 결과가 카드에 영원히 반영되지 않는다.
                // 등록은 확정 대기 중인 create 초안을 대상으로 잡는다.
                const pending =
                  drafts.find(
                    (r) =>
                      r.kind === "draft" &&
                      r.draft.productId === action.productId,
                  ) ??
                  drafts.find(
                    (r) => r.kind === "draft" && r.draft.op === "create",
                  );
                if (pending?.kind === "draft") {
                  settleDraft(pending.draft.draftId, action);
                  // 등록이 끝났으면 초안 모드를 푼다(실패면 계속 고칠 수 있게 유지)
                  if (
                    pending.draft.op === "create" &&
                    action.type === "PRODUCT_UPDATED"
                  ) {
                    setActiveDraft(null);
                  }
                }
              }
              // 이 경로에서는 행동 이벤트를 쏘지 않는다.
              //
              // 예전엔 CART_ADDED 하나만 add_to_cart 로 쐈지만, SSE 페이로드가
              // cartItemId·message 뿐이라 명세 필수 키(quantity·price)를 채우지 못해
              // 서버에 _incomplete 로 쌓였다. 그래서 담기 3개 경로를 모두 커버하는
              // BE CartService 단일 지점 적재로 이관됨(A 문서, 2026-08-06).
              //
              // 나머지 액션(삭제·수량변경·찜)도 여기서 쏘지 않는다 — 대응하는
              // eventType 이름이 E-1 FE 화이트리스트에 없다(analytics/types.ts).
              onActionRef.current?.(action);
              break;
            }
            case "done": {
              setProgress(null);
              // zero_result: 결과 0건(에러 아님). AI token 안내가 없었으면 기본 문구로 채운다.
              if (e.data.finishReason === "zero_result") {
                const last = useChatStore.getState().messages.slice(-1)[0];
                if (last?.role === "assistant" && !last.text) {
                  appendToLastAssistant(
                    "조건에 맞는 상품을 찾지 못했어요. 조건을 바꿔 다시 시도해 주세요.",
                  );
                }
              }
              // 분석 리포트(analysis+replace)는 우측 패널로 교체된다.
              // 구조화 report 우선, 없으면 token 연문 승계(계약 §0 fallback).
              const st = useChatStore.getState();
              if (st.lane === "analysis" && e.data.panel === "replace") {
                const last = st.messages[st.messages.length - 1];
                const next = resolveAnalysisReport(
                  pendingReport,
                  last?.role === "assistant" ? last.text : undefined,
                );
                // null 이면 패널을 건드리지 않는다 — 이전 리포트가 남는 게 낫다
                if (next) setAnalysisReport(next);
              }
              onDoneRef.current?.(e.data.panel);
              break;
            }
            case "error":
              // 종결 이벤트 — 해당 말풍선에 에러 표시.
              //
              // 재시도 여부는 code 가 아니라 retryable 로 판단한다 — 같은 LLM_UNAVAILABLE
              // 이라도 "미구성"(재시도 무의미)과 "일시 불가"(유효)가 섞여 있어
              // emit 지점만이 안다. requestId 는 사용자 신고 시 서버 로그 추적에 쓴다.
              // 계약상 message 가 사용자 문구지만, 운영에서는 raw 원문이 섞일 수 있어
              // code 기반 기본 카피로 한 번 더 정규화한다.
              setProgress(null); // 종결 이벤트 — 진행 표시를 남기지 않는다
              // 계약 §3.2: error 종료 시 보관 중인 리포트는 폐기한다.
              // 패널은 건드리지 않는다 — done 이 안 왔으니 이전 리포트가 정본이다.
              pendingReport = null;
              failLastAssistant(
                resolveChatErrorMessage(e.data.code, e.data.message),
                {
                retryable: e.data.retryable,
                requestId: e.data.requestId,
                },
              );
              break;
          }
        };

        // 2) llmSseUrl + streamTicket 으로 SSE 스트림 소비.
        //    티켓 만료 401(스트림 시작 전 거부)이면 재발급 후 1회만 재시도한다(계약 CH-2).
        //    토큰 수신이 시작된 뒤의 오류는 SSE error 이벤트로 오므로 여기서 재시도하지 않는다
        //    (중복 담기 방지). 재발급도 실패하면 catch 로 떨어진다.
        try {
          await streamChat(
            session.llmSseUrl,
            session.streamTicket,
            body,
            onEvent,
            controller.signal,
          );
        } catch (err) {
          // 401(티켓 만료) — 코디네이터 경유로 재발급(같은 락)하고 1회만 재시도.
          // 갱신된 티켓은 브로드캐스트로 다른 탭에도 공유된다.
          if (err instanceof StreamStartError && err.status === 401) {
            const fresh = await refreshTicket(channel, session.sessionId);
            setSessionId(fresh.sessionId);
            await streamChat(
              fresh.llmSseUrl,
              fresh.streamTicket,
              body,
              onEvent,
              controller.signal,
            );
          } else {
            throw err;
          }
        }

        // 스트림이 끝나도 products.ready 의 CH-5 조회가 남아 있을 수 있다 — 함께 기다린다.
        // (각 조회는 내부에서 catch 하므로 여기서 예외로 실패 처리되지 않는다.)
        if (pendingFetches.length) await Promise.all(pendingFetches);
      } catch (err) {
        // 404 SESSION_NOT_FOUND = 세션 TTL(10분) 만료. CH-1 이 멱등 발급이라 다른 탭이
        // 세션을 축출하는 일은 없으므로 "다른 곳에서 종료됨"이 아니라 단순 만료다.
        // 캐시를 비워 두면 다음 전송의 ensureSession 이 새로 발급한다 — 여기서 자동
        // 재전송하지 않고 재시도 버튼만 준다(중복 담기 방지).
        if (isAbortError(err)) {
          // 사용자가 스스로 끊은 것이다(새 대화·화면 이탈) — 오류가 아니므로
          // 말풍선에 실패를 남기지 않는다. 종전엔 startNewChat 의 abort 가 이 자리로
          // 떨어져 "응답을 받지 못했어요"가 새 대화 직전 말풍선에 붙었다.
          // (reset() 이 뒤따라 지우지만, 언마운트 경로에서는 지울 주체가 없다.)
        } else if (err instanceof SessionClaimPendingError) {
          // 승계 실패가 미해결 — 배너가 이미 떠 있고 사용자가 재시도/새 대화를
          // 골라야 한다. 말풍선의 재시도 버튼은 감춘다(같은 이유로 또 막힌다).
          failLastAssistant(
            "이전 대화를 이어받지 못해 메시지를 보낼 수 없어요. 위 안내에서 다시 시도하거나 새 대화를 시작해 주세요.",
            { retryable: false },
          );
        } else if (isNotFound(err)) {
          clearCachedSession(channel);
          setSessionId(null);
          failLastAssistant(
            "대화가 만료되었어요. 다시 시도하면 새로 이어서 대화할 수 있어요.",
          );
        } else if (err instanceof StreamInterruptedError) {
          // read 가 끝났더라도 done/error 가 없으면 정상 종료가 아니다 — 응답이
          // 반쯤 잘려 버튼도 없이 남는 쪽이 사용자 경험상 더 나쁘다.
          failLastAssistant("응답 연결이 중간에 끊겼어요. 다시 시도해 주세요.");
        } else if (err instanceof StreamStartError) {
          // 스트림 시작 전 거부(계약 CH-2 §실패 응답) — 상태별로 안내와 재시도 여부가 다르다.
          // 자동 재시도는 하지 않는다(중복 담기 방지) — 재시도는 버튼으로만.
          const { message, retryable } = describeStreamStartError(err);
          failLastAssistant(message, { retryable, requestId: err.requestId });
        } else {
          // 세션 발급·티켓 재발급 실패(axios 경로) 등 나머지
          failLastAssistant("응답을 받지 못했어요. 다시 시도해 주세요.");
        }
      } finally {
        setStreaming(false);
        setProgress(null);
        abortRef.current = null;
      }
    },
    [
      addMessage,
      appendToLastAssistant,
      failLastAssistant,
      setConditions,
      setSuggestions,
      setResults,
      addResult,
      settleDraft,
      setSessionId,
      setStreaming,
      setLane,
      setProgress,
      setAnalysisReport,
      setActiveDraft,
      acquireTicket,
      channel,
    ],
  );

  const send = useCallback(
    (
      message: string,
      conditionActions?: ConditionAction[],
      /**
       * 추가 전송 값. 인자를 늘리지 않고 객체로 받는 이유는 호출부마다 채우는 것이
       * 달라서다 — 조건 칩은 구매자, 이미지는 판매자 전용이다.
       */
      opts?: {
        /**
         * 상품 등록용 이미지(판매자). **새로 첨부한 턴에만 넘긴다** —
         * 후속 턴에도 실으면 AI 가 매 턴 사진을 다시 분석해 상품명이 흔들린다.
         * 호출부가 첨부 여부를 알고 있으므로 여기서 판단하지 않는다.
         */
        imageUrls?: string[];
      },
    ) => {
      const trimmed = message.trim();
      // 계약 CH-2: message 와 conditionActions 가 둘 다 비면 400. 하나만 있으면 정상이다.
      if (!trimmed && !conditionActions?.length) return;

      // 이 앱의 상품 검색은 챗봇이다. 단 칩 제거 같은 제어 요청은 사용자의 검색 의도가
      // 아니므로 제외한다.
      //
      // query 는 원문을 싣는다 — 발화는 LLM 진입 전에 개인정보가 필터링된다(2026-08 확인).
      //
      // resultsCount 는 발화 시점에 알 수 없어 싣지 못한다(products.ready → CH-5 조회가
      // 수 초 뒤다). 결과를 기다렸다 쏘면 스트림이 실패한 검색이 통째로 유실돼
      // "검색은 항상 성공한다"로 보이는 생존 편향이 생기므로 지금 쏜다.
      // 결과 수는 서버가 적재하는 recommendation_generated.itemCount 가 정본이다 —
      // 그쪽은 목록 저장 시점이라 개수를 알고 있다. search 행에는 _incomplete 가 붙는다.
      if (trimmed && !conditionActions?.length) {
        track("search", { properties: { query: trimmed } });
      }

      // 전송 시점의 화면을 싣는다(사이드 채팅에서 목록을 옮겨다니며 대화하므로)
      const screen = getScreenContextRef.current?.();

      return run(
        ({ sessionId, threadId }) => ({
          sessionId,
          threadId,
          message: trimmed,
          ...(conditionActions?.length ? { conditionActions } : {}),
          ...(screen ? { screen } : {}),
          ...(opts?.imageUrls?.length ? { imageUrls: opts.imageUrls } : {}),
        }),
        // 칩 제거만 있는 턴은 사용자 말풍선을 남기지 않는다 — 제어 신호이지 발화가 아니다
        // (판매자 confirm 과 동일 처리, 계약 CH-2).
        trimmed || null,
        opts?.imageUrls,
      );
    },
    [run],
  );

  // draft 승인 — 발화가 아니라 최상위 action/draftId 로 확정한다(발화≠동의, 계약 v2).
  const confirm = useCallback(
    (draftId: string) => {
      return run(
        ({ sessionId, threadId }) => ({
          sessionId,
          threadId,
          action: "confirm",
          draftId,
        }),
        null, // 승인은 사용자 말풍선을 남기지 않는다
      );
    },
    [run],
  );

  // 실패한 응답 재시도 — 에러난 (user, assistant) 쌍을 제거하고 같은 발화로 다시 전송.
  // 이미지도 그대로 다시 싣는다(실패한 턴은 서버에 닿지 않아 재분석 우려가 없다).
  const retry = useCallback(() => {
    const dropped = useChatStore.getState().dropLastExchange();
    if (dropped?.text) {
      send(dropped.text, undefined, { imageUrls: dropped.imageUrls });
    }
  }, [send]);

  // 조건 칩 제거 — conditionActions 배열로 보낸다(계약 CH-2 #84, 규약 문자열 방식은 폐기).
  // 어떤 칩을 지웠는지는 UI만 아는 사실이라 발화만으로는 서버가 복원할 수 없다.
  //
  // 화면에서 먼저 지운다 — 서버 왕복을 기다리면 누른 뒤 한참 칩이 남아 있어
  // 눌리지 않은 것처럼 보인다. 다음 턴의 conditions 이벤트가 전체를 덮어쓰므로
  // (§conditions) 이 낙관적 제거가 서버 상태와 어긋난 채로 남지 않는다.
  //
  // **(field, value) 쌍으로 지운다.** category·brand 는 값당 칩 1개라(v0.32.14)
  // field 만 보면 카테고리 칩 하나를 눌렀는데 카테고리 전부가 사라진다.
  // 값이 하나뿐인 축(priceMax 등)은 서버가 value 를 무시하고 축 전체를 지우는데,
  // 그 축은 칩도 하나라 낙관적 제거 결과가 서버 결과와 같다.
  const removeCondition = useCallback(
    (field: ConditionField, value: string | number) => {
      setConditions(
        removeChip(useChatStore.getState().conditions, field, value),
      );
      send("", [{ op: "remove", field, value }]);
    },
    [send, setConditions],
  );

  // 제안 칩(완화·되돌리기) 적용 = 칩 label 을 다음 턴 message 로 보내는 왕복(계약 §suggestions).
  // label 이 사용자 발화 형태("6만원대까지 볼까요?")라 그대로 실으면 LLM 이 완화를 트리거한다.
  const applySuggestion = useCallback(
    (label: string) => {
      send(label);
    },
    [send],
  );

  // 새 대화 = 새 방. 세션(접속)은 유지하고 thread_id 만 새로 판다 — BE 와 합의된 동작.
  // 여기서 세션을 새로 발급하면 다른 탭의 세션을 축출해 멀티탭이 깨진다.
  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    const threadId = newThreadId(channel);
    // 저장소를 먼저 비운다 — saveChat 은 빈 대화를 무시하므로(다른 탭 덮어쓰기 방지)
    // reset() 만으로는 이전 대화가 저장소에 남아 새로고침 때 되살아난다.
    clearChat();
    // reset() 이 claimFailure 도 initial(null) 로 되돌린다 — 새 대화는 승계할
    // 이전 맥락 자체가 없으므로 배너가 남으면 안 된다.
    reset();
    useChatStore.getState().setThreadId(threadId); // reset 이 initial 을 뿌린 뒤에 다시 심는다
  }, [reset, channel]);

  return {
    send,
    confirm,
    retry,
    removeCondition,
    applySuggestion,
    startNewChat,
    isStreaming,
  };
}
