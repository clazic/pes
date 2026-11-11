import * as React from "react";

/**
 * 휴대폰 판단 = 폭 900px 미만 그리고 굵은 포인터(손가락) — 설계 4.16 · F08.
 * 폭만으로 판단하지 않는다(데스크톱 200% 확대는 폭이 좁아도 마우스라 편집 도구가 켜져 있다).
 * 두 조건을 따로 묻는다(합친 미디어 질의 하나는 브라우저마다 해석이 갈릴 수 있다).
 */
const NARROW = "(max-width: 899.98px)";
const COARSE = "(pointer: coarse)";

function subscribe(onChange: () => void) {
  const lists = [window.matchMedia(NARROW), window.matchMedia(COARSE)];
  for (const m of lists) m.addEventListener("change", onChange);
  return () => {
    for (const m of lists) m.removeEventListener("change", onChange);
  };
}

const snapshot = () => window.matchMedia(NARROW).matches && window.matchMedia(COARSE).matches;

export function useIsPhone(): boolean {
  return React.useSyncExternalStore(subscribe, snapshot, () => false);
}

/** 2영역 폭(900~1279) — 보기 전환에서 “단계·라운드”를 빼는 데 쓴다(두 영역이 이미 함께 보임). 배치 자체는 CSS 가 정한다 */
const TWO_AREA = "(min-width: 900px) and (max-width: 1279.98px)";
export function useIsTwoArea(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(TWO_AREA);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(TWO_AREA).matches,
    () => false,
  );
}
