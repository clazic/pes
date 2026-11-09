import * as React from "react";
import { Link } from "react-router";
import { FingerprintIcon, MailIcon, WifiOffIcon } from "lucide-react";
import { useCommand, useNotifications, useProjects, useUsage, useWorkspace } from "@/api/queries";
import type { QuestionView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Eyebrow, Hint, KV, SectionTitle, Tag } from "@/components/pes/bits";
import { Callout } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { FoldCard, More } from "@/components/pes/disclosure";
import { Chip, Status, StatusFrom } from "@/components/pes/status";
import { TurnIndicator, turnDef } from "@/components/pes/turn";
import { clearDraft, draftKey, draftToAnswerText, readDraftNow, useDraft } from "@/lib/draft";
import { cn } from "@/lib/utils";

function Frame({ n, title, children, id }: { n: number; title: string; children: React.ReactNode; id: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-t`} className="w-full max-w-[372px]">
      <h2 id={`${id}-t`} className="mb-2 ml-1 flex items-center text-sm">
        <span aria-hidden="true" className="mr-1.5 inline-flex size-[22px] items-center justify-center rounded-full bg-foreground text-xs text-background">
          {n}
        </span>
        {title}
      </h2>
      <div className="min-h-[640px] overflow-hidden rounded-[30px] border-8 border-ink dark:border-line-strong bg-background text-meta shadow-xl max-[420px]:min-h-0 max-[420px]:rounded-[18px] max-[420px]:border-4 [&_[data-slot=button]]:min-h-12 [&_[data-slot=button]]:text-meta">{children}</div>
    </section>
  );
}

function PBar({ title, sub, back }: { title: string; sub?: string; back?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line bg-surface px-3.5 py-2.5">
      {back ? (
        <Link to={back} className="text-meta font-medium" aria-label="뒤로 가기">
          뒤로
        </Link>
      ) : (
        <span aria-hidden="true" className="inline-flex h-6 w-[34px] items-center justify-center rounded-md bg-foreground text-caption tracking-[0.08em] text-background">
          PES
        </span>
      )}
      <span className="min-w-0 flex-1 text-meta leading-tight font-semibold">
        {title}
        {sub ? <small className="block text-caption font-medium text-muted-foreground">{sub}</small> : null}
      </span>
    </div>
  );
}

function QuestionScreen({ qs, slug, formVersion, idx, setIdx }: { qs: QuestionView[]; slug: string; formVersion: number; idx: number; setIdx: (i: number) => void }) {
  const q = qs[idx];
  const key = q ? draftKey(slug, formVersion, q.id, q.version) : "none";
  const [draft, setDraft] = useDraft(key);
  if (!q) return <p className="p-3 text-meta">답할 질문이 없습니다.</p>;
  return (
    <div className="space-y-2.5 p-3">
      <Progress value={((idx + 1) / qs.length) * 100} aria-label={`질문 ${qs.length}개 중 ${idx + 1}번째`} className="h-1.5" />
      <p className="flex flex-wrap gap-1">
        {q.required ? <Tag tone="acc">필수</Tag> : null}
        {q.importance === "높음" ? <Tag>중요도 높음</Tag> : null}
        {q.source === "human" ? <Tag>{q.source_label}</Tag> : null}
        {q.recheck ? <Status of="question" value="recheck" /> : null}
      </p>
      <h3 className="text-body">{q.text}</h3>
      {q.help ? <p className="text-meta">{q.help}</p> : null}
      {q.options.length ? (
        <RadioGroup value={draft?.option ?? ""} onValueChange={(v) => setDraft({ option: v, usedDefault: false })} aria-label={`${q.number} 선택지`} className="gap-1.5">
          {q.options.map((o) => (
            <label key={o.id} htmlFor={`m-${q.id}-${o.id}`} className={cn("flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg border px-3 text-meta", draft?.option === o.id ? "border-primary bg-primary-soft" : "border-line bg-surface")}>
              <RadioGroupItem id={`m-${q.id}-${o.id}`} value={o.id} className="size-5" />
              <span>
                {o.label}
                {draft?.option === o.id && draft.usedDefault ? <span className="text-caption text-muted-foreground"> · 기본값 채택함</span> : null}
              </span>
            </label>
          ))}
        </RadioGroup>
      ) : null}
      {q.default_option ? (
        <Button onClick={() => setDraft({ option: q.default_option, usedDefault: true })} className="w-full">
          기본값 채택
        </Button>
      ) : null}
      <Label htmlFor={`m-${q.id}-op`} className="text-meta font-semibold">
        질문별 의견 <span className="font-normal text-muted-foreground">(선택)</span>
      </Label>
      <Textarea id={`m-${q.id}-op`} rows={2} placeholder="생각을 남기세요" value={draft?.comment ?? ""} onChange={(e) => setDraft({ comment: e.target.value, commentAsAnswer: q.allow_comment_as_answer ? true : undefined })} />
      <p className="text-caption text-muted-foreground">{draft ? <Status of="answer" value="draft" /> : <Status of="answer" value="none" />} 초안은 이 탭에만</p>
      <div className="flex gap-2">
        <ActionButton className="flex-1" blockedBy={idx === 0 ? "첫 질문입니다." : null} onClick={() => setIdx(idx - 1)}>
          이전
        </ActionButton>
        {idx < qs.length - 1 ? (
          <Button variant="default" className="flex-1" onClick={() => setIdx(idx + 1)}>
            다음
          </Button>
        ) : (
          <Button asChild variant="default" className="flex-1">
            <a href="#m4">검토로</a>
          </Button>
        )}
      </div>
      <Hint>고치기·첨언은 데스크톱에서</Hint>
    </div>
  );
}

export function MobilePage() {
  const notes = useNotifications();
  const projects = useProjects();
  const ws = useWorkspace("dolbom-insight");
  const usage = useUsage();
  const [idx, setIdx] = React.useState(0);
  const send = useCommand("submission.create", { successText: (r) => `보냄 · 접수 번호 ${r.receipt_no}` });
  const approve = useCommand("stage.approve", { successText: (r) => `승인됨 · 접수 번호 ${r.receipt_no}` });
  const resume = useCommand("run.resume", { successText: (r) => `계속 접수됨 · ${r.receipt_no}` });
  const [sheet, setSheet] = React.useState(false);
  const [memo, setMemo] = React.useState("");

  const open = ws.data?.form.questions.filter((q) => !q.sent) ?? [];
  const rows = open.map((q) => {
    const k = draftKey("dolbom-insight", ws.data?.form.version ?? 0, q.id, q.version);
    return { q, k, text: draftToAnswerText(readDraftNow(k), q.options) };
  });
  const missing = rows.filter((r) => r.q.required && !r.text);
  const toSend = rows.filter((r) => r.text);
  const blocked = usage.data?.blocked;

  return (
    <>
      <SectionTitle as="h1" title="휴대폰에서 하는 일" sub="답 · 승인 · 계속 · 끄는 동작 — 고치는 일은 데스크톱으로" />
      <div className="mt-3.5 grid grid-cols-[repeat(auto-fill,minmax(min(100%,372px),1fr))] justify-items-center gap-x-[18px] gap-y-[22px]">
        <Frame n={1} title="알림" id="m1">
          <PBar title="알림" sub={`안 읽음 ${notes.data?.filter((n) => n.unread).length ?? 0}`} />
          <div className="space-y-2.5 p-3">
            {notes.data?.map((n) => (
              <Link key={n.id} to={n.href} className="flex items-start gap-2.5 rounded-xl border border-line bg-surface p-3 text-ink no-underline">
                <span aria-hidden="true" className="inline-flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-foreground text-caption font-semibold text-background">
                  PES
                </span>
                <span>
                  <strong className="block text-sm">{n.title}</strong>
                  <span className="text-xs text-muted-foreground">
                    {n.at} · {n.channel}
                  </span>
                </span>
              </Link>
            ))}
            <p className="text-caption text-muted-foreground">기본 알림에는 프로젝트 이름·질문 문구·파일 이름이 없습니다.</p>
          </div>
        </Frame>

        <Frame n={2} title={`${turnDef("you").label} — 모든 프로젝트`} id="m2">
          <PBar title={`${turnDef("you").label} ${projects.data?.turns.length ?? 0}`} sub="데스크톱과 같은 순서" />
          <div className="space-y-2.5 p-3">
            {projects.data?.turns.map((t) => (
              <Card key={t.id} className="gap-1.5 p-3">
                <p>
                  <StatusFrom s={t.status} />
                </p>
                <h3 className="text-meta">
                  {t.project_title} · {t.where}
                </h3>
                <p className="text-caption text-muted-foreground">{t.text}</p>
                {t.id === "t4" ? <p className="text-caption text-muted-foreground">고르기는 데스크톱 권장</p> : (
                  <Button asChild variant={t.action.primary ? "default" : "outline"}>
                    <Link to={t.id === "t2" ? "#m3" : t.id === "t1" ? "#m7" : t.action.href}>{t.action.label}</Link>
                  </Button>
                )}
              </Card>
            ))}
            {/* AI 작업 중 — 데스크톱과 같은 차례 표시기(소식이 있으면 점이 돈다) */}
            {projects.data?.active
              .filter((p) => p.turn?.side === "ai")
              .map((p) => (
                <div key={p.slug} className="rounded-xl border border-line bg-surface px-3 py-2.5">
                  <p className="mb-1 text-meta font-semibold">{p.title}</p>
                  {p.turn ? <TurnIndicator turn={p.turn} /> : null}
                </div>
              ))}
            {projects.data?.waiting.map((w) => (
              <p key={w.slug + w.text} className="text-caption text-ink-2">
                <Status of="turn" value="waiting" /> {w.project_title} — {w.text}
              </p>
            ))}
          </div>
        </Frame>

        <Frame n={3} title="질문 답하기 — 한 화면에 한 질문" id="m3">
          <PBar title={`조사 R2 · 질문 ${Math.min(idx + 1, open.length)} / ${open.length}`} sub="지역 돌봄 인력 수급(가상)" back="#m2" />
          {ws.data ? <QuestionScreen qs={open} slug="dolbom-insight" formVersion={ws.data.form.version} idx={Math.min(idx, Math.max(0, open.length - 1))} setIdx={setIdx} /> : null}
        </Frame>

        <Frame n={4} title="검토 후 보내기" id="m4">
          <PBar title="보내기 전 확인" sub="조사 R2" back="#m3" />
          <div className="space-y-2.5 p-3">
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.q.id} className="py-2.5 text-sm">
                  <span className="block text-caption font-medium text-muted-foreground">
                    {r.q.number} · {r.q.required ? "필수" : "선택"}
                  </span>
                  {r.text ?? <span className="text-muted-foreground">(답 없음)</span>}
                </li>
              ))}
            </ul>
            {missing.length ? <Callout tone="warn" className="text-caption"><strong>필수 {missing.length}개 답 없음</strong></Callout> : <Callout tone="ok" className="text-caption"><strong>필수 모두 답함</strong> · 폼이 바뀌었으면 아무것도 접수하지 않음</Callout>}
            {send.phase === "unknown" ? (
              <Button className="w-full" onClick={send.recheck}>같은 요청 번호로 확인</Button>
            ) : (
              <ActionButton variant="default" className="w-full" blockedBy={missing.length ? `필수 ${missing.length}개에 답이 없습니다.` : toSend.length === 0 ? "보낼 답이 없습니다." : send.pending ? "보내는 중" : null} onClick={() => ws.data && send.run({ slug: "dolbom-insight", form_version: ws.data.form.version, answers: toSend.map((r) => ({ question_id: r.q.id, text: r.text ?? "" })) }, { onSuccess: () => toSend.forEach((r) => clearDraft(r.k)) })}>
                {toSend.length ? `${toSend.length}개 보내기` : "보낼 답 없음"}
              </ActionButton>
            )}
            <div role="status">
              {send.phase === "confirming" ? <Card className="p-3"><p><Status of="submission" value="pending" /></p><p className="mt-1 text-caption">응답이 늦습니다. 같은 요청 번호로 확인 중이라 다시 눌러도 두 번 보내지 않습니다.</p></Card> : null}
              {send.phase === "done" ? <Card className="p-3"><p><Status of="submission" value="sent" label={`보냄 · ${send.receipt?.committed_at}`} /></p><p className="mt-1 text-caption">접수 번호 {send.receipt?.receipt_no}. 다음: 소유자가 “계속”을 누르면 AI가 이어서 합니다.</p></Card> : null}
              {send.phase === "unknown" ? <Card className="p-3"><p><Status of="generic" value="result_unknown" /></p><p className="mt-1 text-caption">{send.error?.message}</p></Card> : null}
              {send.phase === "error" ? <Card className="p-3"><p><Status of="submission" value={send.error?.code === "version_conflict" ? "conflict" : "failed"} /></p><p className="mt-1 text-caption">{send.error?.message}</p></Card> : null}
            </div>
            <p data-mock="note" className="text-caption text-muted-foreground">“시안” 단추 → 시안 조작에서 네트워크(느림·응답 유실·끊김)와 버전 충돌을 바꿔 볼 수 있습니다.</p>
          </div>
        </Frame>

        <Frame n={5} title="단계 승인 — 며칠 뒤" id="m5">
          <PBar title="조사 단계 승인" sub="지역 돌봄 인력 수급(가상) · 소유자만" back="#m2" />
          <div className="space-y-2.5 p-3">
            <Card className="p-3">
              <Eyebrow>승인할 고정본</Eyebrow>
              <KV items={[["범위", "조사 R3 고정된 결과 · 11-07 17:20"], ["담긴 것", "결과물 3 · 출처 22"], ["반영 내역", "적용 5 · 부분 1 · 유예 1"]]} />
            </Card>
            <Callout tone="warn" className="text-caption">
              <strong>함께 볼 것</strong> 열린 첨언 1개(승인을 막지 않음)
            </Callout>
            <Label htmlFor="apm" className="text-meta font-semibold">
              승인 메모 <span className="font-normal text-muted-foreground">(선택)</span>
            </Label>
            <Textarea id="apm" rows={2} placeholder="예: 방문간호는 사례 지역만" value={memo} onChange={(e) => setMemo(e.target.value)} />
            <Button variant="default" className="w-full" onClick={() => setSheet(true)}>
              본인 확인하고 승인
            </Button>
            <Button asChild className="w-full">
              <Link to="/p/dolbom-insight/e/1/s/research/r/2">전체 내용 보기 (인쇄 미리보기)</Link>
            </Button>
            <Hint>다시 열기는 데스크톱에서</Hint>
          </div>
        </Frame>

        <Frame n={6} title="재인증과 영수증" id="m6">
          <PBar title="조사 단계 승인" sub="지역 돌봄 인력 수급(가상)" />
          <div className="space-y-2.5 p-3">
            {approve.phase === "done" ? (
              <Card className="p-3"><p><Status of="generic" value="approved" label={`승인됨 · ${approve.receipt?.committed_at}`} /></p><p className="mt-1 text-caption">접수 번호 {approve.receipt?.receipt_no} · 고정본 R3 · 김연구. 분석·종합 단계가 열렸습니다.</p></Card>
            ) : (
              <Card className="p-3"><p><Status of="generic" value="approved" label="승인됨 · 11-07 17:31" /></p><p className="mt-1 text-caption">접수 번호 A-12 · 고정본 R3 · 김연구. (예시)</p></Card>
            )}
            <Card className="p-3"><p><Status of="generic" value="not_approved" /></p><p className="mt-1 text-caption">그사이 결과물이 바뀌었습니다(고정본 R3 → 새 버전). 바뀐 곳을 본 뒤 다시 승인해 주세요. 메모는 그대로입니다.</p></Card>
            <div className="-mx-3 -mb-3 rounded-t-[18px] border-t border-line-strong bg-surface px-3.5 shadow-lg py-4" role="group" aria-labelledby="su-t">
              <div aria-hidden="true" className="mx-auto -mt-1.5 mb-2.5 h-1 w-10 rounded bg-line-strong" />
              <h3 id="su-t" className="text-meta">승인하려면 본인 확인이 필요합니다</h3>
              <p className="mt-1.5 text-caption">이 확인은 <strong>이 승인 한 건</strong>에만 쓰입니다: 지역 돌봄 인력 수급 · 조사 단계 · 고정본 R3.</p>
              <Hint className="mt-2">5분 안에 끝내지 못하면 다시 확인합니다. 입력한 메모는 지워지지 않습니다.</Hint>
            </div>
          </div>
        </Frame>

        <Frame n={7} title="멈춘 실행 계속" id="m7">
          <PBar title="기획 R1 · 실행 R1-2" sub="청년 주거 지원 효과(가상) · 방식 A" back="#m2" />
          <div className="space-y-2.5 p-3">
            <p><Status of="run" value="blocked_usage" label="실행 멈춤 · 사용량 문턱" /></p>
            <p className="text-meta">5시간 91% · 문턱 90% · 재개 16:40(PES 추정)</p>
            <p className="text-caption font-medium text-muted-foreground">재개 준비 검사 · 통과 {blocked?.checks.filter((c) => c.pass).length ?? 0} / {blocked?.checks.length ?? 0}</p>
            <ul className="divide-y divide-line text-sm">
              {blocked?.checks.filter((c) => !c.pass).map((c) => (
                <li key={c.item} className="py-2">
                  <span className="block text-caption font-medium text-muted-foreground">{c.item}</span>
                  <Status of="check" value="notyet" /> <span className="text-caption">{c.detail}</span>
                </li>
              ))}
            </ul>
            <More label="통과한 검사 보기">
              <ul className="divide-y divide-line">
                {blocked?.checks.filter((c) => c.pass).map((c) => (
                  <li key={c.item} className="py-1.5">
                    <Status of="check" value="pass" /> {c.item} · {c.detail}
                  </li>
                ))}
              </ul>
            </More>
            <Callout tone={blocked?.checks.every((c) => c.pass) ? "ok" : "warn"} className="text-caption">
              {blocked?.checks.every((c) => c.pass) ? <><strong>재개 준비됨</strong> 저절로 다시 시작하지 않습니다. 누르면 서버가 한 번 더 확인합니다.</> : <><strong>아직 재개할 수 없습니다.</strong> 남은 검사를 통과하면 “재개 준비됨” 알림이 옵니다.</>}
            </Callout>
            <ActionButton variant="default" className="w-full" blockedBy={!blocked?.checks.every((c) => c.pass) ? "재개 준비 검사를 모두 통과해야 합니다." : null} onClick={() => resume.run({ slug: "youth-housing", run_id: "R1-2" })}>
              계속
            </ActionButton>
            <Hint>계속은 API 사용량을 씀 · 정리는 사용량 화면에서</Hint>
          </div>
        </Frame>

        <Frame n={8} title="끊김 · 읽기 전용 · 데스크톱 안내" id="m8">
          <p role="status" className="flex items-center gap-2 bg-foreground px-3 py-2 text-meta font-medium text-background">
            <WifiOffIcon className="size-4" aria-hidden="true" />
            연결 끊김 — 다시 연결 중. 입력은 이 탭에 남아 있습니다.
          </p>
          <PBar title="조사 R2 · 질문" sub="박검토로 보는 화면 · 편집자" />
          <div className="space-y-2.5 p-3">
            <Card className="p-3"><p><Status of="submission" value="failed" label="보내지 않음 · 보내기 전 끊김" /></p><p className="mt-1 text-caption">연결되면 같은 요청 번호로 다시 보냅니다.</p><Button className="mt-2 w-full">다시 보내기</Button></Card>
            <Card className="p-3"><p><Status of="generic" value="result_unknown" /></p><p className="mt-1 text-caption">보낸 뒤 응답을 못 받음 — 성공도 실패도 아님</p><Button className="mt-2 w-full">같은 요청 번호로 확인</Button></Card>
            <Card className="p-3"><p><Chip shape="hsquare" tone="off">읽기 전용</Chip></p><p className="mt-1 text-caption">답은 편집자 이상이 보낼 수 있습니다.</p><p className="text-xs text-muted-foreground">읽기 멤버에게만 보이는 안내(견본)</p></Card>
            <Card className="p-3">
              <p className="font-semibold">휴대폰: 답 · 승인 · 계속 · 끄기</p>
              <p className="text-caption text-muted-foreground">고치기 · 다시 켜기 · 설정은 데스크톱</p>
              <More className="mt-1" label="나눔 자세히">
                <p className="font-semibold text-ink">휴대폰에서 하는 일</p>
                <ul className="mt-1 ml-4.5 list-disc"><li>답·의견·의견으로 답하기, 검토 후 보내기</li><li>단계 승인(재인증), 멈춘 실행 계속(소유자)</li><li>끄는 동작(본인 확인 포함): AI가 읽기 막기, AI 참조 끄기, 동기화 일시 중지</li><li>오류 확인, 인쇄 미리보기, 프롬프트 복사 대안</li></ul>
                <p className="mt-2 font-semibold text-ink">데스크톱으로 안내</p>
                <ul className="mt-1 ml-4.5 list-disc"><li>질문 고치기·더하기·빼기, 첨언 작성, 글 수정 제안 채택</li><li>다시 켜는 동작: AI가 읽기 다시 허용, AI 참조 다시 허용</li><li>단계 다시 열기, 동기화 충돌 고르기, 설정</li></ul>
                <p className="mt-2">휴대폰에서도 “모든 도구 보기”로 편집 도구를 펼칠 수 있습니다(터치 데스크톱 대비).</p>
              </More>
            </Card>
          </div>
        </Frame>
      </div>

      <FoldCard id="rules" className="mt-[18px]" title="휴대폰 규칙" meta="5가지">
        <ul className="ml-4.5 list-disc space-y-1 text-meta">
          <li><strong>엄격해지는 동작은 휴대폰에서도, 느슨해지는 동작은 데스크톱에서.</strong> 다만 정책 변경은 끄기도 요청 한 건마다 본인 확인을 받습니다(stage-5 2.2 유지 — Codex F01). 빠른 것은 단계 수이지 인증 생략이 아닙니다.</li>
          <li>휴대폰 판단은 화면 폭과 굵은 포인터를 함께 보지만 기기 판별로 믿지 않습니다. 데스크톱 200% 확대만으로 동작을 숨기지 않고, 휴대폰에서도 “모든 도구 보기”로 펼칠 수 있습니다(Codex F10).</li>
          <li>누르는 곳은 44px 이상, 입력 글자는 16px 이상(확대 방지), 한 화면에 한 질문, 진행 막대와 “n / 전체”를 함께.</li>
          <li>보내기 전에 끊긴 것(보내지 않음)과 보낸 뒤 응답을 못 받은 것(결과 미확인)을 나눕니다. 둘 다 같은 요청 번호로 다시 확인합니다(Codex F07).</li>
          <li>초안은 같은 탭에만 있습니다(새로고침 보존). 앱을 닫거나 다른 기기로 옮기면 남지 않는다고 처음 답할 때 한 번 알려 줍니다.</li>
        </ul>
      </FoldCard>

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="mx-auto max-w-md rounded-t-[18px] p-4">
          <SheetHeader className="p-0">
            <SheetTitle>승인하려면 본인 확인이 필요합니다</SheetTitle>
            <SheetDescription>이 확인은 이 승인 한 건에만 쓰입니다: 지역 돌봄 인력 수급 · 조사 단계 · 고정본 R3. 내용이 바뀌면 승인하지 않습니다.</SheetDescription>
          </SheetHeader>
          <div className="mt-3 flex flex-col gap-2">
            <Button variant="default" onClick={() => approve.run({ slug: "dolbom-insight", stage: "research", snapshot: "R3", note: memo, step_up: { method: "passkey", bound: "지역 돌봄 · 조사 단계 · 고정본 R3" } }, { onSettled: () => setSheet(false) })}>
              <FingerprintIcon aria-hidden="true" />
              패스키로 확인
            </Button>
            <Button onClick={() => approve.run({ slug: "dolbom-insight", stage: "research", snapshot: "R3", note: memo, step_up: { method: "email", bound: "지역 돌봄 · 조사 단계 · 고정본 R3" } }, { onSettled: () => setSheet(false) })}>
              <MailIcon aria-hidden="true" />
              메일 링크로 확인
            </Button>
          </div>
          <Hint className="mt-2">5분 안에 끝내지 못하면 다시 확인합니다. 메모는 지워지지 않습니다.</Hint>
        </SheetContent>
      </Sheet>
    </>
  );
}
