import * as React from "react";
import { useLocation } from "react-router";
import { useSidebar } from "@/components/ui/sidebar";
import { aiSheet, researchUi, useResearchUi } from "@/lib/research-ui";

/**
 * 집중 모드(설계 16.5)와 앱 셸을 맞춘다 — 앱에 하나, 사이드바 안쪽에 둔다.
 * - 집중 모드를 켜면 왼쪽 칸을 아이콘 줄로 접고, 끄면 켜기 전 상태로 되돌린다.
 * - 연구 공간(/p/…)을 떠나면(모든 프로젝트로) 집중 모드를 끝내고 AI 동료 판을 닫는다.
 * 연구 공간 틀 안에 두지 않는 까닭: 틀이 사라진 뒤에도(관리 공간으로 나감) 왼쪽 칸을 되돌려야 하고,
 * 개발 모드(StrictMode)의 정리 함수 두 번 부르기에 영향받지 않게.
 */
export function FocusModeSync() {
  const ui = useResearchUi();
  const { pathname } = useLocation();
  const { open, setOpen } = useSidebar();
  const before = React.useRef<boolean | null>(null);

  React.useEffect(() => {
    if (pathname.startsWith("/p/")) return;
    if (researchUi.get().focus) researchUi.set({ focus: false });
    if (aiSheet.get().open) aiSheet.set({ open: false });
  }, [pathname]);

  React.useEffect(() => {
    if (ui.focus) {
      if (before.current === null) before.current = open;
      if (open) setOpen(false);
    } else if (before.current !== null) {
      const was = before.current;
      before.current = null;
      if (was) setOpen(true);
    }
    // 켜고 끄는 순간에만 — 사람이 집중 모드 안에서 칸을 다시 펴는 것은 막지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.focus]);
  return null;
}
