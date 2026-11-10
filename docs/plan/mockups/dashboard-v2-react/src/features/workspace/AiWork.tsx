import { Link } from "react-router";
import { useCommand } from "@/api/queries";
import type { TimelineJob, WorkspaceView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CardHead, Tag } from "@/components/pes/bits";
import { ActionButton } from "@/components/pes/controls";
import { InfoTip } from "@/components/pes/disclosure";
import { Chip, StatusFrom } from "@/components/pes/status";
import { useMockSettings } from "@/lib/mock-settings";

function Lane({ title, chip, jobs, empty, note, id }: { title: string; chip: React.ReactNode; jobs: TimelineJob[]; empty?: string; note?: string; id: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0 rounded-xl border border-line bg-surface-soft p-2.5">
      <div className="mb-2 flex items-center justify-between gap-1.5">
        <span className="inline-flex items-center gap-1">
          <h3 id={id} className="text-meta">
            {title}
          </h3>
          {note ? (
            <InfoTip label={`${title} 설명`}>
              <p>{note}</p>
            </InfoTip>
          ) : null}
        </span>
        {chip}
      </div>
      {jobs.length === 0 ? <p className="text-caption text-muted-foreground">{empty}</p> : null}
      <div className="space-y-2">
        {jobs.map((j) => (
          <div key={j.title} className="rounded-lg border border-line bg-surface px-2.5 py-2 text-caption">
            <p className="text-meta font-semibold text-ink">
              <span className="mr-1.5 text-xs font-medium text-muted-foreground">{j.time}</span>
              {j.title}
            </p>
            <p className="text-ink-2">{j.body}</p>
            {j.files?.length ? (
              <p className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground">
                바뀐 파일 {j.files.length}
                <InfoTip label={`${j.title} — 바뀐 파일`}>
                  <ul className="space-y-0.5">
                    {j.files.map((f) => (
                      <li key={f}>
                        <code className="text-xs">{f}</code>
                      </li>
                    ))}
                  </ul>
                </InfoTip>
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * AI 작업(설계 4.10): 실행 표 · 작업 타임라인 3칸 · AI에게 묻는 질문 · 내 컴퓨터에서 확인할 일 · 통제 범위.
 * 정보 밀도(14절): 단추 아래는 못 누르는 이유 한 줄만, 동작 규칙·관측 근거·예정 시점의 뜻은 ⓘ 설명으로.
 */
export function AiWork({ ws, id = "ai" }: { ws: WorkspaceView; id?: string }) {
  const settings = useMockSettings();
  const resume = useCommand("run.resume", { successText: (r) => (ws.mode === "B" ? `계속 접수됨 · 접수 번호 ${r.receipt_no} — 내 컴퓨터 AI가 받으면 이어집니다` : `계속 접수됨 · 접수 번호 ${r.receipt_no} — 실행기가 새 담당을 잡습니다`) });
  const interrupt = useCommand("run.interrupt", { successText: (r) => `중단 요청 접수 · ${r.receipt_no} — 외부 중단 결과는 따로 확인합니다` });
  const selected = ws.runs.rows.find((r) => r.selected);
  const canResume = ws.now.kind === "resume";
  const resumeWhy = settings.role !== "owner" ? "계속은 소유자만 누를 수 있습니다(편집자 허용은 WEB3에서 정함 — 지금은 기본 거부)." : !canResume ? ws.runs.continue_reason || "지금은 계속할 실행이 없습니다." : null;

  return (
    <div className="mt-4">
      <Card id={id} size="compact" aria-labelledby={`${id}-title`}>
        <CardHead
          eyebrow="AI 작업"
          title="실행 · 작업 타임라인"
          titleId={`${id}-title`}
          right={
            <>
              <ActionButton size="sm" variant={canResume && settings.role === "owner" ? "default" : "outline"} blockedBy={resume.pending ? "접수 확인 중입니다" : resumeWhy} reasonId={`${id}-cont-why`} onClick={() => selected && resume.run({ slug: ws.slug, run_id: selected.id })}>
                {ws.runs.rows.length ? "계속" : "AI 실행 시작"}
              </ActionButton>
              <ActionButton size="sm" blockedBy={!selected ? "중단할 실행이 없습니다." : null} onClick={() => selected && interrupt.run({ slug: ws.slug, run_id: selected.id })}>
                중단 요청
              </ActionButton>
              <ActionButton size="sm" blockedBy={settings.role !== "owner" ? "다른 방식으로 넘기기는 소유자만 할 수 있습니다." : !selected ? "넘길 실행이 없습니다." : null}>
                다른 방식으로 넘기기
              </ActionButton>
            </>
          }
        />
        <p className="-mt-1 flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
          <span id={`${id}-cont-why`}>{resumeWhy ?? "계속할 수 있습니다."}</span>
          <InfoTip label="계속 설명">
            <p>누르면 서버가 최신 정책·질문·폼·기한·한도·rev·담당을 다시 검사합니다. “계속 접수됨” 뒤 실행 쪽이 새 담당(claim)을 잡아야 진행입니다.</p>
            <p className="text-muted-foreground">{ws.runs.mode_label}</p>
          </InfoTip>
        </p>
        {resume.phase === "confirming" ? (
          <p role="status" className="mt-1.5 text-meta">
            <Chip shape="ring" tone="run">
              접수 확인 중
            </Chip>{" "}
            같은 요청 번호로 확인 중입니다.
          </p>
        ) : null}
        {resume.phase === "unknown" ? (
          <p role="status" className="mt-1.5 text-meta">
            <Chip shape="dotring" tone="unk">
              결과 미확인
            </Chip>{" "}
            {resume.error?.message}{" "}
            <Button size="sm" onClick={resume.recheck}>
              같은 요청 번호로 확인
            </Button>
          </p>
        ) : null}

        <div className="mt-3 space-y-3.5">
          <div className="min-w-0">
            {ws.runs.rows.length ? (
              <Table regionLabel="실행 목록" className="min-w-[640px]">
                <TableCaption>실행</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">실행</TableHead>
                    <TableHead scope="col">단계·라운드</TableHead>
                    <TableHead scope="col">방식·도구</TableHead>
                    <TableHead scope="col">상태</TableHead>
                    <TableHead scope="col" className="text-right">
                      시작
                    </TableHead>
                    <TableHead scope="col">마지막 소식</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ws.runs.rows.map((r) => (
                    <TableRow key={r.id} data-state={r.selected ? "selected" : undefined}>
                      <TableHead scope="row" className="whitespace-nowrap">
                        {r.id}
                      </TableHead>
                      <TableCell>{r.where}</TableCell>
                      <TableCell>{r.runner}</TableCell>
                      <TableCell>
                        <StatusFrom s={r.status} wrap />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.started}</TableCell>
                      <TableCell>{r.last}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-meta text-ink-2">아직 실행이 없습니다.</p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-2.5 tab:grid-cols-3" aria-label="작업 타임라인">
              <Lane id={`${id}-done`} title="완료" chip={<Chip shape="circle" tone="ok">{ws.runs.lanes.done.length}</Chip>} jobs={ws.runs.lanes.done} empty="아직 없음" />
              <Lane id={`${id}-run`} title="진행" chip={<Chip shape={ws.runs.lanes.running.length ? "ring" : "dash"} tone={ws.runs.lanes.running.length ? "run" : "off"}>{ws.runs.lanes.running.length}</Chip>} jobs={ws.runs.lanes.running} empty={ws.runs.running_empty} note={ws.mode === "B" ? "도우미가 없으면 진행·일정 보고가 오지 않아 비어 있을 수 있습니다. 전달된 사건(결과 제출·질문)은 그대로 보입니다." : undefined} />
              <Lane id={`${id}-plan`} title="예정" chip={<Chip shape="ring" tone="run">{ws.runs.lanes.planned.length}</Chip>} jobs={ws.runs.lanes.planned} empty="없음" note={ws.runs.planned_note} />
            </div>
          </div>

          <div className="grid grid-cols-1 items-start gap-3 tab:grid-cols-2 wide:grid-cols-3">
            <section id={id === "ai" ? "ask" : undefined} aria-labelledby={`${id}-ask`} className="rounded-xl border border-line bg-surface px-3.5 py-3">
              <div className="flex items-center gap-1.5">
                <h3 id={`${id}-ask`} className="text-sm">
                  AI에게 묻는 질문 {ws.asks.length}
                </h3>
                {ws.asks.length ? (
                  <InfoTip label="처리 단계 설명">
                    <p>받음은 읽음이 아닙니다. 답이 오기 전까지 “AI 답변 중” 표시를 하지 않습니다.</p>
                  </InfoTip>
                ) : null}
              </div>
              {ws.asks.length === 0 ? <p className="mt-1.5 text-meta text-muted-foreground">없음</p> : null}
              {ws.asks.map((a) => (
                <div key={a.number} className="mt-1.5 text-meta">
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
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm">프롬프트로 복사</Button>
                    <Button size="sm">AI에게 묻기</Button>
                  </div>
                </div>
              ))}
            </section>
            {ws.local_permission ? (
              <section aria-labelledby={`${id}-perm`} className="rounded-xl border border-line bg-surface px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 id={`${id}-perm`} className="text-sm">
                    내 컴퓨터에서 확인할 일
                  </h3>
                  <Tag>연구 질문 아님</Tag>
                  <InfoTip label="내 컴퓨터에서 확인할 일 설명">
                    <p>{ws.local_permission.note}</p>
                  </InfoTip>
                </div>
                <p className="mt-1.5 text-meta">{ws.local_permission.text}</p>
              </section>
            ) : null}
            {ws.control_scope ? (
              <section aria-labelledby={`${id}-ctrl`} className="rounded-xl border border-line bg-surface px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 id={`${id}-ctrl`} className="text-sm">
                    AI 참조 금지 파일 통제 범위
                  </h3>
                  <InfoTip label="통제 범위 설명" wide>
                    <p>{ws.control_scope.note}</p>
                  </InfoTip>
                </div>
                <p className="mt-1.5 text-meta">
                  <StatusFrom s={ws.control_scope.status} /> {ws.control_scope.text}
                </p>
              </section>
            ) : null}
            {ws.mode === "A" ? (
              <section className="rounded-xl border border-line bg-surface px-3.5 py-3" aria-labelledby={`${id}-usage`}>
                <h3 id={`${id}-usage`} className="text-sm">
                  API 사용량
                </h3>
                <p className="mt-1 text-meta text-ink-2">정리·재개 준비는 사용량 화면에서 합니다.</p>
                <Button asChild size="sm" className="mt-2">
                  <Link to="/usage#blocked">사용량 보기</Link>
                </Button>
              </section>
            ) : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
