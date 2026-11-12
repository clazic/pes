import type { ResultView } from "@/api/types";
import { formatAt, resultMetaText } from "@/lib/labels";

/** 결과 글 머리글 아래 한 줄 — 서버가 준 값(버전 번호 · 채택 여부 · 시각)만 보이고, 없는 것은 숨긴다. 하나도 없으면 줄이 없다 */
export function ResultMeta({ result }: { result: Pick<ResultView, "version" | "status" | "updated_at"> }) {
  const lead = resultMetaText({ ...result, updated_at: null });
  const at = result.updated_at;
  if (lead === null && at === null) return null;
  return (
    <p className="mt-0.5 text-caption text-muted-foreground">
      {lead}
      {lead !== null && at !== null ? " · " : null}
      {at !== null ? <time dateTime={at}>{formatAt(at, false)}</time> : null}
    </p>
  );
}
