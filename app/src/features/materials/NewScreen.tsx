import * as React from "react";
import { XIcon } from "lucide-react";
import { useArrival } from "@/app/arrival";
import { Button } from "@/components/ui/button";
import { AiSwitch } from "./AiSwitch";
import { FilePicker } from "./FilePicker";
import { formatWord, sizeWord } from "./format";
import { NewReferencesSection } from "../references/NewReferences";
import { DenyNotice } from "./notice";

interface Staged {
  id: string;
  file: File;
  /** 올릴 때부터 AI 참조 금지 */
  deny: boolean;
}

/**
 * 새 프로젝트 화면의 “내 자료” 칸(MAT1c · 설계 마법사 4번째 칸)과 그 아래 “참고 프로젝트” 칸(REF1b · NewReferencesSection) — **아직 올리지 않고 담기만** 한다.
 * 프로젝트가 아직 없어 서버에 아무것도 올리지 않는다(자료 올리기 · AI 참조 호출 0, 목록 읽기도 없음). 프로젝트 만들기와 묶는 일은 이어지는 작업이다.
 * 담은 파일은 이 탭의 메모리에만 있다(새로고침하면 다시 골라야 한다). 파일별 AI 참조는 기본 허용이고, 아직 나간 것이 없으니 확인 대화 상자 없이 “올릴 때부터 금지”로 바꿀 수 있다.
 */
export function NewScreen() {
  useArrival(true);
  React.useEffect(() => {
    document.title = "새 프로젝트 · PES";
  }, []);
  const [staged, setStaged] = React.useState<Staged[]>([]);
  const seq = React.useRef(0);
  const add = (files: File[]) => setStaged((cur) => [...cur, ...files.map((file) => ({ id: `staged-${++seq.current}`, file, deny: false }))]);
  const headingId = React.useId();
  return (
    <main id="main" tabIndex={-1} className="min-w-0">
      <div className="border-b px-4 pt-4 pb-3 tab:px-6">
        <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
          새 프로젝트
        </h1>
        <p className="mt-1 text-meta text-muted-foreground">프로젝트를 만드는 칸은 이어서 붙습니다. 지금은 올릴 자료와 참고할 이전 프로젝트를 담아 두는 칸만 있어요.</p>
      </div>
      <div className="flex w-full max-w-3xl flex-col gap-8 px-4 pt-5 pb-16 tab:px-6">
        <section aria-labelledby={headingId}>
          <h2 id={headingId} className="text-title text-ink">
            내 자료
          </h2>
          <p className="mt-1 text-meta text-ink-2">연구에 쓸 파일을 담아 두세요. 건너뛰어도 돼요. 담기만 하고 아직 올리지 않아요. 파일 내용은 이 탭에만 있어서 새로고침하면 다시 골라야 해요.</p>

          <div className="mt-3">
            <FilePicker label="자료 파일 고르기" onPick={add} hint="파일을 여기에 끌어 놓아도 돼요." />
          </div>

          <DenyNotice className="mt-4" />

          {staged.length === 0 ? (
            <p className="mt-4 text-meta text-ink-2">담은 파일이 없어요.</p>
          ) : (
            <ul aria-label="담은 파일" className="mt-4 divide-y divide-line border-y border-line">
              {staged.map((s) => (
                <li key={s.id} data-staged={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-body font-medium break-all text-ink">{s.file.name}</p>
                    <p className="text-caption text-ink-2">
                      {formatWord({ media_type: s.file.type, original_name: s.file.name })} · {sizeWord(s.file.size)} · 아직 올리지 않았어요
                    </p>
                  </div>
                  <span className="flex items-center gap-2">
                    <AiSwitch
                      on={!s.deny}
                      label={`AI 참조: ${s.file.name}`}
                      onClick={() => setStaged((cur) => cur.map((x) => (x.id === s.id ? { ...x, deny: !x.deny } : x)))}
                    />
                    <span className={s.deny ? "text-meta font-medium text-ink" : "text-meta text-ink-2"}>{s.deny ? "올릴 때부터 AI 참조 금지" : "AI 참조 허용"}</span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setStaged((cur) => cur.filter((x) => x.id !== s.id))}>
                    <XIcon aria-hidden="true" />
                    빼기<span className="sr-only">: {s.file.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <NewReferencesSection />
      </div>
    </main>
  );
}
