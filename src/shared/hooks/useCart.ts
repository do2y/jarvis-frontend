"use client";

import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addCartItem, fetchCart } from "@/shared/api/cart";
import { ApiError } from "@/shared/api/client";

// 장바구니 — 서버 원본. 수량·구성이 자주 바뀌어 staleTime 0 (CLAUDE.md 규칙).
// 헤더 뱃지와 장바구니 페이지가 같은 ['cart'] 키를 공유하므로,
// 담기·수량변경·삭제 후 invalidateQueries(['cart'])로 함께 갱신된다.
export function useCart() {
  return useQuery({
    queryKey: ["cart"], // 캐시 이름표
    queryFn: fetchCart, // 서버 요청 함수
    staleTime: 0,
    // 받아온 데이터를 몇 초 동안 신선하다고 볼 것인가 - 화면에 들어올 때마다 새로받기
  });
}

// 헤더 뱃지용 총 수량. 구매 불가(품절·판매종료) 항목도 장바구니에 담겨 있으므로
// 개수에는 포함한다(합계 금액에서만 서버가 제외).
export function useCartItemCount(): number {
  const { data } = useCart();
  return data?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
}

// 재고 부족 — 서버가 합산 후 수량과 재고를 비교해 반환(02 D33). 프론트 수량 제한을
// 통과해도(이미 담긴 양 + 이번 요청 > 재고) 발생하므로 API 응답으로 최종 판정한다.
export function isStockInsufficientError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "CART_STOCK_INSUFFICIENT";
}

function toAddCartMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "CART_OPTION_REQUIRED") return "옵션을 선택해주세요.";
    if (error.code === "CART_OPTION_INVALID")
      return "선택한 옵션을 찾을 수 없어요.";
    if (error.code === "PRODUCT_NOT_FOUND") return "상품을 찾을 수 없어요.";
    // 남은 재고는 detail.availableStock으로 함께 온다(C-2, 2026-07-22) — 수치를 안내에 쓴다.
    // 0이면 "0개만 담을 수 있어요"가 되어버리므로 품절로 안내한다.
    if (error.code === "CART_STOCK_INSUFFICIENT") {
      const stock = error.availableStock;
      if (stock === undefined) return "재고가 부족해요.";
      return stock > 0 ? `재고가 ${stock}개 남았어요.` : "품절된 상품이에요.";
    }
    // 검증 실패는 필드 사유("수량은 99 이하여야 합니다.")가 더 구체적이라 우선
    if (error.displayMessage) return error.displayMessage;
  }
  return "장바구니에 담지 못했어요. 잠시 후 다시 시도해주세요.";
}

// 담기 — 상품 상세·챗봇 카드·찜 목록이 함께 쓰므로 shared에 둔다.
// 자동 재시도 금지(중복 담기 방지, CLAUDE.md). 성공 시 ['cart'] 무효화로 헤더 뱃지 동기화.
export function useAddCartItem() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: addCartItem,
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cart"] });
      toast.success("장바구니에 담았어요.");
    },
    onError: (error) => {
      // 옵션 미선택은 카드가 선택 칩을 띄워 안내하므로 토스트를 내지 않는다 —
      // 사용자가 골라야 하는 UI 라 사라지는 알림으로 대신할 수 없다.
      if (error instanceof ApiError && error.code === "CART_OPTION_REQUIRED") {
        return;
      }
      // 재고 부족은 상세 페이지가 다이얼로그로 따로 알린다(중복 알림 방지).
      if (isStockInsufficientError(error)) return;
      toast.error(toAddCartMessage(error));
    },
  });

  return {
    ...mutation,
    errorMessage: mutation.error ? toAddCartMessage(mutation.error) : null,
    // 재고 부족은 인라인이 아니라 다이얼로그로 알린다(상세 페이지에서 분기).
    isStockError: isStockInsufficientError(mutation.error),
    /**
     * 옵션 미선택으로 막혔을 때 서버가 함께 준 선택지(C-2 detail.options).
     * 명세는 "FE 는 이걸로 바로 옵션 선택을 띄우라"고 한다 — 옵션 UI 가 없는
     * 화면(챗봇 카드 등)에서 문구만 보여주면 사용자가 고를 방법이 없다.
     */
    optionChoices:
      mutation.error instanceof ApiError &&
      mutation.error.code === "CART_OPTION_REQUIRED"
        ? mutation.error.options
        : undefined,
  };
}
