import * as React from "react";
import { Button } from "@/components/ui/button";

/**
 * 휴대폰(좁은 폭 + 굵은 포인터)에서는 편집·첨언 작성 도구를 접어 둔다(설계 4.16).
 * 굵은 포인터는 터치 데스크톱에서도 나타나므로 기기 판별로 믿지 않는다 — 언제든 “모든 도구 보기”로 펼칠 수 있다(Codex F10).
 */
const QUERY = "(max-width: 899.98px) and (pointer: coarse)";
const KEY = "pes-show-all-tools";

let showAll = typeof sessionStorage !== "undefined" && sessionStorage.getItem(KEY) === "1";
const listeners = new Set<() => void>();

function usePhone() {
  const [phone, setPhone] = React.useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  React.useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

function useShowAll() {
  return React.useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => showAll,
    () => showAll,
  );
}

/** 편집 도구를 보여도 되는가 */
export function usePhoneTools() {
  const phone = usePhone();
  const all = useShowAll();
  return !phone || all;
}

export function PhoneToolsToggle() {
  const phone = usePhone();
  const all = useShowAll();
  if (!phone) return null;
  return (
    <Button
      size="sm"
      aria-pressed={all}
      onClick={() => {
        showAll = !showAll;
        try {
          sessionStorage.setItem(KEY, showAll ? "1" : "0");
        } catch {
          /* 무시 */
        }
        listeners.forEach((l) => l());
      }}
    >
      {all ? "편집 도구 접기" : "모든 도구 보기"}
      {all ? null : <span className="sr-only"> — 편집 도구, 데스크톱 권장</span>}
    </Button>
  );
}
