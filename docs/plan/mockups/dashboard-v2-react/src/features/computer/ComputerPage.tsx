import { useComputer } from "@/api/queries";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, SectionTitle } from "@/components/pes/bits";
import { FoldCard, InfoTip } from "@/components/pes/disclosure";
import { LoadError, QuietLoading } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { Status, StatusFrom } from "@/components/pes/status";
import { STATUS } from "@/components/pes/status-registry";
import { useMockSettings } from "@/lib/mock-settings";

/** 내 컴퓨터 연결 /computer(설계 4.11) — 기기 · 도우미 · AI 도구 · 동기화 폴더 · 기기 승인 기록 */
export function ComputerPage() {
  const q = useComputer();
  const settings = useMockSettings();
  const owner = settings.role === "owner";
  if (q.isPending) return <div className="mt-3"><QuietLoading what="내 컴퓨터" /></div>;
  if (q.isError || !q.data) return <div className="mt-3"><LoadError what="내 컴퓨터" lastReceived="—" code="C-0001" onRetry={() => q.refetch()} /></div>;
  const c = q.data;
  return (
    <>
      <SectionTitle
        as="h1"
        title="내 컴퓨터"
        sub={
          <span className="inline-flex flex-wrap items-center gap-1">
            방식 B의 기기 · 연결 · 동기화
            <InfoTip label="폴더 이름 설명">
              <p>폴더는 사람이 붙인 이름만 보이고, 내 컴퓨터의 실제 경로는 웹에 보내지 않습니다.</p>
            </InfoTip>
          </span>
        }
      />
      <Card className="gap-0 px-5">
        <Table regionLabel="기기 목록" className="min-w-[640px]">
          <TableCaption>기기</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">기기</TableHead>
              <TableHead scope="col">도우미</TableHead>
              <TableHead scope="col">연결</TableHead>
              <TableHead scope="col">마지막 확인</TableHead>
              <TableHead scope="col" className="text-right">연결된 프로젝트</TableHead>
              <TableHead scope="col">동작</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.devices.map((d) => (
              <TableRow key={d.name}>
                <TableHead scope="row">{d.name}</TableHead>
                <TableCell>{d.helper}</TableCell>
                <TableCell>
                  <StatusFrom s={d.status} />
                </TableCell>
                <TableCell>{d.checked}</TableCell>
                <TableCell className="text-right tabular-nums">{d.projects}</TableCell>
                <TableCell>
                  {d.status.value === "revoked" ? (
                    "—"
                  ) : (
                    <span className="flex flex-wrap gap-1.5">
                      <ActionButton size="sm">일시 중지</ActionButton>
                      <ActionButton size="sm" variant="destructive" blockedBy={owner ? null : "연결 해제는 소유자(또는 같은 기기)만 할 수 있습니다."}>
                        연결 해제
                      </ActionButton>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <div className="mt-3 grid grid-cols-1 gap-3 desk:grid-cols-2">
        <Card className="gap-0 px-5">
          <Table regionLabel="프로젝트별 연결">
            <TableCaption>프로젝트별 연결</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">프로젝트</TableHead>
                <TableHead scope="col">동기화 폴더</TableHead>
                <TableHead scope="col">AI 도구</TableHead>
                <TableHead scope="col">금지 파일 통제</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.links.map((l) => (
                <TableRow key={l.project}>
                  <TableCell>{l.project}</TableCell>
                  <TableCell>{l.folder}</TableCell>
                  <TableCell>{l.tool}</TableCell>
                  <TableCell>
                    <StatusFrom s={l.scope} />
                    <span className="block text-xs text-muted-foreground">{l.scope_note}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <Card className="gap-0 px-5">
          <Table regionLabel="기기 승인 기록">
            <TableCaption>기기 승인 기록</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">시각</TableHead>
                <TableHead scope="col">기기 · 도구</TableHead>
                <TableHead scope="col">결과</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.approvals.map((a) => (
                <TableRow key={a.at}>
                  <TableCell className="tabular-nums">{a.at}</TableCell>
                  <TableCell>{a.device}</TableCell>
                  <TableCell>
                    <StatusFrom s={a.result} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
      {/* 상태 표시의 뜻(사전)은 자주 보지 않으므로 접는다(정보 밀도 14절) */}
      <FoldCard className="mt-6" title="연결 상태 표시의 뜻" meta={`${Object.keys(STATUS.computer).length}가지 · 도우미 · AI 도구 · 업무 실행은 서로 다른 사실`}>
        <Table regionLabel="내 컴퓨터 카드 상태">
          <TableCaption className="sr-only">내 컴퓨터 카드 (방식 B)</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-[28%]">표시</TableHead>
              <TableHead scope="col">언제(근거)</TableHead>
              <TableHead scope="col">사람이 할 일</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(STATUS.computer).map(([v, d]) => (
              <TableRow key={v}>
                <TableCell>
                  <Status of="computer" value={v} wrap />
                </TableCell>
                <TableCell>{d.basis}</TableCell>
                <TableCell>{d.todo ?? "없음"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Anno>“AI 미접속”은 도우미가 AI 도구 연결이 없다고 확인해 알렸을 때만 씁니다. 활동이 오래됐을 뿐이면 “AI 접속 미확인 · 마지막 호출 hh:mm”으로 보입니다(긴 추론·정상 대기·heartbeat 없는 앱). 기준 시간은 서버가 capabilities로 알려 주는 시험값(WEB15·SEL-19)입니다.</Anno>
      </FoldCard>
    </>
  );
}
