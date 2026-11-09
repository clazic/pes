import * as React from "react";
import { useLocation } from "react-router";
import { FolderIcon, FolderOpenIcon, UploadIcon } from "lucide-react";
import { useCommand, useMaterials } from "@/api/queries";
import { computeAccess, DEST_LABEL, DESTS, POLICY_CASES } from "@/api/policy";
import type { FileRow, MaterialsView } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Anno, CardHead, Hint, SectionTitle } from "@/components/pes/bits";
import { Callout, LoadError, NowCard, QuietLoading, StatBar } from "@/components/pes/blocks";
import { FoldCard, InfoTip, MoreContent, MoreList, MoreRoot, MoreTrigger } from "@/components/pes/disclosure";
import { ConfirmDialog, type ConfirmSpec } from "@/components/pes/confirm";
import { Meter, StateSwitch } from "@/components/pes/controls";
import { Status, StatusFrom } from "@/components/pes/status";
import { STATUS } from "@/components/pes/status-registry";
import { useMockSettings } from "@/lib/mock-settings";
import { cn } from "@/lib/utils";
import { useWs, WorkspaceFrame } from "@/features/workspace/WorkspaceLayout";
import { UploadDialog } from "./UploadDialog";

type Filter = "all" | "deny" | "extract" | "sync";

/** 정책 조합 표 — 규칙 전체라 접어 둔다(정보 밀도 14절). 파일마다의 결론은 자료 표의 AI 참조 열과 이력 카드에 있다. */
function PolicyMatrix({ apiOn }: { apiOn: boolean }) {
  return (
    <FoldCard id="where" className="mt-3" title="실제로 AI에 가나요?" meta="엄격한 쪽 우선 · 목적지별 정책 조합">
      <p className="mb-2 flex flex-wrap items-center gap-2 text-meta text-ink-2">
        AI가 읽기(프로젝트) · AI 참조(파일) · 참고 원본 정책 중 더 엄격한 쪽을 따릅니다. 서버가 목적지별로 계산합니다.
        <Status of="transfer" value={apiOn ? "on" : "off"} label={`이 프로젝트: ${STATUS.transfer[apiOn ? "on" : "off"]!.label}`} />
      </p>
      <Table regionLabel="정책 조합 표" className="min-w-[880px]">
        <TableCaption className="sr-only">정책 조합별 AI 제공 여부</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-[19%]">
              경우
            </TableHead>
            {DESTS.map((d) => (
              <TableHead key={d} scope="col">
                {DEST_LABEL[d]}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {POLICY_CASES.map((c) => (
            <TableRow key={c.id}>
              <TableHead scope="row">{c.label}</TableHead>
              {DESTS.map((d) => {
                const r = computeAccess(d, c);
                return (
                  <TableCell key={d}>
                    <StatusFrom s={r.status} wrap />
                    <span className="mt-0.5 block text-xs text-muted-foreground">{r.reason}</span>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Anno>
        “방식 B · API 목적지”는 B 도구가 PES에 등록된 것과 같은 API로 보내는 경우(예: OpenCode TUI·앱이 구독형 API 모델을 씀)입니다. 도구의 목적지를 모르면 API 목적지로 보고 막습니다. 금지 파일은 내 컴퓨터로 자동으로 내려보내지 않고(추천 (a)), 사람이 웹에서 열거나 직접 받습니다. 금지 파일을 AI 작업 폴더에 주는 선택지는 두지 않습니다(Codex F02). 어느 쪽이든 PES가 막을 수 없는 경로(이미 받은 사본·다른 폴더)가 있으므로 “A·B 모두 제외 보장”이라고 쓰지 않습니다.
      </Anno>
    </FoldCard>
  );
}

function offSpec(files: FileRow[], folder?: string): ConfirmSpec {
  const one = files.length === 1 ? files[0]! : null;
  return {
    eyebrow: "소유자만",
    title: one ? `“${one.name}”의 AI 참조를 끌까요?` : `폴더 “${folder}”의 파일 ${files.length}개 AI 참조를 끌까요?`,
    target: one ? `${one.name} · ${one.version} · AI 참조 정책 rev 1` : `${folder}/ · 파일 ${files.length}개 · 한 tx`,
    verb: "AI 참조 끄기",
    changes: [
      "지금부터 방식 A의 API 호출 맥락에서 뺍니다.",
      "PES를 거치는 방식 B 도구(MCP)와 브라우저 보조(WebMCP) 응답에서 뺍니다.",
      "내 컴퓨터 도우미가 이 파일을 AI 작업 폴더로 받지 않습니다.",
    ],
    unchanged: [
      <span key="r">
        <strong>이미 나간 내용은 회수되지 않습니다.</strong> PES가 관측한 경로의 나간 기록: 11-04 14:10 방식 A 기획 R1 맥락 · 11-04 16:02 Claude Code가 PES를 거쳐 읽음. 파일을 읽은 기록이 모델에 보낸 증거는 아니고, 내 컴퓨터에서 직접 읽은 것은 PES가 모릅니다 — 기록이 없다고 “나간 적 없음”은 아닙니다(R03).
      </span>,
      "내 컴퓨터 AI 작업 폴더에 이미 받은 사본은 저절로 지우지 않습니다. 도우미가 “사람용 폴더로 옮기기”를 제안합니다.",
      "이 파일을 근거로 쓴 결과물에 “AI 참조를 끄기 전에 쓰인 근거” 표시가 붙습니다.",
      "사람은 계속 열어 보고 직접 인용할 수 있습니다.",
    ],
    reasonDefault: one?.id === "f4" ? "" : undefined,
    stepUp: true,
    tightening: true,
    danger: true,
    footnote: "끄기는 휴대폰에서도 됩니다. 정책 변경이므로 이 요청 한 건에 대한 본인 확인은 생략하지 않습니다(Codex F01). 다시 허용은 데스크톱에서 이유를 적고 같은 확인을 거칩니다.",
  };
}

function onSpec(files: FileRow[], folder?: string): ConfirmSpec {
  const one = files.length === 1 ? files[0]! : null;
  return {
    eyebrow: "소유자만 · 데스크톱에서",
    title: one ? `“${one.name}”의 AI 참조를 다시 허용할까요?` : `폴더 “${folder}”의 파일 ${files.length}개 AI 참조를 다시 허용할까요?`,
    target: one ? `${one.name} · ${one.version} · AI 참조 정책 새 rev` : `${folder}/ · 파일 ${files.length}개 · 한 tx`,
    verb: "AI 참조 다시 허용",
    changes: ["허용된 경로(방식 A · PES 경유 B · AI 작업 폴더 동기화)에 다시 내줍니다."],
    unchanged: ["끄기 전·후의 이력은 지우지 않습니다.", "AI가 읽기: 막음 같은 프로젝트 정책은 그대로 따릅니다(엄격한 쪽)."],
    reasonRequired: true,
    stepUp: true,
  };
}

function FilesTable({ m, filter, query, onAccess }: { m: MaterialsView; filter: Filter; query: string; onAccess: (files: FileRow[], next: "allow" | "deny", folder?: string) => void }) {
  const settings = useMockSettings();
  const owner = settings.role === "owner";
  const blocked = owner ? null : "AI 참조는 소유자만 바꿀 수 있습니다. 지금 상태는 볼 수 있고, 바꿔야 하면 첨언으로 소유자에게 알리세요.";
  const rows = m.files.filter((f) => {
    if (query && !f.name.includes(query) && !(f.folder ?? "").includes(query)) return false;
    if (filter === "deny") return f.access === "deny";
    if (filter === "extract") return ["partial", "failed", "unsupported"].includes(f.extract.value);
    if (filter === "sync") return f.pc && ["conflict", "pending", "skipped"].includes(f.pc.value);
    return true;
  });
  const loose = rows.filter((f) => !f.folder);
  const folders = new Map<string, FileRow[]>();
  for (const f of rows.filter((x) => x.folder)) {
    const top = f.folder!.split("/")[0]!;
    folders.set(top, [...(folders.get(top) ?? []), f]);
  }

  const fileRow = (f: FileRow, indent?: boolean) => (
    <TableRow key={f.id} id={f.id} data-state={f.id === "f2" ? "selected" : undefined}>
      <TableCell>
        <span className={cn("flex items-start gap-2", indent && "pl-5")}>
          <span className="inline-flex h-[22px] min-w-[42px] shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface-soft px-1.5 text-caption font-semibold text-ink-2 uppercase">{f.format}</span>
          <span className="min-w-0 break-all">
            {f.name}
            <span className="block text-xs text-muted-foreground">
              {indent && f.folder && f.folder.includes("/") ? `${f.folder.split("/").slice(1).join("/")}/ · ` : ""}
              {f.version} · {f.size}
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {f.by} · {f.at}
      </TableCell>
      <TableCell>
        <StatusFrom s={f.extract} />
        {f.upload_percent != null ? <Progress className="mt-1 h-1.5" value={f.upload_percent} aria-label={`올리기 ${f.upload_percent}%`} /> : null}
        {/* 정보 밀도(14절): 문제가 있을 때만 이유 한 줄(“시트 4 · 표 6” 같은 정상 세부는 보기 화면에) */}
        {f.extract_note && f.extract.value !== "ready" ? <span className="block text-xs text-muted-foreground">{f.extract_note}</span> : null}
      </TableCell>
      <TableCell>
        {f.access === "na" ? (
          <Status of="aiAccess" value="na" />
        ) : (
          <StateSwitch checked={f.access === "allow"} onLabel="허용" offLabel="금지" name={`AI 참조: ${f.name}`} blockedBy={blocked} onRequest={(next) => onAccess([f], next ? "allow" : "deny")} />
        )}
        {f.access_note && f.access !== "allow" ? <span className="block text-xs text-muted-foreground">{f.access_note}</span> : null}
      </TableCell>
      <TableCell>
        {f.used}
        {f.used_note ? <span className="block text-xs text-muted-foreground">{f.used_note}</span> : null}
      </TableCell>
      <TableCell>{f.pc ? <StatusFrom s={f.pc} /> : "—"}</TableCell>
      <TableCell>{f.action === "—" ? "—" : <Button variant="link">{f.action}</Button>}</TableCell>
    </TableRow>
  );

  return (
    <Table regionLabel="내 자료 목록" className="min-w-[920px]">
      <TableCaption>
        내 자료 {m.files.length}개{rows.length !== m.files.length ? ` · 걸러서 ${rows.length}개` : ""}
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-[26%]">파일</TableHead>
          <TableHead scope="col">올린 사람·시각</TableHead>
          <TableHead scope="col" className="w-[20%]">글자 뽑기</TableHead>
          <TableHead scope="col" className="w-[15%]">AI 참조</TableHead>
          <TableHead scope="col">쓰인 곳</TableHead>
          <TableHead scope="col">내 컴퓨터</TableHead>
          <TableHead scope="col">동작</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loose.map((f) => fileRow(f))}
        {[...folders.entries()].map(([folder, list]) => {
          const allowN = list.filter((f) => f.access === "allow").length;
          const denyN = list.filter((f) => f.access === "deny").length;
          const switchable = list.filter((f) => f.access !== "na");
          return (
            <React.Fragment key={folder}>
              <TableRow className="bg-surface-soft">
                <TableCell colSpan={3}>
                  <span className="flex items-center gap-2 font-semibold">
                    <FolderIcon className="size-4" aria-hidden="true" />
                    {folder}/ <span className="font-normal text-muted-foreground">· 폴더째 올림 · 파일 {list.length}개</span>
                  </span>
                </TableCell>
                <TableCell colSpan={4}>
                  <span className="flex flex-wrap items-center gap-2">
                    {denyN === 0 ? <Status of="aiAccess" value="allow" label={`모두 허용 ${allowN}`} /> : allowN === 0 ? <Status of="aiAccess" value="deny" label={`모두 금지 ${denyN}`} /> : <Status of="aiAccess" value="mixed" label={`허용 ${allowN} · 금지 ${denyN}`} />}
                    <Button size="sm" aria-disabled={!owner || undefined} onClick={() => owner && onAccess(switchable.filter((f) => f.access !== "allow"), "allow", folder)}>
                      폴더 전체 허용
                    </Button>
                    <Button size="sm" aria-disabled={!owner || undefined} onClick={() => owner && onAccess(switchable.filter((f) => f.access !== "deny"), "deny", folder)}>
                      폴더 전체 금지
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
              {list.map((f) => fileRow(f, true))}
            </React.Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function MaterialsPage() {
  const { ws } = useWs();
  const q = useMaterials(ws.slug);
  const { hash } = useLocation();
  const settings = useMockSettings();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [upload, setUpload] = React.useState<null | "files" | "folder">(null);
  const [pending, setPending] = React.useState<{ files: FileRow[]; next: "allow" | "deny"; folder?: string } | null>(null);
  const [gapsOnly, setGapsOnly] = React.useState(false);
  const [page, setPage] = React.useState(7);
  const access = useCommand("file_ai_access_set");

  React.useEffect(() => {
    if (hash === "#upload") setUpload("files");
  }, [hash]);

  if (q.isPending) return <WorkspaceFrame active="files"><QuietLoading what="자료" /></WorkspaceFrame>;
  if (q.isError || !q.data) return <WorkspaceFrame active="files"><LoadError what="자료" lastReceived="—" code="M-0001" onRetry={() => q.refetch()} /></WorkspaceFrame>;
  const m = q.data;
  const spec = pending ? (pending.next === "deny" ? offSpec(pending.files, pending.folder) : onSpec(pending.files, pending.folder)) : null;
  const editor = settings.role !== "owner";
  const f4 = m.files.find((f) => f.id === "f4");
  const kpi = (k: string) => m.kpi.find((x) => x.k === k);

  return (
    <WorkspaceFrame active="files">
      {/* 제목·현재 진행·AI가 읽기는 프로젝트 머리에 이미 있다(같은 말 반복 없음) */}
      <SectionTitle as="h2" title="자료" className="mt-6" />
      <NowCard now={m.now} titleId="mat-now" context="자료" />

      <Tabs defaultValue="mine" className="mt-4">
        <TabsList variant="line" aria-label="자료 묶음">
          <TabsTrigger value="mine">내 자료 {m.files.length}</TabsTrigger>
          <TabsTrigger value="ref">참고 프로젝트에서 온 자료 {m.from_refs.length}</TabsTrigger>
        </TabsList>
        <TabsContent value="mine">
          {/* 요약 5칸 → 핵심 4칸(정보 밀도 14절). 각 칸의 보조 설명은 “자세히” */}
          <MoreRoot className="mt-3">
            <StatBar
              label="자료 요약"
              cells={[
                { k: "자료", v: kpi("자료")?.v ?? "—" },
                { k: "AI 참조", v: `허용 ${kpi("AI 참조 허용")?.v ?? "—"} · 금지 ${kpi("AI 참조 금지")?.v ?? "—"}`, to: "#off" },
                { k: "글자 뽑기 확인", v: kpi("글자 뽑기 확인 필요")?.v ?? "—", to: "#preview" },
                {
                  k: "웹 저장 공간",
                  v: (
                    <span className="block">
                      {kpi("웹 저장 공간")?.v ?? "—"}
                      {kpi("웹 저장 공간")?.meter != null ? <Meter percent={kpi("웹 저장 공간")!.meter!} label={`웹 저장 공간 ${kpi("웹 저장 공간")!.meter}% 사용, 상한 2GB(예시값)`} compact className="mt-1.5" /> : null}
                    </span>
                  ),
                },
              ]}
              trailing={<MoreTrigger label="자세히" name="자료 요약 자세히" />}
            />
            <MoreContent className="mt-2 rounded-xl border bg-card px-4 py-3">
              <MoreList items={m.kpi.map((k) => [`${k.k} ${k.v}`, k.s] as [string, string])} />
            </MoreContent>
          </MoreRoot>

          <PolicyMatrix apiOn={ws.api_transfer.value === "on"} />

          <div role="group" aria-label="자료 도구" className="mt-3.5 mb-2.5 flex flex-wrap items-center gap-2">
            <Button variant="default" onClick={() => setUpload("files")} id="upload">
              <UploadIcon aria-hidden="true" />
              자료 올리기
            </Button>
            <Button onClick={() => setUpload("folder")}>
              <FolderOpenIcon aria-hidden="true" />
              폴더째 올리기
            </Button>
            <Label htmlFor="fsearch" className="sr-only">
              자료 찾기
            </Label>
            <Input id="fsearch" type="search" placeholder="파일·폴더 이름으로 찾기" className="max-w-[260px]" value={query} onChange={(e) => setQuery(e.target.value)} />
            {(
              [
                ["all", "전체"],
                ["deny", "AI 참조 금지"],
                ["extract", "글자 뽑기 확인 필요"],
                ["sync", "동기화 문제"],
              ] as [Filter, string][]
            ).map(([k, label]) => (
              <Button key={k} size="sm" aria-pressed={filter === k} className={cn("rounded-full", filter === k && "border-primary bg-primary-soft text-primary-ink")} onClick={() => setFilter(k)}>
                {label}
              </Button>
            ))}
            <InfoTip label="올리기 상한 · 형식">
              <p>파일당 25MB · 형식: hwpx·hwp·pdf·docx·xlsx·pptx·csv·txt·md (doc·xls·ppt는 시험 뒤 결정).</p>
              <p className="text-muted-foreground">상한은 예시값이며 사용자 결정이 필요합니다. 원본은 그대로 보관하고 AI에는 뽑은 글자만 갑니다.</p>
            </InfoTip>
          </div>
          {editor ? (
            <Callout tone="off" className="mb-2.5">
              AI 참조는 소유자만 바꿀 수 있습니다. 바꿔야 하면 첨언으로 소유자에게 알리세요.
            </Callout>
          ) : null}

          <Card className="gap-0 px-5">
            <FilesTable m={m} filter={filter} query={query} onAccess={(files, next, folder) => files.length && setPending({ files, next, folder })} />
            {m.failed_upload ? (
              <Callout tone="bad" className="mt-2.5">
                <strong>올리지 못함 1</strong> · {m.failed_upload}
              </Callout>
            ) : null}
          </Card>

          <div className="mt-3.5 grid grid-cols-1 items-start gap-3.5 wide:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <Card id="preview" className="gap-0 px-5" aria-labelledby="pv-t">
              <CardHead
                eyebrow="글자 뽑기 미리보기"
                title="선행연구 요약(가상).pdf"
                aside={
                  <InfoTip label="뽑기 정보">
                    <p>v1 · 지문 7c2e… · pdf 글자층 뽑기 · 이 브라우저에서 11-03 16:40 · 뽑은 글자는 별도 버전으로 저장</p>
                  </InfoTip>
                }
                titleId="pv-t"
                right={<Status of="extract" value="partial" />}
              />
              <Callout tone="warn">
                <p>
                  <strong>빠진 곳 3가지</strong> · AI에게도 “빠진 곳 있음”을 알림
                </p>
                <ul className="mt-1 ml-4.5 list-disc text-caption">
                  <li>3·7·19쪽: 글자가 없는 그림(스캔) — AI가 이 쪽을 읽지 못합니다.</li>
                  <li>12쪽 표: 칸이 합쳐져 4개 중 1개는 일부만 뽑혔습니다.</li>
                  <li>각주 31개 중 28개만 본문과 이어졌습니다.</li>
                </ul>
              </Callout>
              <div role="group" aria-label="쪽 이동" className="mt-2.5 flex flex-wrap items-center gap-1.5 text-caption">
                <Button size="sm" aria-disabled={page <= 1 || undefined} onClick={() => setPage((p) => (gapsOnly ? ([3, 7, 19].reverse().find((x) => x < p) ?? p) : Math.max(1, p - 1)))}>
                  이전 쪽
                </Button>
                <span role="status">
                  <strong>{page}</strong> / 24쪽
                </span>
                <Button size="sm" aria-disabled={page >= 24 || undefined} onClick={() => setPage((p) => (gapsOnly ? ([3, 7, 19].find((x) => x > p) ?? p) : Math.min(24, p + 1)))}>
                  다음 쪽
                </Button>
                <Button size="sm" aria-pressed={gapsOnly} onClick={() => setGapsOnly((g) => !g)}>
                  빠진 곳만 보기
                </Button>
              </div>
              <div className="mt-2.5 grid grid-cols-1 gap-2.5 tab:grid-cols-2">
                <div>
                  <p className="text-caption font-semibold">원본 {page}쪽</p>
                  <div className="flex min-h-[220px] items-center justify-center rounded-lg border border-line bg-[repeating-linear-gradient(135deg,var(--surface-soft),var(--surface-soft)_8px,var(--surface-sunk)_8px,var(--surface-sunk)_16px)] p-3 text-center text-meta text-muted-foreground">
                    원본 쪽 그림 자리
                    <br />
                    (시안에서는 그림을 넣지 않음)
                  </div>
                </div>
                <div>
                  <p className="text-caption font-semibold">AI가 읽는 글자</p>
                  <div className="min-h-[220px] rounded-lg border border-line bg-surface px-3 py-2.5 text-meta leading-relaxed">
                    {[3, 7, 19].includes(page) ? (
                      <span className="my-2 block rounded-md border border-dashed border-warn-line bg-warn-soft px-2 py-1.5 text-xs font-medium text-warn">이 쪽은 글자층이 없습니다(스캔). 뽑은 글자 없음.</span>
                    ) : (
                      <p>“표 {page}은 가상의 12개 시군 자료를 정리한 것이다. 이직률은 근무 형태별로 다르게 나타났다.”(합성 예시)</p>
                    )}
                    <p className="text-xs text-muted-foreground">앞쪽 끝 문장: “…지역별 이직률 차이는 근무 형태에서 크게 나타났다.”</p>
                  </div>
                </div>
              </div>
              <p className="mt-2 flex items-center gap-1 text-caption text-muted-foreground">
                글자가 있는 PDF로 다시 올리면 새 버전(v2) — v1은 남음
                <InfoTip label="스캔 쪽 설명">
                  <p>스캔 쪽의 글자 인식(OCR)은 나중 선택입니다. 실제 글자 뽑기 라이브러리는 이 화면에서만 따로 불러오는 웹 워커에서 돕니다(0017).</p>
                </InfoTip>
              </p>
            </Card>

            <section className="space-y-3" id="off" aria-label="AI 참조 이력과 효과">
              <Card className="gap-0 px-5">
                <Table regionLabel="AI 참조 이력">
                  <TableCaption>AI 참조 이력 · 내부 검토 의견(가상).docx (지울 수 없음)</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">번호</TableHead>
                      <TableHead scope="col">상태</TableHead>
                      <TableHead scope="col">바꾼 사람·시각</TableHead>
                      <TableHead scope="col">이유</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.history.map((h) => (
                      <TableRow key={h.no}>
                        <TableCell className="tabular-nums">{h.no}</TableCell>
                        <TableCell>
                          <StatusFrom s={h.state} />
                        </TableCell>
                        <TableCell>{h.who}</TableCell>
                        <TableCell>{h.why}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="지금 이 파일의 실제 효과">
                  {f4?.access === "deny" ? (
                    <>
                      <Status of="generic" value="not_sent" label="방식 A: 안 보냄" />
                      <Status of="generic" value="not_given" label="방식 B(PES 경유): 안 내줌" />
                      <Status of="generic" value="not_received_limited" label="내 컴퓨터: 안 받음 · 사본 1 남음" />
                      <Status of="generic" value="visible" label="사람: 볼 수 있음" />
                    </>
                  ) : (
                    <Status of="aiAccess" value="allow" label="지금 허용 — 모든 통제 경로에 내줌" />
                  )}
                </div>
              </Card>
              {/* 권한 없는 사람용 안내는 그 역할로 볼 때만(14절) — 소유자에게는 시안 설명 상자로만 견본을 둔다 */}
              {!editor ? (
                <Card className="gap-0 px-5" data-mock="note">
                  <h3 className="text-sm">견본 · 편집자(박검토)에게 보이는 모습</h3>
                  <p className="mt-2">
                    <StateSwitch checked onLabel="허용" offLabel="금지" name="AI 참조(견본): 2024 지역별 돌봄 인력 현황" blockedBy="AI 참조는 소유자만 바꿀 수 있습니다." />
                  </p>
                  <Hint>AI 참조는 소유자만 바꿀 수 있습니다. 지금 상태는 볼 수 있고, 바꿔야 하면 첨언으로 소유자에게 알리세요.</Hint>
                </Card>
              ) : null}
            </section>
          </div>
        </TabsContent>
        <TabsContent value="ref">
          <Card className="mt-3 gap-0 px-5" aria-labelledby="fr-t">
            <CardHead eyebrow="참고 프로젝트에서 온 자료 · 읽기 전용" title="원본 프로젝트의 스위치를 따릅니다" titleId="fr-t" right={<span className="text-xs font-medium text-muted-foreground">이 화면에서 바꿀 수 없음</span>} />
            <Table regionLabel="참고 프로젝트 자료" className="min-w-[680px]">
              <TableCaption className="sr-only">참고 프로젝트에서 온 자료</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">파일</TableHead>
                  <TableHead scope="col">참고 프로젝트 · 고정한 버전</TableHead>
                  <TableHead scope="col">원본 AI 참조</TableHead>
                  <TableHead scope="col">이 프로젝트에서 AI에 가나</TableHead>
                  <TableHead scope="col">상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.from_refs.map((r) => (
                  <TableRow key={r.file}>
                    <TableCell>{r.file}</TableCell>
                    <TableCell>{r.ref}</TableCell>
                    <TableCell>{r.origin_access ? <StatusFrom s={r.origin_access} /> : "—"}</TableCell>
                    <TableCell>{r.effect}</TableCell>
                    <TableCell>
                      <StatusFrom s={r.status} />
                      {r.status_note ? <span className="block text-xs text-muted-foreground">{r.status_note}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      {/* 상태 견본(시안) — 시안 설명 상자와 함께 숨김. 상태 사전 전체는 /states */}
      <div data-mock="note">
      <SectionTitle title="자료 상태 견본" sub="올리기 · 글자 뽑기 · AI 참조는 서로 다른 사실이라 따로 표시합니다." />
      <div className="grid grid-cols-1 gap-3 tab:grid-cols-3">
        {(["upload", "extract", "aiAccess"] as const).map((dom) => (
          <Card key={dom} className="gap-0 px-5">
            <Table>
              <TableCaption>{{ upload: "올리기", extract: "글자 뽑기", aiAccess: "AI 참조" }[dom]}</TableCaption>
              <TableBody>
                {Object.entries(STATUS[dom]).map(([v, d]) => (
                  <TableRow key={v}>
                    <TableCell>
                      <Status of={dom} value={v} />
                    </TableCell>
                    <TableCell>{d.basis ?? ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ))}
      </div>
      </div>

      <UploadDialog open={upload !== null} onOpenChange={(o) => !o && setUpload(null)} slug={ws.slug} existing={m.files} startMode={upload ?? undefined} />
      {pending && spec ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setPending(null);
              access.reset();
            }
          }}
          spec={spec}
          phase={access.phase}
          receipt={access.receipt}
          errorText={access.error?.message}
          onRecheck={access.recheck}
          onConfirm={(reason, stepUp) => access.run({ slug: ws.slug, file_ids: pending.files.map((f) => f.id), access: pending.next, reason, step_up: stepUp })}
        />
      ) : null}
    </WorkspaceFrame>
  );
}
