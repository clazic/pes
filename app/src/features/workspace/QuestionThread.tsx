import * as React from "react";
import { Send } from "lucide-react";
import type { CommandResult, CommentInput, CommentThreadView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatAt } from "@/lib/labels";
import { clearDraft, type DraftSetOptions } from "@/lib/draft";
import { DraftTextarea } from "./draft-textarea";
import { useKeyedCommand } from "./question-command";

type PostResult = CommandResult<{ thread_id: string; message_id: string; thread_created: boolean }>;

/** 메시지 목록 — 글은 글자 그대로(마크다운 안의 HTML 을 그리지 않는다). 누가 썼는지 글로 밝힌다 */
export function MessageList({ threads, label }: { threads: CommentThreadView[]; label: string }) {
  const messages = threads.flatMap((t) => t.messages);
  return (
    <ol aria-label={label} className="space-y-2">
      {messages.map((m) => (
        <li key={m.message_id} data-message={m.message_id} className="rounded-md bg-surface-sunk px-3 py-2">
          <p className="text-caption text-muted-foreground">
            <span className="font-medium text-ink-2">{m.by === "ai" ? "AI" : "나"}</span> · <time dateTime={m.at}>{formatAt(m.at)}</time>
            {m.receipt_no ? ` · 접수 ${m.receipt_no}` : ""}
          </p>
          <p data-field-kind="comment" className="mt-0.5 text-body whitespace-pre-wrap text-ink">
            {m.body_md}
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * 질문별 의견 스레드(U2c · F04) — 답이 아니다. 답 칸 · 기본값 · 추천 · 답에 붙이는 의견 칸과 다른 노드 · 다른 말이고, 남겨도 답이 만들어지지 않는다.
 * 쓴 글은 초안(칸 이름 comment)으로 남아 접기/펴기 · 다시 읽기 · 폼 버전 상승에도 유지된다. 성공(영수증)을 받은 뒤에만 지운다.
 * 의견을 읽는 길이 없으면(unavailable) 빈 스레드로 단정하지 않고 읽지 못했다고 알린다 — 쓰기는 따로 시도할 수 있다.
 */
export function QuestionThread({
  qid,
  number,
  version,
  versionId,
  threads,
  unavailable,
  draft,
  draftKey,
  post,
  onPosted,
}: {
  qid: string;
  number: number;
  version: number;
  versionId?: string;
  threads: CommentThreadView[];
  unavailable: boolean;
  draft: [string, (v: string, o?: DraftSetOptions) => void];
  /** 초안 저장 키 — 성공한 뒤 이 키만 지운다 */
  draftKey: string;
  post: (input: CommentInput, key: string) => Promise<PostResult>;
  onPosted: (r: PostResult) => void;
}) {
  const cmd = useKeyedCommand();
  const [text] = draft;
  const empty = text.trim() === "";
  // 가장 최근 스레드에 이어 쓴다(없으면 새 스레드)
  const target = threads.at(-1);
  const boxId = `${qid}-comment`;
  const errId = `${qid}-comment-error`;

  const send = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (empty || cmd.pending) return;
    const input: CommentInput = { body_md: text.trim(), ...(target ? { thread_id: target.thread_id } : { question_version: version, ...(versionId ? { question_version_id: versionId } : {}) }) };
    const r = await cmd.run(JSON.stringify(input), (key) => post(input, key));
    if (!r.ok) return;
    clearDraft(draftKey);
    onPosted(r.value);
  };

  return (
    <div id={`${qid}-thread`} role="group" aria-label={`질문 ${number} 의견 스레드`} data-comments={qid} className="mt-3 rounded-lg border border-line bg-surface-soft p-3">
      <p className="text-caption text-muted-foreground">여기 남기는 의견은 답이 아니에요. 답으로 세지 않고, 필수를 채우지도 않아요.</p>
      <div className="mt-2.5">
        {unavailable ? (
          <p className="text-meta text-ink-2">이 연결에서는 남긴 의견을 읽어 오지 못했어요. 서버에 아직 이어지지 않았어요. 아래에서 남기는 의견은 서버에 접수돼요.</p>
        ) : threads.some((t) => t.messages.length) ? (
          <MessageList threads={threads} label={`질문 ${number} 의견`} />
        ) : (
          <p className="text-meta text-ink-2">아직 이 질문에 남긴 의견이 없어요.</p>
        )}
      </div>
      <form onSubmit={send} className="mt-3" aria-describedby={cmd.error ? errId : undefined}>
        <label htmlFor={boxId} className="block text-meta font-medium text-ink">
          질문 {number} 스레드 의견 쓰기
        </label>
        <DraftTextarea id={boxId} rows={2} draft={draft} className="bg-background" />
        {cmd.error ? (
          <p id={errId} role="alert" className="mt-2 rounded-md border border-bad-line bg-bad-soft px-3 py-2 text-meta text-bad">
            {cmd.error}
          </p>
        ) : null}
        <div className="mt-2">
          <Button type="submit" variant="outline" size="sm" className="bg-background coarse:min-h-[44px]" aria-disabled={empty || cmd.pending ? "true" : undefined}>
            <Send aria-hidden="true" />
            스레드에 남기기
          </Button>
        </div>
      </form>
    </div>
  );
}
