import * as React from "react";
import { useProjects } from "@/api/queries";
import { turnKey, turnLabel, type TurnKey } from "@/components/pes/turn";
import { turnBaseline, useMockSettings } from "@/lib/mock-settings";

/**
 * 차례 전환 알림(설계 15.4) — 화면 읽기 프로그램에 polite로 한 번.
 * - 앱에 하나만 둔다: 같은 프로젝트의 표시기가 목록·사이드바·작업 공간에 여러 개 있어도 겹쳐 읽지 않게.
 * - **나의 할 일이 생길 때(→ 나의 할 일)** 와 끝날 때(→ 끝남)만 알린다. AI 쪽으로 넘어가는 것은 사람이 누른 동작의 영수증이 이미 말하고,
 *   AI 진행처럼 잦은 변화는 알리지 않는다(설계 3.5 — 사람이 할 일이 생긴 사건만). 경과 시간이 바뀌는 것도 읽지 않는다.
 * - 처음 불러올 때 · 보는 사람(역할)을 바꿨을 때 · 목 자료를 처음으로 되돌렸을 때는 알리지 않고 기준만 새로 잡는다.
 */
export function TurnAnnouncer() {
  const q = useProjects();
  const { role } = useMockSettings();
  const prev = React.useRef<{ role: string; epoch: number; keys: Map<string, TurnKey> } | null>(null);
  const timer = React.useRef<number | undefined>(undefined);
  const [text, setText] = React.useState("");

  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  React.useEffect(() => {
    const d = q.data;
    if (!d) return;
    const keys = new Map<string, TurnKey>();
    for (const p of d.active) if (p.turn) keys.set(p.slug, turnKey(p.turn));
    const before = prev.current;
    prev.current = { role, epoch: turnBaseline.epoch, keys };
    if (!before || before.role !== role || before.epoch !== turnBaseline.epoch) return;
    const msgs = d.active
      .filter((p) => {
        if (!p.turn) return false;
        const was = before.keys.get(p.slug);
        const now = turnKey(p.turn);
        return was !== undefined && was !== now && (now === "you" || now === "done");
      })
      .map((p) => `${p.title}: ${turnLabel(p.turn!)}${p.turn!.text ? ` · ${p.turn!.text}` : ""}`);
    if (!msgs.length) return;
    // 같은 문장도 다시 읽게 한 번 비운 뒤 채운다(다음 갱신이 와도 이 알림을 지우지 않음)
    setText("");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(`차례가 바뀌었습니다 — ${msgs.join(" / ")}`), 80);
  }, [q.data, role]);

  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-turn-announcer="">
      {text}
    </p>
  );
}
