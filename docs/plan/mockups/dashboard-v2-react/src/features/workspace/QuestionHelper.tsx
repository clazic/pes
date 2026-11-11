import * as React from "react";
import { MessageCircleQuestionIcon, SendHorizontalIcon } from "lucide-react";
import type { QuestionView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Chip } from "@/components/pes/status";

/**
 * 질문마다 여는 AI 도우미 대화(설계 19절 · 사용자 2026-11-12 "모든 질문에 AI 도우미 채팅칸").
 * 대화는 그 질문에 묶인 일반 대화 스레드(threads context_kind=question_comment)다 — 답이 아니다(답은 위 선택지).
 * U5 규칙: "AI 답변 중" 움직이는 표시 없음, 접수 → 내 컴퓨터 받음 → 답 옴을 시각과 함께. 시안은 목 응답(네트워크 없음).
 */
type Msg = { id: string; who: "me" | "ai"; text: string; at: string; state?: "sent" | "received" | "answered" };

const QUICK = ["왜 이 질문을 하나요?", "선택지마다 무엇이 달라지나요?", "추천 이유가 뭔가요?"];

function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 목 답 — 실제로는 연결된 AI가 MCP로 받아 쓴다 */
function mockReply(q: QuestionView, ask: string) {
  if (ask.includes("왜")) return `${q.number}은 이 라운드의 범위를 정하려고 묻는 질문이에요. 답에 따라 다음 조사 항목과 필요한 자료 수가 달라집니다.`;
  if (ask.includes("선택지")) return q.options.length ? q.options.slice(0, 3).map((o, i) => `· ${o.label}: ${["범위가 넓어져 자료가 더 필요하고 일정이 늘어납니다.", "범위가 좁아져 빨리 끝나지만 빠지는 대상이 생깁니다.", "둘 사이 — 사례 지역에서만 넓혀 비교합니다."][i]}`).join("\n") : "이 질문은 선택지가 없어 의견으로 답합니다.";
  if (ask.includes("추천")) return q.default_option ? "기본값은 앞 단계 결정과 가장 덜 부딪히는 쪽이에요. 근거는 기획 R1의 범위 결정입니다." : "이 질문에는 추천을 두지 않았어요 — 판단이 갈리는 질문이라 직접 고르시는 게 맞습니다.";
  return "질문을 받았어요. 근거를 확인해 답을 남길게요.";
}

export function QuestionHelper({ q }: { q: QuestionView }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const inputId = `${q.id}-ai-in`;
  const panelId = `${q.id}-ai`;
  const timers = React.useRef<number[]>([]);
  React.useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const send = (ask: string) => {
    const body = ask.trim();
    if (!body) return;
    const id = `${Date.now()}`;
    setMsgs((m) => [...m, { id, who: "me", text: body, at: now(), state: "sent" }]);
    setText("");
    timers.current.push(
      window.setTimeout(() => setMsgs((m) => m.map((x) => (x.id === id ? { ...x, state: "received" } : x))), 700),
      window.setTimeout(() => {
        setMsgs((m) => [...m.map((x) => (x.id === id ? { ...x, state: "answered" as const } : x)), { id: `${id}-a`, who: "ai", text: mockReply(q, body), at: now() }]);
      }, 1600),
    );
  };

  return (
    <div className="mt-2">
      <Button type="button" variant="ghost" size="sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <MessageCircleQuestionIcon aria-hidden="true" className="text-mode-b" />
        {open ? "AI 도우미 닫기" : "AI 도우미에게 묻기"}
        {msgs.length && !open ? <span className="text-caption text-muted-foreground">· 대화 {msgs.filter((m) => m.who === "me").length}</span> : null}
      </Button>
      {open ? (
        <section id={panelId} aria-label={`${q.number} AI 도우미`} className="mt-1.5 rounded-xl border border-line bg-surface-soft p-2.5">
          {msgs.length === 0 ? (
            <p className="text-meta text-ink-2">이 질문에 대해 궁금한 것을 물어보세요. 답은 위 선택지로 보내고, 여기 대화는 답과 따로 남습니다.</p>
          ) : (
            <ol className="flex flex-col gap-2" aria-live="polite">
              {msgs.map((m) =>
                m.who === "me" ? (
                  <li key={m.id} className="flex flex-col items-end gap-1">
                    <span className="max-w-sm rounded-2xl bg-muted px-3 py-2 text-meta whitespace-pre-line">{m.text}</span>
                    <span className="flex flex-wrap justify-end gap-1">
                      <Chip shape="circle" tone="ok">
                        접수됨 {m.at}
                      </Chip>
                      {m.state === "received" || m.state === "answered" ? (
                        <Chip shape="circle" tone="ok">
                          내 컴퓨터 받음
                        </Chip>
                      ) : (
                        <Chip shape="dotring" tone="unk">
                          아직 안 받음
                        </Chip>
                      )}
                    </span>
                  </li>
                ) : (
                  <li key={m.id} className="text-meta whitespace-pre-line text-foreground">
                    <span className="mb-0.5 block text-caption text-muted-foreground">AI 도우미 · Claude Code · {m.at}</span>
                    {m.text}
                  </li>
                ),
              )}
            </ol>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {QUICK.map((qk) => (
              <Button key={qk} type="button" variant="outline" size="xs" onClick={() => send(qk)}>
                {qk}
              </Button>
            ))}
          </div>
          <form
            className="mt-2 flex items-end gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
            }}
          >
            <Textarea
              id={inputId}
              aria-label={`${q.number} AI 도우미에게 물을 말`}
              rows={1}
              placeholder="예: 포함하면 일정이 얼마나 늘어나요?"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
            <Button type="submit" size="icon-sm" aria-label="AI 도우미에게 보내기" disabled={!text.trim()}>
              <SendHorizontalIcon aria-hidden="true" />
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
