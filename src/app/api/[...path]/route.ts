import type { NextRequest } from "next/server";

import { resolveMock } from "@/mocks/handlers";

/**
 * /api/* 백엔드 프록시 — **로컬 개발 전용 경로**.
 *
 * 배포에서는 이 핸들러가 쓰이지 않는다. nginx(층2 LB, 03 D-분산4)가 `/api/`를
 * spring:8080으로 직접 프록시하므로 요청이 Next까지 오지 않는다.
 * 로컬에는 nginx가 없어 이 핸들러가 그 역할을 대신한다.
 *
 * dev에서 Set-Cookie를 재작성하는 이유: 백엔드 RT 쿠키는 `Secure; SameSite=Strict`로
 * 내려오는데 로컬은 http라 브라우저가 Secure 쿠키를 저장하지 않는다. 그러면
 * /api/auth/refresh가 항상 401(AUTH_REQUIRED) → 인터셉터가 /login으로 튕겨
 * 로그인 자체가 불가능해진다. (원본 vite.config.ts의 proxyRes 훅과 동일 목적)
 *
 * rewrites()를 쓰지 않는 이유: Route Handler는 파일시스템 라우트라 rewrites보다 먼저
 * 매칭되어 둘을 환경별로 나눠 쓸 수 없고, rewrites로는 응답 헤더(Set-Cookie) 조작도 못 한다.
 */

// 프록시 응답은 절대 캐시되면 안 된다.
export const dynamic = "force-dynamic";

// 서버에서 백엔드로 나갈 주소. 브라우저용 NEXT_PUBLIC_*과 분리한다 —
// 컨테이너 안에서는 백엔드가 다른 호스트일 수 있다(5단계에서 네트워크 구성 확인).
const TARGET =
  process.env.API_PROXY_TARGET ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:8080";

const isDev = process.env.NODE_ENV === "development";

/**
 * 목 모드 — 백엔드 없이 화면을 띄운다(`MOCK_API=1 npm run dev`).
 *
 * 이 자리에 둔 이유: 브라우저에서 나가는 모든 /api 호출이 이미 이 프록시 한 곳을 지난다.
 * 그래서 컴포넌트·훅·shared/api 를 하나도 건드리지 않고 목을 끼울 수 있다.
 *
 * NODE_ENV 로 막지 않는다 — 프로덕션 빌드로 시연할 때도 목이 필요하다.
 * 스위치는 MOCK_API 값 하나뿐이니, 실서버에 붙이려면 그 값을 비운다.
 */
const useMock = process.env.MOCK_API === "1";

// 홉 단위 헤더 — 프록시가 그대로 전달하면 안 된다(RFC 7230).
// content-length는 스트림 전달 시 실제 길이와 어긋날 수 있어 fetch가 다시 계산하게 둔다.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/**
 * 응답에서 추가로 제거해야 하는 헤더.
 *
 * `content-encoding`: fetch는 upstream 응답을 **자동으로 압축 해제**해서 body에 담는다.
 * 그런데 이 헤더를 그대로 넘기면 브라우저는 "gzip이다"라고 믿고 평문을 압축 해제하려다
 * `ERR_CONTENT_DECODING_FAILED`로 실패한다.
 * (curl은 Accept-Encoding을 기본으로 보내지 않아 백엔드가 압축하지 않으므로 재현되지 않는다 —
 *  브라우저에서만 드러난 버그였다.)
 *
 * `content-length`도 압축 해제로 길이가 달라지므로 HOP_BY_HOP에서 이미 제거된다.
 */
const RESPONSE_STRIP = new Set(["content-encoding"]);

function filterHeaders(source: Headers, isResponse = false): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (isResponse && RESPONSE_STRIP.has(k)) return;
    out.set(key, value);
  });
  return out;
}

/**
 * dev 한정 쿠키 완화 — Secure 제거, SameSite=Lax.
 * 프록시 덕에 브라우저 기준 same-origin이라 이 완화는 로컬에서만 유효하고 안전하다.
 */
function relaxCookieForDev(cookie: string): string {
  return cookie
    .replace(/;\s*Secure/gi, "")
    .replace(/;\s*SameSite=\w+/gi, "; SameSite=Lax");
}

async function handler(req: NextRequest): Promise<Response> {
  // /api/... 경로를 그대로 백엔드에 넘긴다(쿼리스트링 포함).
  const url = new URL(req.url);

  // 목이 처리하는 경로면 백엔드로 가지 않는다.
  // 처리하지 않는 경로는 null 이라 아래 실제 프록시로 그대로 떨어진다.
  if (useMock) {
    const mocked = resolveMock(req.method, url.pathname, url.searchParams);
    if (mocked) {
      return Response.json(mocked.body, { status: mocked.status });
    }
  }

  const upstreamUrl = `${TARGET}${url.pathname}${url.search}`;

  // GET/HEAD는 body가 없다. 그 외는 요청 스트림을 그대로 흘려보낸다 —
  // 스트림을 넘길 때 Node fetch는 duplex: 'half'가 필수다(없으면 런타임 에러).
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers: filterHeaders(req.headers),
    body: hasBody ? req.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
    redirect: "manual",
    // 백엔드 응답을 캐시하지 않는다.
    cache: "no-store",
  } as RequestInit & { duplex?: "half" });

  const headers = filterHeaders(upstream.headers, true);

  // Set-Cookie는 한 응답에 여러 개가 올 수 있다(AT 갱신 + RT 재발급 동시).
  // headers.get()은 콤마로 합쳐버려 쿠키 값이 깨지므로 getSetCookie()로 개별 처리한다.
  headers.delete("set-cookie");
  const cookies = upstream.headers.getSetCookie();
  for (const cookie of cookies) {
    headers.append("set-cookie", isDev ? relaxCookieForDev(cookie) : cookie);
  }

  // body를 버퍼링하지 않고 그대로 흘린다(스트리밍 응답 대비).
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
