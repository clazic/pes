import * as React from "react";
import { Link } from "react-router";
import { useArrival } from "./arrival";

/** 모르는 주소 · 없는 라운드(예: r/0). 단계 시작으로 오해하지 않는다. 경고(alert)가 아니라 보통 화면이다. */
export function NotFound({ back }: { back?: { href: string; label: string } }) {
  useArrival(true);
  React.useEffect(() => {
    document.title = "찾을 수 없음 · PES";
  }, []);
  return (
    <main id="main" tabIndex={-1} data-area="body" className="mx-auto w-full max-w-2xl px-4 pt-10 pb-16">
      <h1 data-screen-title="" tabIndex={-1} className="text-page text-ink">
        찾을 수 없음
      </h1>
      <p className="mt-2 text-body text-ink-2">이 주소에 해당하는 화면이 없습니다. 라운드 번호나 단계 이름을 확인해 주세요.</p>
      {back ? (
        <p className="mt-4 text-meta">
          <Link to={back.href}>{back.label}</Link>
        </p>
      ) : null}
    </main>
  );
}
