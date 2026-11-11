import * as React from "react";
import { useLocation, useNavigationType } from "react-router";

/**
 * 화면에 도착했을 때의 초점(설계 12.6 · 17절) — 주소가 상태다.
 *  - 처음 불러올 때: 주소의 focus 가 가리키는 요소가 있으면 그것, 없으면 초점을 옮기지 않는다(첫 Tab = 건너뛰기 링크).
 *  - 뒤로·앞으로(POP)·다른 화면(경로)으로 옮길 때: focus 요소가 있으면 그것, 없고 경로가 바뀌었으면 새 화면 제목([data-screen-title]).
 *  - 같은 화면에서 검색어만 바뀔 때(view · peek · print · focus 따라가기): 초점을 건드리지 않는다.
 * 기록은 루트 레이아웃 하나에 둔다 — 화면 부품이 바뀌어도(찾을 수 없음 ↔ 작업 공간) 앞 경로를 안다.
 */
export class ArrivalLog {
  private initialKey: string | null = null;
  private lastPath: string | null = null;
  private doneKey: string | null = null;

  /** 이 기록 칸(key)에 처음 도착했으면 판단 재료를 돌려주고, 이미 처리했으면 null */
  arrive(key: string, pathname: string): { initial: boolean; pathChanged: boolean } | null {
    if (this.doneKey === key) return null;
    this.initialKey ??= key;
    this.doneKey = key;
    const pathChanged = this.lastPath !== null && this.lastPath !== pathname;
    this.lastPath = pathname;
    return { initial: key === this.initialKey, pathChanged };
  }
}

export const ArrivalContext = React.createContext<ArrivalLog | null>(null);

export function useArrivalRoot() {
  const [log] = React.useState(() => new ArrivalLog());
  return log;
}

/** 화면이 그릴 준비가 되면(ready) 한 번 — 초점 자리를 정한다 */
export function useArrival(ready: boolean) {
  const state = React.useContext(ArrivalContext);
  const { key, pathname, search } = useLocation();
  const navType = useNavigationType();
  React.useEffect(() => {
    if (!state || !ready) return;
    const at = state.arrive(key, pathname);
    if (!at) return;
    const { initial, pathChanged } = at;
    if (!initial && navType !== "POP" && !pathChanged) return;

    const id = new URLSearchParams(search).get("focus");
    const target = id ? document.getElementById(id) : null;
    if (target) {
      target.focus();
      if (document.activeElement === target) return;
    }
    if (initial || !pathChanged) return;
    // 스크롤은 ScrollRestoration 이 맡는다(앞으로 = 맨 위, 뒤로 = 그 자리)
    const toTitle = () => document.querySelector<HTMLElement>("main [data-screen-title]")?.focus({ preventScroll: true });
    // 휴대폰 사이드바 판(모달)에서 링크를 눌렀으면 판이 닫히며 초점을 돌려준 다음에 옮긴다(판 안 초점 가두기와 다투지 않게)
    if (!document.querySelector('[data-slot="sheet-content"]')) return void toTitle();
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      if (!document.querySelector('[data-slot="sheet-content"]') || tries > 20) {
        window.clearInterval(t);
        toTitle();
      }
    }, 50);
    return () => window.clearInterval(t);
  }, [state, ready, key, pathname, search, navType]);
}
