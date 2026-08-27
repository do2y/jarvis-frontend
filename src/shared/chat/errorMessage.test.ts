import { describe, expect, it } from "vitest";
import { resolveChatErrorMessage } from "./errorMessage";

describe("resolveChatErrorMessage", () => {
  it("친절한 한국어 문구는 그대로 보여준다", () => {
    expect(
      resolveChatErrorMessage("INTERNAL", "상품 서버 통신에 실패했습니다."),
    ).toBe("상품 서버 통신에 실패했습니다.");
  });

  it("빈 메시지는 코드별 기본 문구로 접는다", () => {
    expect(resolveChatErrorMessage("LLM_TIMEOUT", "")).toBe(
      "응답이 지연되고 있어요. 다시 시도해 주세요.",
    );
  });

  it("HTTP 원문 메시지는 사용자용 문구로 바꾼다", () => {
    expect(
      resolveChatErrorMessage("INTERNAL", "Request failed with status code 500"),
    ).toBe("일시적인 오류가 발생했어요. 다시 시도해 주세요.");
  });

  it("코드명만 온 경우도 사용자용 문구로 바꾼다", () => {
    expect(resolveChatErrorMessage("LLM_UNAVAILABLE", "LLM_UNAVAILABLE")).toBe(
      "지금은 채팅 응답을 사용할 수 없어요. 잠시 후 다시 시도해 주세요.",
    );
  });

  it("영문 예외 원문은 노출하지 않는다", () => {
    expect(
      resolveChatErrorMessage(
        "SEARCH_FAILED",
        "seller token missing brandId claim",
      ),
    ).toBe("상품을 찾는 중 문제가 발생했어요. 다시 시도해 주세요.");
  });
});

