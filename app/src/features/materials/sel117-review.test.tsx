// SEL-117 1차 리뷰 수정 시험 — 대화 상자가 열린 동안 뒤 화면을 inert 로 둔다(필수 1). 합성 자료뿐, 네트워크 0.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "@/api/http-client";
import { WORKSPACE } from "@/api/fixture";
import { ClientContext } from "@/api/queries";
import { useUploads } from "./use-uploads";
import { boot, createMaterialsClient, file, m, main, switchOf, table, waitRows } from "@/test/sel117";

afterEach(cleanup);
// 확인 중 시도는 sessionStorage 에 남는다 — 앞 시험의 키가 뒤 시험 화면에 새지 않게 매번 비운다
beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

/** 앱 루트 — body 바로 아래에서 main 을 품고 있는 요소 */
const appRoot = () => {
  let el: HTMLElement = main();
  while (el.parentElement && el.parentElement !== document.body) el = el.parentElement;
  return el;
};

describe("리뷰 필수 1 — 대화 상자가 열린 동안 뒤 화면은 inert", () => {
  it("끄기 대화 상자가 열리면 앱 루트에 inert 가 걸리고, 닫으면 풀린다", async () => {
    await boot(createMaterialsClient());
    await waitRows();
    const user = userEvent.setup();
    expect(appRoot().hasAttribute("inert")).toBe(false);

    await user.click(switchOf("mat-1"));
    await screen.findByRole("dialog", { name: "AI 참조 끄기" });
    await waitFor(() => expect(appRoot().hasAttribute("inert")).toBe(true));

    await user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(appRoot().hasAttribute("inert")).toBe(false));
  });
});

describe("리뷰 2 — 요청 전 실패는 “보내지 못함”, 요청을 보낸 뒤 연결 끊김은 “접수 확인 중”", () => {
  it("파일을 읽다 TypeError 가 나면 role 없는 글이 아니라 “보내지 못했어요”, “접수 확인 중”은 없다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    mc.failNext(new TypeError("합성 브라우저 오류"));
    const user = userEvent.setup();
    const input = screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement;
    await user.upload(input, file("unsent-synthetic.txt", "보내지 않음"));
    await waitFor(() => expect(document.body.textContent).toContain("보내지 못했어요"));
    expect(document.body.textContent).not.toContain("접수 확인 중");
    expect(document.body.textContent).toContain("합성 브라우저 오류");
  });
});

describe("리뷰 2 — fetch 호출 전 · 후 실패 분류 (실제 http 클라이언트 + 가짜 fetch)", () => {
  const real = (fetchImpl: typeof fetch) => createHttpClient({ session: "synthetic-session-review", projects: { [WORKSPACE.slug]: "pj-synthetic-9" }, fetch: fetchImpl });
  const pick = async (mc: ReturnType<typeof createMaterialsClient>, fetchImpl: typeof fetch) => {
    const c = real(fetchImpl);
    Object.assign(mc.client, { uploadMaterial: c.uploadMaterial });
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    const input = screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement;
    await user.upload(input, file("review2-synthetic.txt", "리뷰 2"));
  };

  it("fetch 를 부르기 전 실패(파일 읽기 실패)는 “보내지 못했어요” — 접수 확인 중 아님, fetch 0 회", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const mc = createMaterialsClient();
    const f = file("review2-unread.txt", "x");
    Object.defineProperty(f, "arrayBuffer", { value: () => Promise.reject(new TypeError("합성 읽기 실패")) });
    const c = real(fetchImpl as unknown as typeof fetch);
    Object.assign(mc.client, { uploadMaterial: c.uploadMaterial });
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, f);
    await waitFor(() => expect(document.body.textContent).toContain("보내지 못했어요"));
    expect(document.body.textContent).not.toContain("접수 확인 중");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("파일을 읽는 동안(fetch 0 회)은 “올리는 중”만 — 아직 보내지 않았으니 “접수 확인 중”은 없다", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const mc = createMaterialsClient();
    const f = file("review2-slow.txt", "느린 읽기");
    // 해시 계산(파일 읽기)을 붙잡아 둔다 — 이 동안 요청은 나가지 않는다
    Object.defineProperty(f, "arrayBuffer", { value: () => new Promise<ArrayBuffer>(() => {}) });
    const c = real(fetchImpl as unknown as typeof fetch);
    Object.assign(mc.client, { uploadMaterial: c.uploadMaterial });
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, f);
    await waitFor(() => expect(document.body.textContent).toContain("올리는 중"));
    expect(document.body.textContent).not.toContain("접수 확인 중");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetch 가 TypeError 로 실패(요청을 보낸 뒤 연결 끊김)는 “접수 확인 중” — 보내지 못함 아님", async () => {
    const boom = new TypeError("Failed to fetch");
    const fetchImpl = vi.fn(async () => {
      throw boom;
    });
    const mc = createMaterialsClient();
    await pick(mc, fetchImpl as unknown as typeof fetch);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));
    expect(document.body.textContent).not.toContain("보내지 못했어요");
  });
});

describe("리뷰 3 — 응답을 받은 뒤 본문 읽기 실패도 “접수 확인 중”(같은 키 유지)", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
  /** 올리기 예약은 준비됨으로 답하고, 자료 POST 만 `answer` 로 답한다 */
  const fetchWith = (answer: () => Response) =>
    vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => (String(url).endsWith("/uploads") ? ok({ data: { blob_id: "blob-synth-1", state: "ready" } }) : answer()));
  const materialKeys = (f: ReturnType<typeof fetchWith>) =>
    f.mock.calls.filter((c) => String(c[0]).endsWith("/materials")).map((c) => (c[1] as RequestInit).headers as Record<string, string>);
  const run = async (f: ReturnType<typeof fetchWith>) => {
    const mc = createMaterialsClient();
    Object.assign(mc.client, { uploadMaterial: real(f as unknown as typeof fetch).uploadMaterial });
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    const input = screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement;
    const same = file("review3-synthetic.txt", "리뷰 3");
    await user.upload(input, same);
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));
    expect(document.body.textContent).not.toContain("보내지 못했어요");
    await user.upload(input, same);
    await waitFor(() => expect(materialKeys(f).length).toBe(2));
  };
  const real = (fetchImpl: typeof fetch) => createHttpClient({ session: "synthetic-session-review", projects: { [WORKSPACE.slug]: "pj-synthetic-9" }, fetch: fetchImpl });

  it("2xx 인데 JSON 이 아닌 응답 → 접수 확인 중, 다시 올리면 같은 멱등 키", async () => {
    const f = fetchWith(() => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await run(f);
    const [a, b] = materialKeys(f).map((h) => h["idempotency-key"]);
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it("응답 본문 스트림이 도중에 끊김(json 이 TypeError) → 접수 확인 중, 다시 올리면 같은 멱등 키", async () => {
    const broken = { ok: true, status: 201, json: () => Promise.reject(new TypeError("terminated")) } as unknown as Response;
    const f = fetchWith(() => broken);
    await run(f);
    const [a, b] = materialKeys(f).map((h) => h["idempotency-key"]);
    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });
});

describe("최종 리뷰 1/2 필수 1 — 예약 · 완료 POST 도 멱등 키를 보낸다 (서버는 둘 다 #require_key)", () => {
  const ok = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const real = (fetchImpl: typeof fetch) => createHttpClient({ session: "synthetic-session-final", projects: { [WORKSPACE.slug]: "pj-synthetic-9" }, fetch: fetchImpl });
  type Seen = { method: string; path: string; key: string | null };
  /** 서버처럼: 예약(POST /uploads) · 완료(POST /uploads/{blob}/complete) · 자료(POST /materials) 는 키가 없으면 400, 한 키를 다른 명령에 다시 쓰면 409 */
  function strictServer() {
    const seen: Seen[] = [];
    const spent = new Map<string, string>();
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url), "http://app.invalid").pathname.replace(/^.*\/projects\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const key = new Headers(init?.headers).get("idempotency-key");
      seen.push({ method, path, key });
      const command = method === "POST" ? path.replace(/\/uploads\/[^/]+\/complete$/, "/uploads/:blob/complete") : null;
      if (command) {
        if (!key) return ok({ error: { code: "invalid_payload", message: "키 없음", retryable: false, target: "$.headers.idempotency-key" } }, 400);
        if (spent.has(key) && spent.get(key) !== command) return ok({ error: { code: "idempotency_key_reuse", message: "키 재사용", retryable: false, target: "$.headers.idempotency-key" } }, 409);
        spent.set(key, command);
      }
      if (method === "POST" && path === "/uploads") return ok({ data: { blob_id: "blob-f1", state: "staging" } });
      if (method === "PUT") return ok({ data: { blob_id: "blob-f1", state: "staged" } }, 200);
      if (path.endsWith("/complete")) return ok({ data: { blob_id: "blob-f1", state: "ready" } }, 200);
      if (method === "POST" && path === "/materials")
        return ok({ data: { object_id: "mat-f1", version_id: "mv-f1", version_no: 1, blob_id: "blob-f1", file_policy_id: "fp-f1", role: "attachment", ai_access: "allow", original_name: "f.txt", media_type: "text/plain", size: 3, sha256: "a".repeat(64) }, receipt: { receipt_no: "R-1", tx_id: "tx-1", committed_at: new Date().toISOString() } });
      return ok({ error: { code: "not_found", message: "없음", retryable: false } }, 404);
    });
    return { impl: impl as unknown as typeof fetch, seen };
  }

  it("예약 · 완료 · 자료 POST 가 모두 키를 보내고, 서로 다른 키다 (실제 서버처럼 키 없음 400 · 다른 명령에 재사용 409)", async () => {
    const s = strictServer();
    const r = await real(s.impl).uploadMaterial(WORKSPACE.slug, WORKSPACE.edition, { file: file("f.txt", "abc") }, "base-key-1");
    expect(r.receipt.receipt_no).toBe("R-1");
    const posts = s.seen.filter((x) => x.method === "POST");
    expect(posts.map((x) => x.path)).toEqual(["/uploads", "/uploads/blob-f1/complete", "/materials"]);
    for (const p of posts) expect(p.key, p.path).toBeTruthy();
    expect(new Set(posts.map((p) => p.key)).size).toBe(3);
    expect(posts[2]!.key).toBe("base-key-1");
  });

  it("같은 키로 다시 올리면 예약 · 완료도 같은 키를 쓴다 (단계 재시도 = 서버 재생)", async () => {
    const s = strictServer();
    const c = real(s.impl);
    await c.uploadMaterial(WORKSPACE.slug, WORKSPACE.edition, { file: file("f.txt", "abc") }, "base-key-2");
    await c.uploadMaterial(WORKSPACE.slug, WORKSPACE.edition, { file: file("f.txt", "abc") }, "base-key-2");
    const posts = s.seen.filter((x) => x.method === "POST");
    expect(posts.slice(0, 3).map((x) => x.key)).toEqual(posts.slice(3, 6).map((x) => x.key));
  });
});

describe("최종 리뷰 1/2 필수 2 — 화면을 옮겨도 진행 중(접수 확인 중) 업로드의 멱등 키가 남는다", () => {
  it("응답 유실 → /records 로 갔다가 돌아와 같은 파일을 다시 고르면 같은 키 · 자료는 하나만 늘어난다", async () => {
    const mc = createMaterialsClient();
    const view = await boot(mc);
    await waitRows();
    const before = table().querySelectorAll("[data-material]").length;
    mc.loseReplyNext();
    const user = userEvent.setup();
    const f = file("away-synthetic.txt", "화면 이동");
    await user.upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, f);
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));

    const files = view.router.state.location.pathname;
    await view.router.navigate(files.replace(/\/files$/, "/records"));
    await waitFor(() => expect(screen.queryByRole("table", { name: "내 자료" })).toBeNull());
    await view.router.navigate(files);
    await waitRows();

    await user.upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, f);
    await waitFor(() => expect(mc.uploads).toHaveLength(2));
    expect(mc.uploads[1]!.key).toBe(mc.uploads[0]!.key);
    await waitFor(() => expect(table().querySelectorAll("[data-material]").length).toBe(before + 1));
  });

  it("돌아오면 확인 중인 파일이 “접수 확인 중”으로 다시 보인다 (보관은 sessionStorage 의 키 · 이름 · 단계만, 세션 비밀 없음)", async () => {
    const mc = createMaterialsClient();
    const view = await boot(mc);
    await waitRows();
    mc.loseReplyNext();
    await userEvent.setup().upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, file("restore-synthetic.txt", "복원"));
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));
    const files = view.router.state.location.pathname;
    await view.router.navigate(files.replace(/\/files$/, "/records"));
    await waitFor(() => expect(screen.queryByRole("table", { name: "내 자료" })).toBeNull());
    await view.router.navigate(files);
    await waitRows();
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중 — 파일 1개: 답이 오지 않았어요"));
    const stored = JSON.stringify(Object.entries(window.sessionStorage));
    expect(stored).toContain(mc.uploads[0]!.key!);
    expect(stored).not.toContain("synthetic-session");
  });

  it("영수증을 받으면 보관한 키를 지운다 — 같은 파일을 또 올리면 새 키", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    const f = file("done-synthetic.txt", "끝");
    const input = () => screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement;
    await user.upload(input(), f);
    await waitFor(() => expect(document.body.textContent).toMatch(/접수\s*\d/));
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain(mc.uploads[0]!.key!);
    await user.upload(input(), f);
    await waitFor(() => expect(mc.uploads).toHaveLength(2));
    expect(mc.uploads[1]!.key).not.toBe(mc.uploads[0]!.key);
  });
});

describe("최종 리뷰 1/2 필수 2 — 새로 고침(새 마운트) 뒤에도 같은 키, 범위(판)가 다르면 섞이지 않는다", () => {
  it("보관된 시도가 있으면 새로 마운트해도 같은 파일은 같은 키 — 다른 판의 보관은 보이지 않는다", async () => {
    const mc = createMaterialsClient();
    const first = await boot(mc);
    await waitRows();
    mc.loseReplyNext();
    const f = file("reload-synthetic.txt", "새로 고침");
    await userEvent.setup().upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, f);
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));
    first.unmount();
    // 다른 판의 확인 중 시도가 보관돼 있어도 이 판 화면에는 보이지 않는다
    window.sessionStorage.setItem(`pes-upload:${JSON.stringify([WORKSPACE.slug, WORKSPACE.edition + 1, "other"])}`, JSON.stringify({ key: "other-key", name: "other.txt", phase: "unknown" }));

    // 새로 고침: 앱을 처음부터 다시 띄운다(sessionStorage 는 남는다)
    await boot(mc);
    await waitRows();
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중 — 파일 1개: 답이 오지 않았어요"));
    await userEvent.setup().upload(screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, f);
    await waitFor(() => expect(mc.uploads).toHaveLength(2));
    expect(mc.uploads[1]!.key).toBe(mc.uploads[0]!.key);
  });
});

describe("최종 리뷰 1/2 권장 3 — 프로젝트 · 판이 바뀌면 이전 범위의 업로드 줄이 새 범위에 섞이지 않는다", () => {
  it("판 1 업로드를 붙잡은 채 판 2 로 바꾸고 풀어 주면 판 2 의 줄에는 아무것도 나타나지 않는다", async () => {
    const mc = createMaterialsClient();
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ClientContext.Provider value={mc.client}>{children}</ClientContext.Provider>
      </QueryClientProvider>
    );
    const view = renderHook(({ ed }) => useUploads("sample-study", ed), { wrapper, initialProps: { ed: 1 } });
    const release = mc.hold();
    act(() => view.result.current.start([file("scope-a.txt", "A")]));
    await waitFor(() => expect(view.result.current.items.map((i) => i.phase)).toEqual(["sending"]));
    view.rerender({ ed: 2 });
    await waitFor(() => expect(view.result.current.items).toEqual([]));
    await act(async () => {
      release();
      await waitFor(() => expect(mc.uploads).toHaveLength(1));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(view.result.current.items).toEqual([]);
    // 판 1 로 돌아오면 끝난 시도는 보관에서 지워져 있다(영수증을 받았다)
    view.rerender({ ed: 1 });
    await waitFor(() => expect(view.result.current.items).toEqual([]));
  });
});

/* ───────────── 최종 리뷰 2/2 ───────────── */

describe("최종 리뷰 2/2 필수 1 — 같은 키 전체 재시도는 서버의 재생 응답(옛 staging)을 보고도 수렴한다 (상태를 지키는 서버 모형)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (code: string, status: number, reason?: string) => json({ error: { code, message: `합성 ${code}`, retryable: false, ...(reason ? { details: { reason } } : {}) } }, status);
  /** 응답 본문이 끊겨 읽기 실패 — 서버는 이미 처리했다 */
  const torn = () => ({ ok: true, status: 201, json: () => Promise.reject(new TypeError("terminated")) }) as unknown as Response;

  /**
   * 실제 서버(SEL-115)의 성질: 명령(예약 · 완료 · 자료)은 키별로 첫 응답을 저장해 `replayed: true` 로 그대로 재생한다(옛 state 도 그대로).
   * ready blob 은 불변이라 PUT 은 409 conflict(retryable:false). 같은 sha256+크기는 blob 하나로 합친다(ready 면 deduplicated). 자료는 새 키마다 새 행.
   */
  function stateful(dropAt: string | null) {
    const stored = new Map<string, { status: number; body: Record<string, unknown> }>();
    const blobs = new Map<string, { id: string; state: "staging" | "staged" | "ready" }>();
    const materials: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    let drop = dropAt;
    let seq = 0;
    const reply = (stage: string, status: number, body: Record<string, unknown>) => {
      if (drop === stage) {
        drop = null;
        return torn();
      }
      return json(body, status);
    };
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url), "http://app.invalid").pathname.replace(/^.*\/projects\/[^/]+/, "");
      const method = (init?.method ?? "GET").toUpperCase();
      const key = new Headers(init?.headers).get("idempotency-key");
      calls.push(`${method} ${path}`);
      if (method === "GET" && path === "/materials") return json({ data: { materials } });
      if (method === "POST" && path === "/uploads") {
        const hit = stored.get(key!);
        if (hit) return reply("reserve", hit.status, { ...hit.body, replayed: true });
        const req = JSON.parse(String(init!.body)) as { sha256: string; size: number };
        const known = blobs.get(`${req.sha256}:${req.size}`);
        const blob = known ?? { id: `blob-${++seq}`, state: "staging" as const };
        blobs.set(`${req.sha256}:${req.size}`, blob);
        const dedup = known?.state === "ready";
        const out = { status: dedup ? 200 : 201, body: { data: { blob_id: blob.id, state: blob.state, ...(dedup ? { deduplicated: true } : {}) } } };
        stored.set(key!, out);
        return reply("reserve", out.status, out.body);
      }
      const put = /^\/uploads\/([^/]+)$/.exec(path);
      if (method === "PUT" && put) {
        const blob = [...blobs.values()].find((b) => b.id === put[1])!;
        if (blob.state === "ready") return err("conflict", 409);
        blob.state = "staged";
        return reply("put", 200, { data: { blob_id: blob.id, state: "staged" } });
      }
      const done = /^\/uploads\/([^/]+)\/complete$/.exec(path);
      if (method === "POST" && done) {
        const hit = stored.get(key!);
        if (hit) return reply("complete", hit.status, { ...hit.body, replayed: true });
        const blob = [...blobs.values()].find((b) => b.id === done[1])!;
        if (blob.state !== "staged" && blob.state !== "ready") return err("conflict", 409, "blob_not_ready");
        blob.state = "ready";
        const out = { status: 200, body: { data: { blob_id: blob.id, state: "ready" } } };
        stored.set(key!, out);
        return reply("complete", 200, out.body);
      }
      if (method === "POST" && path === "/materials") {
        const hit = stored.get(key!);
        if (hit) return reply("material", hit.status, { ...hit.body, replayed: true });
        const blob_id = (JSON.parse(String(init!.body)) as { blob_id: string }).blob_id;
        const row = { object_id: `mat-s${materials.length + 1}`, version_id: `mv-s${materials.length + 1}`, version_no: 1, blob_id, file_policy_id: "fp-s", role: "attachment", title: "s.txt", original_name: "s.txt", media_type: "text/plain", size: 3, sha256: "a".repeat(64), ai_access: "allow" };
        materials.push(row);
        const out = { status: 201, body: { data: row, receipt: { receipt_no: `R-${materials.length}`, tx_id: `tx-${materials.length}`, committed_at: new Date().toISOString() } } };
        stored.set(key!, out);
        return reply("material", 201, out.body);
      }
      return err("not_found", 404);
    });
    return { impl: impl as unknown as typeof fetch, materials, calls };
  }
  const real = (impl: typeof fetch) => createHttpClient({ session: "synthetic-session-final2", projects: { [WORKSPACE.slug]: "pj-synthetic-9" }, fetch: impl });
  const up = (c: ReturnType<typeof real>, key: string) => c.uploadMaterial(WORKSPACE.slug, WORKSPACE.edition, { file: file("s.txt", "abc") }, key);

  for (const stage of ["reserve", "put", "complete", "material"]) {
    it(`${stage} 단계의 응답을 잃어도 같은 키로 다시 보내면 영수증을 받고 자료는 1개`, async () => {
      const s = stateful(stage);
      const c = real(s.impl);
      await expect(up(c, "k-final2")).rejects.toBeInstanceOf(Error);
      const r = await up(c, "k-final2");
      expect(r.receipt.receipt_no).toMatch(/^R-/);
      expect(s.materials).toHaveLength(1);
    });
  }

  it("자료 등록 응답을 잃은 뒤 재시도의 영수증은 처음 것이다 (재생) — 두 번째 자료가 생기지 않는다", async () => {
    const s = stateful("material");
    const c = real(s.impl);
    await expect(up(c, "k-final2b")).rejects.toBeInstanceOf(Error);
    const r = await up(c, "k-final2b");
    expect(r.receipt.replayed).toBe(true);
    expect(r.receipt.receipt_no).toBe("R-1");
    expect(s.materials).toHaveLength(1);
  });

  it("PUT 이 없던 예약 재생(PUT 응답 유실 전)은 PUT 을 건너뛰지 않는다 — 바이트가 아직 없으면 올려야 완료된다", async () => {
    const s = stateful("reserve");
    const c = real(s.impl);
    await expect(up(c, "k-final2c")).rejects.toBeInstanceOf(Error);
    const r = await up(c, "k-final2c");
    expect(r.receipt.receipt_no).toBe("R-1");
    expect(s.calls.filter((x) => x.startsWith("PUT"))).toHaveLength(1);
  });
});

describe("최종 리뷰 2/2 필수 2 — 진행 중 요청의 늦은 영수증은 돌아온 화면에도 닿고, 영수증 전에는 같은 파일을 또 올리지 않는다", () => {
  const input = () => screen.getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement;
  async function leaveAndReturn(view: Awaited<ReturnType<typeof boot>>) {
    const files = view.router.state.location.pathname;
    await view.router.navigate(files.replace(/\/files$/, "/records"));
    await waitFor(() => expect(screen.queryByRole("table", { name: "내 자료" })).toBeNull());
    await view.router.navigate(files);
    await waitRows();
  }

  it("진행 중에 화면을 떠났다 돌아온 뒤 이전 요청이 끝나면 “접수 확인 중”이 영수증 줄로 바뀐다", async () => {
    const mc = createMaterialsClient();
    const view = await boot(mc);
    await waitRows();
    const release = mc.hold();
    const f = file("late-synthetic.txt", "늦은 영수증");
    await userEvent.setup().upload(input(), f);
    await waitFor(() => expect(mc.uploads).toHaveLength(1));
    await leaveAndReturn(view);
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));
    release();
    await waitFor(() => expect(document.body.textContent).toMatch(/접수\s*\d/));
    expect(document.body.textContent).not.toContain("접수 확인 중");
  });

  it("영수증이 오기 전에는 같은 파일을 다시 골라도 새 업로드를 시작하지 않는다 — 끝난 뒤 자료는 하나만 늘어난다", async () => {
    const mc = createMaterialsClient();
    const view = await boot(mc);
    await waitRows();
    const before = table().querySelectorAll("[data-material]").length;
    const release = mc.hold();
    const f = file("twice-synthetic.txt", "두 번");
    const user = userEvent.setup();
    await user.upload(input(), f);
    await waitFor(() => expect(mc.uploads).toHaveLength(1));
    await leaveAndReturn(view);
    await user.upload(input(), f);
    await new Promise((r) => setTimeout(r, 30));
    expect(mc.uploads).toHaveLength(1);
    release();
    await waitFor(() => expect(table().querySelectorAll("[data-material]").length).toBe(before + 1));
    expect(mc.uploads).toHaveLength(1);
  });
});

describe("최종 리뷰 2/2 — 같은 파일이 중복 등록돼도 자료 목록에는 한 줄만 보인다 (서버는 같은 바이트의 blob·파일 정책을 하나로 합친다)", () => {
  it("blob · 원래 이름이 같은 두 자료 행은 한 줄 — 다른 파일은 그대로", async () => {
    const dup = m(5, { blob_id: "blob-1", file_policy_id: "fp-1", sha256: m(1).sha256, original_name: m(1).original_name, title: m(1).title });
    const mc = createMaterialsClient([m(1), dup, m(3)]);
    await boot(mc);
    await waitRows();
    expect(table().querySelectorAll("[data-material]")).toHaveLength(2);
    expect(table().querySelector('[data-material="mat-1"]')).not.toBeNull();
    expect(table().querySelector('[data-material="mat-3"]')).not.toBeNull();
  });
});
