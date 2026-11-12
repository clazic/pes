import { FORMAT_VERSION, PesApiError, type ApiErrorCode, type CommandResult, type ReferenceCandidate, type ReferenceContent, type ReferenceRow, type ReferencesMethods, type ReferenceSnapshot, type Receipt } from "./types";

/**
 * 가짜 클라이언트의 참고 프로젝트(REF1b · SEL-114) — 메모리 안 합성 자료. 서버(SEL-113)처럼 거절하고 영수증을 준다:
 * 이미 붙인 프로젝트 → conflict · base_rev 어긋남 → rev_conflict · 지금 고정된 버전(또는 원본 없음 행)으로 다시 고정 → conflict · 같은 멱등 키 같은 요청은 처음 영수증을 replayed 로.
 * 후보 프로젝트 · 스냅숏 읽기는 서버에 길이가 없지만 가짜는 합성 후보를 돌려준다(화면 시험 · 시안용). 네트워크를 쓰지 않는다.
 */

/** 합성 스냅숏 — 1판 완료본(추천) · 2판 R1 승인본 · 2판 진행 중(승인 안 됨) */
const snapshotsOf = (tag: string, name: string): ReferenceSnapshot[] => [
  { id: `s-${tag}1`, key: "1판 완료본", label: `1판 완료본 · ${name}`, approved: true, recommended: true },
  { id: `s-${tag}2`, key: "2판 R1 승인본", label: `2판 R1 승인본 · ${name}`, approved: true, recommended: false },
  { id: `s-${tag}3`, key: "2판 진행 중", label: `2판 진행 중 스냅숏 · ${name}`, approved: false, recommended: false },
];

export const DEMO_REFERENCE_CANDIDATES: ReferenceCandidate[] = [
  { project_id: "pj-a", key: "synthetic-a", label: "합성 장기요양", attached: false, snapshots: snapshotsOf("a", "합성 장기요양") },
  { project_id: "pj-b", key: "synthetic-b", label: "합성 물가", attached: false, snapshots: snapshotsOf("b", "합성 물가") },
  { project_id: "pj-c", key: "synthetic-c", label: "합성 지역통계", attached: false, snapshots: snapshotsOf("c", "합성 지역통계") },
  { project_id: "pj-d", key: "synthetic-d", label: "합성 병원", attached: false, snapshots: snapshotsOf("d", "합성 병원") },
];

const ATTACHED_AT = "2026-11-10T09:00:00+09:00";
const row = (n: number, over: Partial<ReferenceRow> = {}): ReferenceRow => ({
  id: `ref-${n}`,
  access: "ok",
  state: "pinned",
  referenced_project_id: `pj-${n}`,
  referenced_project_key: `synthetic-${n}`,
  source_label: `합성 참고 ${n}`,
  source_snapshot_id: `s-${n}1`,
  source_snapshot_key: "1판 완료본",
  latest_snapshot_id: `s-${n}1`,
  new_version_available: false,
  scope: ["final_report", "sources"],
  ai_delivery: { allowed: true, withheld_reason: null },
  attached_at: ATTACHED_AT,
  refreshed_at: null,
  rev: "1",
  ...over,
});

/**
 * 앱 기본 합성 참고 프로젝트(sample-study 1판) — 새 버전 있음 · 고정됨(원본 Go 꺼짐) · 원본 없음 · 권한 없음 · 고정됨(이 프로젝트 Go 꺼짐).
 * 권한 없는 줄은 서버처럼 id · access · state 외 칸이 모두 null.
 */
export const DEMO_REFERENCES: ReferenceRow[] = [
  row(1, { referenced_project_id: "pj-a", referenced_project_key: "synthetic-a", source_label: "합성 장기요양", source_snapshot_id: "s-a1", latest_snapshot_id: "s-a2", state: "new_version", new_version_available: true }),
  row(2, { referenced_project_id: "pj-b", referenced_project_key: "synthetic-b", source_label: "합성 물가", source_snapshot_id: "s-b1", latest_snapshot_id: "s-b1", ai_delivery: { allowed: false, withheld_reason: "source_go_off" } }),
  row(3, {
    state: "source_missing",
    referenced_project_id: null,
    referenced_project_key: "synthetic-gone",
    source_label: "합성 폐기본",
    source_snapshot_id: null,
    source_snapshot_key: "1판 완료본",
    latest_snapshot_id: null,
    ai_delivery: { allowed: false, withheld_reason: "source_missing" },
  }),
  {
    id: "ref-4",
    access: "no_permission",
    state: "no_permission",
    referenced_project_id: null,
    referenced_project_key: null,
    source_label: null,
    source_snapshot_id: null,
    source_snapshot_key: null,
    latest_snapshot_id: null,
    new_version_available: null,
    scope: null,
    ai_delivery: null,
    attached_at: null,
    refreshed_at: null,
    rev: null,
  },
  row(5, { referenced_project_id: "pj-d", referenced_project_key: "synthetic-d", source_label: "합성 병원", source_snapshot_id: "s-d1", latest_snapshot_id: "s-d1", ai_delivery: { allowed: false, withheld_reason: "project_go_off" } }),
];

const fail = (code: ApiErrorCode, message: string, target?: string): never => {
  throw new PesApiError({
    format_version: FORMAT_VERSION,
    error: { code, message, retryable: false, ...(target ? { target } : {}), next_action: "reread_context" },
    request_id: "req-fake-ref",
  });
};

export interface FakeReferencesOptions {
  /** 이 slug · 판만 안다 — 다른 곳은 [] / null / not_found */
  known: (slug: string, edition: number) => boolean;
  /** 쓰기 성공마다(변경분 읽기용 기록) */
  committed: (tx_id: string) => void;
  /** 처음 영수증 번호가 이어 가는 값(다른 쓰기와 겹치지 않게 큰 수에서 시작) */
  firstSeq?: number;
}

export function createFakeReferences(options: FakeReferencesOptions, rows: ReferenceRow[] = DEMO_REFERENCES, candidates: ReferenceCandidate[] = DEMO_REFERENCE_CANDIDATES): ReferencesMethods {
  const store = structuredClone(rows);
  const done = new Map<string, { request: string; result: CommandResult<unknown> }>();
  let seq = options.firstSeq ?? 1500;
  let nextId = 50;

  const snapOf = (projectId: string | null, id: string | null | undefined) => (id ? candidates.find((c) => c.project_id === projectId)?.snapshots.find((x) => x.id === id) : undefined);
  const attachedIds = () => new Set(store.flatMap((x) => (x.referenced_project_id ? [x.referenced_project_id] : [])));

  /** 쓰기 하나 — 순서: 멱등 키 확인 → 같은 키의 처음 영수증 재생(다른 요청이면 거절) → 대상 검사 · 변경 */
  async function command<T>(slug: string, edition: number, key: string | undefined, parts: unknown[], apply: () => T): Promise<CommandResult<T>> {
    if (!key) return fail("invalid_payload", "요청 내용이 올바르지 않습니다.", "$.headers.idempotency-key");
    const request = JSON.stringify([slug, edition, parts]);
    const first = done.get(key);
    if (first) {
      if (first.request !== request) return fail("idempotency_key_reuse", "같은 Idempotency-Key로 다른 요청을 보냈습니다.", "$.headers.idempotency-key");
      const again = structuredClone(first.result) as CommandResult<T>;
      return { ...again, receipt: { ...again.receipt, replayed: true } };
    }
    if (!options.known(slug, edition)) return fail("not_found", "요청한 대상을 찾을 수 없습니다.", "$.project");
    const data = apply();
    const n = String(++seq).padStart(4, "0");
    const receipt: Receipt = { receipt_no: n, numbered: true, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: key, replayed: false };
    const result: CommandResult<T> = { format_version: FORMAT_VERSION, request_id: `req-ref-${n}`, receipt, data };
    done.set(key, { request, result });
    options.committed(receipt.tx_id);
    return structuredClone(result);
  }

  /** 읽는 줄의 내용(서버가 주는 모양): 범위에 든 항목만. 원본 없음 · 권한 없음은 내용이 없다 */
  function contentOf(r: ReferenceRow): ReferenceContent | null {
    if (r.access !== "ok" || r.state === "source_missing") return null;
    const label = r.source_label ?? "";
    const citation = (object: string) => ({ reference_id: r.id, project_id: r.referenced_project_id ?? "", project_label: label, snapshot_id: r.source_snapshot_id ?? "", object_id: `obj-${object}`, version_id: `ver-${object}` });
    const items: ReferenceContent["items"] = [];
    const scope = r.scope ?? [];
    if (scope.includes("final_report")) {
      items.push({ item: "final_report", object_id: "obj-rep", version_id: "ver-rep", kind: "report", title: `${label} 최종 보고서`, summary: "합성 요약 한 줄", body_md: "합성 보고서 본문입니다.\n\n둘째 문단입니다.", url: null, quote: null, citation: citation("rep") });
    }
    if (scope.includes("sources")) {
      items.push({ item: "sources", object_id: "obj-src", version_id: "ver-src", kind: "web", title: `${label} 출처`, summary: null, body_md: null, url: null, quote: "합성 발췌 문장", citation: citation("src") });
    }
    return { items };
  }

  return {
    async getReferences(slug, edition) {
      return options.known(slug, edition) ? structuredClone(store) : [];
    },
    async getReference(slug, edition, refId) {
      if (!options.known(slug, edition)) return null;
      const r = store.find((x) => x.id === refId);
      return r ? structuredClone({ reference: r, content: contentOf(r) }) : null;
    },
    async getReferenceCandidates(scope) {
      const attached = scope && options.known(scope.slug, scope.edition) ? attachedIds() : new Set<string>();
      return structuredClone(candidates).map((c) => ({ ...c, attached: attached.has(c.project_id) }));
    },
    attachReference: (slug, edition, input, key) =>
      command(slug, edition, key, ["attach", input], () => {
        const cand = candidates.find((c) => c.project_id === input.referenced_project_id);
        const snap = snapOf(cand?.project_id ?? null, input.source_snapshot_id);
        if (!cand || !snap) return fail("not_found", "그 프로젝트나 버전을 찾을 수 없습니다.", "$.body.source_snapshot_id");
        if (attachedIds().has(cand.project_id)) return fail("conflict", "이미 붙인 프로젝트입니다.", "$.body.referenced_project_id");
        const created = row(++nextId, {
          referenced_project_id: cand.project_id,
          referenced_project_key: cand.key,
          source_label: input.source_label || cand.label,
          source_snapshot_id: snap.id,
          source_snapshot_key: snap.key,
          latest_snapshot_id: cand.snapshots.find((x) => x.recommended)?.id ?? snap.id,
          scope: input.scope ?? ["final_report", "sources"],
        });
        created.state = created.latest_snapshot_id !== snap.id ? "new_version" : "pinned";
        created.new_version_available = created.state === "new_version";
        store.push(created);
        return { reference: structuredClone(created) };
      }),
    refreshReference: (slug, edition, refId, input, key) =>
      command(slug, edition, key, ["refresh", refId, input], () => {
        const r = store.find((x) => x.id === refId);
        if (!r) return fail("not_found", "그 참고 프로젝트를 찾을 수 없습니다.");
        if (r.access !== "ok" || r.state === "source_missing") return fail("conflict", "원본이 없거나 권한이 없어 다시 고정할 수 없습니다.");
        if (input.base_rev !== undefined && input.base_rev !== r.rev) return fail("rev_conflict", "그사이 다른 곳에서 바뀌었습니다. 다시 읽어 주세요.", "$.body.base_rev");
        const wanted = input.source_snapshot_id ?? r.latest_snapshot_id ?? undefined;
        if (wanted === r.source_snapshot_id) return fail("conflict", "이미 그 버전으로 고정되어 있습니다.", "$.body.source_snapshot_id");
        const snap = snapOf(r.referenced_project_id, wanted);
        if (!snap) return fail("not_found", "그 버전을 찾을 수 없습니다.", "$.body.source_snapshot_id");
        r.source_snapshot_id = snap.id;
        r.source_snapshot_key = snap.key;
        r.rev = String(Number(r.rev) + 1);
        r.refreshed_at = new Date().toISOString();
        r.state = r.latest_snapshot_id && r.latest_snapshot_id !== snap.id ? "new_version" : "pinned";
        r.new_version_available = r.state === "new_version";
        return { reference: structuredClone(r) };
      }),
    detachReference: (slug, edition, refId, key) =>
      command(slug, edition, key, ["detach", refId], () => {
        const i = store.findIndex((x) => x.id === refId);
        if (i < 0) return fail("not_found", "그 참고 프로젝트를 찾을 수 없습니다.");
        store.splice(i, 1);
        return { reference_id: refId, detached: true as const };
      }),
  };
}
