import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { PesApiError, type MaterialPreview, type MaterialRow } from "@/api/types";
import { useClient } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { formatWord, sizeWord } from "./format";

/** <pre> 에 보일 글자 수 상한 — 큰 글 파일이 화면을 멈추지 않게 앞부분만 */
const TEXT_LIMIT = 100_000;

type Shown = { kind: "text"; text: string; cut: boolean } | { kind: "image"; bytes: Uint8Array } | { kind: "download" };

/**
 * 미리보기 방식을 정한다(SEL-102) — 같은 출처 문서로 열지 않는다.
 *  - 안전한 글(text/plain)은 글자로만(<pre> 의 글자 노드 — 본문의 태그가 요소가 되지 않는다), png 는 <img>, 그 밖은 열지 않고 내려받기만.
 *  - 서버가 attachment 라고 했거나 sandbox 헤더를 붙인 것, 모르는 형식은 열지 않는다. iframe · object · embed 는 쓰지 않는다.
 */
function decide(p: MaterialPreview): Shown {
  const type = p.content_type.split(";")[0]?.trim().toLowerCase();
  if (!p.inline || p.sandbox !== null) return { kind: "download" };
  if (type === "text/plain") {
    const text = new TextDecoder("utf-8").decode(p.bytes);
    return text.length > TEXT_LIMIT ? { kind: "text", text: text.slice(0, TEXT_LIMIT), cut: true } : { kind: "text", text, cut: false };
  }
  if (type === "image/png") return { kind: "image", bytes: p.bytes };
  return { kind: "download" };
}

/** 바이트 → blob 주소(그림 · 내려받기). 화면에서 사라질 때 풀어 준다 */
function useBlobUrl(bytes: Uint8Array | null, type: string): string | null {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!bytes || typeof URL.createObjectURL !== "function") return;
    const made = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    // blob 주소는 브라우저 바깥 자원이라 효과로 맞춘다(그리는 중에 만들면 다시 그릴 때마다 새로 생긴다)
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(made);
    return () => {
      URL.revokeObjectURL?.(made);
      setUrl(null);
    };
  }, [bytes, type]);
  return url;
}

function Body({ row, preview }: { row: MaterialRow; preview: MaterialPreview }) {
  const shown = React.useMemo(() => decide(preview), [preview]);
  const imageUrl = useBlobUrl(shown.kind === "image" ? shown.bytes : null, "image/png");
  // 내려받기는 어떤 형식이든 문서로 열리지 않게 일반 바이트로 만든다
  const saveUrl = useBlobUrl(shown.kind === "download" ? preview.bytes : null, "application/octet-stream");
  if (shown.kind === "text") {
    return (
      <>
        {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 긴 글을 키보드로 밀어 볼 수 있게 초점을 받는다 */}
        <pre tabIndex={0} aria-label={`${row.title} 내용`} className="mt-3 max-h-96 overflow-auto rounded-md border border-line bg-surface-sunk p-3 font-mono text-meta whitespace-pre-wrap text-ink">
          {shown.text}
        </pre>
        {shown.cut ? <p className="mt-1 text-caption text-ink-2">앞부분 {TEXT_LIMIT.toLocaleString("ko-KR")}자만 보여요. 전체는 내려받아 확인하세요.</p> : null}
      </>
    );
  }
  if (shown.kind === "image") {
    return imageUrl ? <img src={imageUrl} alt={`${row.title} 미리보기 그림`} className="mt-3 max-h-96 max-w-full rounded-md border border-line object-contain" /> : null;
  }
  return (
    <div className="mt-3 text-meta text-ink-2">
      <p>이 형식({formatWord(row)})은 화면에서 미리볼 수 없습니다. 내려받아 확인하세요.</p>
      {saveUrl ? (
        <p className="mt-2">
          <a href={saveUrl} download={row.original_name} className="text-primary-ink underline underline-offset-2 hover:decoration-2">
            내려받기: {row.original_name}
          </a>
          <span className="ml-2 text-caption">{sizeWord(preview.bytes.byteLength)}</span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * 미리보기 칸(MAT1c · SEL-102) — 표 아래 비모달 region “미리보기: <제목>”. 미리보기 주소는 세션 헤더가 필요해 링크로 열 수 없으니
 * 클라이언트가 바이트를 받아 화면이 그린다. 사람 화면이라 금지(deny) 파일도 미리볼 수 있다. Esc 또는 닫기로 닫으면 초점이 연 단추로 돌아간다.
 */
export function PreviewPane({ row, slug, edition, onClose }: { row: MaterialRow; slug: string; edition: number; onClose: () => void }) {
  const client = useClient();
  const ref = React.useRef<HTMLElement>(null);
  const q = useQuery({
    queryKey: ["materials-preview", slug, edition, row.blob_id],
    queryFn: () => client.getMaterialPreview(slug, edition, row.blob_id),
    // 바이트는 닫으면 버린다 — 다시 열면 다시 읽는다(변조 거절도 다시 확인)
    gcTime: 0,
    staleTime: Infinity,
  });
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  // Esc 는 이 칸 안에서 눌렀을 때만 닫는다(다른 대화 상자의 Esc 와 섞이지 않게)
  const close = React.useRef(onClose);
  React.useEffect(() => {
    close.current = onClose;
  });
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && ref.current?.contains(e.target as Node)) close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const titleId = `preview-title-${row.object_id}`;
  const error = q.error;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-busy={q.isPending || undefined}
      className="mt-6 rounded-md border border-line bg-surface p-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={titleId} className="text-title text-ink">
            미리보기: {row.title}
          </h2>
          <p className="text-caption text-ink-2">
            {row.original_name} · {formatWord(row)} · {sizeWord(row.size)}
            {row.ai_access === "deny" ? " · AI 참조 금지 파일이지만 사람은 미리볼 수 있어요" : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          닫기
        </Button>
      </div>
      {q.isPending ? <p className="mt-3 text-meta text-ink-2">불러오는 중</p> : null}
      {error ? (
        <p role="alert" className="mt-3 text-meta font-medium text-bad">
          미리보기를 열지 못했어요. {error instanceof PesApiError ? error.message : "잠시 뒤 다시 열어 주세요."}
        </p>
      ) : null}
      {q.data ? <Body row={row} preview={q.data} /> : null}
    </section>
  );
}
