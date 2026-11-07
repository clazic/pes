import * as React from "react";
import { Link } from "react-router";
import { PlusIcon } from "lucide-react";
import { useProjects } from "@/api/queries";
import { STAGE_LABEL, STAGE_SHORT, type ProjectCard, type ProjectsView } from "@/api/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, CardHead, ModeBadge, SectionTitle, Tag } from "@/components/pes/bits";
import { EmptyState, LoadError, QuietLoading } from "@/components/pes/blocks";
import { InfoTip, More, MoreList } from "@/components/pes/disclosure";
import { StatCard, StatRow } from "@/components/pes/stat-card";
import { STAGE_MARK } from "@/components/pes/stage";
import { Chip, Status, StatusFrom, StatusMark } from "@/components/pes/status";
import { STATUS } from "@/components/pes/status-registry";
import { elapsedText, TurnIndicator, TurnTrack, turnDef, useNow } from "@/components/pes/turn";
import { cn } from "@/lib/utils";

/** 화면 말은 상태 사전 한 곳에서(4차): 나의 할 일 · AI가 하는 중 · AI가 읽기 허용/막음 */
const YOU = turnDef("you").label;
const AI = turnDef("ai").label;
const ALLOW = STATUS.transfer.on!.short!;
const BLOCK = STATUS.transfer.off!.short!;

function stageLabel(p: ProjectCard) {
  return "단계: " + p.stages.map((s) => `${STAGE_LABEL[s.key]} ${STAGE_MARK[s.view].text}`).join(", ");
}

/** AI가 하는 중인 프로젝트(서버가 카드마다 계산한 차례) */
function aiProjects(d: ProjectsView) {
  return d.active.filter((p) => p.turn?.side === "ai");
}

function StageMini({ p, compact }: { p: ProjectCard; compact?: boolean }) {
  return (
    <ol aria-label={stageLabel(p)} className={cn("grid grid-cols-6 gap-[3px]", compact && "w-[228px]")}>
      {p.stages.map((s) => (
        <li key={s.key} aria-hidden="true" className={cn("flex flex-col items-center gap-0.5 rounded-md bg-surface-soft px-0.5 pt-[5px] pb-1 text-center text-[11.5px] font-medium text-ink-2", STAGE_MARK[s.view].cell)}>
          <StatusMark shape={STAGE_MARK[s.view].shape} />
          {STAGE_SHORT[s.key]}
        </li>
      ))}
    </ol>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  const id = `p-${p.slug}`;
  return (
    <Card className="flex flex-col gap-2.5 px-5" aria-labelledby={id}>
      <div className="flex flex-wrap gap-x-1.5 gap-y-1">
        <Tag>{p.edition}판</Tag>
        <ModeBadge mode={p.mode} detail={p.runner_label} />
        {/* 기본값(허용)은 표의 열과 요약 카드가 말한다 — 카드에는 예외(막음·차단 중)만 */}
        {p.api_transfer.value !== "on" ? <StatusFrom s={p.api_transfer} /> : null}
      </div>
      <h3 id={id} className="text-[15px]">
        <Link to={p.href}>{p.title}</Link>
      </h3>
      <StageMini p={p} />
      {/* 차례 표시기(4차): 공이 사람 쪽이면 나의 할 일 n건 + 바로 가기, AI 쪽이면 지금 하는 일 + 경과 */}
      {p.turn ? <TurnIndicator turn={p.turn} action className="border-t border-line pt-2.5" /> : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2.5 gap-y-1 text-[13px]">
        {p.lines.slice(0, 1).map((l) => (
          <React.Fragment key={l.label}>
            <dt className="font-medium text-muted-foreground">{l.label}</dt>
            <dd className="m-0 min-w-0">
              {l.status ? <StatusFrom s={l.status} className="mr-1" /> : null}
              {l.text}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <More className="mt-auto border-t border-line pt-1.5" name={`${p.title} 자세히`}>
        <MoreList
          items={[
            ...(p.lines[1] ? ([[p.lines[1].label, p.lines[1].text]] as [string, string][]) : []),
            ["최근", `${p.foot[0]} · ${p.foot[1]}`],
            ...(p.api_transfer.value === "on" ? ([["AI가 읽기", ALLOW]] as [string, string][]) : []),
          ]}
        />
      </More>
    </Card>
  );
}

/**
 * 요약 카드 줄 — 목록 읽기 하나에서 센다(새 읽기 없음). 숫자는 서버가 사람·권한별로 계산한 나의 할 일·카드 그대로.
 * 정보 밀도(14절): 카드마다 이름 · 큰 수 · 배지 + 한 줄. 규칙 문장은 ⓘ 설명으로.
 */
function Summary({ d }: { d: ProjectsView }) {
  const count = (v: string[]) => d.turns.filter((t) => v.includes(t.status.value)).length;
  const blocked = count(["blocked"]);
  const answers = count(["answer", "start_q"]);
  const approvals = count(["approve", "resume"]);
  const checks = count(["check"]);
  const modeA = d.active.filter((p) => p.mode === "A").length;
  const on = d.active.filter((p) => p.api_transfer.value === "on").length;
  const off = d.active.length - on;
  const parts = [answers ? `답 ${answers}` : null, approvals ? `승인·계속 ${approvals}` : null, checks ? `확인 ${checks}` : null].filter(Boolean).join(" · ");
  const ai = aiProjects(d);
  const now = useNow();
  const first = ai[0];
  return (
    <StatRow label="프로젝트 요약" dense>
      <StatCard
        id="sum-turns"
        label={YOU}
        value={d.turns.length}
        unit="건"
        badge={blocked ? <Status of="turn" value="blocked" label={`막힘 ${blocked}`} /> : <Status of="check" value="pass" label="막힘 없음" />}
        lead={parts || "—"}
      />
      <StatCard id="sum-active" label="내 프로젝트" value={d.active.length} unit="개" badge={<Tag>보관됨 {d.archived_count}</Tag>} lead={`방식 A ${modeA} · 방식 B ${d.active.length - modeA}`} />
      <StatCard
        id="sum-ai"
        label={AI}
        value={ai.length}
        unit="개"
        badge={first?.turn ? <TurnTrack turn={first.turn} /> : null}
        lead={first?.turn ? `${first.title} · ${first.turn.fresh ? (first.turn.since ? elapsedText(first.turn.since, now) : "") : "소식 없음"}` : "없음"}
      />
      <StatCard
        id="sum-transfer"
        label="AI가 읽기"
        labelAside={
          <InfoTip label="AI가 읽기 설명">
            <p>등록된 AI 연결(API)이 이 프로젝트 자료를 읽게 할지입니다. 막음인 프로젝트는 방식 A를 시작하지 않습니다. 정책 변경은 요청 한 건마다 본인 확인을 거칩니다.</p>
          </InfoTip>
        }
        value={`${ALLOW} ${on}`}
        badge={off ? <Status of="transfer" value="off" label={`${BLOCK} ${off}`} /> : null}
      />
    </StatRow>
  );
}

function TurnsCard({ d }: { d: ProjectsView }) {
  const ai = aiProjects(d);
  return (
    <Card id="turns" className="mt-6 gap-0 px-5" aria-labelledby="turns-t">
      <CardHead
        title={`${YOU} ${d.turns.length}`}
        titleId="turns-t"
        aside={
          <InfoTip label="나의 할 일 순서 설명">
            <p>지금 풀 수 있는 막힘 → 답 → 승인 → 계속 → 확인 순서입니다. 서버가 사람·권한별로 계산합니다.</p>
          </InfoTip>
        }
      />
      {d.turns.length === 0 ? (
        <EmptyState title="지금은 나의 할 일이 없습니다" body={`${ai.length ? `AI가 프로젝트 ${ai.length}개를 하는 중입니다. ` : ""}질문이 오면 알림으로 알려 드립니다.`} />
      ) : (
        <>
          {/* 900px 이상: 표(dashboard-01 표 모양) */}
          <Table regionLabel="나의 할 일 표" containerClassName="hidden tab:block" className="min-w-[760px]">
            <TableCaption className="sr-only">나의 할 일 — 순위대로</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-[150px]">상태</TableHead>
                <TableHead scope="col">프로젝트 · 위치</TableHead>
                <TableHead scope="col">할 일</TableHead>
                <TableHead scope="col" className="w-[110px]">기한·경과</TableHead>
                <TableHead scope="col" className="w-[96px] text-right">
                  <span className="sr-only">동작</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.turns.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="align-middle">
                    <StatusFrom s={t.status} />
                  </TableCell>
                  <TableHead scope="row" className="align-middle">
                    {t.project_title}
                    <span className="block text-xs font-normal text-muted-foreground">{t.where}</span>
                  </TableHead>
                  <TableCell className="align-middle">{t.text}</TableCell>
                  <TableCell className="align-middle text-muted-foreground">{t.since}</TableCell>
                  <TableCell className="text-right align-middle">
                    <Button asChild size="sm" variant={t.action.primary ? "default" : "outline"}>
                      <Link to={t.action.href}>{t.action.label}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* 900px 미만: 한 줄씩 쌓기(단추가 화면 밖으로 밀리지 않게) */}
          <ul className="tab:hidden">
            {d.turns.map((t) => (
              <li key={t.id} className="grid grid-cols-1 gap-y-1.5 border-b border-line py-3 text-[13px] last:border-b-0">
                <span className="justify-self-start">
                  <StatusFrom s={t.status} />
                </span>
                <span className="font-semibold">
                  {t.project_title}
                  <span className="block text-xs font-normal text-muted-foreground">{t.where}</span>
                </span>
                <span>{t.text}</span>
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">{t.since}</span>
                  <Button asChild size="sm" variant={t.action.primary ? "default" : "outline"}>
                    <Link to={t.action.href}>{t.action.label}</Link>
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {ai.length || d.waiting.length ? (
        <div className="mt-1 border-t border-line pt-3 pb-1">
          <p className="text-xs font-medium text-muted-foreground">기다리는 중 · 내 할 일 아님</p>
          <ul className="mt-1.5 space-y-2 text-[13px]">
            {/* AI가 하는 중 — 공이 AI 쪽에 있다(소식이 있으면 점이 돈다) */}
            {ai.map((p) => (
              <li key={p.slug} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <strong className="min-w-0 font-semibold tab:w-[15rem] tab:shrink-0">{p.title}</strong>
                {p.turn ? <TurnIndicator turn={p.turn} className="min-w-0 flex-1" /> : null}
              </li>
            ))}
            {d.waiting.map((w) => (
              <li key={w.slug + w.text} className="flex flex-wrap items-center gap-x-2">
                <Status of="turn" value="waiting" />
                <strong className="font-semibold">{w.project_title}</strong>
                <span className="text-ink-2">{w.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

/** 표 보기(기본) — 카드와 같은 정보: 판·방식·단계·차례(차례 표시기)·AI·내 컴퓨터/사용량/참고·AI가 읽기·마지막 활동·알림 */
function ProjectsTable({ d, onRetry }: { d: ProjectsView; onRetry: () => void }) {
  return (
    <Card className="mt-3 gap-0 px-5" id="table">
      <Table regionLabel="프로젝트 표" className="min-w-[1040px]">
        <TableCaption className="sr-only">프로젝트 표 (카드와 같은 정보)</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">프로젝트</TableHead>
            <TableHead scope="col">단계 · 현재</TableHead>
            <TableHead scope="col" className="w-[236px]">차례</TableHead>
            <TableHead scope="col">AI 상태</TableHead>
            <TableHead scope="col">AI가 읽기</TableHead>
            <TableHead scope="col" className="text-right">
              마지막 활동
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {d.active.map((p) => (
            <TableRow key={p.slug}>
              <TableHead scope="row" className="max-w-[260px]">
                <Link to={p.href}>{p.title}</Link>
                <span className="mt-1 flex flex-wrap items-center gap-1 font-normal">
                  <Tag>{p.edition}판</Tag>
                  <ModeBadge mode={p.mode} detail={p.runner_label} />
                </span>
              </TableHead>
              <TableCell>
                <StageMini p={p} compact />
                <span className="mt-1 block text-xs text-muted-foreground">현재 {p.current}</span>
              </TableCell>
              <TableCell>{p.turn ? <TurnIndicator turn={p.turn} action /> : null}</TableCell>
              <TableCell>{p.table.ai}</TableCell>
              <TableCell>
                {/* 열 이름이 “AI가 읽기”라 칩은 사전의 짧은 글자(허용/막음)만 — 같은 말 반복 없음 */}
                <StatusFrom s={p.api_transfer} short />
              </TableCell>
              <TableCell className="text-right tabular-nums">{p.table.last}</TableCell>
            </TableRow>
          ))}
          {d.legacy.map((l) => (
            <TableRow key={l.title} className="bg-surface-soft">
              <TableHead scope="row">
                {l.title}
                <span className="mt-1 flex gap-1 font-normal">
                  <Tag>옛 형식</Tag>
                  <Chip shape="hsquare" tone="off">
                    읽기 전용
                  </Chip>
                </span>
              </TableHead>
              <TableCell colSpan={4} className="text-ink-2">
                {l.note}
              </TableCell>
              <TableCell className="text-right">
                <Button variant="link">옮기기 안내</Button>
              </TableCell>
            </TableRow>
          ))}
          {d.failed_cards.map((f) => (
            <TableRow key={f.code}>
              <TableHead scope="row">
                프로젝트 1개
                <span className="mt-1 block font-normal">
                  <Chip shape="square" tone="bad">
                    불러오지 못함
                  </Chip>
                </span>
              </TableHead>
              <TableCell colSpan={4} className="text-ink-2">
                이 줄만 읽지 못함 · 마지막으로 받은 시각 {f.last_received} · 오류 번호 {f.code}
              </TableCell>
              <TableCell className="text-right">
                <Button size="sm" onClick={onRetry}>
                  다시 시도
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/**
 * 프로젝트 목록(설계 4.1) — shadcn dashboard-01 블록 패턴: 요약 카드 줄 → 나의 할 일 표 → 내 프로젝트/보관됨 + 표/카드 보기.
 * 줄마다 차례 표시기(4차, 설계 15절) — 공이 왼쪽(사람)이면 나의 할 일, 오른쪽(AI)이면 AI가 하는 중.
 * 기본은 표(같은 정보), 카드 보기는 그대로 남긴다.
 */
export function ProjectsPage() {
  const q = useProjects();
  // 900px 이상은 표(dashboard-01), 휴대폰·좁은 창은 카드(표는 옆으로 밀려 단추가 가려짐). 사람이 바꾸면 그대로.
  const [view, setView] = React.useState<"table" | "cards">(() => (window.innerWidth < 900 ? "cards" : "table"));
  const [tab, setTab] = React.useState("active");

  return (
    <>
      <SectionTitle
        as="h1"
        title="프로젝트"
        right={
          <Button asChild variant="default">
            <Link to="/new">
              <PlusIcon aria-hidden="true" />새 프로젝트
            </Link>
          </Button>
        }
      />
      {q.isPending ? <QuietLoading what="프로젝트 목록" /> : null}
      {q.isError ? <LoadError what="프로젝트 목록" lastReceived="—" code="R-0001" onRetry={() => q.refetch()} /> : null}
      {q.data ? (
        <>
          <Summary d={q.data} />
          <TurnsCard d={q.data} />

          <div className="mt-8 flex flex-wrap items-center justify-between gap-2" id="cards">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList variant="line" aria-label="목록 거르기">
                <TabsTrigger value="active">내 프로젝트 {q.data.active.length}</TabsTrigger>
                <TabsTrigger value="archived">보관됨 {q.data.archived_count}</TabsTrigger>
              </TabsList>
            </Tabs>
            <ToggleGroup type="single" value={view} onValueChange={(v) => v && setView(v as "table" | "cards")} aria-label="보기 방식" variant="outline" size="sm">
              <ToggleGroupItem value="table">표</ToggleGroupItem>
              <ToggleGroupItem value="cards">카드</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {tab === "archived" ? (
            <div className="mt-3">
              <EmptyState title="보관된 프로젝트 2개" body="보관된 프로젝트는 읽기 전용입니다. 시안에서는 목록을 그리지 않았습니다." />
            </div>
          ) : view === "table" ? (
            <ProjectsTable d={q.data} onRetry={() => q.refetch()} />
          ) : (
            <section aria-label="프로젝트 카드" className="mt-3 grid grid-cols-1 items-stretch gap-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
              {q.data.active.map((p) => (
                <ProjectCardView key={p.slug} p={p} />
              ))}
              {q.data.legacy.map((l) => (
                <Card key={l.title} className="flex flex-col gap-2 border-dashed bg-surface-soft px-5" aria-labelledby="legacy-t">
                  <div className="flex flex-wrap gap-1.5">
                    <Tag>옛 형식</Tag>
                    <Chip shape="hsquare" tone="off">
                      읽기 전용
                    </Chip>
                  </div>
                  <h3 id="legacy-t" className="text-[15px]">
                    {l.title}
                  </h3>
                  <p className="text-[12.5px]">{l.note}</p>
                  <p className="mt-auto flex items-center justify-between border-t border-line pt-2 text-[12.5px] text-muted-foreground">
                    <span>옛 화면에서 열기</span>
                    <Button variant="link">옮기기 안내</Button>
                  </p>
                </Card>
              ))}
              {q.data.failed_cards.map((f) => (
                <Card key={f.code} className="flex flex-col gap-2 px-5" aria-labelledby="fail-t">
                  <p>
                    <Chip shape="square" tone="bad">
                      불러오지 못함
                    </Chip>
                  </p>
                  <h3 id="fail-t" className="text-[15px]">
                    프로젝트 1개
                  </h3>
                  <p className="text-[12.5px]">이 카드만 읽지 못함 · 마지막으로 받은 시각 {f.last_received}</p>
                  <p className="mt-auto flex items-center justify-between border-t border-line pt-2 text-[12.5px] text-muted-foreground">
                    <span>오류 번호 {f.code}</span>
                    <Button size="sm" onClick={() => q.refetch()}>
                      다시 시도
                    </Button>
                  </p>
                </Card>
              ))}
            </section>
          )}

          {/* 빈 상태 견본은 지금 장면이 아니다 — 시안 설명 상자와 함께 숨김(머리줄 “시안” 단추에서 켬). /states에도 있음 */}
          <section aria-label="빈 상태 견본" data-mock="note" className="mt-8 grid grid-cols-1 gap-4 tab:grid-cols-2" id="empty">
            <EmptyState
              eyebrow="빈 상태 · 처음 쓰는 사람"
              title="아직 프로젝트가 없습니다"
              body="두 가지로 시작할 수 있습니다. 나중에 실행마다 바꿀 수 있습니다."
              action={
                <>
                  <Button asChild variant="default">
                    <Link to="/new/a">웹에서 바로 만들기(방식 A)</Link>
                  </Button>
                  <Button asChild>
                    <Link to="/new/b">내 컴퓨터 AI로 만들기(방식 B)</Link>
                  </Button>
                </>
              }
            />
            <EmptyState eyebrow="빈 상태 · 나의 할 일" title="지금은 나의 할 일이 없습니다" body="AI가 프로젝트 2개를 하는 중입니다. 질문이 오면 알림으로 알려 드립니다." action={<Button asChild><Link to="/#cards">진행 상황 보기</Link></Button>} />
          </section>
          <Anno>
            요약 카드 4장과 나의 할 일·프로젝트 표는 shadcn dashboard-01 블록의 배치(요약 카드 줄 + 표)를 따랐다. 차례 열의 표시기는 사람(왼쪽) ↔ AI(오른쪽) 가운데 지금 공이 있는 쪽을 보이고, 바뀌면 공이 옮겨 간다(움직임 줄이기에서는 움직이지 않음 — 글자가 뜻을 전함). 시안 단추의 “차례 바뀜 장면”으로 볼 수 있다. 숫자는 모두 같은 목록 읽기에서 센 것이라 새 읽기 경로가 없다. 카드 보기는 “같은 크기 카드”(설계 4.1) 그대로다. 권한이 사라진 프로젝트는 목록에서 빠지고 알림으로 한 번 알립니다. 웹으로 옮긴 프로젝트는 내 컴퓨터의 옛 화면에서 “웹으로 옮김 — 웹에서 열기”로 보입니다. 갱신 때는 이전 화면을 둔 채 바뀐 줄만 바꿉니다(변경 알림 → 바뀐 읽기만 다시).
          </Anno>
        </>
      ) : null}
    </>
  );
}
