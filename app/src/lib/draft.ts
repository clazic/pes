import * as React from "react";

/**
 * 같은 탭 초안(설계 12.5-6) — sessionStorage. 키에 프로젝트·판·단계·라운드·폼 버전·질문·질문 버전이 들어가
 * 질문이 새 버전이 되면 옛 초안이 옮겨 가지 않는다. 서버에 보내지 않는다. 저장소를 못 쓰면 이 화면 안에서만 기억한다.
 */
export function useDraft(key: string): [string, (v: string) => void] {
  const storageKey = `pes-draft:${key}`;
  const [value, setValue] = React.useState(() => {
    try {
      return window.sessionStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  });
  const set = React.useCallback(
    (v: string) => {
      setValue(v);
      try {
        if (v) window.sessionStorage.setItem(storageKey, v);
        else window.sessionStorage.removeItem(storageKey);
      } catch {
        /* 저장소를 못 쓰는 환경 — 화면 안에서만 */
      }
    },
    [storageKey],
  );
  return [value, set];
}
