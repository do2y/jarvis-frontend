import "server-only";
import { cache } from "react";

import { resolveMock } from "@/mocks/handlers";

// 봉투 타입을 client.ts에서 가져오지 않고 여기에 다시 적는다.
// client.ts는 클라이언트 전용 모듈(axios 인스턴스·authStore·window 참조)이라
// 타입만 import해도 모듈 그래프가 이어져 'server-only'가 클라이언트 번들로 샌다.
// 구조는 백엔드 공통 응답 계약이라 양쪽이 같아야 한다 — 계약이 바뀌면 둘 다 고칠 것.
interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/**
 * 서버 컴포넌트 전용 데이터 조회.
 *
 * `shared/api/client.ts`(axios)를 서버에서 쓰지 않는 이유:
 *  - 요청 인터셉터가 authStore(메모리 AT)를 읽는다 — 서버엔 그 상태가 없다
 *  - 응답 인터셉터가 401에서 `window.location`으로 리다이렉트한다 — 서버엔 window가 없다
 *  - axios 인스턴스는 모듈 싱글턴이라 요청 간에 공유된다
 *
 * 그래서 여기서는 인증 없이 공개 API만 부른다(상품·브랜드·홈).
 * 인증이 필요한 화면은 지금처럼 클라이언트에서 조회한다(계획서 비목표).
 *
 * `server-only`: 이 모듈이 클라이언트 번들에 섞이면 빌드가 실패하도록 강제한다.
 */

// 서버에서 백엔드로 나가는 주소. 브라우저용(NEXT_PUBLIC_*)과 분리한다 —
// 컨테이너 안에서는 백엔드가 다른 호스트일 수 있다.
const BASE =
  process.env.API_PROXY_TARGET ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:8080";

/** 서버 조회 실패. 호출부가 status로 분기한다(404 → notFound 등). */
export class ServerFetchError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ServerFetchError";
    this.status = status;
    this.code = code;
  }
}

interface ServerFetchOptions {
  /** 초 단위 재검증 주기. 생략 시 캐시하지 않는다(요청마다 조회). */
  revalidate?: number;
}

/**
 * 응답 대기 상한(ms).
 *
 * 이게 없으면 백엔드에 닿지 못하는 환경에서 요청이 무한정 매달린다. 특히
 * **빌드 시점 프리렌더**가 그렇다 — CI 컨테이너 안에는 백엔드가 없으므로
 * 홈 정적 생성이 60초 타임아웃에 걸려 `next build` 자체가 실패한다(실제로 겪음).
 * 짧게 끊고 실패시키면 호출부의 catch가 받아 초기 데이터 없이 렌더된다.
 */
const TIMEOUT_MS = 5000;

/**
 * 응답 본문 로그의 깊이·길이 상한.
 *
 * 터미널 로그라 브라우저 콘솔처럼 접을 수가 없다. 상품 목록 응답 하나가
 * 수백 줄로 쏟아지면 정작 보려던 `[ssr ←]` 줄이 스크롤 밖으로 밀려난다.
 * 기본은 요약만 찍고, 전체가 필요할 때만 환경변수로 연다.
 */
const BODY_MAX_CHARS = 2000;

/**
 * 응답 본문 로그 스위치. `SSR_LOG_BODY=1`(요약) / `=full`(전체).
 *
 * 기본 off 인 이유: 홈 한 번 렌더에 SSR 조회가 여러 건 나가는데, 매번 본문을
 * 뱉으면 `[ssr ←]` 줄들이 본문 사이에 파묻혀 오히려 흐름을 못 읽는다.
 * 응답 내용을 봐야 할 때만 켜는 도구로 둔다.
 *
 * `NEXT_PUBLIC_` 접두사를 쓰지 않는다 — 서버 전용 모듈이라 브라우저로 나갈 일이
 * 없고, 접두사를 붙이면 클라이언트 번들에 값이 박힌다.
 */
/**
 * 목 모드 — 백엔드 없이 SSR 페이지를 렌더한다(`MOCK_API=1 npm run dev`).
 *
 * 프록시(app/api/[...path]/route.ts)에도 같은 스위치가 있지만 여기에 또 필요하다:
 * SSR 조회는 브라우저를 거치지 않고 이 모듈이 백엔드를 **직접** 부르므로
 * 프록시의 목이 걸리지 않는다. 이걸 빼면 홈·상품 상세가 SSR 에서 실패하고
 * (5초 타임아웃) 클라이언트 조회로만 채워져 초기 HTML 이 빈 채로 나간다.
 *
 * NODE_ENV 로 막지 않는 이유는 프록시 쪽 주석과 같다 — 프로덕션 빌드 시연 대응.
 */
const USE_MOCK = process.env.MOCK_API === "1";

const SSR_LOG_BODY_MODE = process.env.SSR_LOG_BODY ?? "";
const SSR_LOG_BODY = SSR_LOG_BODY_MODE !== "" && SSR_LOG_BODY_MODE !== "0";
const SSR_LOG_BODY_FULL = SSR_LOG_BODY_MODE === "full";

/**
 * 응답 본문을 터미널에 한 줄로 눌러 담는다.
 *
 * `console.log(obj)`를 그대로 쓰지 않는 이유: Node 는 기본 깊이 2 를 넘으면
 * `[Object]`·`[Array]` 로 접어버려 정작 확인하려는 중첩 필드가 안 보인다.
 * JSON 으로 직렬화해 그 접힘을 없애고, 대신 길이를 잘라 폭주를 막는다.
 */
function formatBody(body: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(body, null, 2) ?? String(body);
  } catch {
    // 순환 참조 등 — 본문 하나 때문에 SSR 이 죽으면 안 된다.
    return "[직렬화 실패]";
  }
  if (SSR_LOG_BODY_FULL || text.length <= BODY_MAX_CHARS) return text;
  return `${text.slice(0, BODY_MAX_CHARS)}\n… (${text.length - BODY_MAX_CHARS}자 생략, 전체는 SSR_LOG_BODY=full)`;
}

/**
 * 공개 API GET. 백엔드 공통 봉투({success, data, error})를 벗겨 data를 반환한다.
 * 봉투 규약은 client.ts의 응답 인터셉터와 동일하게 맞춘다.
 */
export async function serverGet<T>(
  path: string,
  options: ServerFetchOptions = {},
): Promise<T> {
  const { revalidate } = options;

  // 목이 처리하는 경로면 백엔드로 나가지 않는다.
  // 봉투를 벗기는 아래 로직을 그대로 태우기 위해 body 만 만들어 흐름에 얹는다.
  if (USE_MOCK) {
    const [pathname, query = ""] = path.split("?");
    const mocked = resolveMock("GET", pathname, new URLSearchParams(query));
    if (mocked) {
      if (process.env.NODE_ENV === "development") {
        console.log(`[ssr ⊙ mock] ${mocked.status} GET ${path}`);
      }
      const envelope = mocked.body as ApiEnvelope<T>;
      if (!envelope.success) {
        throw new ServerFetchError(
          envelope.error?.message ?? "요청을 처리하지 못했습니다.",
          mocked.status,
          envelope.error?.code,
        );
      }
      return envelope.data as T;
    }
  }

  // 개발 전용 로그. SSR 조회는 브라우저 네트워크 탭에 안 잡히므로(서버가 부른다)
  // dev 터미널에 남기지 않으면 실제로 나갔는지 확인할 방법이 없다.
  // revalidate 캐시에 맞으면 fetch 자체가 생략되어 "→"만 찍히고 "←"가 없을 수 있다.
  const debug = process.env.NODE_ENV === "development";
  const startedAt = debug ? performance.now() : 0;
  if (debug) console.log(`[ssr →] GET ${BASE}${path} (revalidate=${revalidate ?? "no-store"})`);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // revalidate가 없으면 매 요청 조회(재고·가격이 실시간이어야 하는 화면 대비).
      ...(revalidate === undefined
        ? { cache: "no-store" as const }
        : { next: { revalidate } }),
    });
  } catch (e) {
    if (debug) {
      const ms = Math.round(performance.now() - startedAt);
      console.warn(`[ssr ✕] GET ${path} (${ms}ms)`, (e as Error).message);
    }
    throw e;
  }

  // 봉투가 실려 오면 에러도 그 안에 있다 — code를 살려 호출부가 분기할 수 있게 한다.
  let body: ApiEnvelope<T> | undefined;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    body = undefined;
  }

  // 본문까지 파싱한 뒤에 찍는다 — 응답 줄과 본문이 갈라져 있으면 SSR 이 여러 건
  // 동시에 나갈 때 어느 본문이 어느 요청 것인지 터미널에서 짝지을 수 없다.
  if (debug) {
    const ms = Math.round(performance.now() - startedAt);
    // 4xx·5xx 를 성공과 같은 마커로 찍으면 훑을 때 놓친다. 실패는 ✕ 로 갈라
    // 아래 throw 되는 응답임을 줄 첫머리에서 알아보게 한다.
    const head = `[ssr ${res.ok ? "←" : "✕"}] ${res.status} GET ${path} (${ms}ms)`;
    // 본문은 기본 off — 켤 때만 찍는다. SSR 로그는 페이지마다 여러 건이 겹쳐
    // 항상 본문을 뱉으면 터미널이 본문으로만 채워진다.
    // 다만 에러 본문은 그 자체가 실패 원인이라 스위치와 무관하게 항상 남긴다.
    const withBody = SSR_LOG_BODY || !res.ok;
    const line = withBody ? `${head}\n${formatBody(body)}` : head;
    if (res.ok) console.log(line);
    else console.warn(line);
  }

  if (!res.ok) {
    const error: ApiErrorBody | undefined = body?.error;
    throw new ServerFetchError(
      error?.message ?? `request failed: ${res.status}`,
      res.status,
      error?.code,
    );
  }

  // success:false가 HTTP 200으로 오는 경우도 방어한다(client.ts와 동일 정책).
  if (body && typeof body === "object" && "success" in body) {
    if (!body.success) {
      throw new ServerFetchError(
        body.error?.message ?? "요청을 처리하지 못했습니다.",
        res.status,
        body.error?.code,
      );
    }
    return body.data as T;
  }

  return body as T;
}

/**
 * 요청 단위 중복 제거 래퍼.
 *
 * `generateMetadata`와 `page`가 같은 데이터를 각각 부르면 요청당 API가 2번 나간다.
 * React `cache()`는 같은 렌더 패스 안에서 동일 인자 호출을 1회로 합친다.
 * (네이티브 fetch의 자동 dedupe도 있지만, revalidate 옵션이 다르면 별개 항목이 되므로
 *  호출부가 같은 함수를 쓰도록 여기서 한 번 더 묶는다.)
 */
export function cachedGet<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return cache(fn);
}
