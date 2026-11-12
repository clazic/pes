import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { FORMAT_VERSION, PesApiError, type CommandResult, type PesClient } from "@/api/types";
import { renderApp, type Env } from "@/test/render-app";
import { createScriptedClient, timeoutError } from "@/test/scripted-client";
import { base } from "@/test/contract";
import { ready } from "@/test/ui";

/**
 * SEL-114 REF1b 시험 계약 — 이전 프로젝트 참고자료 화면(앱): 생성 화면(/new) “참고 프로젝트” 칸 · 작업 중 참고 프로젝트 목록 · 붙이기 · 떼기 · 다른 버전으로 다시 고정 · 인용 표시.
 * 이슈(SEL-114 · 부모 SEL-110), 서버 계약 SEL-113(REF1a, `git -C ~/hc-work/pes/SEL-113 show 081719e:tests/helpers/sel113_env.ts` · `tests/test_sel113_api.test.ts` 머리말),
 * 설계 dashboard-v2.md 4.9 · 5.3 · 5.4 · F06 · 승인 시안(dashboard-v2-react ReferencesPage.tsx · SnapshotPick) 에서 뽑은 해석이다. 구현을 추측해서 맞춘 것이 아니다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료 · 키 · 경로 없음).
 *
 * ═══ PesClient 확장 — 정한 인터페이스 (types.ts 에 같은 이름으로 추가한다. 가짜 · HTTP 클라이언트가 같이 지킨다) ═══
 *   getReferences(slug, edition): Promise<ReferenceRow[]>                모르는 slug · 없는 판 = []
 *   getReference(slug, edition, refId): Promise<{ reference: ReferenceRow; content: ReferenceContent | null } | null>   없으면 null
 *   getReferenceCandidates(scope: { slug: string; edition: number } | null): Promise<ReferenceCandidate[]>
 *        붙일 수 있는 프로젝트와 각 프로젝트의 고를 수 있는 스냅숏. scope=null 이면 생성 화면(프로젝트가 아직 없음). 서버에 읽는 길이 없으면 NotConnectedError.
 *   attachReference(slug, edition, input: { referenced_project_id; source_snapshot_id; scope?: string[]; source_label?: string }, key): CommandResult<{ reference: ReferenceRow }>
 *   refreshReference(slug, edition, refId, input: { source_snapshot_id?: string; base_rev?: string }, key): CommandResult<{ reference: ReferenceRow }>
 *   detachReference(slug, edition, refId, key): CommandResult<{ reference_id: string; detached: true }>
 *   쓰기는 모두 멱등 키 필수(없으면 요청 없이 invalid_payload) · 같은 키 · 같은 요청은 처음 영수증을 replayed 로 · 거절은 PesApiError.
 *
 * ═══ 화면 계약 ═══
 * [주소 · 위치]
 *   작업 중 목록: `/p/:slug/e/:edition/references` (사이드바 · 머리줄 셸 안, `main` 하나, 화면 제목 `[data-screen-title]` h1 “참고 프로젝트”).
 *     사이드바에 링크(이름에 “참고 프로젝트”)가 있고 이 주소로 간다(aria-current="page").
 *   생성 화면: `/new` — 앱에는 아직 생성 마법사가 없다(SEL-117 이 /new 에 “내 자료” 칸을 만든다). 이 이슈는 그 화면의 **“참고 프로젝트” 칸**을 만든다. 프로젝트가 아직 없어
 *     서버에 아무것도 붙이지 않는다(attachReference · getReferences 호출 0) — 담기만. 만들기(프로젝트 생성 명령)와의 연결은 이 이슈 밖(후속).
 *     main 안 region 이름 “참고 프로젝트”(제목 h2). 후보 읽기는 getReferenceCandidates(null) 한 번.
 * [표] caption “참고 프로젝트” 를 가진 table 하나, 열 머리 th[scope=col]. 행 `[data-reference="<id>"]` + `data-state="pinned|new_version|source_missing|source_archived|no_permission"`.
 *   칸 `[data-cell="…"]`: name(source_label + referenced_project_key) · version(고정한 버전 = source_snapshot_key, 모르면 “버전 정보 없음”) · state(상태 낱말) · ai-delivery · actions.
 *   상태 낱말(색만으로 알리지 않는다): pinned “고정됨” · new_version “새 버전 있음” · source_missing “원본 없음” · source_archived “원본 보관됨” · no_permission “권한 없음”.
 *   새 버전 있음: state 칸에 낱말 + “저절로 바뀌지 않” 고지(고정 버전은 그대로이고 사람이 고를 때만 바뀐다). state 가 new_version 일 때만 — 고정됨 행에는 없다.
 *   원본 없음(tombstone): 이름(label · key)과 고정했던 버전 이름은 그대로 보이고 “원본 없음”, 다른 버전으로 다시 고정 단추 없음(서버가 409), 떼기 단추는 있다.
 *   권한 없음: 이름 · key · label · 버전 id 어느 것도 화면에 없다(서버가 안 준다) — 행에는 “권한 없음”과 “내용 비공개”만. 내용 보기 · 다시 고정 단추 없음, 떼기 단추는 있다(이름 “떼기: 권한 없는 참고 프로젝트”).
 *   AI 전달(ai-delivery 칸, 행 `data-ai-delivery="allowed|withheld|unknown"`): allowed true → “AI 전달 가능” · false → “AI 전달 안 됨” + 이유 한 줄
 *     (withheld_reason source_go_off → “원본 프로젝트의 Go 가 꺼져 있어” · project_go_off → “이 프로젝트의 Go 가 꺼져 있어” · source_missing → “원본 없음”, 처음 보는 이유 값은 값을 그대로 찍지 않고 “AI 전달 안 됨”만).
 *     ai_delivery 를 서버가 안 주면 unknown → “AI 전달 정보 없음”(allowed 로 간주하지 않는다). 표 위 상시 안내 `[data-ai-notice]`: AI 전달이 안 되는 참고 프로젝트도 “이 화면에서는 계속 보입니다”(사람에게는 내용이 보인다),
 *     과장 낱말(OVERCLAIM) 없음.
 *   행이 0 이면 표 대신 “붙인 참고 프로젝트가 없습니다”(오류 아님) + 붙이기 단추. 읽기 실패는 role=alert(빈 상태로 보이지 않음).
 * [붙이기] 단추 “참고 프로젝트 붙이기” → role=dialog 이름 “참고 프로젝트 붙이기”. 안에서 getReferenceCandidates({slug, edition}) 한 번.
 *   radiogroup “참고할 프로젝트”(radio 이름 = 후보 label. 이미 붙인 프로젝트(attached)는 목록에 남되 “이미 붙임” 글과 함께 radio disabled — 숨기지 않는다) → 고르면 radiogroup “고정할 버전”이 그 프로젝트의 스냅숏을 보인다.
 *   스냅숏 radio 이름에 스냅숏 label, 승인 안 된 것은 “승인 안 됨” 글(승인본처럼 보이지 않게). 추천(recommended) 스냅숏이 기본으로 골라져 있다(고정할 버전을 항상 함께 정한다 — 고르지 않은 채 붙일 수 없다).
 *   범위 체크박스 “최종 보고서” · “조사 출처”(둘 다 기본 켜짐 = 서버 기본) — 둘 다 끄면 붙이기 단추 aria-disabled(요청 없음). 단추 “취소” · “붙이기”.
 *   붙이기 보낸 값: attachReference(slug, ed, { referenced_project_id, source_snapshot_id, scope: 켜진 칸 key 배열 }, 키). 프로젝트를 안 골랐으면 붙이기 aria-disabled(요청 0).
 *   F06: 보내는 동안 단추 aria-disabled(두 번 눌러도 한 번) · 영수증 전에는 role=status “접수 확인 중”뿐 — 성공 말 · 새 행 없음. 영수증 뒤 목록을 다시 읽어 새 행 · 대화 상자 닫힘 · “접수 <receipt_no>”.
 *   거절(PesApiError): role=alert 에 서버 메시지 · 대화 상자와 고른 값 그대로. 시간 초과: “접수 확인 중” 유지(실패 아님), 다시 누르면 **같은 멱등 키**.
 *   후보를 못 읽으면(NotConnectedError 등): 대화 상자 안 role=alert(서버 메시지/연결 안 됨 문장), 붙이기 단추 aria-disabled, 요청 0.
 * [떼기] 행 단추 “떼기: <source_label>” → role=dialog 이름 “참고 프로젝트 떼기”(원본은 그대로이고, 이미 쓴 인용은 옛 버전 그대로임을 말한다: “원본” “그대로” “인용” 포함) · 단추 “취소” · “떼기”.
 *   F06 은 붙이기와 같다. 성공 뒤 목록을 다시 읽어 그 행이 사라진다. 거절은 role=alert · 행 그대로.
 * [다른 버전으로 다시 고정] 행 단추 “다시 고정: <source_label>” → role=dialog 이름 “다른 버전으로 다시 고정”. 안에서 getReferenceCandidates({slug, edition}).
 *   radiogroup “고정할 버전” = 그 프로젝트의 스냅숏, 지금 고정된 것에 “지금 고정됨” 글. 새 버전 있음이면 latest_snapshot_id 가 기본 선택, 아니면 지금 고정된 것.
 *   지금 고정된 것을 고르면 “다시 고정” aria-disabled(서버가 409). 보낸 값: refreshReference(slug, ed, ref.id, { source_snapshot_id, base_rev: 그 행의 rev }, 키).
 *   성공은 영수증 뒤(F06) — 영수증 전에는 행의 버전 · 상태가 그대로. 409 conflict / rev_conflict: role=alert 에 서버 메시지 · 대화 상자 그대로 · 성공 말 없음 · 목록을 다시 읽는다(다른 곳에서 바뀐 값을 따른다).
 * [내용 보기 · 인용] 단추 “내용 보기: <source_label>”(원본 없음 · 권한 없음 행에는 없다) → region(또는 비모달 dialog) 이름 “참고 내용: <source_label>”. getReference 한 번.
 *   읽기 전용임을 말한다(“읽기 전용”). 항목마다 `[data-citation]` 에 **프로젝트 label 과 고정한 버전 이름(source_snapshot_key)** 이 보인다 — 인용은 어느 프로젝트 · 어느 버전인지 늘 보인다(SEL-110).
 *   본문은 글자로만(textContent) — `<script>` 가 요소가 되지 않는다. AI 전달이 안 되는 참고 프로젝트도 사람은 내용을 본다. 실패(PesApiError)는 role=alert, 내용 안 보임.
 * [접근성] 표 · 라디오 · 대화 상자는 키보드만으로: Tab 으로 단추에 닿고 Enter 가 열고, 방향키가 라디오를 옮기고, Esc 가 닫고 초점이 연 단추로 돌아온다. 대화 상자 안에 초점이 갇힌다. 상태 변화(role=status)는 polite, 경고(role=alert)와 섞이지 않는다.
 *
 * [e2e 가 기대하는 앱 기본 가짜 클라이언트 자료 — sample-study 판 1] 참고 프로젝트 행 4개 이상: 고정됨 · 새 버전 있음 · 원본 없음 · 권한 없음 상태가 각각 하나 이상(합성). 후보 프로젝트 2개 이상.
 */

/* ───────────── 타입(정한 인터페이스) ───────────── */

export type ReferenceState = "pinned" | "new_version" | "source_missing" | "source_archived" | "no_permission";
export type WithheldReason = string;

export interface ReferenceAiDelivery {
  allowed: boolean;
  withheld_reason: WithheldReason | null;
}

/** 서버가 안 주는 칸은 null — 권한 없는 줄은 id · access · state 만 값이 있고 나머지는 모두 null */
export interface ReferenceRow {
  id: string;
  access: "ok" | "no_permission";
  state: ReferenceState;
  referenced_project_id: string | null;
  referenced_project_key: string | null;
  source_label: string | null;
  source_snapshot_id: string | null;
  source_snapshot_key: string | null;
  latest_snapshot_id: string | null;
  new_version_available: boolean | null;
  scope: string[] | null;
  ai_delivery: ReferenceAiDelivery | null;
  attached_at: string | null;
  refreshed_at: string | null;
  /** 서버의 10진 문자열 그대로(다시 고정의 base_rev) */
  rev: string | null;
}

export const REF_ROW_KEYS = ["access", "ai_delivery", "attached_at", "id", "latest_snapshot_id", "new_version_available", "referenced_project_id", "referenced_project_key", "refreshed_at", "rev", "scope", "source_label", "source_snapshot_id", "source_snapshot_key", "state"];

export interface ReferenceCitation {
  reference_id: string;
  project_id: string;
  project_label: string;
  snapshot_id: string;
  object_id: string;
  version_id: string;
}
/** 서버가 항목 종류별로만 주는 칸(보고서: title · summary · body_md / 출처: title · url · quote)을 안 준 쪽은 null */
export interface ReferenceContentItem {
  item: "final_report" | "sources";
  object_id: string;
  version_id: string;
  kind: string;
  title: string;
  summary: string | null;
  body_md: string | null;
  url: string | null;
  quote: string | null;
  citation: ReferenceCitation;
}
export interface ReferenceContent {
  items: ReferenceContentItem[];
}

export interface ReferenceSnapshot {
  id: string;
  key: string;
  label: string;
  approved: boolean;
  recommended: boolean;
}
export interface ReferenceCandidate {
  project_id: string;
  key: string;
  label: string;
  /** 이미 이 프로젝트에 붙인 프로젝트 */
  attached: boolean;
  snapshots: ReferenceSnapshot[];
}

export interface ReferenceAttachInput {
  referenced_project_id: string;
  source_snapshot_id: string;
  scope?: string[];
  source_label?: string;
}
export interface ReferenceRefreshInput {
  source_snapshot_id?: string;
  base_rev?: string;
}

export interface ReferencesMethods {
  getReferences(slug: string, edition: number): Promise<ReferenceRow[]>;
  getReference(slug: string, edition: number, refId: string): Promise<{ reference: ReferenceRow; content: ReferenceContent | null } | null>;
  getReferenceCandidates(scope: { slug: string; edition: number } | null): Promise<ReferenceCandidate[]>;
  attachReference(slug: string, edition: number, input: ReferenceAttachInput, idempotencyKey: string | undefined): Promise<CommandResult<{ reference: ReferenceRow }>>;
  refreshReference(slug: string, edition: number, refId: string, input: ReferenceRefreshInput, idempotencyKey: string | undefined): Promise<CommandResult<{ reference: ReferenceRow }>>;
  detachReference(slug: string, edition: number, refId: string, idempotencyKey: string | undefined): Promise<CommandResult<{ reference_id: string; detached: true }>>;
}

/* ───────────── 합성 자료 ───────────── */

export const REFS = `${base}/references`;
export const NEW = "/new";

/** 1판 완료본(추천) · 2판 R1 승인본 · 2판 진행 중(승인 안 됨) */
export const snapshotsOf = (tag: string): ReferenceSnapshot[] => [
  { id: `s-${tag}1`, key: "1판 완료본", label: `1판 완료본 · 합성 ${tag}`, approved: true, recommended: true },
  { id: `s-${tag}2`, key: "2판 R1 승인본", label: `2판 R1 승인본 · 합성 ${tag}`, approved: true, recommended: false },
  { id: `s-${tag}3`, key: "2판 진행 중", label: `2판 진행 중 스냅숏 · 합성 ${tag}`, approved: false, recommended: false },
];

export const CANDIDATES: ReferenceCandidate[] = [
  { project_id: "pj-a", key: "synthetic-a", label: "합성 장기요양", attached: true, snapshots: snapshotsOf("a") },
  { project_id: "pj-b", key: "synthetic-b", label: "합성 물가", attached: true, snapshots: snapshotsOf("b") },
  { project_id: "pj-c", key: "synthetic-c", label: "합성 지역통계", attached: false, snapshots: snapshotsOf("c") },
  { project_id: "pj-d", key: "synthetic-d", label: "합성 병원", attached: true, snapshots: snapshotsOf("d") },
];

const ISO = "2026-11-10T09:00:00+09:00";
export const ref = (n: number, over: Partial<ReferenceRow> = {}): ReferenceRow => ({
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
  attached_at: ISO,
  refreshed_at: null,
  rev: "1",
  ...over,
});
export const noPermission = (n: number): ReferenceRow => ({
  id: `ref-${n}`, access: "no_permission", state: "no_permission",
  referenced_project_id: null, referenced_project_key: null, source_label: null, source_snapshot_id: null, source_snapshot_key: null, latest_snapshot_id: null,
  new_version_available: null, scope: null, ai_delivery: null, attached_at: null, refreshed_at: null, rev: null,
});

/**
 * ref-1 장기요양(pj-a): 새 버전 있음 · ref-2 물가(pj-b): 고정됨, 원본 Go 꺼짐 · ref-3 폐기본: 원본 없음(tombstone, label · key 유지)
 * ref-4: 권한 없음(내용 없음) · ref-5 병원(pj-d): 고정됨, 이 프로젝트 Go 꺼짐
 */
export const REFERENCES: ReferenceRow[] = [
  ref(1, { referenced_project_id: "pj-a", referenced_project_key: "synthetic-a", source_label: "합성 장기요양", source_snapshot_id: "s-a1", latest_snapshot_id: "s-a2", state: "new_version", new_version_available: true }),
  ref(2, { referenced_project_id: "pj-b", referenced_project_key: "synthetic-b", source_label: "합성 물가", source_snapshot_id: "s-b1", latest_snapshot_id: "s-b1", ai_delivery: { allowed: false, withheld_reason: "source_go_off" } }),
  ref(3, {
    state: "source_missing", referenced_project_id: null, source_label: "합성 폐기본", referenced_project_key: "synthetic-gone", source_snapshot_id: null, source_snapshot_key: "1판 완료본", latest_snapshot_id: null,
    new_version_available: false, ai_delivery: { allowed: false, withheld_reason: "source_missing" },
  }),
  noPermission(4),
  ref(5, { referenced_project_id: "pj-d", referenced_project_key: "synthetic-d", source_label: "합성 병원", source_snapshot_id: "s-d1", latest_snapshot_id: "s-d1", ai_delivery: { allowed: false, withheld_reason: "project_go_off" } }),
];

export const citationOf = (r: ReferenceRow, item: string): ReferenceCitation => ({
  reference_id: r.id, project_id: r.referenced_project_id ?? "pj-x", project_label: r.source_label ?? "", snapshot_id: r.source_snapshot_id ?? "s-x", object_id: `obj-${item}`, version_id: `ver-${item}`,
});
export const contentOf = (r: ReferenceRow, over: Partial<ReferenceContentItem>[] = []): ReferenceContent => ({
  items: [
    { item: "final_report", object_id: "obj-rep", version_id: "ver-rep", kind: "report", title: `${r.source_label} 최종 보고서`, summary: "합성 요약 한 줄", body_md: "# 합성 보고서\n\n합성 본문 문단.", url: null, quote: null, citation: citationOf(r, "rep"), ...over[0] },
    { item: "sources", object_id: "obj-src", version_id: "ver-src", kind: "web", title: `${r.source_label} 출처`, summary: null, body_md: null, url: "https://example.invalid/synthetic-ref", quote: "합성 발췌 문장", citation: citationOf(r, "src"), ...over[1] },
  ],
});

/* ───────────── 가짜 클라이언트 ───────────── */

export interface AttachCall { slug: string; edition: number; input: ReferenceAttachInput; key: string | undefined }
export interface RefreshCall { slug: string; edition: number; ref_id: string; input: ReferenceRefreshInput; key: string | undefined }
export interface DetachCall { slug: string; edition: number; ref_id: string; key: string | undefined }

const err = (code: string, message: string) => new PesApiError({ format_version: FORMAT_VERSION, error: { code: code as never, message, retryable: false }, request_id: "req-ref" });
export const rejection = (message = "합성 거절 문장", code = "forbidden") => err(code, message);

/**
 * 가짜 클라이언트 위에 참고 프로젝트 읽기 · 쓰기를 얹는다. 서버처럼: 이미 붙인 프로젝트 → conflict · base_rev 어긋남 → rev_conflict · 지금 고정된 버전으로 다시 고정 → conflict
 * · 멱등 키가 같으면 처음 영수증을 replayed 로. hold() 다음 쓰기를 release() 까지 붙잡는다 · failNext(err) · loseReplyNext()(서버는 처리했지만 답이 시간 초과로 사라진다) · breakRead() · breakCandidates(err?)
 * · bumpOutside(): 다른 곳에서 rev 가 바뀐 것을 흉내(다음 다시 고정이 rev_conflict).
 */
export function createReferencesClient(rows: ReferenceRow[] = REFERENCES, candidates: ReferenceCandidate[] = CANDIDATES, contents: Record<string, ReferenceContent | null | Error> = {}) {
  const s = createScriptedClient();
  const store = structuredClone(rows);
  const attaches: AttachCall[] = [];
  const refreshes: RefreshCall[] = [];
  const detaches: DetachCall[] = [];
  const candidateCalls: Array<{ slug: string; edition: number } | null> = [];
  const detailCalls: string[] = [];
  const reads: string[] = [];
  const done = new Map<string, CommandResult<unknown>>();
  let seq = 700;
  let nextId = 50;
  let gate: Promise<void> | null = null;
  let release: () => void = () => {};
  let failure: Error | null = null;
  let lose = false;
  let replyGate: Promise<void> | null = null;
  let releaseReply: () => void = () => {};
  let broken = false;
  let candidateFailure: Error | null = null;

  const receipt = (key: string | undefined) => {
    const n = String(++seq).padStart(4, "0");
    return { receipt_no: n, tx_id: `tx-${n}`, committed_at: new Date().toISOString(), idempotency_key: key ?? "", replayed: false };
  };
  async function command<T>(key: string | undefined, apply: () => T): Promise<CommandResult<T>> {
    if (gate) await gate;
    if (failure) {
      const f = failure;
      failure = null;
      throw f;
    }
    if (key && done.has(key)) {
      const first = done.get(key) as CommandResult<T>;
      return { ...structuredClone(first), receipt: { ...first.receipt, replayed: true } };
    }
    const data = apply();
    const r: CommandResult<T> = { format_version: FORMAT_VERSION, request_id: `req-${seq + 1}`, receipt: receipt(key), data };
    if (key) done.set(key, r);
    if (replyGate) await replyGate;
    if (lose) {
      lose = false;
      throw timeoutError();
    }
    return structuredClone(r);
  }
  const snapOf = (projectId: string | null, id: string) => candidates.find((c) => c.project_id === projectId)?.snapshots.find((x) => x.id === id);

  const methods: ReferencesMethods = {
    async getReferences(...args) {
      reads.push(String(args[0]));
      if (broken) throw new Error("읽기 실패(시험)");
      return structuredClone(store);
    },
    async getReference(_slug, _ed, refId) {
      detailCalls.push(refId);
      const row = store.find((x) => x.id === refId);
      if (!row) return null;
      const c = contents[refId];
      if (c instanceof Error) throw c;
      const content = c === undefined ? (row.access === "ok" && row.state !== "source_missing" ? contentOf(row) : null) : c;
      return structuredClone({ reference: row, content });
    },
    async getReferenceCandidates(scope) {
      candidateCalls.push(scope ? { ...scope } : null);
      if (candidateFailure) throw candidateFailure;
      return structuredClone(candidates);
    },
    attachReference: (slug, edition, input, key) => {
      attaches.push({ slug, edition, input: structuredClone(input), key });
      return command(key, () => {
        const cand = candidates.find((c) => c.project_id === input.referenced_project_id);
        if (!cand || !snapOf(cand.project_id, input.source_snapshot_id)) throw err("not_found", "그 프로젝트나 버전을 찾을 수 없습니다(합성).");
        if (store.some((x) => x.referenced_project_id === cand.project_id)) throw err("conflict", "이미 붙인 프로젝트입니다(합성).");
        const snap = snapOf(cand.project_id, input.source_snapshot_id)!;
        const row = ref(++nextId, {
          referenced_project_id: cand.project_id, referenced_project_key: cand.key, source_label: input.source_label ?? cand.label, source_snapshot_id: snap.id, source_snapshot_key: snap.key,
          latest_snapshot_id: snap.id, scope: input.scope ?? ["final_report", "sources"],
        });
        store.push(row);
        return { reference: structuredClone(row) };
      });
    },
    refreshReference: (slug, edition, refId, input, key) => {
      refreshes.push({ slug, edition, ref_id: refId, input: structuredClone(input), key });
      return command(key, () => {
        const row = store.find((x) => x.id === refId);
        if (!row) throw err("not_found", "그 참고 프로젝트를 찾을 수 없습니다(합성).");
        if (input.base_rev !== undefined && input.base_rev !== row.rev) throw err("rev_conflict", "그사이 다른 곳에서 바뀌었습니다. 다시 읽어 주세요(합성).");
        if (input.source_snapshot_id === row.source_snapshot_id) throw err("conflict", "이미 그 버전으로 고정되어 있습니다(합성).");
        const snap = snapOf(row.referenced_project_id, input.source_snapshot_id ?? "");
        if (!snap) throw err("not_found", "그 버전을 찾을 수 없습니다(합성).");
        row.source_snapshot_id = snap.id;
        row.source_snapshot_key = snap.key;
        row.rev = String(Number(row.rev) + 1);
        row.refreshed_at = new Date().toISOString();
        row.state = row.latest_snapshot_id && row.latest_snapshot_id !== snap.id ? "new_version" : "pinned";
        row.new_version_available = row.state === "new_version";
        return { reference: structuredClone(row) };
      });
    },
    detachReference: (slug, edition, refId, key) => {
      detaches.push({ slug, edition, ref_id: refId, key });
      return command(key, () => {
        const i = store.findIndex((x) => x.id === refId);
        if (i < 0) throw err("not_found", "그 참고 프로젝트를 찾을 수 없습니다(합성).");
        store.splice(i, 1);
        return { reference_id: refId, detached: true as const };
      });
    },
  };
  const client = { ...s.client, ...methods } as unknown as PesClient;

  return {
    s,
    client,
    store,
    attaches,
    refreshes,
    detaches,
    candidateCalls,
    detailCalls,
    reads,
    hold() {
      gate = new Promise<void>((res) => (release = res));
      return () => {
        gate = null;
        release();
      };
    },
    failNext: (e: Error) => void (failure = e),
    loseReplyNext: () => void (lose = true),
    /** 서버는 처리했지만 답이 아직 오지 않는다(다음 쓰기 하나) — 풀기 전까지 목록 읽기는 처리된 값을 본다. hold() 는 처리 전에 붙잡는다 */
    holdReplyNext() {
      replyGate = new Promise<void>((res) => (releaseReply = res));
      return () => {
        replyGate = null;
        releaseReply();
      };
    },
    breakRead: () => void (broken = true),
    breakCandidates: (e: Error = new Error("후보를 읽을 수 없습니다(시험)")) => void (candidateFailure = e),
    /** 다른 곳에서 이 참고 프로젝트가 바뀐 것을 흉내 — rev 가 올라간다 */
    bumpOutside: (id: string) => {
      const row = store.find((x) => x.id === id);
      if (row?.rev) row.rev = String(Number(row.rev) + 1);
    },
  };
}
export type ReferencesClient = ReturnType<typeof createReferencesClient>;

/* ───────────── 화면 찾기 ───────────── */

export async function boot(rc: ReferencesClient = createReferencesClient(), path = REFS, env: Env = {}) {
  const view = await renderApp(path, env, { client: rc.client });
  await ready();
  return { rc, ...view };
}

export const main = () => screen.getByRole("main");
export const table = () => within(main()).getByRole("table", { name: "참고 프로젝트" });
export const rowOf = (refId: string) => {
  const el = table().querySelector<HTMLElement>(`[data-reference="${refId}"]`);
  if (!el) throw new Error(`참고 프로젝트 행 ${refId} 가 없다`);
  return el;
};
export const cell = (refId: string, name: string) => {
  const el = rowOf(refId).querySelector<HTMLElement>(`[data-cell="${name}"]`);
  if (!el) throw new Error(`칸 ${name} 이 없다`);
  return el;
};
export const waitRows = async () => waitFor(() => expect(table().querySelectorAll("[data-reference]").length).toBeGreaterThan(0));
export const statusText = () => screen.queryAllByRole("status").map((x) => x.textContent ?? "").join(" ");

/** 과장 낱말 — 안내 어디에도 없어야 한다 */
export const OVERCLAIM = /완전\s*(히)?\s*차단|완벽|100\s*%|절대|제외(를)?\s*보장(합니다|해요|됩니다)|빈틈\s*없/;
