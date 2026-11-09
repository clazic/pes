import { Link } from "react-router";
import { COMMANDS, READS } from "@/api/types";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Anno, SectionTitle, Tag } from "@/components/pes/bits";

const SCREENS: { name: string; to: string; statics: string; design: string; note: string }[] = [
  // 관리 공간(모아 보기) — 어디로 갈지 고르는 곳(5차, 설계 16.1)
  { name: "관리 · 프로젝트 목록 · 나의 할 일", to: "/", statics: "projects.html", design: "4.1 · 15 · 16.1", note: "모든 프로젝트의 나의 할 일(서버가 사람·권한별로 계산) · 줄마다 차례 표시기 · 막힌 것 수 → 누르면 연구 공간" },
  { name: "관리 · 새 프로젝트 · 방식 고르기", to: "/new", statics: "new-project.html", design: "4.2", note: "A·B 카드" },
  { name: "관리 · 방식 A 만들기 6칸", to: "/new/a", statics: "new-project.html #wizard", design: "4.3", note: "2칸 AI 연결·모델(AI 연결 추가), 4칸 파일·폴더 담기(아직 올리지 않음)" },
  { name: "관리 · 방식 B 등록 안내", to: "/new/b", statics: "new-project.html #mode-b", design: "4.4", note: "도구 6가지 표" },
  { name: "관리 · 기기 승인", to: "/device", statics: "new-project.html #mode-b", design: "4.4", note: "코드 대조 · 사람 자격" },
  { name: "관리 · 사용량", to: "/usage", statics: "usage.html", design: "4.12", note: "AI 연결별 사용량·한도 · API 회사 화면에서 본 숫자 · 확인 안 된 호출 정리" },
  { name: "관리 · 내 컴퓨터", to: "/computer", statics: "workspace.html #states", design: "4.11", note: "모든 기기 · 관측 셋(도우미 · AI 도구 · 업무 실행)" },
  { name: "관리 · 알림", to: "/notifications", statics: "mobile.html 1번", design: "4.13", note: "이미 처리된 사건은 되살리지 않음" },
  // 연구 공간(집중) — 프로젝트 하나(5차, 설계 16.2~16.5)
  { name: "연구 · 연구 개요(방식 B · 조사 R2)", to: "/p/dolbom-insight", statics: "(새 화면)", design: "16.2 · 16.5", note: "이어서 하기 · 연구 질문 · 지금 어디까지 · 핵심 발견 5 · 남은 문제 6 · 다음 마일스톤" },
  { name: "연구 · 지금 할 일 — 질문에 답하기", to: "/p/dolbom-insight/e/1/s/research/r/2?t=answer", statics: "workspace.html", design: "16.3 · 4.7", note: "가운데에 질문 폼 하나 · 순서 줄 · 다음 할 일 · 오른쪽 AI 동료 · 집중 모드(J/K · Esc)" },
  { name: "연구 · 지금 할 일 — 결과 글 문제 풀기", to: "/p/dolbom-insight/e/1/s/research/r/2?t=review", statics: "workspace.html", design: "16.4 · 4.7", note: "문제 문단에 여백 선 · 물결 밑줄 · 표시 단추 → 그 자리에서 해결 흐름" },
  { name: "연구 · 막힌 것·풀 것", to: "/p/dolbom-insight/problems", statics: "(새 화면)", design: "16.4", note: "연구 내용 3 · 진행 3 — 원인 한 줄 → 선택지(추천) → 한 번에 처리 · 해결 기록" },
  { name: "연구 · 멈춘 실행 풀기(방식 A · 사용량)", to: "/p/youth-housing/e/1/s/plan/r/1", statics: "(새 장면)", design: "16.4 · 4.12", note: "AI 실행 멈춤 — 확인 안 된 호출 정리(사용량 화면과 같은 대화 상자) · 넘기기 · 취소" },
  { name: "연구 · 시작 질문(방식 A · 단계 시작)", to: "/p/rural-care-access/e/1/s/plan/r/start", statics: "(새 장면)", design: "4.5 · 16.3", note: "round_id=NULL → “단계 시작” · 필수 시작 질문 미응답" },
  { name: "연구 · AI 작업 중(방식 B)", to: "/p/ltc-survey/e/2/s/research/r/1", statics: "(새 장면)", design: "4.11 · 15 · 16.3", note: "지금 내 할 일 없음 → 진행 보기 · 시안 단추 “차례 바뀜 장면”으로 AI 끝남 → 나의 할 일" },
  { name: "연구 · 단계 결과(지난 단계)", to: "/p/dolbom-insight/s/plan", statics: "(새 화면)", design: "16.2", note: "승인본 요약 · 앞 단계 변경 — 다시 확인 · 아직" },
  { name: "연구 · 더 보기 · AI 작업 기록", to: "/p/dolbom-insight/ai", statics: "workspace.html #ai", design: "4.10", note: "핵심 상태 · 실행 표 · 타임라인 3칸" },
  { name: "연구 · 더 보기 · 자료", to: "/p/dolbom-insight/files", statics: "materials.html", design: "4.8", note: "파일·폴더째 올리기, 폴더 단위 AI 참조, 목적지별 조합표" },
  { name: "연구 · 더 보기 · 참고 프로젝트", to: "/p/dolbom-insight/references", statics: "workspace.html #refs", design: "4.9", note: "어느 스냅숏이든 고정(승인본은 추천)" },
  { name: "연구 · 더 보기 · 설정", to: "/p/dolbom-insight/settings", statics: "(일부 usage.html)", design: "4.14", note: "AI가 읽기(허용/막음) · AI 연결·모델" },
  { name: "연구 · 더 보기 · 내 컴퓨터 연결", to: "/p/dolbom-insight/sync", statics: "workspace.html #states", design: "4.11 · 16.6", note: "이 프로젝트의 기기 · 관측 셋 · 동기화 표" },
  { name: "휴대폰", to: "/mobile", statics: "mobile.html", design: "4.16", note: "8화면 — 실제로 답·보내기·승인·계속" },
  { name: "상태 견본", to: "/states", statics: "각 시안의 상태 견본", design: "3.6 · 6절", note: "빈·로딩·오류·권한 없음·끊김·충돌·차단·미상 + 차례 표시기 견본 5 + 상태 사전 전체(막힌 것 종류·상태 포함)" },
];

/** 시안 안내 — 정적 HTML 시안 index.html 대응 */
export function GuidePage() {
  return (
    <>
      <SectionTitle as="h1" title="시안 안내 — React + Vite + TypeScript + Tailwind CSS + shadcn/ui" sub="결정 0017(2026-11-05 사용자 결정). 합성 예시만 쓰고 네트워크 호출이 없습니다. 정적 HTML 시안(mockups/dashboard-v2/)을 대체합니다." />
      <Anno className="mt-0 mb-4">
        5차(2026-11-08, 두 공간): <strong>관리 공간</strong>(모아 보기 — 목록 · 나의 할 일 · 내 컴퓨터 · 사용량 · 알림 · 새 프로젝트)과 <strong>연구 공간</strong>(프로젝트 하나 — 연구 개요 · 지금 할 일 · 막힌 것·풀 것 · 결과 글 · AI 동료 · 집중 모드)으로 나눴습니다. 연구 공간에는 관리용 전역 메뉴가 없고 “모든 프로젝트”와 프로젝트 전환만 있습니다. 설계 16절.{" "}
        2차(테마 적용): 앱 셸은 shadcn 공식 <strong>sidebar-07</strong> 블록(아이콘만 남기고 접힘 — 머리줄 왼쪽 단추 또는 Ctrl/Cmd+B, 900px 아래는 Sheet)과 shadcn-admin 구조를 참고한 머리줄(빵부스러기 · 명령 찾기 · 알림 · 테마 · 사용자)입니다. 프로젝트 목록·사용량은 <strong>dashboard-01</strong> 패턴(요약 카드 줄 + 표, 사용량 추이 차트 하나), 작업 공간은 문서 중심입니다. 머리줄의 팔레트 단추에서 tweakcn 테마 4개(Modern Minimal · Vercel · Graphite · Clean Slate, Apache-2.0) × 밝게/어둡게/시스템 따라를 바꿔 볼 수 있고, 고른 값은 이 브라우저에만 남습니다. 글꼴은 어느 테마든 Pretendard입니다. 설계 12.9절.
      </Anno>
      <Card className="gap-0 px-5">
        <Table regionLabel="화면 목록" className="min-w-[720px]">
          <TableCaption>화면 {SCREENS.length}개 — 주소 · 정적 시안 대응 · 설계 절</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">화면</TableHead>
              <TableHead scope="col">주소</TableHead>
              <TableHead scope="col">정적 시안</TableHead>
              <TableHead scope="col">설계</TableHead>
              <TableHead scope="col">메모</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SCREENS.map((s) => (
              <TableRow key={s.to}>
                <TableHead scope="row">
                  <Link to={s.to}>{s.name}</Link>
                </TableHead>
                <TableCell>
                  <code className="text-xs break-all">{s.to}</code>
                </TableCell>
                <TableCell>{s.statics}</TableCell>
                <TableCell>{s.design}</TableCell>
                <TableCell>{s.note}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <SectionTitle id="added" title="2026-11-05 사용자 추가 요구 반영 위치" />
      <div className="grid grid-cols-1 gap-3 desk:grid-cols-2">
        <Card className="gap-1.5 px-4">
          <h3 className="text-meta">폴더째 올리기</h3>
          <p className="text-meta">
            <Link to="/p/dolbom-insight/files#upload">자료 → 자료 올리기 · 폴더째 올리기</Link>: 폴더 고르기(webkitdirectory)·폴더 끌어 놓기, 상대 경로 나무, 올리기 전 미리 보기(파일 수·총 크기·지원 안 되는 형식·너무 큰 파일·숨김 파일 빼기), 확인, 진행률·일부 실패, 폴더 단위 AI 참조. 자료 표의 폴더 줄에서 폴더 전체 허용·금지. 상한은 “예시값, 사용자 결정 필요”.
          </p>
        </Card>
        <Card className="gap-1.5 px-4">
          <h3 className="text-meta">AI 연결 수동 등록 <Tag tone="warn">0013 일부 변경 필요</Tag></h3>
          <p className="text-meta">
            <Link to="/new/a?step=2">A 마법사 2칸</Link> · <Link to="/usage#connections">사용량 → AI 연결</Link> · <Link to="/p/youth-housing/settings">프로젝트 설정</Link>: 종류·이름·주소·키(다시 안 보임·저장 위치)·모델 불러오기/직접 입력·연결 시험·과금 방식. 쓴 만큼 과금은 비용 상한 필수.
          </p>
        </Card>
        <Card className="gap-1.5 px-4">
          <h3 className="text-meta">화면 문구는 ‘API’로</h3>
          <p className="text-meta">AI가 읽기 · API 사용량 · API 한도 · API 연결 · 추가 요금 꺼짐 확인. 특정 제공사 이름은 화면에 쓰지 않고, 필요하면 내부 식별자에만 남깁니다(화면에 안 보임).</p>
        </Card>
        <Card className="gap-1.5 px-4">
          <h3 className="text-meta">글꼴 Pretendard</h3>
          <p className="text-meta">npm 패키지 pretendard 1.3.9(고정) — Pretendard Variable 동적 subset woff2를 번들에 넣어 자체 호스팅, font-display: swap, 대체 system-ui · Apple SD Gothic Neo · Malgun Gothic. 숫자 표는 tabular-nums. SIL Open Font License 1.1.</p>
        </Card>
      </div>

      <SectionTitle id="commands" title="화면이 부르는 PES 명령(닫힌 목록)" sub="모든 단추는 아래 명령 하나로만 바뀝니다 — 검증된 쓰기 경로 하나. “미정”은 계획에 이름·경로가 없는 것." />
      <div className="grid grid-cols-1 gap-3 desk:grid-cols-2">
        {[
          { title: "쓰기", rows: COMMANDS },
          { title: "읽기", rows: READS },
        ].map((g) => (
          <Card key={g.title} className="gap-0 px-5">
            <Table regionLabel={`${g.title} 명령`}>
              <TableCaption>{g.title}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">명령</TableHead>
                  <TableHead scope="col">경로</TableHead>
                  <TableHead scope="col">담당</TableHead>
                  <TableHead scope="col">상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(g.rows).map(([name, spec]) => (
                  <TableRow key={name}>
                    <TableCell>
                      <code className="text-xs">{name}</code>
                      {"humanOnly" in spec && spec.humanOnly ? <span className="block text-xs text-muted-foreground">사람만</span> : null}
                    </TableCell>
                    <TableCell className="text-xs break-all">
                      {spec.method} {spec.path}
                    </TableCell>
                    <TableCell className="text-xs">{spec.owner}</TableCell>
                    <TableCell>{spec.status === "미정" ? <Tag tone="warn">미정</Tag> : <Tag tone="ok">계획</Tag>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        ))}
      </div>
      <Anno>
        결정 기록: <code>docs/plan/decisions/0017-dashboard-react-vite.md</code> · 설계: <code>docs/plan/ui/dashboard-v2.md</code> 12절(구현 기술) · 논의: <code>docs/plan/discussion/2026-11-05-dashboard-v2-react-notes.md</code>. 경로 표기의 P = /api/v1/projects/{"{id}"}.
      </Anno>
      <span id="decisions" />
    </>
  );
}
