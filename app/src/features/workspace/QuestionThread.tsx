import * as React from "react";
import { Send } from "lucide-react";
import type { CommandResult, CommentInput, CommentThreadView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { formatAt } from "@/lib/labels";
import { clearDraft, readLiveDraft, type DraftSetOptions } from "@/lib/draft";
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
  reason,
  pending = false,
  readOnly = false,
  onReload,
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
  /** unavailable 의 이유 — failed 면 서버에 이어져 있지만 읽다가 실패한 것(다시 읽기), 그 밖에는 읽는 길이 아직 없음 */
  reason?: "not_connected" | "failed";
  /** 의견을 읽는 중 — 읽는 동안은 비었다고도 읽지 못했다고도 하지 않고, 이어 쓸 스레드를 모르니 남기기도 막는다 */
  pending?: boolean;
  /** 지난 라운드 — 의견은 읽기만 한다 */
  readOnly?: boolean;
  onReload?: () => void;
  draft: [string, (v: string, o?: DraftSetOptions) => void];
  /** 초안 저장 키 — 성공한 뒤 이 키만 지운다 */
  draftKey: string;
  post: (input: CommentInput, key: string) => Promise<PostResult>;
  onPosted: (r: PostResult) => void;
}) {
  const cmd = useKeyedCommand(`thread:${draftKey}`);
  const [text] = draft;
  const empty = text.trim() === "";
  // 가장 최근 스레드에 이어 쓴다(없으면 새 스레드)
  const target = threads.at(-1);
  const boxId = `${qid}-comment`;
  const errId = `${qid}-comment-error`;

  const send = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (empty || cmd.pending || pending || readOnly) return;
    const input: CommentInput = { body_md: text.trim(), ...(target ? { thread_id: target.thread_id } : { question_version: version, ...(versionId ? { question_version_id: versionId } : {}) }) };
    // 같은 의견 = 같은 질문의 같은 글. 서명에 thread_id 를 넣지 않는다 — 첫 요청이 닿았는데 답을 못 받은 사이 의견 목록이 갱신되어 스레드가 보여도
    // 재시도는 같은 키·처음 내용(thread_id 없음)으로 가야 서버가 재생한다(내용이 다르면 409, 키가 다르면 두 번 접수)
    const r = await cmd.run(JSON.stringify({ qid, body_md: input.body_md }), (key, kept) => post((kept as CommentInput | undefined) ?? input, key), input);
    if (!r.ok) return;
    // 보내는 사이에 더 쓴 글은 지우지 않는다 — 보낸 그대로일 때만 비운다(한글 조합 중인 글도 비교에 넣는다)
    if (readLiveDraft(draftKey).trim() === input.body_md) clearDraft(draftKey);
    onPosted(r.value);
  };

  return (
    <div id={`${qid}-thread`} role="group" aria-label={`질문 ${number} 의견 스레드`} data-comments={qid} className="mt-3 rounded-lg border border-line bg-surface-soft p-3">
      <p className="text-caption text-muted-foreground">여기 남기는 의견은 답이 아니에요. 답으로 세지 않고, 필수를 채우지도 않아요.</p>
      <div className="mt-2.5">
        {pending ? (
          <p role="status" className="text-meta text-ink-2">
            의견을 불러오는 중이에요.
          </p>
        ) : unavailable && reason === "failed" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-meta text-ink-2">남긴 의견을 읽다가 잘못됐어요. 잠시 뒤 다시 읽어 보세요.</p>
            {onReload ? (
              <Button type="button" variant="outline" size="sm" className="bg-background coarse:min-h-[44px]" onClick={onReload}>
                의견 다시 읽기
              </Button>
            ) : null}
          </div>
        ) : unavailable ? (
          <p className="text-meta text-ink-2">이 연결에서는 남긴 의견을 읽어 오지 못했어요. 서버에 아직 이어지지 않았어요. 아래에서 남기는 의견은 서버에 접수돼요.</p>
        ) : threads.some((t) => t.messages.length) ? (
          <MessageList threads={threads} label={`질문 ${number} 의견`} />
        ) : (
          <p className="text-meta text-ink-2">아직 이 질문에 남긴 의견이 없어요.</p>
        )}
      </div>
      {readOnly ? (
        <p className="mt-3 text-meta text-ink-2">지난 라운드라 의견은 읽기만 해요.</p>
      ) : (
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
            <Button type="submit" variant="outline" size="sm" className="bg-background coarse:min-h-[44px]" aria-disabled={empty || cmd.pending || pending ? "true" : undefined}>
              <Send aria-hidden="true" />
              스레드에 남기기
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
