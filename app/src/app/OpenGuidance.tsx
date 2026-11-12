import * as React from "react";

/**
 * production 빌드에서 1회용 코드(#code=…)를 세션으로 바꾸지 못했고(없음·쓴 코드·만료·거절) 같은 탭에 받아 둔 것도 없을 때의 화면(U1b, SEL-85).
 * 가짜(합성) 자료도 서버 요청도 없다 — 앱은 `pes open <프로젝트> --app` 으로 열어야 서버 자료를 읽는다. 화면 제목(data-screen-title)은 두지 않는다(작업 공간 화면이 아니다).
 */
export function OpenGuidance() {
  React.useEffect(() => {
    document.title = "pes open 으로 여세요 · PES";
  }, []);
  return (
    <main id="main" tabIndex={-1} data-area="body" className="mx-auto w-full max-w-2xl px-4 pt-10 pb-16">
      <h1 className="text-page text-ink">이 주소는 pes open 으로 여세요</h1>
      <p className="mt-2 text-body text-ink-2">
        주소만 붙여 넣으면 앱이 연구 자료를 읽을 권한을 받지 못합니다. 터미널에서 아래처럼 실행하면 브라우저가 알맞은 주소로 열립니다.
      </p>
      <p className="mt-4">
        <code className="rounded-md border border-line bg-muted px-2 py-1 text-meta text-ink">pes open &lt;프로젝트 이름&gt; --app</code>
      </p>
      <p className="mt-4 text-meta text-ink-2">서버가 꺼져 있으면 먼저 pes serve &lt;프로젝트 이름&gt; 으로 켭니다. 다른 탭이나 창에는 권한이 넘어가지 않으니, 새 탭에서는 같은 명령으로 다시 여세요.</p>
    </main>
  );
}
