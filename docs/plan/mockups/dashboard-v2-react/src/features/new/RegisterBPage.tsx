import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, ModeBadge, SectionTitle, Tag } from "@/components/pes/bits";
import { InfoTip, More } from "@/components/pes/disclosure";
import { Status } from "@/components/pes/status";

const TOOLS: { tool: string; how: string; test: string; ctrl: "limited" | "checking"; ctrlNote?: string; note: string }[] = [
  { tool: "Claude Code", how: "PES MCP 직접 · 도우미 선택", test: "PR20a 시험", ctrl: "limited", ctrlNote: "폴더 직접 읽기 가능", note: "6단계 전체 기준 도구" },
  { tool: "Claude 앱", how: "로컬 확장 · 원격 커넥터(5단계) · 안 되면 복사", test: "PR20a 시험", ctrl: "checking", note: "복사만으로는 전달 확인 아님" },
  { tool: "Codex CLI", how: "PES MCP 직접", test: "PR20b 시험", ctrl: "limited", note: "모델·사용량은 도구가 알린 값" },
  { tool: "Codex 앱", how: "직접 연결 확인 중 · 안 되면 복사", test: "PR20c 시험", ctrl: "checking", note: "설정 공유 미확인" },
  { tool: "OpenCode TUI", how: "PES MCP 직접", test: "PR20b 시험", ctrl: "limited", note: "같은 API로 보내면 AI가 읽기 정책 적용 · 목적지 모르면 막음" },
  { tool: "OpenCode 앱", how: "직접 연결 확인 중 · 안 되면 복사", test: "PR20c 시험", ctrl: "checking", note: "API 목적지면 AI가 읽기 정책" },
];

/** 방식 B 등록 안내(설계 4.4) */
export function RegisterBPage() {
  return (
    <>
      <SectionTitle as="h1" title="내 컴퓨터 AI로 만들고 웹에 등록하기" sub="연결은 내 컴퓨터가 먼저 겁니다." right={<ModeBadge mode="B" detail="내 컴퓨터 AI" />} />
      <div className="grid grid-cols-1 gap-3 desk:grid-cols-2">
        <Card className="gap-0 px-5" aria-labelledby="b-steps">
          <h2 id="b-steps" className="text-title">
            순서
          </h2>
          <ol className="mt-2 ml-5 list-decimal space-y-2 text-sm">
            <li>
              <strong>로그인</strong> — 내 컴퓨터에서 한 번. 브라우저에 “기기 승인”이 뜹니다.
              <code className="mt-1 block rounded-md bg-foreground px-2.5 py-1.5 text-meta text-background">pes login</code>
            </li>
            <li>
              <strong>만들기</strong> — AI 도구에서 시작합니다(예: Claude Code).
              <code className="mt-1 block rounded-md bg-foreground px-2.5 py-1.5 text-meta text-background">/pes:start 지역 돌봄 인력 수급</code>
            </li>
            <li>
              <strong>코드 확인</strong> — 내 컴퓨터와 웹의 코드가 같은지 봅니다.
            </li>
            <li>
              <strong>승인</strong> — 같을 때만. 프로젝트가 등록되고 내가 소유자가 됩니다.
            </li>
            <li>
              <span className="inline-flex flex-wrap items-center gap-1">
                <strong>이어 하기</strong> — 답·승인은 웹, AI는 내 컴퓨터에서.
                <InfoTip label="이어 하기 설명">
                  <p>도우미가 AI 도구 연결이 없다고 알리면 “AI 미접속 · 대기 중”, 소식이 오래됐을 뿐이면 “AI 접속 미확인”으로 보입니다.</p>
                </InfoTip>
              </span>
            </li>
          </ol>
          <div className="mt-3">
            <Button asChild variant="default">
              <Link to="/device">기기 승인 화면 보기</Link>
            </Button>
          </div>
        </Card>
        <Card className="gap-0 px-5" aria-labelledby="b-cost">
          <h2 id="b-cost" className="text-title">
            알아 둘 것
          </h2>
          <ul className="mt-2 ml-4.5 list-disc space-y-1 text-sm">
            <li>AI 비용은 각 도구의 구독 — <strong>PES가 멈출 수 없음</strong></li>
            <li>폴더를 직접 읽는 도구는 금지 파일 통제가 “제한 있음”</li>
          </ul>
          <More className="mt-1.5" name="알아 둘 것 자세히">
            <ul className="ml-4.5 list-disc space-y-0.5">
              <li>AI 참조 금지 파일은 PES를 거쳐서는 내주지 않지만, 내 컴퓨터 폴더를 직접 읽는 도구는 PES가 통제할 수 없습니다.</li>
              <li>브라우저 탭 안 보조(WebMCP)는 내 컴퓨터 연결을 대신하지 않습니다.</li>
              <li>2~4단계 로컬은 같은 등록을 로컬 PES에 합니다.</li>
            </ul>
          </More>
        </Card>
      </div>
      <Card className="mt-3 gap-0 px-5">
        <Table regionLabel="방식 B 도구 6가지" className="min-w-[720px]">
          <TableCaption>방식 B 도구 6가지 — 연결 방법과 한계</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">도구</TableHead>
              <TableHead scope="col" className="w-[30%]">연결 방법</TableHead>
              <TableHead scope="col">확인 상태</TableHead>
              <TableHead scope="col">AI 참조 금지 통제</TableHead>
              <TableHead scope="col" className="w-[26%]">알아 둘 것</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TOOLS.map((t) => (
              <TableRow key={t.tool}>
                <TableHead scope="row">{t.tool}</TableHead>
                <TableCell>{t.how}</TableCell>
                <TableCell>
                  <Tag>{t.test}</Tag>
                </TableCell>
                <TableCell>
                  <Status of="generic" value={t.ctrl} />
                  {t.ctrlNote ? <span className="block text-xs text-muted-foreground">{t.ctrlNote}</span> : null}
                </TableCell>
                <TableCell>{t.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Anno>OpenCode TUI·앱이 PES에 등록된 것과 같은 API로 보내는지는 도구가 알린 값으로만 압니다. 모르면 API 목적지로 보고 엄격하게 막습니다(Codex F02, 설계 G18).</Anno>
      </Card>
    </>
  );
}
