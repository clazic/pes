import * as React from "react";
import { useReferenceDetail } from "@/api/queries";
import type { ReferenceContentItem, ReferenceRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { noteClass } from "@/features/records/parts";
import { nameOf } from "./logic";

/** 출처 주소는 http · https 만 링크로 둔다 — 그 밖의 주소(javascript: 같은)는 글자로만 */
function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * 인용 표시 — 어느 프로젝트의 어느 버전인지 늘 보인다(SEL-110). 프로젝트 이름은 서버가 준 인용 칸, 버전 이름은 지금 고정한 버전(source_snapshot_key).
 * 둘 중 모르는 것은 “정보 없음”으로 말한다(지어내지 않는다).
 */
function Citation({ item, row }: { item: ReferenceContentItem; row: ReferenceRow }) {
  const project = item.citation.project_label || row.source_label || "프로젝트 정보 없음";
  const version = row.source_snapshot_key ?? "버전 정보 없음";
  return (
    <p data-citation={item.object_id} className={`mt-1 ${noteClass}`}>
      인용: <span className="font-medium text-ink">{project}</span> · <span className="font-medium text-ink">{version}</span>
    </p>
  );
}

function Item({ item, row }: { item: ReferenceContentItem; row: ReferenceRow }) {
  const href = item.url ? safeUrl(item.url) : null;
  return (
    <li className="border-b border-line py-3 last:border-b-0">
      <h3 className="text-body font-medium break-words text-ink">{item.title}</h3>
      <Citation item={item} row={row} />
      {item.summary ? <p className="mt-2 text-meta text-ink">{item.summary}</p> : null}
      {/* 본문은 글자로만 그린다 — 요소로 해석하지 않는다 */}
      {item.body_md ? <p className="mt-2 max-w-[70ch] text-meta whitespace-pre-wrap text-ink">{item.body_md}</p> : null}
      {item.quote ? <blockquote className="mt-2 max-w-[70ch] rounded-md bg-surface-sunk px-3 py-2 text-meta text-ink">{item.quote}</blockquote> : null}
      {item.url ? (
        <p className="mt-2 text-meta break-all">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary-ink underline underline-offset-2 hover:decoration-2">
              {item.url}
              <span className="sr-only"> (새 탭에서 열림)</span>
            </a>
          ) : (
            <span className="text-ink-2">{item.url}</span>
          )}
        </p>
      ) : null}
    </li>
  );
}

/**
 * 참고 내용(읽기 전용) — 목록 아래에 펼치는 비모달 칸. AI 전달이 안 되는 참고 프로젝트도 사람은 내용을 본다.
 * 읽기 실패(PesApiError 포함)는 role=alert, 그때 내용은 보이지 않는다.
 */
export function ContentPane({ slug, edition, row, onClose }: { slug: string; edition: number; row: ReferenceRow; onClose: () => void }) {
  const detail = useReferenceDetail(slug, edition, row.id);
  const headingId = React.useId();
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    ref.current?.focus({ preventScroll: false });
  }, []);
  const name = nameOf(row);
  // 읽는 동안 낡은 줄이 아니라 지금 받은 줄을 쓴다(고정한 버전 이름이 바뀌었을 수 있다)
  const current = detail.data?.reference ?? row;
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={headingId} data-reference-content={row.id} className="mt-8 scroll-mt-24 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title break-words text-ink">
            참고 내용: {name}
          </h2>
          <p className="mt-1 text-meta text-ink-2">읽기 전용이에요. 원본은 여기서 고칠 수 없어요. 고정한 버전: {current.source_snapshot_key ?? "버전 정보 없음"}</p>
        </div>
        <div data-print="hide">
          <Button variant="outline" size="sm" onClick={onClose}>
            닫기<span className="sr-only">: 참고 내용</span>
          </Button>
        </div>
      </div>
      {detail.isPending ? (
        <p aria-busy="true" className="mt-3 text-meta text-ink-2">
          내용을 불러오는 중
        </p>
      ) : detail.isError ? (
        <p role="alert" className="mt-3 text-meta font-medium text-bad">
          내용을 읽지 못했어요. {detail.error.message}
        </p>
      ) : detail.data === null ? (
        <p className="mt-3 text-meta text-ink-2">이 참고 프로젝트를 더는 찾을 수 없어요. 목록이 바뀌었을 수 있어요.</p>
      ) : detail.data.content === null || detail.data.content.items.length === 0 ? (
        <p className="mt-3 text-meta text-ink-2">볼 수 있는 내용이 없어요.</p>
      ) : (
        <ul className="mt-2 border-t border-line">
          {detail.data.content.items.map((item) => (
            <Item key={`${item.item}-${item.object_id}-${item.version_id}`} item={item} row={current} />
          ))}
        </ul>
      )}
    </section>
  );
}
