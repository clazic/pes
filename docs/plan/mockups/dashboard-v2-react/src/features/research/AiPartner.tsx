import * as React from "react";
import { Link } from "react-router";
import { useCommand } from "@/api/queries";
import type { WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/pes/bits";
import { ActionButton } from "@/components/pes/controls";
import { InfoTip } from "@/components/pes/disclosure";
import { StatusFrom } from "@/components/pes/status";
import { agoText, elapsedText, TurnMark, useNow } from "@/components/pes/turn";
import { aiSheet, useAiSheet } from "@/lib/research-ui";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { AssumptionBulkDialog } from "@/features/research/AssumptionBulkDialog";

const WHOLE = "이 라운드 전체";

/** AI 쪽 경과 · 마지막 소식(글자만 — 15초마다 바뀜, 움직임 아님). 소식이 오래되면 “마지막 소식 n분 전” */
function AiSignal({ since, last, fresh }: { since?: string; last?: string; fresh: boolean }) {
  const now = useNow(`${since ?? ""}|${last ?? ""}|${fresh ? "1" : "0"}`);
  const parts = [since ? elapsedText(since, now) : null, last ? (fresh ? `소식 ${agoText(last, now)}` : `마지막 소식 ${agoText(last, now)}`) : "아직 소식 없음"].filter(Boolean);
  return <p className="text-xs text-muted-foreground tabular-nums">{parts.join(" · ")}</p>;
}

/** 빠른 부탁(채워 넣기만 — 보내기는 사람이 누름) */
const QUICK = ["이 문단 다시 써 줘", "근거 더 찾아 줘", "반대 근거도 찾아 줘", "쉽게 줄여 줘"];

/**
 * AI 동료(설계 16.2 오른쪽 칸) — AI가 지금 하는 일 · AI에게 부탁하기(사람→AI 질문, U5) · AI가 남긴 가정·결정 제안(U3).
 * - 지금 하는 일은 서버가 계산한 차례(15절)와 실행 카드 그대로 — 진행 소식이 없으면 움직이지 않는다.
 * - 부탁은 “접수됨”까지가 사실이다. 방식 B는 내 컴퓨터 AI가 받아야 처리되고(받음 ≠ 읽음), 답이 오기 전에는 “답 없음”.
 * - 연결·사용량은 맨 아래 한 줄(작게). 문제가 되면 막힌 것·풀 것에 올라온다.
 */
type AiPartnerProps = { ws: WorkspaceView; idPrefix?: string; className?: string; onCollapse?: () => void };

/**
 * 프로젝트가 바뀌면 칸의 지역 상태(부탁 초안·가정 일괄 대화 상자)를 새 프로젝트로 가져가지 않는다 —
 * key 로 다시 그려 이전 프로젝트의 가정 id 가 새 프로젝트로 전송되는 상태를 없앤다(최종 리뷰 F1).
 */
export function AiPartner(props: AiPartnerProps) {
  return <AiPartnerView key={props.ws.slug} {...props} />;
}

function AiPartnerView({ ws, idPrefix = "aip", className, onCollapse }: AiPartnerProps) {
  const { role } = useMockSettings();
  const sheet = useAiSheet();
  const paragraphs = ws.result?.paragraphs.map((_, i) => `문단 ${i + 1}`) ?? [];
  const [target, setTarget] = React.useState(() => (sheet.target && paragraphs.includes(sheet.target) ? sheet.target : WHOLE));
  const [text, setText] = React.useState("");
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkSession, setBulkSession] = React.useState(0);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const bulkOpenRef = React.useRef<HTMLSpanElement>(null);
  const proposalHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const ask = useCommand("question.create", { successText: (r) => `AI에게 부탁 접수됨 · 접수 번호 ${r.receipt_no} — ${ws.mode === "B" ? "내 컴퓨터 AI가 받아야 처리됩니다" : "실행이 이어질 때 처리됩니다"}` });
  const decide = useCommand("decision.record");

  // 결과 글에서 “AI에게 부탁”을 누르면 그 문단을 부탁할 곳으로
  // (아직 받지 않은 부탁만 — 접힌 칸이 이 부탁으로 펼쳐져 새로 그려져도 받고, 그 뒤 다시 그려질 때는 초점을 빼앗지 않음)
  // 옛 effect의 [sheet.target, sheet.nonce]와 같은 키를 본다(대상만 바뀌어도 반영)
  const [seenSheet, setSeenSheet] = React.useState({ target: sheet.target, nonce: sheet.nonce });
  if (seenSheet.target !== sheet.target || seenSheet.nonce !== sheet.nonce) {
    setSeenSheet({ target: sheet.target, nonce: sheet.nonce });
    if (sheet.target && aiSheet.pending(sheet.nonce)) setTarget(sheet.target);
  }
  React.useEffect(() => {
    const nonce = sheet.nonce;
    if (!aiSheet.pending(nonce)) return;
    const t = window.setTimeout(() => {
      aiSheet.done(nonce);
      textRef.current?.focus();
    }, 120);
    return () => window.clearTimeout(t);
  }, [sheet.target, sheet.nonce]);

  const readOnly = role === "reader";
  const why = readOnly ? "읽기 멤버는 AI에게 부탁할 수 없습니다." : !text.trim() ? "부탁할 말을 적어 주세요." : ask.pending ? "접수 확인 중입니다" : null;
  const recent = [...ws.asks].reverse().slice(0, 3);
  const props = ws.proposals;
  const pending = props.filter((p) => p.state.value === "proposed").length;
  const pendingAssumptions = props.filter((p) => p.kind === "assumption" && p.state.value === "proposed");
  const t = ws.third_card;

  const openBulk = () => {
    setBulkSession((n) => n + 1);
    setBulkOpen(true);
  };
  // 닫힌 뒤 초점: 열기 단추가 남아 있으면 그 단추, 전부 받아들여 단추가 사라졌으면 제안 제목(최종 리뷰 F3)
  const restoreProposalFocus = () => {
    const opener = bulkOpenRef.current?.querySelector("button");
    if (opener) opener.focus();
    else proposalHeadingRef.current?.focus();
  };

  return (
    <section aria-labelledby={`${idPrefix}-title`} className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 id={`${idPrefix}-title`} className="text-sm">
            AI 동료
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            방식 {ws.mode} · {ws.runner_label}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button asChild size="sm" variant="ghost" className="text-xs">
            <Link to={`/p/${ws.slug}/ai`}>작업 기록</Link>
          </Button>
          {onCollapse ? (
            <Button size="sm" variant="ghost" className="text-xs" aria-expanded="true" onClick={onCollapse}>
              접기
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 px-4 py-3.5">
        {/* AI가 지금 하는 일 — 차례가 AI 쪽이면 표시기, 아니면 실행 상태 한 줄 */}
        <section aria-labelledby={`${idPrefix}-now`} className="space-y-1.5">
          <h3 id={`${idPrefix}-now`} className="text-meta text-muted-foreground">
            AI가 지금
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {ws.turn && ws.turn.side === "ai" ? <TurnMark turn={ws.turn} className="size-3 text-primary-ink" /> : null}
            <StatusFrom s={ws.ai_card.status} wrap />
          </div>
          <p className="text-meta leading-relaxed text-ink">{ws.ai_card.line}</p>
          {ws.turn && ws.turn.side === "ai" ? <AiSignal since={ws.turn.since} last={ws.turn.last_signal} fresh={Boolean(ws.turn.fresh)} /> : null}
        </section>

        <section aria-labelledby={`${idPrefix}-ask`} className="space-y-2 border-t border-line pt-3.5">
          <div className="flex items-center gap-1">
            <h3 id={`${idPrefix}-ask`} className="text-meta">
              AI에게 부탁하기
            </h3>
            <InfoTip label="AI에게 부탁하기 설명">
              <p>사람→AI 질문으로 접수합니다. 접수됨까지가 사실이고, {ws.mode === "B" ? "내 컴퓨터 AI가 받아야 처리됩니다(받음 ≠ 읽음)." : "PES 실행기가 실행을 이어 갈 때 처리합니다."}</p>
              <p>답이 오기 전에는 “AI 답변 중”을 보이지 않고 “답 없음”으로 둡니다. 결과 글을 바꾸는 부탁은 글 수정 제안으로 돌아오고, 채택해야 바뀝니다.</p>
            </InfoTip>
          </div>
          {readOnly ? (
            <p className="text-meta text-ink-2">읽기 멤버는 부탁을 볼 수만 있습니다.</p>
          ) : (
            <>
              <div>
                <Label htmlFor={`${idPrefix}-target`} className="text-meta font-medium">
                  부탁할 곳
                </Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger id={`${idPrefix}-target`} className="mt-1 h-8 w-full text-meta">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={WHOLE}>{WHOLE}</SelectItem>
                    {paragraphs.map((p) => (
                      <SelectItem key={p} value={p}>
                        결과 글 {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="빠른 부탁 — 글을 채워 넣기만 함">
                {QUICK.map((q) => (
                  <Button key={q} size="xs" variant="outline" className="h-7 rounded-full px-2.5 text-caption font-normal" onClick={() => setText(q)}>
                    {q}
                  </Button>
                ))}
              </div>
              <div>
                {/* 자리표시자만으로 이름을 대신하지 않는다(6차) — 위의 “부탁할 곳”과 같은 모양의 이름표 */}
                <Label htmlFor={`${idPrefix}-text`} className="text-meta font-medium">
                  부탁할 말
                </Label>
                <Textarea ref={textRef} id={`${idPrefix}-text`} rows={2} className="mt-1" placeholder="예: 이 문단의 표본 수를 같이 적어 줘" value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  size="sm"
                  variant="default"
                  blockedBy={why}
                  onClick={() => ask.run({ slug: ws.slug, text: text.trim(), direction: "human_to_agent", target: target === WHOLE ? undefined : `결과 글 ${target}` }, { onSuccess: () => setText("") })}
                >
                  부탁 보내기
                </ActionButton>
                {ask.phase === "confirming" ? <span className="text-xs text-ink-2">접수 확인 중…</span> : null}
              </div>
            </>
          )}
          {recent.length ? (
            <ul className="space-y-2 pt-1" aria-label="최근 부탁">
              {recent.map((a) => (
                <li key={a.number} className="rounded-lg border border-line bg-surface-soft px-2.5 py-2 text-caption">
                  <p className="text-ink">
                    <span className="font-semibold">{a.number}</span> {a.text}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.steps.map((s) => (
                      <StatusFrom key={`${a.number}-${s.value}-${s.label}`} s={s} />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section aria-labelledby={`${idPrefix}-prop`} className="space-y-2 border-t border-line pt-3.5">
          <div className="flex flex-wrap items-center gap-1">
            <h3 ref={proposalHeadingRef} id={`${idPrefix}-prop`} tabIndex={-1} className="text-meta">
              AI가 남긴 가정·결정 제안 <span className="font-normal text-muted-foreground tabular-nums">{props.length}</span>
            </h3>
            <InfoTip label="가정·결정 제안 설명">
              <p>AI가 일하며 세운 가정과 결정 제안입니다. 받아들이거나 버리면 판단자·근거가 기록됩니다. 판단하지 않아도 일을 막지 않으며 나의 할 일 수에 넣지 않습니다{pending ? ` — 판단 전 ${pending}개` : ""}.</p>
            </InfoTip>
            {pendingAssumptions.length >= 2 ? (
              <span ref={bulkOpenRef} className="ml-auto flex flex-wrap items-center gap-1">
                <ActionButton
                  size="xs"
                  variant="outline"
                  blockedBy={role === "owner" ? null : "소유자만 가정을 확인할 수 있습니다."}
                  showReason
                  onClick={openBulk}
                >
                  판단 전 가정 {pendingAssumptions.length}개 모두 받아들이기
                </ActionButton>
              </span>
            ) : null}
          </div>
          {props.length === 0 ? <p className="text-meta text-muted-foreground">아직 없습니다.</p> : null}
          <ul className="space-y-2">
            {props.map((p) => (
              <li key={p.id} className="rounded-lg border border-line px-2.5 py-2 text-meta">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag>{p.kind === "assumption" ? "가정" : "결정 제안"}</Tag>
                  <StatusFrom s={p.state} />
                </div>
                <p className="mt-1 text-ink">{p.text}</p>
                <p className="mt-0.5 text-caption text-muted-foreground">
                  근거: {p.basis} · {p.by} {p.at}
                </p>
                {p.state.value === "proposed" && !readOnly ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <ActionButton size="xs" variant="outline" blockedBy={decide.pending ? "접수 확인 중입니다" : null} onClick={() => decide.run({ slug: ws.slug, proposal_id: p.id, verdict: "accept" })}>
                      받아들이기
                    </ActionButton>
                    <ActionButton size="xs" variant="ghost" blockedBy={decide.pending ? "접수 확인 중입니다" : null} onClick={() => decide.run({ slug: ws.slug, proposal_id: p.id, verdict: "reject" })}>
                      버리기
                    </ActionButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {/* 관리 지표는 작게(설계 16.5) — 문제가 되면 막힌 것·풀 것에 올라온다 */}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line pt-3 text-caption text-muted-foreground">
          <span>{t.kind === "computer" ? "내 컴퓨터" : "API 사용량"}</span>
          <StatusFrom s={t.status} />
          {t.short ? <span>{t.short}</span> : null}
          <InfoTip label="연결·사용량 설명">
            <p>연결·사용량 같은 관리 지표는 연구 공간에서 작게만 보입니다. 연구를 막으면 “막힌 것·풀 것”에 올라옵니다.</p>
            <p className="text-muted-foreground">{t.kind === "computer" ? `${t.device} · ${t.checked}` : `${t.connection} · ${t.line}`}</p>
          </InfoTip>
        </p>
      </div>
      <AssumptionBulkDialog
        key={bulkSession}
        slug={ws.slug}
        assumptions={pendingAssumptions}
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onClosedFocus={restoreProposalFocus}
      />
    </section>
  );
}
