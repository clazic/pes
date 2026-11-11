import * as React from "react";

/**
 * 같은 탭 초안(설계 12.5-6) — sessionStorage. 키에 프로젝트·판·단계·라운드·폼 버전·질문·질문 버전이 들어가
 * 질문이 새 버전이 되면 옛 초안이 옮겨 가지 않는다: 키가 바뀌면 새 키의 저장값을 다시 읽고, 옛 키에는 쓰지 않는다.
 * 서버에 보내지 않는다. 저장소를 못 쓰면 이 화면 안에서만 기억한다.
 */
const PREFIX = "pes-draft:";

function read(storageKey: string): string {
  try {
    return window.sessionStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

export function useDraft(key: string): [string, (v: string) => void] {
  const storageKey = `${PREFIX}${key}`;
  const [state, setState] = React.useState(() => ({ key: storageKey, value: read(storageKey) }));
  // 키가 바뀌면 그 그림에서 바로 새 키의 값을 쓴다(옛 키 글이 한 번도 보이지 않게)
  const current = state.key === storageKey ? state : { key: storageKey, value: read(storageKey) };
  if (current !== state) setState(current);
  const set = React.useCallback(
    (v: string) => {
      setState({ key: storageKey, value: v });
      try {
        if (v) window.sessionStorage.setItem(storageKey, v);
        else window.sessionStorage.removeItem(storageKey);
      } catch {
        /* 저장소를 못 쓰는 환경 — 화면 안에서만 */
      }
    },
    [storageKey],
  );
  return [current.value, set];
}
