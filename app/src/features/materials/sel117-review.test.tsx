// SEL-117 1차 리뷰 수정 시험 — 대화 상자가 열린 동안 뒤 화면을 inert 로 둔다(필수 1). 합성 자료뿐, 네트워크 0.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "@/api/http-client";
import { WORKSPACE } from "@/api/fixture";
import { boot, createMaterialsClient, file, main, switchOf, waitRows } from "@/test/sel117";

afterEach(cleanup);

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

  it("fetch 가 TypeError 로 실패(요청을 보낸 뒤 연결 끊김)는 “접수 확인 중” — 보내지 못함 아님", async () => {
    const boom = new TypeError("Failed to fetch");
    const fetchImpl = vi.fn(async () => {
      throw boom;
    });
    const mc = createMaterialsClient();
    await pick(mc, fetchImpl as unknown as typeof fetch);
    await waitFor(() => expect(document.body.textContent).toContain("접수 확인 중"));
    expect(document.body.textContent).not.toContain("보내지 못했어요");
    expect(fetchImpl).toHaveBeenCalled();
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
