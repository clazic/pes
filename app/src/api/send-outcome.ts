// SEL-117 리뷰 2 — 쓰기 요청을 보낸 뒤(fetch 가 던진) 실패를 표시한다. 오류 객체는 그대로 두고(identity 유지), 결과를 모른다는 것만 기록한다.
// 요청을 만들기 전의 실패(파일 읽기 · 해시 계산)는 표시되지 않는다 → 보내지 못함.
const afterSend = new WeakSet<object>();

export const markAfterSend = (e: unknown): void => {
  if (typeof e === "object" && e !== null) afterSend.add(e);
};

export const isAfterSend = (e: unknown): boolean => typeof e === "object" && e !== null && afterSend.has(e);
