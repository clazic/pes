import * as React from "react";
import { Link, useLocation } from "react-router";
import { ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { useCommand } from "@/api/queries";
import type { ProblemView, ReferenceView, WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Anno, CardHead, Cite, KV } from "@/components/pes/bits";
import { ActionButton } from "@/components/pes/controls";
import { InfoTip, More, MoreList } from "@/components/pes/disclosure";
import { Status, StatusFrom, StatusMark } from "@/components/pes/status";
import { lookup } from "@/components/pes/status-registry";
import { ResolveFlow } from "@/features/research/ResolveFlow";
import { aiSheet } from "@/lib/research-ui";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { usePhoneTools } from "./phone-tools";

export function ReferenceCard({ r, slug, anchor }: { r: ReferenceView; slug: string; anchor?: boolean }) {
  const settings = useMockSettings();
  const refresh = useCommand("reference_refresh");
  const owner = settings.role === "owner";
  const why = owner ? null : "참고 프로젝트 갱신·떼기는 소유자만 할 수 있습니다(편집자 허용은 정해지지 않음 — 지금은 기본 거부).";
  return (
    <Card id={anchor ? "refs" : undefined} size="compact" aria-labelledby={`${r.id}-t`}>
      <CardHead eyebrow="참고 프로젝트 · 읽기 전용" title={r.title} titleId={`${r.id}-t`} right={<StatusFrom s={r.status} />} />
      {/* 정보 밀도(14절): 고정 버전 · 새 버전 · AI 제공 한 줄. 붙인 범위 · 목적지별 이유 · 사람은 “자세히” */}
      <KV
        items={[
          ["고정한 버전", r.pinned],
          ...(r.new_version ? ([["새 버전", r.new_version]] as [string, string][]) : []),
          [
            "AI 제공",
            <span key="ai" className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-ink-2">API</span>
              <StatusFrom s={r.to_api.status} />
              <span className="ml-1 text-ink-2">B 도구</span>
              <StatusFrom s={r.to_b.status} />
            </span>,
          ],
        ]}
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {r.status.value === "new_version" ? (
          <>
            <ActionButton size="sm" variant={owner ? "default" : "outline"} blockedBy={why} onClick={() => refresh.run({ slug, ref_id: r.id, mode: "update" })}>
              새 버전과 비교하고 갱신
            </ActionButton>
            <ActionButton size="sm" blockedBy={why} onClick={() => refresh.run({ slug, ref_id: r.id, mode: "keep" })}>
              지금 버전 유지
            </ActionButton>
          </>
        ) : null}
        <ActionButton variant="link" blockedBy={why}>
          떼기
        </ActionButton>
      </div>
      <More className="mt-1.5" label="범위 · 목적지별 이유">
        <MoreList
          items={[
            ["붙인 범위", r.scope],
            ["방식 A · API 목적지", r.to_api.text],
            ["방식 B · 그 밖의 도구(PES 경유)", r.to_b.text],
            ["사람", "두 프로젝트 모두 권한이 있을 때만 볼 수 있음"],
          ]}
        />
      </More>
      <Anno>
        갱신하면 새 버전에 다시 고정합니다. 이미 쓴 인용은 옛 고정 버전을 계속 가리킵니다. 원본 프로젝트가 AI가 읽기: 막음이면 API 목적지(방식 A, B 도구가 API로 보내는 경우)에는 보내지 않고, 그 밖의 B 도구는 원본이 허용한 목적지 범위만 읽습니다(Codex F02). 원본이 지워지면 “원본 없음”, 보관되면 “원본 보관됨”, 원본 권한이 없으면 내용 대신 “권한 없음”만 보입니다.
      </Anno>
    </Card>
  );
}

function CommentDialog({ open, onOpenChange, quote, slug }: { open: boolean; onOpenChange: (o: boolean) => void; quote: string; slug: string }) {
  const [body, setBody] = React.useState("");
  const add = useCommand("thread.create");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>첨언 달기</DialogTitle>
          <DialogDescription>인용: “{quote}” · 결과 글은 읽기 전용입니다. 고치는 길은 첨언 → 글 수정 제안 → 새 버전 채택입니다.</DialogDescription>
        </DialogHeader>
        <Label htmlFor="cmt" className="text-meta font-semibold">
          첨언
        </Label>
        <Textarea id="cmt" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>취소</Button>
          <ActionButton variant="default" blockedBy={!body.trim() ? "첨언 내용을 적어 주세요." : null} onClick={() => add.run({ slug, quote, body }, { onSuccess: () => { setBody(""); onOpenChange(false); } })}>
            첨언 달기
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 문단 안의 문제 부분에 밑줄(장식 — 뜻은 옆 표시 단추의 모양·글자가 전함) */
function withFlags(text: string, problems: ProblemView[]) {
  const flags = problems.filter((p) => p.quote && text.includes(p.quote));
  if (!flags.length) return text;
  const parts: React.ReactNode[] = [];
  let rest = text;
  let k = 0;
  for (const p of flags) {
    const at = rest.indexOf(p.quote!);
    if (at < 0) continue;
    parts.push(rest.slice(0, at));
    parts.push(
      <span key={k++} data-flag={p.id} className={cn("pes-flag", p.state === "ai" ? "pes-flag-ai" : PROBLEM_TONE[p.kind] === "bad" ? "pes-flag-bad" : "pes-flag-warn")}>
        {p.quote}
      </span>,
    );
    rest = rest.slice(at + p.quote!.length);
  }
  parts.push(rest);
  return parts;
}

const PROBLEM_TONE: Record<ProblemView["kind"], "warn" | "bad"> = {
  weak_evidence: "warn",
  conflict_data: "bad",
  verify_failed: "bad",
  required_question: "warn",
  run_stopped: "bad",
  sync_conflict: "bad",
  extract_failed: "bad",
};

/**
 * 문단 여백의 문제 표시 단추(설계 16.4) — 모양 + 글자(근거 부족 · 검증 실패 …). 누르면 그 문단 바로 아래에 해결 흐름이 펼쳐진다.
 * J/K(집중 모드)로 표시 사이를 옮긴다(data-jk).
 */
function FlagButton({ p, open, onToggle }: { p: ProblemView; open: boolean; onToggle: () => void }) {
  const def = lookup("problem", p.kind);
  const label = p.state === "ai" ? `${def.label} · AI 작업 중` : def.label;
  return (
    <button
      type="button"
      data-jk=""
      aria-expanded={open}
      aria-controls={`pbx-${p.id}`}
      aria-label={`${label}: ${p.title} — 해결 흐름 ${open ? "접기" : "펼치기"}`}
      onClick={onToggle}
      className={cn(
        "mx-0.5 inline-flex items-center gap-1 rounded-md border px-1.5 align-[1px] text-xs leading-[1.7] font-medium coarse:min-h-[44px]",
        p.state === "ai" ? "border-dashed border-primary-line bg-primary-soft text-primary-ink" : PROBLEM_TONE[p.kind] === "bad" ? "border-bad-line bg-bad-soft text-bad" : "border-warn-line bg-warn-soft text-warn",
      )}
    >
      <StatusMark shape={p.state === "ai" ? "ring" : def.shape} />
      {label}
      <ChevronDownIcon aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-180")} />
    </button>
  );
}

export function ResultPanel({ ws, withReferences = false }: { ws: WorkspaceView; withReferences?: boolean }) {
  const showTools = usePhoneTools();
  const settings = useMockSettings();
  const [commenting, setCommenting] = React.useState(false);
  const { hash } = useLocation();
  const [openFlag, setOpenFlag] = React.useState<string | null>(() => (hash.startsWith("#pbx-") ? hash.slice(5) : null));
  const highlighted = ws.result?.paragraphs.find((p) => p.highlighted)?.text ?? "";
  const flagged = ws.problems.filter((p) => p.paragraph !== undefined && (p.state === "open" || p.state === "ai"));

  // 풀고 나면 그 표시는 사라진다 — 다음 표시(없으면 “다음 할 일”)로 초점을 옮긴다
  const onResolved = (p: ProblemView) => {
    const rest = flagged.filter((x) => x.id !== p.id && x.state === "open");
    setOpenFlag(null);
    window.setTimeout(() => {
      const next = rest[0] ? document.querySelector<HTMLElement>(`[aria-controls="pbx-${CSS.escape(rest[0].id)}"]`) : null;
      (next ?? document.querySelector<HTMLElement>("#main [data-jk-next]"))?.focus();
    }, 450);
  };

  const copyPrompt = async () => {
    const text = `${ws.title} · ${ws.current.label}\n선택한 문장: ${highlighted}\n(토큰·비밀은 넣지 않음)`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("복사됨 — 복사는 전달 확인이 아닙니다. 붙여 넣은 뒤 결과를 가져오세요.");
    } catch {
      toast.error("클립보드에 쓰지 못했습니다. 아래 문장을 직접 선택해 복사해 주세요.");
    }
  };

  return (
    <div className="space-y-4">
      {ws.result ? (
        <Card className="gap-0 px-5 py-6 tab:px-8 tab:py-7" aria-labelledby="result-title" id="result-card">
          <article aria-labelledby="result-title">
          <CardHead eyebrow={ws.result.eyebrow} title={ws.result.title} titleId="result-title" size="lg" />
          {/* 정보 밀도(14절): 결과 글 위는 한 줄 — 상태 · 짧은 메타 · 반영 요약. 제출자·기반·모델 이름 근거는 “결과물 정보” */}
          <p className="-mt-1 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line pb-3 text-caption text-muted-foreground">
            <StatusFrom s={ws.result.status} />
            {ws.result.meta_short ? <span>{ws.result.meta_short}</span> : null}
            {ws.reflection ? (
              <Link to="#refl-title" className="inline-flex items-center gap-1.5 no-underline">
                <span className="underline decoration-1 underline-offset-[3px]">반영 {ws.reflection.rows.length}건</span>
                <StatusFrom s={ws.reflection.summary} />
              </Link>
            ) : null}
            <InfoTip label="결과물 정보 — 제출 · 기반 · 모델 이름" wide>
              <p>{ws.result.meta}</p>
            </InfoTip>
          </p>
          <div className="max-w-[46rem] space-y-3.5 text-body leading-[1.85] text-foreground">
            {ws.result.paragraphs.map((p, i) => {
              const probs = flagged.filter((x) => x.paragraph === i);
              const edge = probs.length ? (probs.every((x) => x.state === "ai") ? "border-dashed border-primary-line" : probs.some((x) => x.state === "open" && PROBLEM_TONE[x.kind] === "bad") ? "border-bad" : "border-warn") : "";
              const text = withFlags(p.text, probs);
              return (
                <div key={i} id={`para-${i}`} tabIndex={-1} className={cn("outline-none", probs.length && "-ml-3 border-l-2 pl-2.5 tab:-ml-4 tab:pl-3.5", edge)}>
                  <p>
                    <span className="sr-only">문단 {i + 1}{probs.length ? ` — 막힌 것 ${probs.length}` : ""}: </span>
                    {p.highlighted ? <mark className="bg-highlight px-0 py-px text-ink shadow-[inset_0_-2px_0_var(--warn-line)]">{text}</mark> : text}{" "}
                    {p.cites.map((c) => (
                      <Cite key={c.label} c={c} />
                    ))}
                    {p.cites.length && !p.text.endsWith(".") ? "." : ""}
                    {probs.map((x) => (
                      <FlagButton key={x.id} p={x} open={openFlag === x.id} onToggle={() => setOpenFlag((o) => (o === x.id ? null : x.id))} />
                    ))}
                  </p>
                  {p.pending_edit ? (
                    <p className="mt-1.5 rounded-md border border-dashed border-primary-line bg-primary-soft px-2.5 py-1.5 text-meta leading-relaxed text-ink">
                      <Status of="claim" value="pending_edit" /> <span className="ml-1">{p.pending_edit}</span>
                    </p>
                  ) : null}
                  {probs.map((x) => (
                    <div key={x.id} id={`pbx-${x.id}`} hidden={openFlag !== x.id} className="my-2 rounded-xl border border-line-strong bg-surface p-3.5 text-meta leading-normal shadow-sm">
                      {openFlag === x.id ? <ResolveFlow ws={ws} p={x} onResolved={onResolved} /> : null}
                    </div>
                  ))}
                  {p.highlighted && showTools && settings.role !== "reader" ? (
                    <div role="toolbar" aria-label="선택한 문장 도구" className="my-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 shadow-md">
                      <span className="mr-1 text-xs font-semibold text-muted-foreground">선택한 문장</span>
                      <Button size="sm" onClick={() => setCommenting(true)}>
                        첨언
                      </Button>
                      <Button size="sm" onClick={() => aiSheet.ask(`문단 ${i + 1}`)}>
                        AI에게 부탁
                      </Button>
                      <Button size="sm" onClick={() => toast.info("다음 라운드 할 일 제안으로 남깁니다(바로 실행하지 않음).")}>
                        할 일로
                      </Button>
                      <Button size="sm" onClick={copyPrompt}>
                        프롬프트로 복사
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          </article>
          <Anno>인용 칩은 세 가지입니다: 출처(조사 출처), 자료(내 자료 — 파일·위치), 참고(다른 프로젝트 — 프로젝트·고정한 버전). AI 참조를 나중에 끈 파일을 근거로 쓴 곳은 주의 칩으로 남깁니다(회수가 아니라 표시).</Anno>
        </Card>
      ) : (
        <Card className="px-4">
          <p className="text-sm text-ink-2">아직 결과물이 없습니다. AI 실행이 결과를 내면 여기에 보입니다.</p>
          <Anno>이전된 옛 프로젝트에 가정·결정·의견 기록이 없으면 “기록 없음”으로 보입니다.</Anno>
        </Card>
      )}

      {ws.annotations.map((a) => (
        <Card key={a.no} className="gap-0 border-warn-line px-4" aria-labelledby={`an-${a.no}`} id={`an-${a.no}`}>
          <div className="flex items-start gap-2">
            <span aria-hidden="true" className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-warn-soft text-xs font-semibold text-warn">
              {a.no}
            </span>
            <div className="min-w-0 flex-1">
              <h3 id={`an-${a.no}`} className="text-meta">
                첨언 {a.no} · {a.who} · {a.at}
              </h3>
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground">
                <span>“{a.quote}”</span>
                <StatusFrom s={a.anchor} />
                <InfoTip label={`첨언 ${a.no} 정보 — 붙은 곳`}>
                  <p>{a.note}. 붙은 곳이 바뀌면 위치 표시가 달라지고, 인용과 스레드는 그대로 남습니다.</p>
                </InfoTip>
              </p>
            </div>
          </div>
          <p className="mt-2">{a.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="link">답글</Button>
            <Button variant="link">AI에게 묻기</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="link" className="gap-1">
                  해결
                  <ChevronDownIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52">
                <DropdownMenuItem>글 수정</DropdownMenuItem>
                <DropdownMenuItem>다음 라운드 할 일</DropdownMenuItem>
                <DropdownMenuItem>앞 단계 다시 열기</DropdownMenuItem>
                <DropdownMenuItem>그냥 닫기</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Card>
      ))}

      {ws.reflection ? (
        <Card size="compact" aria-labelledby="refl-title">
          <CardHead eyebrow="반영 내역" title={`지난 라운드 의견 ${ws.reflection.rows.length}건`} titleId="refl-title" right={<StatusFrom s={ws.reflection.summary} />} />
          <Table regionLabel="반영 내역" className="min-w-[560px]">
            <TableCaption className="sr-only">반영 내역</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-[38%]">지난 의견</TableHead>
                <TableHead scope="col" className="w-[14%]">처리</TableHead>
                <TableHead scope="col" className="w-[30%]">근거</TableHead>
                <TableHead scope="col">판단</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ws.reflection.rows.map((r) => (
                <TableRow key={r.opinion}>
                  <TableCell>{r.opinion}</TableCell>
                  <TableCell>
                    <Status of="reflection" value={r.result} />
                  </TableCell>
                  <TableCell>{r.evidence}</TableCell>
                  <TableCell>{r.judged}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Anno>“적용”은 결과 버전이나 실제로 적용된 후속(질문·할 일)의 증거가 있을 때만 씁니다. 의견을 하나도 안 보냈으면 “보낸 의견 없음”, 보냈는데 처리가 없으면 “처리 0건”으로 다르게 보입니다.</Anno>
        </Card>
      ) : null}

      {withReferences
        ? ws.references.map((r, i) => <ReferenceCard key={r.id} r={r} slug={ws.slug} anchor={i === 0} />)
        : null}
      <CommentDialog open={commenting} onOpenChange={setCommenting} quote={highlighted.slice(0, 24) + "…"} slug={ws.slug} />
    </div>
  );
}
