import "server-only";

/**
 * 로컬 목 데이터 — 백엔드 없이 화면을 띄우기 위한 픽스처.
 *
 * 존재 이유: 백엔드가 내려간 상태에서도 모바일 화면 캡처·UI 작업이 되어야 한다.
 * `MOCK_API=1` 일 때만 프록시(app/api/[...path]/route.ts)가 이 데이터를 쓴다.
 *
 * 타입 계약은 실제 응답과 1:1 로 맞춘다 — 여기서 필드를 임의로 만들면
 * 화면이 목에서만 동작하고 실제 백엔드에서 깨진다.
 * - 인기/추천: features/home/types.ts (`PopularProduct` · `RecommendationResult`)
 * - 상세: features/product/types.ts (`ProductDetail`)
 * - 장바구니: shared/types/cart.ts (`Cart`)
 *
 * **id 는 전부 문자열이다**(2026-08-06 공통 규약). number 로 두면 64비트 값의
 * 끝자리가 조용히 바뀐다.
 */

/**
 * 인라인 SVG 상품 이미지.
 *
 * 외부 이미지 호스트를 쓰지 않는 이유: 목의 목적이 "백엔드·네트워크 없이 화면이 뜨는 것"이라
 * 외부 URL 을 넣으면 오프라인에서 또 깨진다. ProductImage 의 실패 대체 화면이 뜨면
 * 캡처용으로 쓸 수 없다.
 */
function productImage(label: string, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/>
<text x="300" y="318" font-family="Pretendard, sans-serif" font-size="44" font-weight="700"
 fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text>
</svg>`;
  // encodeURIComponent 로 감싼다 — base64 는 한글에서 btoa 가 터진다.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface MockProduct {
  productId: string;
  name: string;
  brandId: string;
  brandName: string;
  categoryId: string;
  categoryName: string;
  imageUrl: string;
  price: number;
  originalPrice: number;
  rating: number;
  reviewCount: number;
  summary: string;
  reason: string;
}

/** 목 상품 원본 — 목록·상세·장바구니가 전부 여기서 파생된다(값이 어긋나지 않게). */
export const MOCK_PRODUCTS: MockProduct[] = [
  {
    productId: "9001",
    name: "에어플로우 러닝화",
    brandId: "101",
    brandName: "스트라이드",
    categoryId: "1",
    categoryName: "신발",
    imageUrl: productImage("러닝화", "#2a63b8", "#6f9fe0"),
    price: 89000,
    originalPrice: 129000,
    rating: 4.6,
    reviewCount: 1284,
    summary: "가벼운 메시 갑피와 반발 쿠션으로 장거리에도 부담이 적은 러닝화",
    reason: "가벼운 러닝화를 찾으신 조건에 맞춰 무게 240g 이하 모델을 골랐어요",
  },
  {
    productId: "9002",
    name: "데일리 코튼 후드",
    brandId: "102",
    brandName: "베이직랩",
    categoryId: "2",
    categoryName: "상의",
    imageUrl: productImage("후드", "#1d6b45", "#5fbc8f"),
    price: 39900,
    originalPrice: 59000,
    rating: 4.4,
    reviewCount: 872,
    summary: "기모 없이도 도톰한 20수 코튼, 사계절 입기 좋은 기본 후드",
    reason: "무난하게 매치하기 좋은 기본 아이템으로 함께 담았어요",
  },
  {
    productId: "9003",
    name: "웜다운 경량 패딩",
    brandId: "103",
    brandName: "노스레이어",
    categoryId: "3",
    categoryName: "아우터",
    imageUrl: productImage("패딩", "#8c3b2e", "#d98a72"),
    price: 149000,
    originalPrice: 249000,
    rating: 4.8,
    reviewCount: 2431,
    summary: "덕다운 충전재로 가볍고 따뜻한 경량 패딩. 휴대용 파우치 포함",
    reason: "리뷰 2천 건 이상에서 보온성 평가가 특히 높았어요",
  },
  {
    productId: "9004",
    name: "미니멀 크로스백",
    brandId: "104",
    brandName: "포켓폼",
    categoryId: "4",
    categoryName: "가방",
    imageUrl: productImage("크로스백", "#5b4b8a", "#9c8bc7"),
    price: 54000,
    originalPrice: 78000,
    rating: 4.3,
    reviewCount: 415,
    summary: "휴대폰과 지갑만 담는 최소 사이즈. 스트랩 길이 조절 가능",
    reason: "가볍게 들고 다니기 좋은 소형 가방을 함께 추천했어요",
  },
  {
    productId: "9005",
    name: "논슬립 요가 매트",
    brandId: "105",
    brandName: "코어핏",
    categoryId: "5",
    categoryName: "운동용품",
    imageUrl: productImage("요가매트", "#b5761a", "#e8b463"),
    price: 32000,
    originalPrice: 45000,
    rating: 4.5,
    reviewCount: 668,
    summary: "6mm 두께 TPE 소재. 땀에 젖어도 미끄러지지 않는 표면 처리",
    reason: "홈트레이닝 용도로 많이 함께 구매되는 상품이에요",
  },
  {
    productId: "9006",
    name: "스테인리스 보온병 500ml",
    brandId: "106",
    brandName: "킵워머",
    categoryId: "6",
    categoryName: "생활용품",
    imageUrl: productImage("보온병", "#2f6d75", "#7bb8bf"),
    price: 24900,
    originalPrice: 33000,
    rating: 4.7,
    reviewCount: 1902,
    summary: "12시간 보온·24시간 보냉. 원터치 뚜껑으로 한 손 개폐",
    reason: "운동할 때 함께 챙기기 좋은 물병으로 골랐어요",
  },
  {
    productId: "9007",
    name: "부드러운 워시드 데님",
    brandId: "102",
    brandName: "베이직랩",
    categoryId: "7",
    categoryName: "하의",
    imageUrl: productImage("데님", "#33507a", "#7d9ac4"),
    price: 59000,
    originalPrice: 89000,
    rating: 4.2,
    reviewCount: 537,
    summary: "신축성 있는 워시드 가공으로 첫 착용부터 편한 스트레이트 데님",
    reason: "후드와 함께 코디하기 좋은 하의로 추가했어요",
  },
  {
    productId: "9008",
    name: "노이즈 캔슬링 이어버드",
    brandId: "107",
    brandName: "사운드코어",
    categoryId: "8",
    categoryName: "디지털",
    imageUrl: productImage("이어버드", "#3c3c46", "#8a8a99"),
    price: 119000,
    originalPrice: 179000,
    rating: 4.6,
    reviewCount: 3208,
    summary: "주변음 모드 지원, 케이스 포함 최대 32시간 재생",
    reason: "러닝 중에 쓰기 좋은 방수 등급 IPX4 제품이에요",
  },
];

const byId = new Map(MOCK_PRODUCTS.map((p) => [p.productId, p]));

/** P-4 인기상품 카드 형태로 변환 (features/home/types.ts `PopularProduct`) */
function toPopularCard(p: MockProduct) {
  return {
    productId: p.productId,
    name: p.name,
    brandName: p.brandName,
    imageUrl: p.imageUrl,
    price: p.price,
    originalPrice: p.originalPrice,
    rating: p.rating,
    reviewCount: p.reviewCount,
  };
}

export function mockPopular(size = 12) {
  return { items: MOCK_PRODUCTS.slice(0, size).map(toPopularCard) };
}

/**
 * P-5 개인화 추천. 상관키 2종을 반드시 싣는다 —
 * 없으면 노출·클릭 이벤트(E-1)가 고아가 되어 서버 검증에서 버려진다.
 */
export function mockRecommended() {
  return {
    source: "PERSONALIZED",
    recommendationRequestId: "mock-req-0001",
    listId: "mock-list-0001",
    items: MOCK_PRODUCTS.slice(0, 6).map((p) => ({
      ...toPopularCard(p),
      reason: p.reason,
    })),
  };
}

export function mockCategories() {
  return {
    categories: [
      { id: "1", name: "신발", children: [{ id: "11", name: "러닝화" }] },
      { id: "2", name: "상의", children: [{ id: "21", name: "후드티" }] },
      { id: "3", name: "아우터", children: [{ id: "31", name: "패딩" }] },
      { id: "4", name: "가방", children: [{ id: "41", name: "크로스백" }] },
      { id: "5", name: "운동용품", children: [{ id: "51", name: "요가" }] },
      { id: "6", name: "생활용품", children: [{ id: "61", name: "보온병" }] },
      { id: "7", name: "하의", children: [{ id: "71", name: "데님" }] },
      { id: "8", name: "디지털", children: [{ id: "81", name: "이어폰" }] },
    ],
  };
}

/** P-2 상품 상세 (features/product/types.ts `ProductDetail`) */
export function mockProductDetail(id: string) {
  const p = byId.get(id) ?? MOCK_PRODUCTS[0];
  return {
    id: p.productId,
    name: p.name,
    imageUrl: p.imageUrl,
    detailImages: [
      productImage(`${p.name} 상세 1`, "#e9ecf0", "#c9ced5"),
      productImage(`${p.name} 상세 2`, "#dfe4ea", "#b8bfc8"),
    ],
    price: p.price,
    originalPrice: p.originalPrice,
    summary: p.summary,
    description: `${p.summary}\n\n브랜드 ${p.brandName}의 대표 상품입니다.`,
    attributes: {
      소재: "폴리에스터 62%, 나일론 38%",
      제조국: "베트남",
      사이즈: ["S", "M", "L", "XL"],
      세탁방법: "찬물 단독 세탁 권장",
    },
    options: [
      {
        optionId: `${p.productId}01`,
        name: "블랙 / M",
        extraPrice: 0,
        stockQuantity: 12,
        purchaseState: "AVAILABLE",
      },
      {
        optionId: `${p.productId}02`,
        name: "블랙 / L",
        extraPrice: 0,
        stockQuantity: 4,
        purchaseState: "AVAILABLE",
      },
      {
        optionId: `${p.productId}03`,
        name: "아이보리 / M",
        extraPrice: 3000,
        stockQuantity: 0,
        purchaseState: "SOLD_OUT",
      },
    ],
    brand: {
      id: p.brandId,
      name: p.brandName,
      logoUrl: productImage(p.brandName, "#14181d", "#454d57"),
    },
    category: { id: p.categoryId, name: p.categoryName },
    rating: { average: p.rating, count: p.reviewCount },
    status: "ON_SALE",
    stockQuantity: 16,
    purchaseState: "AVAILABLE",
  };
}

/** P-3 상품 후기. distribution 은 page=0 응답에만 실린다(명세). */
export function mockReviews(page = 0) {
  const content = [
    {
      reviewId: "r1",
      rating: 5,
      content: "생각보다 훨씬 가볍고 마감도 깔끔해요. 재구매 의사 있습니다.",
      authorNickname: "러너**",
      createdAt: "2026-08-18T12:00:00+09:00",
    },
    {
      reviewId: "r2",
      rating: 4,
      content: "사이즈가 살짝 크게 나온 편이라 한 치수 작게 주문했습니다.",
      authorNickname: "달리**",
      createdAt: "2026-08-14T09:30:00+09:00",
    },
    {
      reviewId: "r3",
      rating: 5,
      content: "배송도 빠르고 착용감이 편해서 매일 신고 있어요.",
      authorNickname: "산책**",
      createdAt: "2026-08-09T18:20:00+09:00",
    },
  ];
  return {
    content: page === 0 ? content : [],
    ...(page === 0
      ? { distribution: { "5": 812, "4": 331, "3": 92, "2": 31, "1": 18 } }
      : {}),
    page,
    size: 10,
    totalElements: content.length,
    totalPages: 1,
  };
}

/** C-1 장바구니. 합계는 서버 계산값이므로 목에서도 미리 계산해 내린다. */
export function mockCart() {
  const picks = [MOCK_PRODUCTS[0], MOCK_PRODUCTS[2]];
  const quantities = [1, 2];
  const items = picks.map((p, i) => ({
    cartItemId: `c${i + 1}`,
    productId: p.productId,
    name: p.name,
    brandId: p.brandId,
    brandName: p.brandName,
    imageUrl: p.imageUrl,
    optionId: `${p.productId}01`,
    optionName: "블랙 / M",
    quantity: quantities[i],
    price: p.price,
    originalPrice: p.originalPrice,
    purchaseState: "AVAILABLE",
    maxQuantity: 12,
  }));
  const totalSale = items.reduce((s, it) => s + it.price * it.quantity, 0);
  const totalOriginal = items.reduce(
    (s, it) => s + it.originalPrice * it.quantity,
    0,
  );
  return {
    items,
    totalOriginal,
    totalSale,
    discount: totalOriginal - totalSale,
  };
}

export function mockBrand(id: string) {
  const p = MOCK_PRODUCTS.find((x) => x.brandId === id) ?? MOCK_PRODUCTS[0];
  return {
    id: p.brandId,
    name: p.brandName,
    logoUrl: productImage(p.brandName, "#14181d", "#454d57"),
    description: `${p.brandName}은(는) 일상에서 편하게 쓰는 물건을 만듭니다.`,
    products: MOCK_PRODUCTS.filter((x) => x.brandId === id).map(toPopularCard),
  };
}
