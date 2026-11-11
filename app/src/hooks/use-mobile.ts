import * as React from "react"

// PES 시안: 휴대폰·좁은 창 기준을 설계 3.8의 tab(900px)에 맞춤 — 그 아래는 사이드바가 Sheet로 열린다
const MOBILE_BREAKPOINT = 900
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onStoreChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onStoreChange)
  return () => mql.removeEventListener("change", onStoreChange)
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

function getServerSnapshot() {
  return false
}

export function useIsMobile() {
  // 폭은 React 밖의 값이므로 useSyncExternalStore로 읽는다(처음 값도 첫 그리기부터 맞다)
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
