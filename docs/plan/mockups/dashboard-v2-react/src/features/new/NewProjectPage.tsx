import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Anno, Eyebrow, KV, ModeBadge, SectionTitle } from "@/components/pes/bits";
import { More } from "@/components/pes/disclosure";

/**
 * 새 프로젝트 — 방식 고르기(설계 4.2). 처음 만드는 방법일 뿐, 만든 뒤에도 실행마다 A·B를 고르고 넘길 수 있다.
 * 정보 밀도(14절): 카드마다 제목 + 한 줄 + 세 줄(필요 · 비용 · 자료). 모델 고르기 등은 “자세히”.
 */
export function NewProjectPage() {
  return (
    <>
      <SectionTitle as="h1" title="새 프로젝트" sub="어떻게 시작할까요? 만들기 전에는 아무것도 저장하지 않습니다." />
      <section aria-labelledby="pick-title">
        <h2 id="pick-title" className="sr-only">
          어떻게 시작할까요
        </h2>
        <div className="mt-3 grid grid-cols-1 items-stretch gap-3 tab:grid-cols-2">
          <Card className="gap-2 border-2 border-primary px-5" aria-labelledby="pick-a">
            <Eyebrow>추천</Eyebrow>
            <h3 id="pick-a" className="flex flex-wrap items-center gap-2 text-title">
              <ModeBadge mode="A" />
              웹에서 바로
            </h3>
            <p className="text-sm text-ink-2">PES가 내가 등록한 AI 연결(API)을 부릅니다. 내 컴퓨터가 꺼져 있어도 됩니다.</p>
            <KV
              items={[
                ["필요", "AI 연결 1개(직접 등록)"],
                ["비용", "구독형은 문턱 90%에서, 쓴 만큼 과금은 상한에서 멈춤"],
                ["자료", "API로 보냄 · 프로젝트·파일마다 끌 수 있음"],
              ]}
            />
            <More label="자세히" name="방식 A 자세히">
              <p>AI 연결은 구독형 API 또는 쓴 만큼 과금 API를 직접 등록합니다(특정 서비스에 묶지 않음). 모델은 그 연결의 목록에서 고르거나 직접 입력하고, 실행 하나는 모델 하나로 갑니다. 쓴 만큼 과금은 비용 상한이 필수입니다.</p>
            </More>
            <div className="mt-auto pt-1.5">
              <Button asChild variant="default">
                <Link to="/new/a">방식 A로 만들기</Link>
              </Button>
            </div>
          </Card>
          <Card className="gap-2 px-5" aria-labelledby="pick-b">
            <Eyebrow>다른 방법</Eyebrow>
            <h3 id="pick-b" className="flex flex-wrap items-center gap-2 text-title">
              <ModeBadge mode="B" />
              내 컴퓨터 AI로 만들고 웹에서 이어 하기
            </h3>
            <p className="text-sm text-ink-2">내 컴퓨터의 AI 도구로 만들어 이 웹에 등록합니다.</p>
            <KV
              items={[
                ["필요", "내 컴퓨터 AI 도구 · 연결 도우미(선택)"],
                ["비용", "각 도구의 구독 — PES가 멈출 수 없음"],
                ["자료", "내 컴퓨터와 웹이 양쪽으로 주고받음"],
              ]}
            />
            <More label="자세히" name="방식 B 자세히">
              <p>도구 6가지: Claude Code · Claude 앱 · Codex CLI · Codex 앱 · OpenCode TUI · OpenCode 앱. 모델은 각 도구에서 고르고, PES는 도구가 알린 값만 봅니다.</p>
            </More>
            <div className="mt-auto pt-1.5">
              <Button asChild>
                <Link to="/new/b">등록 안내 보기</Link>
              </Button>
            </div>
          </Card>
        </div>
        <Anno>이 선택은 “처음 만드는 방법”입니다. 만든 뒤에도 실행마다 방식 A·B를 고를 수 있고, 사람이 다른 방식으로 넘길 수 있습니다(인계). 같은 상태면 A·B 화면의 문구·단추·권한이 같습니다. 이 PES에 방식 A를 쓸 수 없으면(배포 설정) A 카드에 “관리자 설정 필요”가 보입니다(GET /api/v1/capabilities).</Anno>
      </section>
    </>
  );
}
