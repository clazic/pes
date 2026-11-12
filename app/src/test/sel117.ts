import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { FORMAT_VERSION, PesApiError, type CommandResult, type PesClient } from "@/api/types";
import { renderApp, type Env } from "@/test/render-app";
import { createScriptedClient, timeoutError } from "@/test/scripted-client";
import { base } from "@/test/contract";
import { ready } from "@/test/ui";

/**
 * SEL-117 MAT1c 시험 계약 — 내 자료 화면(생성 화면 · 작업 중 자료 목록), 파일별 AI 참조 스위치, 미리보기(앱).
 * 이슈(SEL-117 · 부모 SEL-111), 서버 계약 SEL-115(MAT1a, tests/helpers/sel115_env.ts 머리말), 설계 dashboard-v2.md 4.8 · 5.3 · F06 · 확인 대화 상자 규칙(240행),
 * SEL-102(미리보기 sandbox · nosniff · 같은 출처 문서로 열지 않음)에서 뽑은 해석이다. 구현을 추측해서 맞춘 것이 아니다.
 * 이름을 바꿔야 하면 구현이 아니라 이 파일(과 보고서의 해석)을 고치고 leader 에게 알린다. 합성 자료뿐(실제 자료 · 키 · 경로 없음).
 *
 * ═══ PesClient 확장 — 정한 인터페이스 (types.ts 에 같은 이름으로 추가한다. 가짜 · HTTP 클라이언트가 같이 지킨다) ═══
 *   getMaterials(slug, edition): Promise<MaterialRow[]>                 모르는 slug · 없는 판 = []   (사람 화면 — deny 파일도 모두 온다)
 *   uploadMaterial(slug, edition, input: { file: File; title?: string; object_id?: string }, idempotencyKey)
 *                                                                        : Promise<CommandResult<MaterialUploadResult>>   object_id 있으면 그 자료의 새 버전
 *   setMaterialAiAccess(slug, edition, filePolicyId, input: { ai_access: "allow" | "deny"; reason?: string }, idempotencyKey)
 *                                                                        : Promise<CommandResult<MaterialAiAccessResult>>
 *   getMaterialPreview(slug, edition, blobId): Promise<MaterialPreview>  거절은 PesApiError (미리보기는 사람 화면 읽기 — 이 blob 만)
 *   쓰기는 모두 멱등 키 필수(없으면 요청 없이 invalid_payload) · 같은 키 · 같은 요청은 처음 영수증을 replayed 로 · 거절은 PesApiError.
 *
 * ═══ 화면 계약 ═══
 * [주소 · 위치]
 *   작업 중 자료 목록: `/p/:slug/e/:edition/files` (사이드바 · 머리줄 셸 안, `main` 하나, 화면 제목 `[data-screen-title]` h1 "내 자료").
 *     사이드바에 링크(이름에 "내 자료")가 있고 이 주소로 간다(aria-current="page").
 *   생성 화면: `/new` — 앱에는 아직 생성 마법사가 없다. 이 이슈가 그 화면의 **“내 자료” 칸**을 만든다(설계서 마법사 4번째 칸: 끌어 놓기 · 형식 · 파일별 AI 참조 · 올릴 때부터 금지,
 *     “아직 올리지 않고 담기만”). 프로젝트가 아직 없어 서버에 아무것도 올리지 않는다(uploadMaterial 호출 0) — 만들기(프로젝트 생성 명령)는 이 이슈 밖.
 *     main 안 region 이름 "내 자료"(제목 h2 "내 자료"). 다른 칸이 늦게 와도 이 칸은 단독으로 그려진다.
 * [올리기]
 *   `input[type=file]` 이름 “자료 파일 고르기”(두 화면 모두; 키보드 초점이 닿는다 — tabindex=-1 아님) · 여러 파일 가능(multiple).
 *   목록 화면: 고르면 파일마다 uploadMaterial 한 번(파일마다 다른 멱등 키). 영수증이 오기 전에는 role=status “접수 확인 중”만 있고 성공 말 · 새 행이 없다 — 영수증 뒤 getMaterials 를 다시 읽어 행이 생긴다(낙관적 갱신 없음).
 *   성공: role=status 에 “접수 <receipt_no>”(number 없는 영수증이면 “접수됨”). 실패(PesApiError): role=alert 에 서버 메시지, 행 그대로. 시간 초과(TimeoutError): “접수 확인 중” 유지 · 같은 파일을 다시 올리면 **같은 멱등 키**.
 *   행마다 단추형 입력 “새 버전 올리기: <제목>”(input[type=file], 이름에 제목) → uploadMaterial({ object_id: 그 자료 })  — 원본을 덮어쓰지 않고 새 버전.
 * [표] caption “내 자료” 를 가진 table 하나, 열 머리 th[scope=col]. 행 `[data-material="<object_id>"]` + `data-ai-access="allow|deny|unknown"`. 칸 `[data-cell="…"]`:
 *   name(제목 + 원래 파일 이름) · format(형식 낱말: text/plain → “TXT” · application/pdf → “PDF” · 그 밖은 파일 확장자 대문자 · 모르면 “형식 모름”) · size(바이트 → “10 B” · “2 KB” · “1.5 MB”, 1024 단위) · version(“v<번호>”)
 *   · extraction(추출 상태) · ai-access(스위치 칸) · actions(미리보기 · 새 버전 올리기).
 *   추출 상태: SEL-116 계약이 아직 없다 → 행마다 정확히 “추출 상태 정보 없음”. “준비됨 · 성공 · 완료 · 뽑힘 · 실패 · 지원 안 함 · 0건” 같은 말을 지어내지 않는다(칸 자리는 있다).
 * [AI 참조 스위치]
 *   행마다 role=switch, 이름에 제목(“AI 참조: <제목>”), aria-checked=true(allow) | false(deny). 서버가 ai_access 를 주지 않은 행(null)은 스위치 없음 + 글 “AI 참조 상태 정보 없음” — allow 로 간주하지 않는다.
 *   바꾸기는 확인 대화 상자를 거친다(설계 240행): 끄기 → role=dialog 이름 “AI 참조 끄기”, 다시 켜기 → “AI 참조 다시 허용”. 각각 단추 “취소” · 동사 단추(대화 상자 이름과 같은 글: “AI 참조 끄기” | “AI 참조 다시 허용”), textbox “이유”(선택).
 *   보내는 동안 동사 단추는 disabled 가 아니라 aria-disabled="true"(초점 유지) · 두 번 눌러도 한 번만 · 영수증 전에는 스위치 aria-checked 가 그대로이고 role=status 에 “접수 확인 중”(F06) — 성공 말 없음.
 *   성공(changed: true): role=status “접수 <receipt_no>” · 대화 상자 닫힘 · 스위치와 행 data-ai-access 가 새 값 · 초점이 그 스위치(document.body 아님).
 *   같은 값(서버 changed: false): role=status 에 “바뀐 것 없음” — 스위치 그대로, “꺼졌습니다/켜졌습니다” 같은 변화 말 없음.
 *   거절(PesApiError): role=alert 에 서버 메시지 · 대화 상자와 입력한 이유 그대로 · 스위치 그대로. 시간 초과: “접수 확인 중”(실패 아님) 유지, 다시 동사 단추를 누르면 **같은 멱등 키**.
 *   보낸 값: setMaterialAiAccess(slug, edition, 그 행의 file_policy_id, { ai_access, reason? (비면 키 없음) }, 키).
 * [정직한 금지 안내] — 대화 상자 안(끄기)과 표 위 상시 안내 `[data-deny-notice]` 둘 다:
 *   - 금지는 PES 의 AI 도구 · MCP · 프롬프트에서 그 파일을 뺀다고 말한다(낱말 “AI 도구” · “MCP” · “프롬프트” 포함).
 *   - **B(내 컴퓨터)에서 파일을 직접 읽는 것은 막지 못한다**고 숨기지 않는다(“B” · “직접 읽” · “막지 못” 포함).
 *   - 이미 나간 내용은 회수되지 않는다고 말한다(“회수” 포함 · 설계 240행).
 *   - “완전 차단 · 완벽 · 100% · 절대 · 제외를 보장” 같은 과장 낱말은 어디에도 없다.
 *   - 사람 화면에서는 deny 파일도 보인다고 말한다(“사람 화면” 또는 “이 화면에서는 계속 보입니다”).
 * [미리보기] 행의 단추 “미리보기: <제목>” → region(또는 비모달 dialog) 이름 “미리보기: <제목>”. getMaterialPreview(slug, edition, blob_id) 한 번.
 *   - text/plain(안전한 글)은 <pre> 에 **글자로만**(textContent) 보인다 — 본문의 `<script>` · `<b>` 가 요소가 되지 않는다.
 *   - image/png 는 <img> (blob 주소). 그 밖 형식(pdf · octet-stream · attachment)은 열지 않고 “내려받기”만(미리보기 안 됨 안내).
 *   - 같은 출처 문서로 열지 않는다(SEL-102): iframe · object · embed · frame 이 있다면 iframe 이고 sandbox 속성이 있으며 allow-same-origin · allow-scripts 가 없다. 미리보기용 <a target="_blank"> 는 rel 에 noopener.
 *   - 실패(PesApiError, 예: 바이트 변조 409): role=alert 에 서버 메시지, 내용 안 보임.
 *   - deny 파일도 사람은 미리볼 수 있다.
 * [접근성] 표 · 스위치 · 대화 상자는 키보드만으로 된다: Tab 으로 스위치에 닿고 Space/Enter 가 대화 상자를 열고, Esc 는 닫고 초점이 그 스위치로 돌아간다. 상태 변화(role=status)는 polite.
 * [자료 없음] 행이 0 이면 표 대신 빈 상태 글 “올린 자료가 없습니다”(오류 아님) + 올리기 입력은 있다. 읽기 실패는 role=alert(빈 상태로 보이지 않음).
 *
 * [e2e 가 기대하는 앱 기본 가짜 클라이언트 자료 — sample-study 판 1]
 *   자료 2개 이상: AI 참조 허용 1개 이상 · 금지 1개 이상. 모두 합성. (이 이슈의 e2e 는 구현 뒤 보강 모드에서)
 */

/* ───────────── 타입(정한 인터페이스) ───────────── */

export type AiAccess = "allow" | "deny";

export interface MaterialRow {
  object_id: string;
  version_id: string;
  version: number;
  blob_id: string;
  file_policy_id: string;
  role: string;
  title: string;
  original_name: string;
  media_type: string;
  size: number;
  sha256: string;
  /** 서버가 주지 않으면 null(allow 로 간주하지 않는다) */
  ai_access: AiAccess | null;
  /** SEL-116 계약 전 — 항상 null(“추출 상태 정보 없음”). 칸 자리만 있다 */
  extraction: null;
}

export interface MaterialUploadResult {
  object_id: string;
  version_id: string;
  version: number;
  blob_id: string;
  file_policy_id: string;
  role: string;
  ai_access: AiAccess;
  original_name: string;
  media_type: string;
  size: number;
  sha256: string;
}

export interface MaterialAiAccessResult {
  file_policy_id: string;
  blob_id: string;
  ai_access: AiAccess;
  rev: number;
  changed: boolean;
}

export interface MaterialPreview {
  blob_id: string;
  content_type: string;
  /** content-disposition 이 inline 인가(아니면 attachment) */
  inline: boolean;
  /** content-security-policy 헤더 값(sandbox 가 필요한 형식) · 없으면 null */
  sandbox: string | null;
  bytes: Uint8Array;
}

export interface MaterialsMethods {
  getMaterials(slug: string, edition: number): Promise<MaterialRow[]>;
  uploadMaterial(slug: string, edition: number, input: { file: File; title?: string; object_id?: string }, idempotencyKey: string | undefined): Promise<CommandResult<MaterialUploadResult>>;
  setMaterialAiAccess(slug: string, edition: number, filePolicyId: string, input: { ai_access: AiAccess; reason?: string }, idempotencyKey: string | undefined): Promise<CommandResult<MaterialAiAccessResult>>;
  getMaterialPreview(slug: string, edition: number, blobId: string): Promise<MaterialPreview>;
}

/* ───────────── 합성 자료 ───────────── */

export const FILES = `${base}/files`;
export const NEW = "/new";
const enc = (s: string) => new TextEncoder().encode(s);

const sha = (n: number) => String(n).repeat(64).slice(0, 64);
export const m = (n: number, over: Partial<MaterialRow> = {}): MaterialRow => ({
  object_id: `mat-${n}`,
  version_id: `mat-${n}-v1`,
  version: 1,
  blob_id: `blob-${n}`,
  file_policy_id: `fp-${n}`,
  role: "attachment",
  title: `합성 자료 ${n}`,
  original_name: `synthetic-${n}.txt`,
  media_type: "text/plain",
  size: 10,
  sha256: sha(n),
  ai_access: "allow",
  extraction: null,
  ...over,
});

/** 허용 txt(10 B) · 금지 pdf(2 KB, v3) · 허용 xlsx(1.5 MB) · 상태 모름 csv */
export const MATERIALS: MaterialRow[] = [
  m(1),
  m(2, { title: "합성 보고서", original_name: "report-synthetic.pdf", media_type: "application/pdf", size: 2048, version: 3, version_id: "mat-2-v3", ai_access: "deny" }),
  m(3, { title: "합성 통계표", original_name: "stats-synthetic.xlsx", media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1_572_864 }),
  m(4, { title: "합성 목록", original_name: "list-synthetic.csv", media_type: "text/csv", size: 300, ai_access: null }),
];

export const previewOf = (over: Partial<MaterialPreview> = {}): MaterialPreview => ({ blob_id: "blob-1", content_type: "text/plain", inline: true, sandbox: null, bytes: enc("합성 본문 한 줄\n둘째 줄"), ...over });

export const file = (name = "new-synthetic.txt", body = "합성 새 파일", type = "text/plain") => new File([body], name, { type });

/* ───────────── 가짜 클라이언트 ───────────── */

export interface UploadCall {
  name: string;
  size: number;
  title?: string;
  object_id?: string;
  key: string | undefined;
}
export interface AccessCall {
  slug: string;
  edition: number;
  file_policy_id: string;
  input: { ai_access: AiAccess; reason?: string };
  key: string | undefined;
}

/**
 * 가짜 클라이언트 위에 내 자료 읽기 · 쓰기를 얹는다. 서버처럼: 같은 값으로 두면 changed:false(rev 그대로) · 멱등 키가 같으면 처음 영수증을 replayed 로.
 * hold(): 다음 쓰기를 release() 까지 붙잡는다 · failNext(err) · loseReplyNext()(서버는 처리했지만 답이 시간 초과로 사라진다) · breakRead().
 */
export function createMaterialsClient(rows: MaterialRow[] = MATERIALS, previews: Record<string, MaterialPreview | Error> = {}) {
  const s = createScriptedClient();
  const store = structuredClone(rows);
  const uploads: UploadCall[] = [];
  const accessCalls: AccessCall[] = [];
  const previewCalls: string[] = [];
  const reads: string[] = [];
  const done = new Map<string, CommandResult<unknown>>();
  let seq = 700;
  let nextObj = 50;
  let gate: Promise<void> | null = null;
  let release: () => void = () => {};
  let failure: Error | null = null;
  let lose = false;
  let broken = false;

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
    if (lose) {
      lose = false;
      throw timeoutError();
    }
    return structuredClone(r);
  }

  const methods: MaterialsMethods = {
    async getMaterials(...args) {
      reads.push(String(args[0]));
      if (broken) throw new Error("읽기 실패(시험)");
      return structuredClone(store);
    },
    uploadMaterial: (_slug, _ed, input, key) => {
      uploads.push({ name: input.file.name, size: input.file.size, title: input.title, object_id: input.object_id, key });
      return command(key, () => {
        const existing = input.object_id ? store.find((x) => x.object_id === input.object_id) : undefined;
        const n = ++nextObj;
        const row = m(n, {
          object_id: existing?.object_id ?? `mat-${n}`,
          title: existing?.title ?? input.title ?? input.file.name,
          original_name: input.file.name,
          media_type: input.file.type || "application/octet-stream",
          size: input.file.size,
          version: existing ? existing.version + 1 : 1,
          version_id: `mat-${n}-v${existing ? existing.version + 1 : 1}`,
        });
        if (existing) store.splice(store.indexOf(existing), 1, row);
        else store.push(row);
        const { extraction: _x, ai_access: _a, ...rest } = row;
        return { ...rest, ai_access: "allow" as const };
      });
    },
    setMaterialAiAccess: (slug, edition, fp, input, key) => {
      accessCalls.push({ slug, edition, file_policy_id: fp, input: structuredClone(input), key });
      return command(key, () => {
        const row = store.find((x) => x.file_policy_id === fp);
        if (!row) throw new PesApiError({ format_version: FORMAT_VERSION, error: { code: "not_found", message: "그 파일 정책을 찾을 수 없습니다.", retryable: false }, request_id: "req-m" });
        const changed = row.ai_access !== input.ai_access;
        row.ai_access = input.ai_access;
        return { file_policy_id: fp, blob_id: row.blob_id, ai_access: input.ai_access, rev: changed ? 2 : 1, changed };
      });
    },
    async getMaterialPreview(_slug, _ed, blobId) {
      previewCalls.push(blobId);
      const p = previews[blobId];
      if (p instanceof Error) throw p;
      return p ? structuredClone(p) : previewOf({ blob_id: blobId });
    },
  };
  const client = { ...s.client, ...methods } as unknown as PesClient;

  return {
    s,
    client,
    store,
    uploads,
    accessCalls,
    previewCalls,
    reads,
    hold() {
      gate = new Promise<void>((res) => (release = res));
      return () => {
        gate = null;
        release();
      };
    },
    failNext: (err: Error) => void (failure = err),
    loseReplyNext: () => void (lose = true),
    breakRead: () => void (broken = true),
  };
}
export type MaterialsClient = ReturnType<typeof createMaterialsClient>;

export const rejection = (message = "합성 거절 문장", code = "forbidden") =>
  new PesApiError({ format_version: FORMAT_VERSION, error: { code: code as never, message, retryable: false }, request_id: "req-rej" });

/* ───────────── 화면 찾기 ───────────── */

export async function boot(mc: MaterialsClient = createMaterialsClient(), path = FILES, env: Env = {}) {
  const view = await renderApp(path, env, { client: mc.client });
  await ready();
  return { mc, ...view };
}

export const main = () => screen.getByRole("main");
export const table = () => within(main()).getByRole("table", { name: "내 자료" });
export const rowOf = (objectId: string) => {
  const el = table().querySelector<HTMLElement>(`[data-material="${objectId}"]`);
  if (!el) throw new Error(`자료 행 ${objectId} 가 없다`);
  return el;
};
export const cell = (objectId: string, name: string) => {
  const el = rowOf(objectId).querySelector<HTMLElement>(`[data-cell="${name}"]`);
  if (!el) throw new Error(`칸 ${name} 이 없다`);
  return el;
};
export const switchOf = (objectId: string) => within(rowOf(objectId)).getByRole("switch", { name: /AI 참조/ });
export const waitRows = async () => waitFor(() => expect(table().querySelectorAll("[data-material]").length).toBeGreaterThan(0));

/** 과장 낱말 — 금지 안내 어디에도 없어야 한다 */
export const OVERCLAIM = /완전\s*(히)?\s*차단|완벽|100\s*%|절대|제외(를)?\s*보장(합니다|해요|됩니다)|빈틈\s*없/;
