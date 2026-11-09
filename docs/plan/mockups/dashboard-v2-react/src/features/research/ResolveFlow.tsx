import * as React from "react";
import { Link } from "react-router";
import { useCommand, useUsage } from "@/api/queries";
import type { ProblemOption, ProblemView, WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { InfoTip, MoreContent, MoreRoot, MoreTrigger } from "@/components/pes/disclosure";
import { Chip, Status } from "@/components/pes/status";
import { SettleDialog } from "@/features/usage/SettleDialog";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";

/** 확인 안 된 호출 정리(사용량 화면과 같은 대화 상자) — 필요할 때만 사용량 읽기를 부른다 */
function SettleFromProblem({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const usage = useUsage();
  const call = usage.data?.unknown_calls[0];
  if (!call) return null;
  return <SettleDialog id={call.id} open={open} onOpenChange={onOpenChange} hint={call.evidence_hint} onDone={onDone} />;
}

/**
 * 해결 흐름(설계 16.4): 원인 한 줄 → 선택지 2~3개(추천 표시 — 미리 고르지 않음) → 한 번에 처리.
 * 한 번 누름 = 닫힌 명령 하나(problem.resolve, 또는 그 일의 원래 명령 — 답하기 · 동기화 고르기 · 호출 정리).
 * 성공은 영수증(접수 번호) 뒤에만, 느리면 “접수 확인 중”, 응답이 사라지면 “결과 미확인 → 같은 요청 번호로 확인”.
 * 막힌 것 보드 · 결과 글 문단 표시 · 지금 할 일 단계가 같은 부품을 쓴다.
 */
export function ResolveFlow({
  ws,
  p,
  headingAs: H = "h3",
  headingId,
  onResolved,
  showTitle = true,
}: {
  ws: WorkspaceView;
  p: ProblemView;
  headingAs?: "h2" | "h3";
  headingId?: string;
  /** 영수증을 받은 뒤(문제가 목록에서 빠지기 전) — 부르는 쪽이 초점을 다음으로 옮긴다 */
  onResolved?: (p: ProblemView, o: ProblemOption) => void;
  showTitle?: boolean;
}) {
  const { role } = useMockSettings();
  const uid = React.useId();
  const [choice, setChoice] = React.useState("");
  const [note, setNote] = React.useState("");
  const [settling, setSettling] = React.useState(false);
  const resolve = useCommand("problem.resolve", { successText: (r) => `정함 · 접수 번호 ${r.receipt_no}${r.replayed ? " (같은 요청 — 다시 처리하지 않음)" : ""}` });
  const sync = useCommand("sync.conflict.resolve", { successText: (r) => `정함 · 접수 번호 ${r.receipt_no}` });
  const send = useCommand("submission.create", { successText: (r) => `보냄 · 접수 번호 ${r.receipt_no}` });
  const revise = useCommand("question.revise", { successText: (r) => `보류함 · 접수 번호 ${r.receipt_no} — 새 폼 버전` });
  const opt = p.options.find((o) => o.id === choice);
  const cmd = opt?.via === "sync.conflict.resolve" ? sync : opt?.via === "submission.create" ? send : opt?.via === "question.revise" ? revise : resolve;
  const required = ws.form.questions.filter((q) => q.required && !q.sent && !q.deferred);

  const why =
    role === "reader"
      ? "고르기는 편집자 이상입니다(읽기 멤버는 볼 수만 있음)."
      : opt?.owner_only && role !== "owner"
        ? "이 선택은 소유자만 할 수 있습니다 — 누르면 서버가 다시 검사합니다."
        : opt?.needs === "note" && !note.trim()
          ? "요약을 적어 주세요."
          : cmd.pending
            ? "접수 확인 중입니다"
            : !opt
              ? "어떻게 할지 하나를 고르세요."
              : null;

  const done = () => opt && onResolved?.(p, opt);
  const run = () => {
    if (!opt) return;
    if (opt.via === "sync.conflict.resolve") {
      const row = ws.sync?.rows.find((r) => `ps-${r.id}` === p.id);
      if (row) sync.run({ slug: ws.slug, item: row.item, choice: opt.id as "pc" | "web" | "later", reason: note }, { onSuccess: done });
      return;
    }
    if (opt.via === "submission.create" && opt.id === "default") {
      const q = required[0];
      const label = q?.options.find((o) => o.id === q.default_option)?.label;
      if (q && label) send.run({ slug: ws.slug, form_version: ws.form.version, answers: [{ question_id: q.id, text: label }] }, { onSuccess: done });
      return;
    }
    if (opt.via === "question.revise") {
      revise.run({ slug: ws.slug, question_ids: required.map((q) => q.id), action: "defer" }, { onSuccess: done });
      return;
    }
    resolve.run({ slug: ws.slug, problem_id: p.id, option_id: opt.id, note: note.trim() || undefined }, { onSuccess: done });
  };

  const optionList = (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-meta font-semibold">어떻게 할까요?</legend>
      <RadioGroup value={choice} onValueChange={setChoice} aria-label={`${p.title} — 어떻게 할까요`} className="gap-1.5">
        {p.options.map((o) => {
          const id = `${uid}-${o.id}`;
          return (
            <label key={o.id} htmlFor={id} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-meta", choice === o.id ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
              <RadioGroupItem id={id} value={o.id} className="mt-0.5" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <strong className="font-semibold">{o.label}</strong>
                  {o.recommended ? <Tag tone="acc">추천</Tag> : null}
                  {o.owner_only && role !== "owner" ? <Tag>소유자만</Tag> : null}
                  {o.to_ai ? <Tag>AI에게 맡김</Tag> : null}
                </span>
                <span className="mt-0.5 block text-caption text-ink-2">{o.effect}</span>
                {o.recommended && o.why ? <span className="mt-0.5 block text-caption text-muted-foreground">추천 이유: {o.why}</span> : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );

  const action = opt ? (
    opt.go ? (
      <Button asChild variant="default" size="sm">
        <Link to={opt.go}>{opt.label}</Link>
      </Button>
    ) : opt.needs === "settle" ? (
      <ActionButton size="sm" variant="default" blockedBy={why} showReason={!cmd.pending} onClick={() => setSettling(true)}>
        {opt.label}
      </ActionButton>
    ) : (
      <ActionButton size="sm" variant="default" blockedBy={why} showReason={!cmd.pending} onClick={run}>
        {opt.label}
      </ActionButton>
    )
  ) : (
    <ActionButton size="sm" variant="default" blockedBy={why} showReason>
      처리하기
    </ActionButton>
  );

  return (
    <div className="min-w-0 space-y-2.5" data-problem={p.id}>
      {showTitle ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Status of="problem" value={p.kind} />
            {p.state !== "open" ? <Status of="problemState" value={p.state} /> : null}
            <InfoTip label={`${p.title} — 찾은 곳 · 막는 것`}>
              <p>찾은 곳: {p.found}</p>
              <p>막는 것: {p.blocks.length ? p.blocks.join(" · ") : "없음(진행은 됨)"}</p>
              <p className="text-muted-foreground">고르면 닫힌 명령 하나로 처리합니다 — 서버가 선택지·권한을 다시 검사합니다.</p>
            </InfoTip>
          </div>
          <H id={headingId} className={H === "h2" ? "text-title" : "text-body"}>
            {p.title}
          </H>
        </div>
      ) : null}
      <p className="text-body">
        <span className="mr-1 font-semibold text-ink">원인</span>
        {p.cause}
      </p>
      <p className="text-caption text-muted-foreground">
        관련: <Link to={p.where.href}>{p.where.label}</Link>
        {p.blocks.length ? ` · 막는 것: ${p.blocks.join(" · ")}` : ""}
      </p>
      {p.note ? (
        <Callout tone="off">
          <Status of="problemState" value={p.state} /> {p.note}
        </Callout>
      ) : null}

      {p.state === "open" ? (
        <>
          {optionList}
          {opt && opt.needs === "note" ? (
            <div>
              <Label htmlFor={`${uid}-note`} className="text-meta font-semibold">
                요약 <span className="font-medium text-ink-2">(필수)</span>
              </Label>
              <Textarea id={`${uid}-note`} rows={3} className="mt-1" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          ) : opt && !opt.go && opt.needs !== "settle" ? (
            <div>
              <Label htmlFor={`${uid}-note`} className="text-meta font-medium">
                메모 <span className="font-normal text-muted-foreground">(선택 — 해결 기록에 남음)</span>
              </Label>
              <Input id={`${uid}-note`} className="mt-1" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
            {action}
            <span role="status" className="text-caption text-ink-2">
              {cmd.phase === "confirming" ? (
                <>
                  <Chip shape="ring" tone="run">
                    접수 확인 중
                  </Chip>{" "}
                  같은 요청 번호로 확인 중
                </>
              ) : cmd.phase === "unknown" ? (
                <>
                  <Status of="generic" value="result_unknown" />{" "}
                  <Button size="sm" onClick={cmd.recheck}>
                    같은 요청 번호로 확인
                  </Button>
                </>
              ) : cmd.phase === "done" && cmd.receipt ? (
                <Chip shape="circle" tone="ok">
                  정함 · 접수 번호 {cmd.receipt.receipt_no}
                </Chip>
              ) : null}
            </span>
          </div>
          {cmd.error && cmd.phase === "error" ? <p className="text-xs font-medium text-bad">{cmd.error.message}</p> : null}
          {opt?.needs === "settle" ? <SettleFromProblem open={settling} onOpenChange={setSettling} onDone={() => done()} /> : null}
        </>
      ) : p.state === "ai" ? (
        <MoreRoot>
          <MoreTrigger label="다른 길로 다시 정하기" name={`${p.title} — 다른 길로 다시 정하기`} className="-ml-1" />
          <MoreContent className="mt-1.5 space-y-2.5">
            {optionList}
            <div className="flex flex-wrap items-center gap-2">{action}</div>
          </MoreContent>
        </MoreRoot>
      ) : null}
    </div>
  );
}
