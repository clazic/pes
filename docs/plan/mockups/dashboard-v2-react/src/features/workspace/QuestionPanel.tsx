import * as React from "react";
import { Link } from "react-router";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "lucide-react";
import { useCommand } from "@/api/queries";
import type { QuestionView, WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CardHead, Hint, Tag } from "@/components/pes/bits";
import { Callout, EmptyState } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { InfoTip, MoreContent, MoreRoot, MoreTrigger } from "@/components/pes/disclosure";
import { Chip, Status, StatusFrom } from "@/components/pes/status";
import { clearDraft, draftKey, draftToAnswerText, readDraftNow, useDraft } from "@/lib/draft";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { usePhoneTools } from "./phone-tools";

function answerTextFor(q: QuestionView, key: string) {
  return draftToAnswerText(readDraftNow(key), q.options);
}

/** 질문 카드 머리: 번호 · 필수/선택 · 중요도 · (AI가 아닌 경우) 출처 · 다시 확인 + 질문 정보(ⓘ). 같은 뜻의 표시는 하나만(탭이 이미 “AI가 묻는 질문”). */
function QuestionTags({ q, extra }: { q: QuestionView; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-xs font-semibold text-muted-foreground">{q.number}</span>
      {q.required ? <Tag tone="acc">필수</Tag> : null}
      {q.importance === "높음" ? <Tag>중요도 높음</Tag> : null}
      {q.source === "human" ? <Tag>{q.source_label}</Tag> : null}
      {extra}
      <InfoTip label={`${q.number} 질문 정보`}>
        <p>{q.meta}</p>
        <p className="text-muted-foreground">
          {q.source_label} · {q.required ? "필수" : "선택"} · 중요도 {q.importance}
        </p>
      </InfoTip>
    </div>
  );
}

function QuestionCard({ q, slug, formVersion, readOnly }: { q: QuestionView; slug: string; formVersion: number; readOnly: boolean }) {
  const key = draftKey(slug, formVersion, q.id, q.version);
  const [draft, setDraft] = useDraft(key);
  const send = useCommand("submission.create", { successText: (r) => `보냄 · 접수 번호 ${r.receipt_no}${r.replayed ? " (같은 요청 — 다시 처리하지 않음)" : ""}` });
  const showTools = usePhoneTools();
  const titleId = `${q.id}-t`;
  const answer = draftToAnswerText(draft, q.options);
  const otherOpt = q.options.find((o) => o.label.startsWith("기타"));
  const blockedReason = !answer ? (q.options.length ? "선택지를 고르거나 허용된 경우 의견으로 답하면 보낼 수 있습니다." : "의견을 적으면 보낼 수 있습니다.") : null;
  const defaultLabel = q.default_option ? q.options.find((o) => o.id === q.default_option)?.label : null;
  const commentOnly = q.options.length === 0;

  if (q.sent) {
    return (
      <article id={q.id} aria-labelledby={titleId} className="rounded-xl border border-line bg-surface-soft p-3">
        <QuestionTags q={q} extra={<Status of="answer" value="sent" />} />
        <h3 id={titleId} className="mt-1.5 text-[15px]">
          {q.text}
        </h3>
        <p className="mt-1.5 text-[13px]">
          <strong>답:</strong> {q.sent.answer} <span className="text-muted-foreground">— {q.sent.by} {q.sent.at} 보냄 · 접수 번호 {q.sent.receipt_no}</span>
        </p>
        {!readOnly ? (
          <div className="mt-1.5 flex items-center gap-1">
            <Button variant="link">답 고쳐 보내기</Button>
            <InfoTip label="답 고쳐 보내기 설명">
              <p>고치면 새 답 버전이 생기고 옛 답은 남습니다.</p>
            </InfoTip>
          </div>
        ) : null}
      </article>
    );
  }

  const comment = (
    <>
      <Textarea id={`${q.id}-op`} rows={2} placeholder={commentOnly ? "답을 적어 주세요" : "이 질문에 대한 생각(답과 따로 남음)"} value={draft?.comment ?? ""} onChange={(e) => setDraft({ comment: e.target.value })} />
      {q.allow_comment_as_answer && !commentOnly ? (
        <div className="mt-2 flex items-start gap-2 text-[13px]">
          <Checkbox id={`${q.id}-asans`} checked={Boolean(draft?.commentAsAnswer)} onCheckedChange={(c) => setDraft({ commentAsAnswer: c === true })} className="mt-0.5" />
          <Label htmlFor={`${q.id}-asans`} className="block leading-snug font-normal">
            이 의견을 답으로 보내기
          </Label>
        </div>
      ) : !commentOnly ? (
        <Hint className="mt-1">의견만으로는 답이 되지 않습니다 — 선택지를 골라 주세요.</Hint>
      ) : null}
    </>
  );

  return (
    <article id={q.id} aria-labelledby={titleId} className={cn("rounded-xl border bg-surface p-3", q.recheck ? "border-warn-line" : "border-line")}>
      <div className="flex flex-wrap items-start justify-between gap-1.5">
        <QuestionTags q={q} extra={q.recheck ? <Status of="question" value="recheck" /> : null} />
        {!readOnly && showTools ? (
          <div className="flex gap-2.5">
            <Button variant="link">고치기</Button>
            <Button variant="link">빼기</Button>
          </div>
        ) : null}
      </div>
      <h3 id={titleId} className="mt-1.5 text-[15px]">
        {q.text}
      </h3>
      {q.help ? <p className="mt-1 text-[13px] text-ink-2">{q.help}</p> : null}
      {q.recheck ? (
        <div className="mt-2 rounded-lg border border-warn-line bg-warn-soft px-2.5 py-2 text-[12.5px]">
          <p>
            바뀐 곳: <del className="text-bad">{q.recheck.diff.removed}</del> → <ins className="font-semibold text-ok no-underline">{q.recheck.diff.added}</ins>, {q.recheck.diff.note}
          </p>
          <p className="mt-0.5">
            옛 답({q.recheck.old_answer})은 옮기지 않음 · <Link to="#">옛 답 보기</Link>
          </p>
        </div>
      ) : null}

      {readOnly ? (
        <Callout tone="off" className="mt-2">
          <Chip shape="hsquare" tone="off">
            읽기 전용
          </Chip>{" "}
          답은 편집자 이상이 보낼 수 있습니다.
        </Callout>
      ) : (
        <>
          {q.options.length ? (
            <fieldset className="mt-2">
              <legend className="mb-1 text-[13px] font-semibold">하나를 고르세요</legend>
              <RadioGroup value={draft?.option ?? ""} onValueChange={(v) => setDraft({ option: v, usedDefault: false })} className="gap-1.5" aria-label={`${q.number} 선택지`}>
                {q.options.map((o) => {
                  const id = `${q.id}-${o.id}`;
                  return (
                    <label key={o.id} htmlFor={id} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-[7px] text-[13.5px] coarse:min-h-12 coarse:items-center", draft?.option === o.id ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
                      <RadioGroupItem value={o.id} id={id} className="mt-0.5" />
                      <span>
                        {o.label}
                        {o.id === q.default_option ? <span className="ml-1.5 text-xs text-muted-foreground">기본값</span> : null}
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
              {otherOpt && draft?.option === otherOpt.id ? (
                <div className="mt-1.5">
                  <Label htmlFor={`${q.id}-other`} className="text-[13px] font-medium">
                    직접 쓰기
                  </Label>
                  <Input id={`${q.id}-other`} className="mt-1" value={draft?.other ?? ""} onChange={(e) => setDraft({ other: e.target.value })} />
                </div>
              ) : null}
            </fieldset>
          ) : null}
          {defaultLabel ? (
            <Button size="sm" className="mt-2" aria-describedby={`${q.id}-defh`} onClick={() => setDraft({ option: q.default_option, usedDefault: true })}>
              기본값으로 고르기
              <span id={`${q.id}-defh`} className="sr-only">
                기본값: {defaultLabel} — 고르기 전에는 답이 아닙니다
              </span>
            </Button>
          ) : null}
          {commentOnly ? (
            <div className="mt-2.5">
              <Label htmlFor={`${q.id}-op`} className="mb-1 block text-[13px] font-semibold">
                답(의견)
              </Label>
              {comment}
            </div>
          ) : (
            <MoreRoot className="mt-2" defaultOpen={Boolean(draft?.comment || draft?.commentAsAnswer)}>
              <MoreTrigger label="의견 남기기" name={`${q.number} 의견 남기기`} className="-ml-1" />
              <MoreContent className="mt-1">
                <Label htmlFor={`${q.id}-op`} className="sr-only">
                  {q.number} 질문별 의견
                </Label>
                {comment}
              </MoreContent>
            </MoreRoot>
          )}
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
            <span role="status">
              {send.phase === "confirming" ? (
                <Status of="submission" value="pending" />
              ) : send.phase === "unknown" ? (
                <Status of="generic" value="result_unknown" />
              ) : send.phase === "error" ? (
                <Status of="submission" value={send.error?.code === "version_conflict" ? "conflict" : "failed"} />
              ) : draft ? (
                <Status of="answer" value="draft" />
              ) : (
                <Status of="answer" value="none" />
              )}
            </span>
            {send.phase === "unknown" ? (
              <Button size="sm" onClick={send.recheck}>
                같은 요청 번호로 확인
              </Button>
            ) : (
              <ActionButton
                size="sm"
                blockedBy={send.pending ? "보내는 중입니다" : blockedReason}
                onClick={() =>
                  send.run(
                    { slug, form_version: formVersion, answers: [{ question_id: q.id, text: answer ?? "" }] },
                    { onSuccess: () => clearDraft(key) },
                  )
                }
              >
                이 질문만 보내기
              </ActionButton>
            )}
          </div>
          {send.error && send.phase !== "unknown" ? <p className="mt-1.5 text-xs font-medium text-bad">{send.error.message}</p> : null}
          {send.phase === "unknown" ? <p className="mt-1.5 text-xs text-ink-2">{send.error?.message}</p> : null}
        </>
      )}
    </article>
  );
}

function ReviewDialog({ ws, open, onOpenChange }: { ws: WorkspaceView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const send = useCommand("submission.create", { successText: (r) => `보냄 · 접수 번호 ${r.receipt_no}` });
  const open_q = ws.form.questions.filter((q) => !q.sent);
  const rows = open_q.map((q) => {
    const key = draftKey(ws.slug, ws.form.version, q.id, q.version);
    return { q, key, text: answerTextFor(q, key) };
  });
  const missingRequired = rows.filter((r) => r.q.required && !r.text);
  const toSend = rows.filter((r) => r.text);
  const busy = send.phase === "sending" || send.phase === "confirming";
  React.useEffect(() => {
    if (open) send.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>답 검토 후 보내기 · {ws.form.round_label} · 폼 v{ws.form.version}</DialogTitle>
          <DialogDescription>한 번에 보냅니다. 당시 폼 v{ws.form.version} 기준으로 필수·조건부·의견 응답을 확인하고, 하나라도 맞지 않으면 아무것도 접수하지 않습니다.</DialogDescription>
        </DialogHeader>
        {send.phase === "done" && send.receipt ? (
          <Callout tone="ok" role="status">
            <Chip shape="circle" tone="ok">
              보냄 · {send.receipt.committed_at}
            </Chip>{" "}
            접수 번호 {send.receipt.receipt_no}. 다음: 소유자가 “계속”을 누르면 AI가 이어서 합니다.
          </Callout>
        ) : (
          <>
            <ul className="divide-y divide-line text-[13.5px]">
              {rows.map((r) => (
                <li key={r.q.id} className="py-2">
                  <span className="block text-[12.5px] font-medium text-muted-foreground">
                    {r.q.number} · {r.q.required ? "필수" : "선택"}
                    {r.q.recheck ? " · 질문 변경 — 답 재확인" : ""}
                  </span>
                  {r.text ?? <span className="text-muted-foreground">(답 없음 — 보내지 않음)</span>}
                </li>
              ))}
            </ul>
            {missingRequired.length ? (
              <Callout tone="warn">
                <strong>필수 질문 {missingRequired.length}개에 답이 없습니다.</strong> {missingRequired.map((r) => r.q.number).join(", ")}에 답하면 보낼 수 있습니다.
              </Callout>
            ) : (
              <Callout tone="ok">
                <strong>필수 질문 모두 답함.</strong> 폼이 그사이 바뀌었으면 아무것도 접수하지 않습니다.
              </Callout>
            )}
          </>
        )}
        {send.phase === "confirming" ? (
          <p role="status" className="text-[13px]">
            <Status of="submission" value="pending" /> 응답이 늦습니다. 같은 요청 번호로 확인 중이라 다시 눌러도 두 번 보내지 않습니다.
          </p>
        ) : null}
        {send.phase === "unknown" ? (
          <Callout tone="warn" role="status">
            <Status of="generic" value="result_unknown" /> {send.error?.message}{" "}
            <Button size="sm" className="mt-2" onClick={send.recheck}>
              같은 요청 번호로 확인
            </Button>
          </Callout>
        ) : null}
        {send.phase === "error" && send.error ? (
          <Callout tone="bad" role="alert">
            <Status of="submission" value={send.error.code === "version_conflict" ? "conflict" : "failed"} /> {send.error.message}
          </Callout>
        ) : null}
        <DialogFooter>
          {send.phase === "done" ? (
            <Button variant="default" onClick={() => onOpenChange(false)}>
              닫기
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => onOpenChange(false)}>
                취소
              </Button>
              <ActionButton
                variant="default"
                blockedBy={busy ? "보내는 중입니다" : missingRequired.length ? `필수 질문 ${missingRequired.length}개에 답이 없습니다.` : toSend.length === 0 ? "보낼 답이 없습니다." : null}
                onClick={() =>
                  send.run(
                    { slug: ws.slug, form_version: ws.form.version, answers: toSend.map((r) => ({ question_id: r.q.id, text: r.text ?? "" })) },
                    { onSuccess: () => toSend.forEach((r) => clearDraft(r.key)) },
                  )
                }
              >
                {toSend.length ? `${toSend.length}개 보내기` : "보낼 답 없음"}
              </ActionButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddQuestionDialog({ ws, open, onOpenChange }: { ws: WorkspaceView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = React.useState("");
  const add = useCommand("question.create");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>질문 더하기 — 새 폼 v{ws.form.version + 1}을 만듭니다</DialogTitle>
          <DialogDescription>사람이 더한 질문은 “사람이 더함”으로 보입니다. 질문 방향(누가 누구에게 묻는가)은 U2에서 정합니다(설계 G8).</DialogDescription>
        </DialogHeader>
        <Label htmlFor="addq" className="text-[13px] font-semibold">
          질문 문구
        </Label>
        <Textarea id="addq" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>취소</Button>
          <ActionButton variant="default" blockedBy={!text.trim() ? "질문 문구를 적어 주세요." : null} onClick={() => add.run({ slug: ws.slug, text }, { onSuccess: () => { setText(""); onOpenChange(false); } })}>
            질문 더하기
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function QuestionPanel({ ws }: { ws: WorkspaceView }) {
  const settings = useMockSettings();
  const readOnly = settings.role === "reader";
  const owner = settings.role === "owner";
  const [review, setReview] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const showTools = usePhoneTools();
  const approveBlocked = !owner ? "단계 승인은 소유자만 할 수 있습니다." : ws.approval.reasons.length ? ws.approval.reasons.join(" · ") : null;

  return (
    <Card className="gap-0 px-5">
      <CardHead
        eyebrow={`질문·답 · 폼 v${ws.form.version}`}
        title={ws.form.total ? `답할 질문 ${ws.form.answerable} / 전체 ${ws.form.total}` : "열린 질문 없음"}
        titleId="q-title"
        right={ws.form.required_left ? <Tag tone="acc">필수 {ws.form.required_left} 남음</Tag> : null}
      />
      <Tabs defaultValue="ai" className="gap-2.5">
        <TabsList variant="line" aria-label="질문 묶음">
          <TabsTrigger value="ai">AI가 묻는 질문 {ws.form.total}</TabsTrigger>
          <TabsTrigger value="ask">AI에게 묻는 질문 {ws.form.asks_count}</TabsTrigger>
        </TabsList>
        <TabsContent value="ai" className="space-y-2.5">
          {ws.form.questions.length === 0 ? (
            <EmptyState
              title="지금 답할 질문이 없습니다"
              body={ws.now.kind === "blocked" ? "실행이 멈춰 새 질문이 없습니다. 첨언·자료 올리기는 지금도 됩니다." : "AI가 결과를 내면 여기에 질문이 옵니다."}
              action={<Button asChild><Link to="#ai">AI 작업 보기</Link></Button>}
            />
          ) : (
            ws.form.questions.map((q) => <QuestionCard key={`${q.id}-${q.version}`} q={q} slug={ws.slug} formVersion={ws.form.version} readOnly={readOnly} />)
          )}
          {!readOnly && showTools && ws.form.questions.length ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setAdding(true)}>
                <PlusIcon aria-hidden="true" />
                질문 더하기
              </Button>
              <Button size="sm" aria-label="선택한 질문 위로">
                <ArrowUpIcon aria-hidden="true" />
                위로
              </Button>
              <Button size="sm" aria-label="선택한 질문 아래로">
                <ArrowDownIcon aria-hidden="true" />
                아래로
              </Button>
              <InfoTip label="질문 더하기·빼기·순서 설명">
                <p>더하기·빼기·순서는 새 폼(v{ws.form.version + 1})을 만듭니다. 빼기는 지우기가 아니라 보류·합치기·철회입니다.</p>
              </InfoTip>
            </div>
          ) : null}
          {!readOnly && ws.form.answerable > 0 ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-primary-line bg-primary-soft p-3">
              <Button variant="default" onClick={() => setReview(true)}>
                답 검토 후 보내기
              </Button>
              <span className="text-[12.5px] text-ink-2">초안은 이 탭에만 있습니다</span>
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="ask">
          {ws.asks.length ? (
            ws.asks.map((a) => (
              <div key={a.number} className="rounded-xl border border-line p-3 text-[13px]">
                <p>
                  <strong>
                    {a.number} · {a.who}
                  </strong>{" "}
                  {a.text}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1" aria-label="처리 단계">
                  {a.steps.map((s) => (
                    <StatusFrom key={s.label} s={s} />
                  ))}
                  <InfoTip label="처리 단계 설명">
                    <p>받음은 읽음이 아닙니다. 답이 오기 전까지 “AI 답변 중” 표시를 하지 않습니다.</p>
                  </InfoTip>
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="AI에게 묻는 질문이 없습니다" body="결과 글에서 문장을 고르고 ‘AI에게 묻기’를 누르면 여기에 보입니다." />
          )}
        </TabsContent>
      </Tabs>

      {/* 단계 승인: 단추 + 못 누르는 이유 한 줄. “소유자만”은 그 권한이 없는 사람에게만 보인다(14절) */}
      <div className="mt-3.5 rounded-xl border border-line bg-surface-soft p-3" aria-labelledby="ap-t">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="ap-t" className="flex flex-wrap items-center gap-1.5 text-sm">
            {ws.approval.stage_label} 단계 승인 {!owner ? <Tag>소유자만</Tag> : null}
          </h3>
          <ActionButton size="sm" blockedBy={approveBlocked} reasonId="ap-why">
            승인 검토하기
          </ActionButton>
        </div>
        {approveBlocked ? (
          <p id="ap-why" className="mt-1.5 flex flex-wrap items-center gap-1 text-[12.5px] text-ink-2">
            <span>{owner ? `아직: ${approveBlocked}` : approveBlocked}</span>
            <InfoTip label="단계 승인 설명">
              <p>{ws.approval.note}</p>
            </InfoTip>
          </p>
        ) : null}
      </div>
      <ReviewDialog ws={ws} open={review} onOpenChange={setReview} />
      <AddQuestionDialog ws={ws} open={adding} onOpenChange={setAdding} />
    </Card>
  );
}
