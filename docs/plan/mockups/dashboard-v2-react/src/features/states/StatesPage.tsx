import * as React from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, Eyebrow, SectionTitle } from "@/components/pes/bits";
import { Callout, EmptyState, LoadError, OfflineBanner } from "@/components/pes/blocks";
import { ActionButton } from "@/components/pes/controls";
import { More } from "@/components/pes/disclosure";
import { Chip, Status } from "@/components/pes/status";
import { DOMAIN_LABEL, SHAPES, STATUS } from "@/components/pes/status-registry";
import { TurnIndicator } from "@/components/pes/turn";
import type { StatusDomain, TurnView } from "@/api/types";

/** 차례 표시기 견본 다섯 — 시각은 이 화면을 연 때 기준(경과 시간이 실제로 흐름) */
function turnSamples(base: number): { title: string; keep: string; turn: TurnView }[] {
  const ago = (m: number) => new Date(base - m * 60000).toISOString();
  return [
    { title: "나의 할 일", keep: "공은 사람 쪽 · 정지된 강한 색 · 수 · 바로 가기", turn: { side: "you", count: 3, text: "조사 R2 질문 2", action: { label: "답하기", href: "/p/dolbom-insight/e/1/s/research/r/2#q-21" } } },
    { title: "AI 작업 중 · 소식 있음", keep: "공은 AI 쪽 · 점이 천천히 돎(소식이 시험값 안일 때만) · 경과", turn: { side: "ai", text: "조사 R2 결과 쓰는 중…", since: ago(3), last_signal: ago(0), fresh: true } },
    { title: "AI 작업 중 · 소식 없음", keep: "움직이지 않음 · 점선 고리 · 마지막 소식 시각(멈췄다고 단정하지 않음)", turn: { side: "ai", text: "2판 조사 R1 · 새 출처 찾기", since: ago(30), last_signal: ago(18), fresh: false } },
    { title: "기다림", keep: "공은 가운데 · 내 할 일 아님(다른 사람·시각)", turn: { side: "waiting", text: "실행 멈춤 · 사용량 — 재개 가능 16:40(PES 추정)까지" } },
    { title: "끝남", keep: "공은 가운데 · 누구의 할 일도 없음", turn: { side: "done", text: "1판 완료" } },
  ];
}

function Sample({ eyebrow, title, keep, children }: { eyebrow: string; title: string; keep: string; children: React.ReactNode }) {
  return (
    <Card className="gap-2 px-4" aria-label={`${eyebrow}: ${title}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="text-meta">{title}</h3>
      <div>{children}</div>
      <p className="mt-auto border-t border-line pt-2 text-caption text-muted-foreground">지키는 것: {keep}</p>
    </Card>
  );
}

/** 상태 견본 — 공통 화면 상태(설계 3.6)를 실제 컴포넌트로 한곳에, 그리고 상태 사전 전체(설계 6절) */
export function StatesPage() {
  const [loadingShown, setLoadingShown] = React.useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setLoadingShown(true), 300);
    return () => window.clearTimeout(t);
  }, []);
  const domains = Object.keys(STATUS) as StatusDomain[];
  const [base] = React.useState(() => Date.now());
  return (
    <>
      <SectionTitle as="h1" title="상태 견본" sub="같은 상태는 어느 화면에서나 같은 모양·글자·색으로 보입니다. 색만으로 구분하지 않습니다." />

      <Card size="compact" aria-labelledby="shape-t">
        <h2 id="shape-t" className="text-title">
          상태 표기 — 모양 9가지 + 글자 + 색
        </h2>
        <ul className="mt-2.5 grid grid-cols-1 gap-x-3.5 gap-y-2 text-meta tab:grid-cols-3 desk:grid-cols-5">
          {SHAPES.map((s) => (
            <li key={s.shape} className="flex items-center gap-2">
              <Chip shape={s.shape} tone={s.tone}>
                {s.name}
              </Chip>
              <span className="text-ink-2">{s.meaning}</span>
            </li>
          ))}
        </ul>
        <More className="mt-2" label="그리는 방법">
          <p>모양은 SVG를 글자 색(currentColor)으로 그려 고대비(강제 색) 모드·흑백 인쇄에서도 남습니다. 뜻은 옆 글자가 전달하므로 모양은 화면 읽기에서 숨깁니다(aria-hidden). 테마 4개 × 밝게/어둡게 모두 글자 4.5:1 · 모양·테두리 3:1 이상입니다.</p>
        </More>
      </Card>

      <div className="mt-4">
        <Card size="compact" aria-labelledby="turn-t">
          <h2 id="turn-t" className="text-title">
            차례 표시기 — 지금 누가 움직일 차례인가
          </h2>
          <p className="mt-1 text-meta text-ink-2">왼쪽 끝은 사람, 오른쪽 끝은 AI. 공이 있는 쪽이 차례입니다. 목록 줄 · 작업 공간 띠 · 사이드바 배지 · 휴대폰이 같은 표시를 씁니다.</p>
          <ul className="mt-3 grid grid-cols-1 gap-3 tab:grid-cols-2 desk:grid-cols-3">
            {turnSamples(base).map((s) => (
              <li key={s.title} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
                <TurnIndicator turn={s.turn} action />
                <p className="mt-auto border-t border-line pt-1.5 text-caption text-muted-foreground">지키는 것: {s.keep}</p>
              </li>
            ))}
          </ul>
          <More className="mt-2" label="움직임 규칙">
            <p>움직임은 셋뿐입니다 — 차례가 바뀔 때 공이 옮겨 가는 것(0.5초), AI 작업 중이고 소식이 시험값 안일 때 공 둘레를 도는 점(1.8초에 한 바퀴), 나의 할 일로 바뀌는 순간 한 번 퍼지는 고리. 깜박이거나 번쩍이지 않습니다.</p>
            <p>움직임 줄이기(운영체제 설정)에서는 셋 다 멈추고, 모양과 글자만으로 같은 뜻을 전합니다. 소식이 오래되면 점이 멈추고 “소식 없음 · 마지막 소식 n분 전”이 됩니다(방식 B에서 AI가 일하는 척 보이지 않게 — stage-3 2.6).</p>
            <p>화면 읽기 프로그램에는 나의 할 일이 생길 때(→ 나의 할 일)와 끝날 때만 한 번 조용히 알립니다. 경과 시간이 바뀌는 것은 읽지 않습니다.</p>
          </More>
        </Card>
      </div>

      <SectionTitle title="공통 화면 상태 — 실제 컴포넌트" sub="빈 · 로딩 · 오류 · 권한 없음 · 끊김 · 충돌 · 차단 · 미상 · 접수 확인 중 · 결과 미확인 · 옛 형식" />
      <div className="grid grid-cols-1 items-stretch gap-3 tab:grid-cols-2 desk:grid-cols-3">
        <Sample eyebrow="빈 상태" title="무엇이 언제 생기는지 + 다음 행동 1개" keep="빈 표를 그리지 않음">
          <EmptyState title="아직 질문이 없습니다" body="AI가 결과를 내면 여기에 질문이 옵니다." action={<Button size="sm">AI 작업 보기</Button>} />
        </Sample>
        <Sample eyebrow="로딩(첫 표시)" title="뼈대 깜박임 대신 0.3초 뒤 한 줄" keep="정적 셸 + 첫 읽기 묶음 한 번 · 갱신 중에는 이전 화면 유지">
          {loadingShown ? <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-meta text-ink-2">작업 공간 불러오는 중… 첫 표시는 서버가 계산한 읽기 묶음 하나로 그립니다.</p> : <div aria-busy="true" className="h-9" />}
        </Sample>
        <Sample eyebrow="불러오기 오류" title="그 영역만 오류, 나머지는 계속" keep="초안 유지 · 오류 번호 · 마지막으로 받은 시각">
          <LoadError what="결과물" lastReceived="14:10" code="R-5521" onRetry={() => undefined} />
        </Sample>
        <Sample eyebrow="권한 없음" title="단추는 남기고 이유 문장" keep="서버가 다시 검사 · 초점을 받아 이유를 읽음">
          <ActionButton size="sm" blockedBy="단계 승인은 소유자만 할 수 있습니다." reasonId="st-why">
            승인 검토하기
          </ActionButton>
          <p id="st-why" className="mt-1.5 text-caption text-ink-2">
            단계 승인은 소유자만 할 수 있습니다.
          </p>
          <p className="mt-2 text-caption">
            <Status of="reference" value="no_permission" /> 원본 권한이 없으면 내용·이름도 보이지 않습니다.
          </p>
        </Sample>
        <Sample eyebrow="끊김" title="화면 위 띠" keep="입력은 이 탭에 남음 · 자동 재전송 없음">
          <OfflineBanner />
        </Sample>
        <Sample eyebrow="버전 충돌" title="그사이 폼이 바뀜" keep="부분 접수 없음 · 초안 유지">
          <Callout tone="bad">
            <Status of="submission" value="conflict" /> 그사이 질문이 바뀌었습니다 — 바뀐 곳을 보고 다시 보내 주세요. 아무것도 접수하지 않았고 초안은 그대로입니다.
          </Callout>
        </Sample>
        <Sample eyebrow="차단" title="보낼 수 없음 + 이유 한 줄" keep="자동 재시도 없음">
          <Callout tone="bad">
            <Status of="generic" value="cannot_send" /> AI가 읽기: 막음이라 방식 A를 시작할 수 없습니다(정책 rev 2).
          </Callout>
        </Sample>
        <Sample eyebrow="미상" title="모르면 모른다고" keep="0이나 “꺼짐”으로 채우지 않음">
          <p className="flex flex-wrap gap-1.5">
            <Status of="computer" value="unknown" />
            <Status of="computer" value="ai_unconfirmed" />
            <Status of="resetBasis" value="unknown" />
          </p>
          <p className="mt-1.5 text-caption">마지막 확인 3시간 전. 꺼졌는지 끊겼는지 알 수 없습니다.</p>
        </Sample>
        <Sample eyebrow="접수 확인 중" title="응답이 늦음" keep="성공이라 하지 않음 · 다시 눌러도 두 번 처리 안 됨">
          <p>
            <Status of="submission" value="pending" />
          </p>
          <p className="mt-1.5 text-caption">응답이 늦어 같은 요청 번호(멱등 키)로 확인 중입니다.</p>
        </Sample>
        <Sample eyebrow="결과 미확인" title="보낸 뒤 응답 유실" keep="미접수·성공을 단정하지 않음 · 같은 키·내용·폼 버전으로 확인(Codex F07)">
          <p>
            <Status of="generic" value="result_unknown" />
          </p>
          <p className="mt-1.5 text-caption">접수됐는지 모릅니다. 같은 요청 번호로 확인하면 서버가 처리했을 때 처음 영수증을 돌려줍니다.</p>
        </Sample>
        <Sample eyebrow="옛 형식 · 웹으로 옮김" title="읽기 전용 + 옮기기 안내" keep="빈 화면·오류 없음(U12 Z3, WEB9)">
          <p className="flex flex-wrap gap-1.5">
            <Chip shape="hsquare" tone="off">
              읽기 전용
            </Chip>
            <Chip shape="hsquare" tone="off">
              웹으로 옮김 — 웹에서 열기
            </Chip>
          </p>
        </Sample>
        <Sample eyebrow="갱신 칩 5가지" title="머리줄의 작은 표시" keep="입력·초점·한글 조합·스크롤을 건드리지 않음">
          <p className="flex flex-wrap gap-1.5">
            {Object.keys(STATUS.refresh).map((v) => (
              <Status key={v} of="refresh" value={v} />
            ))}
          </p>
        </Sample>
      </div>
      <Anno>
        이 상태들은 “시안 조작”(역할 · 네트워크 느림/응답 유실/끊김 · 다음 제출 충돌 · 갱신 통로)으로 실제 화면에서도 볼 수 있습니다. 예: 끊김으로 바꾸고 <Link to="/p/dolbom-insight/e/1/s/research/r/2#q-21">질문</Link>에서 “이 질문만 보내기”.
      </Anno>

      <SectionTitle title="상태 사전 전체(설계 6절 상태 총표)" sub="화면은 이 사전 밖의 상태 이름을 만들지 않습니다. 근거 열의 영어 코드는 개발자용입니다." />
      <div className="grid grid-cols-1 gap-3 desk:grid-cols-2">
        {domains.map((dom) => (
          <Card key={dom} size="compact">
            <Table regionLabel={`${DOMAIN_LABEL[dom]} 상태`}>
              <TableCaption>{DOMAIN_LABEL[dom]}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="w-[42%]">
                    표시
                  </TableHead>
                  <TableHead scope="col">근거</TableHead>
                  <TableHead scope="col">사람이 할 일</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(STATUS[dom]).map(([v, d]) => (
                  <TableRow key={v}>
                    <TableCell>
                      <Status of={dom} value={v} wrap />
                    </TableCell>
                    <TableCell className="text-caption">{d.basis ?? "—"}</TableCell>
                    <TableCell className="text-caption">{d.todo ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ))}
      </div>
    </>
  );
}
