// SEL-94 U3b 1차 리뷰(R1) 고침 시험 — 낙관적 확인(base_version_id) · not_supported 안내 · 가짜 서버 규칙 · retryable · 근거 링크 · 키 재사용.
// 기존 시험(src/features/workspace/u3b-*.test.tsx)은 그대로 두고 고친 동작만 새로 못 박는다. 합성 자료뿐.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import { WORKSPACE } from "@/api/fixture";
import { createHttpClient } from "@/api/http-client";
import { FORMAT_VERSION, PesApiError, type ApiErrorCode, type PesClient } from "@/api/types";
import { SourceLink, isSafeHref } from "@/features/records/parts";
import { ROUND_RESEARCH_2, boot, cellText, fullData, rowButton, rowOf, row, type U3Client } from "@/test/u3b";

afterEach(cleanup);

const dialog = (name: RegExp) => screen.findByRole("dialog", { name });
const submit = (d: HTMLElement) => within(d).getByRole("button", { name: "판단 기록" });
const box = (d: HTMLElement, name: string) => within(d).getByRole("textbox", { name }) as HTMLTextAreaElement;
const receiptText = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "").join(" ");
const apiError = (code: ApiErrorCode, retryable = false, message = "서버 말(시험)") =>
  new PesApiError({ format_version: FORMAT_VERSION, error: { code, message, retryable, next_action: "reread_context" }, request_id: "req-fix" });

/** 읽기 세 개를 서버가 아직 못 주는 것처럼 */
function notSupportedReads(u3: U3Client) {
  const c = u3.client as unknown as Record<string, () => Promise<never>>;
  for (const m of ["getAssumptions", "getDecisions", "getReflections"]) c[m] = () => Promise.reject(apiError("not_supported", false, "아직 서버에서 지원하지 않습니다."));
}

describe("권장 1 — 판단 입력에 사람이 본 버전(base_version_id)", () => {
  it("가정 확인 · 틀림 · 고침 / 결정 채택 · 대체 · 철회 모두 열 때의 행 version_id 를 base_version_id 로 보낸다", async () => {
    const { u3, user } = await boot();
    const run = async (id: string, kind: "assumption" | "decision", button: string, title: RegExp, fill: Record<string, string> = {}) => {
      await user.click(rowButton(await rowOf(kind, id), button));
      const d = await dialog(title);
      for (const [label, value] of Object.entries(fill)) {
        await user.clear(box(d, label));
        await user.type(box(d, label), value);
      }
      await user.click(submit(d));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    await run("as-1", "assumption", "확인", /가정 확인/);
    await run("dec-4", "decision", "채택", /결정 채택/);
    await run("dec-2", "decision", "대체", /결정 대체/, { "새 결정": "비교 기간은 2022년부터로 한다", 근거: "코로나 이후만" });
    await run("dec-3", "decision", "철회", /결정 철회/, { 근거: "더는 맞지 않음" });
    const base = Object.fromEntries(u3.cmds.map((c) => [c.objectId, c.input.base_version_id]));
    expect(base).toEqual({ "as-1": "as-1-v1", "dec-4": "dec-4-v1", "dec-2": "dec-2-v1", "dec-3": "dec-3-v1" });
  });

  it("틀림 · 고침도 base_version_id 를 싣는다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "틀림"));
    let d = await dialog(/가정 틀림/);
    await user.type(box(d, "근거"), "정의가 바뀜");
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(1));
    expect(u3.cmds[0].input).toMatchObject({ verdict: "reject", base_version_id: "as-1-v1" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(rowButton(await rowOf("assumption", "as-6"), "고침"));
    d = await dialog(/가정 고침/);
    await user.clear(box(d, "고친 가정"));
    await user.type(box(d, "고친 가정"), "야간 개관 시간은 계절마다 다르다");
    await user.type(box(d, "근거"), "계절별 공지");
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].input).toMatchObject({ verdict: "revise", base_version_id: "as-6-v1" });
  });

  it("그 사이 행이 바뀌어 rev_conflict 로 거절되면 '다른 곳에서 바뀌었어요' + 다시 보기. 빨간 실패 말(기록하지 못했어요)이 아니다", async () => {
    const { u3, user } = await boot();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    const d = await dialog(/가정 확인/);
    // 다른 곳에서 새 버전이 생겼다
    const stored = u3.store.assumptions.find((x) => x.object_id === "as-1")!;
    stored.version_id = "as-1-v9";
    stored.statement = "도서관 방문 수의 정의는 2021년부터 같다고 본다";
    u3.failNext(apiError("rev_conflict", false, "기준 버전이 현재와 다릅니다."));
    await user.click(submit(d));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/다른 곳에서 바뀌었어요/);
    expect(alert.textContent).not.toMatch(/기록하지 못했어요/);
    expect(u3.cmds[0].input.base_version_id).toBe("as-1-v1");
    // 보낼 수 있는 단추는 없고 다시 보기가 그 자리에 있다
    expect(within(d).queryByRole("button", { name: "판단 기록" })).toBeNull();
    expect(row("assumption", "as-1")!.getAttribute("data-state")).toBe("proposed");
    expect(cellText(row("assumption", "as-1")!, "statement")).toContain("2019년부터");

    const reads = u3.readCalls("getAssumptions").length;
    await user.click(within(d).getByRole("button", { name: "다시 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(u3.readCalls("getAssumptions").length).toBeGreaterThan(reads);
    await waitFor(() => expect(cellText(row("assumption", "as-1")!, "statement")).toContain("2021년부터"));
    expect(receiptText()).toMatch(/다른 곳에서 바뀌어 다시 읽었어요/);
    expect(receiptText()).not.toMatch(/접수 \d{4}/);
    expect(document.activeElement).not.toBe(document.body);

    // 다시 열어 판단하면 새 버전을 기준으로 보낸다
    await user.click(rowButton(row("assumption", "as-1")!, "확인"));
    await user.click(submit(await dialog(/가정 확인/)));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].input.base_version_id).toBe("as-1-v9");
    expect(u3.cmds[1].key).not.toBe(u3.cmds[0].key);
  });

  it("가짜 클라이언트: 낡은 base_version_id 는 rev_conflict 로 거절하고 행을 바꾸지 않는다, 판단하면 version_id 가 새로 바뀐다", async () => {
    const c: PesClient = createFakeClient(WORKSPACE, fullData());
    const ws = [WORKSPACE.slug, WORKSPACE.edition] as const;
    const before = (await c.getAssumptions(...ws)).find((x) => x.object_id === "as-1")!;
    await expect(c.assessAssumption(...ws, "as-1", { verdict: "confirm", rationale: "", base_version_id: "as-1-낡음" }, "k-1")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
    expect((await c.getAssumptions(...ws)).find((x) => x.object_id === "as-1")!.state).toBe("proposed");

    const ok = await c.assessAssumption(...ws, "as-1", { verdict: "confirm", rationale: "", base_version_id: before.version_id }, "k-2");
    const after = (await c.getAssumptions(...ws)).find((x) => x.object_id === "as-1")!;
    expect(after.version_id).not.toBe(before.version_id);
    expect(after.version_id).toBe(ok.data.version_id);
    // 옛 버전으로 결정 판단도 거절
    const decs = await c.getDecisions(...ws);
    const adopted = decs.find((x) => x.object_id === "dec-2")!;
    await expect(c.revokeDecision(...ws, "dec-2", { base_version_id: "dec-2-낡음", rationale: "x" }, "k-3")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
    await expect(c.supersedeDecision(...ws, "dec-2", { base_version_id: "dec-2-낡음", statement: "새", rationale: "x" }, "k-4")).rejects.toMatchObject({ body: { error: { code: "rev_conflict" } } });
    const done = await c.supersedeDecision(...ws, "dec-2", { base_version_id: adopted.version_id, statement: "새 결정", rationale: "x" }, "k-5");
    const old = (await c.getDecisions(...ws)).find((x) => x.object_id === "dec-2")!;
    expect(old.state).toBe("superseded");
    expect(old.version_id).not.toBe(adopted.version_id);
    expect(done.data.object_id).not.toBe("dec-2");
  });
});

describe("권장 2 — not_supported 는 차분한 안내", () => {
  it("세 영역 모두 '아직 서버에서 읽을 수 없어요' — 빨간 실패 · 다시 읽기 단추 · 경보가 없다", async () => {
    await boot(fullData(), undefined, {}, notSupportedReads);
    await waitFor(() => expect(document.querySelectorAll("[data-read-state='not-supported']").length).toBeGreaterThanOrEqual(3));
    for (const n of document.querySelectorAll("[data-read-state='not-supported']")) {
      expect(n.textContent).toBe("아직 서버에서 읽을 수 없어요.");
      expect(n.className).not.toMatch(/text-bad/);
    }
    expect(screen.queryByRole("button", { name: "다시 읽기" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/불러오지 못했어요/);
    // "기록 없음"이라고 하지 않는다
    expect(document.body.textContent).not.toMatch(/기록 없음/);
  });

  it("그 밖의 읽기 실패는 그대로 '불러오지 못했어요' + 다시 읽기", async () => {
    await boot(fullData(), undefined, {}, (u3) => u3.breakRead("getAssumptions"));
    await waitFor(() => expect(screen.getAllByText("불러오지 못했어요.").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("button", { name: "다시 읽기" }).length).toBeGreaterThan(0);
  });

  it("라운드 화면 첫머리 반영 요약도 not_supported 면 같은 차분한 안내", async () => {
    await boot(fullData(), ROUND_RESEARCH_2, {}, notSupportedReads);
    await waitFor(() => expect(document.querySelector("[data-read-state='not-supported']")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "다시 읽기" })).toBeNull();
  });

  it("http 클라이언트: 가정 · 결정 · 반영 읽기와 쓰기 7개가 각자 정해진 경로로 요청을 보내고 not_supported 를 내지 않는다 (SEL-100 이 SEL-94 의 '서버에 아직 없음'을 뒤집음)", async () => {
    const seen: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input), "http://app.invalid").pathname}`);
      return new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "r", error: { code: "not_found", message: "없음(시험)", retryable: false, next_action: "reread_context" } }), { status: 404 });
    });
    const http = createHttpClient({ session: "s", projects: { demo: "p-1" }, fetch: fetchSpy as unknown as typeof fetch });
    const base = { base_version_id: "x-v1" };
    const P = "/api/v1/projects/p-1";
    // 결정 쓰기 셋은 먼저 그 판의 결정 목록을 읽어 scope 를 알아낸다(없는 결정이라 POST 없이 not_found) — 첫 요청이 그 사전 읽기다
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["getAssumptions", () => http.getAssumptions("demo", 1), `GET ${P}/assumptions`],
      ["getDecisions", () => http.getDecisions("demo", 1), `GET ${P}/decisions`],
      ["getReflections", () => http.getReflections("demo", 1, "research", "1"), `GET ${P}/reflections`],
      ["assessAssumption", () => http.assessAssumption("demo", 1, "as-1", { verdict: "confirm", rationale: "", ...base }, "k"), `POST ${P}/assumptions`],
      ["adoptDecision", () => http.adoptDecision("demo", 1, "dec-1", { rationale: "", ...base }, "k"), `GET ${P}/decisions`],
      ["supersedeDecision", () => http.supersedeDecision("demo", 1, "dec-1", { statement: "s", rationale: "r", ...base }, "k"), `GET ${P}/decisions`],
      ["revokeDecision", () => http.revokeDecision("demo", 1, "dec-1", { rationale: "r", ...base }, "k"), `GET ${P}/decisions`],
    ];
    for (const [name, call, expected] of cases) {
      seen.length = 0;
      const outcome = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(seen[0], `${name} 의 첫 요청`).toBe(expected);
      if (outcome !== null) {
        expect(outcome).toBeInstanceOf(PesApiError);
        expect((outcome as PesApiError).body.error.code, `${name} 는 not_supported 를 내지 않는다(서버 404 = not_found 만)`).not.toBe("not_supported");
      }
    }
  });
});

describe("권장 3 — 화면 규칙과 가짜 서버 규칙이 같다", () => {
  it("AI 가 확인한 가정(as-6)의 '확인' 단추를 누르면 conflict 가 아니라 기록된다 (가짜 클라이언트)", async () => {
    const c: PesClient = createFakeClient(WORKSPACE, fullData());
    const ws = [WORKSPACE.slug, WORKSPACE.edition] as const;
    const as6 = (await c.getAssumptions(...ws)).find((x) => x.object_id === "as-6")!;
    expect(as6.assessed_by?.kind).toBe("ai");
    await c.assessAssumption(...ws, "as-6", { verdict: "confirm", rationale: "내가 봤다", base_version_id: as6.version_id }, "k-ai");
    const after = (await c.getAssumptions(...ws)).find((x) => x.object_id === "as-6")!;
    expect(after.assessed_by?.kind).toBe("human");
    // 사람이 확인한 가정은 다시 판단할 수 없다(덮어쓰지 않음)
    const as2 = (await c.getAssumptions(...ws)).find((x) => x.object_id === "as-2")!;
    await expect(c.assessAssumption(...ws, "as-2", { verdict: "reject", rationale: "x", base_version_id: as2.version_id }, "k-h")).rejects.toMatchObject({ body: { error: { code: "conflict" } } });
  });
});

describe("권장 4 — 서버가 다시 보내도 된다고 한(retryable) 거절은 접수 확인 중, 키 유지", () => {
  it("retryable 거절 뒤 다시 누르면 같은 멱등 키 · 빨간 경보 없음", async () => {
    const { u3, user } = await boot();
    u3.failNext(apiError("conflict", true, "잠시 뒤 다시 시도(시험)"));
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    const d = await dialog(/가정 확인/);
    await user.click(submit(d));
    await waitFor(() => expect(screen.getByText(/접수 확인 중 — 답이 오지 않았어요/)).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].key).toBe(u3.cmds[0].key);
    await waitFor(() => expect(receiptText()).toMatch(/접수 \d{4}/));
  });

  it("시간 초과 뒤 글을 고쳐 보내면 새 요청이라고 미리 알려 준다 (안내 한 줄)", async () => {
    const { u3, user } = await boot();
    u3.loseReplyNext();
    await user.click(rowButton(await rowOf("assumption", "as-1"), "틀림"));
    const d = await dialog(/가정 틀림/);
    await user.type(box(d, "근거"), "처음 글");
    await user.click(submit(d));
    await waitFor(() => expect(screen.getByText(/글을 고치고 누르면 새 요청으로 보내요/)).toBeTruthy());
    await user.type(box(d, "근거"), " 고침");
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].key).not.toBe(u3.cmds[0].key);
  });
});

describe("권장 5 — 근거 링크 걸러 내기", () => {
  it("같은 사이트 안 주소만 isSafeHref", () => {
    for (const ok of ["/p/demo/e/1/s/research/r/1", "/demo/reports/plan.html", "/a#b"]) expect(isSafeHref(ok), ok).toBe(true);
    for (const bad of ["javascript:alert(1)", "//evil.example/x", "/\\evil.example", "https://evil.example", "data:text/html,x", "", "p/x", "/a b", " /a", "\t/a"]) expect(isSafeHref(bad), bad).toBe(false);
  });

  it("안전하지 않은 href 는 링크 없이 글자만, 안전한 것은 링크", () => {
    render(
      <MemoryRouter>
        <SourceLink link={{ label: "나쁜 링크", href: "javascript:alert(1)" }} />
        <SourceLink link={{ label: "남의 사이트", href: "//evil.example/x" }} />
        <SourceLink link={{ label: "보고서", href: "/demo/reports/plan.html" }} />
        <SourceLink link={{ label: "앱 안", href: "/p/demo/e/1/records" }} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: "나쁜 링크" })).toBeNull();
    expect(screen.queryByRole("link", { name: "남의 사이트" })).toBeNull();
    expect(screen.getByText("나쁜 링크")).toBeTruthy();
    expect(screen.getByRole("link", { name: "보고서" }).getAttribute("href")).toBe("/demo/reports/plan.html");
    expect(screen.getByRole("link", { name: "앱 안" }).getAttribute("href")).toBe("/p/demo/e/1/records");
  });
});

describe("권장 6·7 — 접수 줄은 대화 상자 제목과 같은 말, 서버 거절 뒤에는 새 멱등 키", () => {
  it("접수 줄이 대화 상자 제목 낱말을 그대로 쓴다", async () => {
    const { user } = await boot();
    await user.click(rowButton(await rowOf("decision", "dec-4"), "채택"));
    const d = await dialog(/결정 채택/);
    const title = within(d).getByRole("heading").textContent;
    await user.click(submit(d));
    await waitFor(() => expect(receiptText()).toMatch(/접수 \d{4}/));
    expect(receiptText()).toContain(`${title}을(를) 기록했어요`);
  });

  it("서버가 거절(conflict)한 뒤 다시 누르면 새 멱등 키로 보낸다", async () => {
    const { u3, user } = await boot();
    u3.failNext(apiError("conflict"));
    await user.click(rowButton(await rowOf("assumption", "as-1"), "확인"));
    const d = await dialog(/가정 확인/);
    await user.click(submit(d));
    await screen.findByRole("alert");
    await user.click(submit(d));
    await waitFor(() => expect(u3.cmds).toHaveLength(2));
    expect(u3.cmds[1].key).not.toBe(u3.cmds[0].key);
    expect(u3.cmds[0].key).toBeTruthy();
  });
});
