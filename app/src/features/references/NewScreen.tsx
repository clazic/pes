import * as React from "react";
import { useArrival } from "@/app/arrival";
import { NewReferencesSection } from "./NewReferences";

/**
 * 새 프로젝트 화면(`/new`) — 이 이슈(REF1b)는 그 화면의 “참고 프로젝트” 칸을 만든다. 프로젝트를 만드는 칸과 “내 자료” 칸(MAT1c · SEL-117)은 같은 main 안에 이어서 붙는다:
 * 칸마다 `<section aria-labelledby>` + h2, 화면 제목은 h1 “새 프로젝트”. SEL-117 이 먼저 병합되면 그쪽 NewScreen 위에 이 칸(NewReferencesSection)만 얹는다.
 */
export function NewScreen() {
  useArrival(true);
  React.useEffect(() => {
    document.title = "새 프로젝트 · PES";
  }, []);
  return (
    <main id="main" tabIndex={-1} className="min-w-0">
      <div className="border-b px-4 pt-4 pb-3 tab:px-6">
        <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
          새 프로젝트
        </h1>
        <p className="mt-1 text-meta text-muted-foreground">프로젝트를 만드는 칸은 이어서 붙습니다. 지금은 참고할 이전 프로젝트를 담아 두는 칸만 있어요.</p>
      </div>
      <div className="w-full max-w-3xl px-4 pt-5 pb-16 tab:px-6">
        <NewReferencesSection />
      </div>
    </main>
  );
}
