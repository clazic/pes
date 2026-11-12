// SEL-117 MAT1c — 내 자료 화면(작업 중 자료 목록 · 생성 화면 “내 자료” 칸) · 파일별 AI 참조 스위치 · 미리보기. 구현 뒤 통과(MAT1c).
// 계약(주소 · 이름 · 문구 · 클라이언트 모양)은 src/test/sel117.ts 머리말. 합성 자료뿐, 네트워크 0(가짜 클라이언트).
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render-app";
import { ready } from "@/test/ui";
import {
  FILES,
  MATERIALS,
  NEW,
  OVERCLAIM,
  boot,
  cell,
  createMaterialsClient,
  file,
  m,
  main,
  previewOf,
  rejection,
  rowOf,
  switchOf,
  table,
  waitRows,
} from "@/test/sel117";

afterEach(cleanup);
beforeEach(() => {
  // 확인 중 시도는 sessionStorage 에 남는다 — 앞 시험의 키가 뒤 시험 화면에 새지 않게 매번 비운다
  window.sessionStorage.clear();
  window.localStorage.clear();
  // jsdom 에는 blob 주소가 없다 — 이미지 미리보기가 쓸 수 있게 흉내만
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:synthetic-preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

const statusText = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "").join(" ");
const fileInput = (name: RegExp | string = "자료 파일 고르기") => screen.getByLabelText(name, { selector: "input[type=file]" }) as HTMLInputElement;
const dialogOf = (name: string) => screen.findByRole("dialog", { name });
/** 미리보기 칸 — 비모달 dialog 또는 region (계약: 둘 중 하나) */
const pane = (name: RegExp) => screen.queryByRole("dialog", { name }) ?? screen.queryByRole("region", { name });
const findPane = (name: RegExp) => waitFor(() => { const el = pane(name); if (!el) throw new Error("미리보기 칸이 없다"); return el; });

describe("자리 · 목록 — 형식 · 크기 · 버전 · 추출 상태", () => {
  it("/files: main 하나, 화면 제목 h1 “내 자료”, caption “내 자료” 표(th scope=col), 사이드바 링크가 이 화면을 가리킨다", async () => {
    await boot();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(main().querySelector("h1[data-screen-title]")?.textContent).toContain("내 자료");
    await waitRows();
    const heads = [...table().querySelectorAll("thead th")];
    expect(heads.length).toBeGreaterThan(3);
    for (const th of heads) expect(th.getAttribute("scope")).toBe("col");
    const link = within(screen.getByRole("navigation", { name: /연구 흐름|탐색/ })).queryByRole("link", { name: /내 자료/ }) ?? screen.getByRole("link", { name: /내 자료/ });
    expect(link.getAttribute("href")).toBe(FILES);
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("행마다 형식 · 크기 · 버전을 보인다 (TXT 10 B v1 · PDF 2 KB v3 · XLSX 1.5 MB · CSV)", async () => {
    await boot();
    await waitRows();
    expect(cell("mat-1", "format").textContent).toMatch(/TXT/);
    expect(cell("mat-1", "size").textContent).toMatch(/(^|\D)10\s*B\b/);
    expect(cell("mat-1", "version").textContent).toMatch(/v1\b/);
    expect(cell("mat-2", "format").textContent).toMatch(/PDF/);
    expect(cell("mat-2", "size").textContent).toMatch(/2(\.0)?\s*KB/);
    expect(cell("mat-2", "version").textContent).toMatch(/v3\b/);
    expect(cell("mat-3", "format").textContent).toMatch(/XLSX/);
    expect(cell("mat-3", "size").textContent).toMatch(/1\.5\s*MB/);
    expect(cell("mat-4", "format").textContent).toMatch(/CSV/);
    // 제목과 원래 파일 이름이 함께 — 서버가 준 글 그대로
    expect(cell("mat-2", "name").textContent).toContain("합성 보고서");
    expect(cell("mat-2", "name").textContent).toContain("report-synthetic.pdf");
  });

  it("모르는 형식은 지어내지 않고 “형식 모름”", async () => {
    const mc = createMaterialsClient([m(9, { original_name: "noext", media_type: "" })]);
    await boot(mc);
    await waitRows();
    expect(cell("mat-9", "format").textContent).toMatch(/형식 모름/);
  });

  it("추출 상태: SEL-116 계약 전이라 모든 행이 정확히 “추출 상태 정보 없음” — 준비됨 · 성공 · 실패 · 0건 같은 말을 지어내지 않는다", async () => {
    await boot();
    await waitRows();
    for (const row of MATERIALS) {
      const t = (cell(row.object_id, "extraction").textContent ?? "").trim();
      expect(t).toBe("추출 상태 정보 없음");
      expect(t).not.toMatch(/준비됨|성공|완료|뽑힘|실패|지원 안 함|일부만|0\s*건/);
    }
    // 열 머리에도 추출 칸 자리가 있다
    expect([...table().querySelectorAll("thead th")].some((th) => /추출|글자 뽑기/.test(th.textContent ?? ""))).toBe(true);
  });

  it("사람 화면에서는 금지(deny) 파일도 목록에 보인다", async () => {
    await boot();
    await waitRows();
    expect(rowOf("mat-2").getAttribute("data-ai-access")).toBe("deny");
    expect(rowOf("mat-1").getAttribute("data-ai-access")).toBe("allow");
    expect(cell("mat-2", "name").textContent).toContain("합성 보고서");
  });

  it("자료가 0이면 표 대신 빈 상태 글(오류 아님), 올리기 입력은 있다", async () => {
    await boot(createMaterialsClient([]));
    await waitFor(() => expect(main().textContent).toContain("올린 자료가 없습니다"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table", { name: "내 자료" })).toBeNull();
    expect(fileInput().type).toBe("file");
  });

  it("읽기 실패는 role=alert (빈 상태로 위장하지 않는다)", async () => {
    const mc = createMaterialsClient();
    mc.breakRead();
    await boot(mc);
    await screen.findByRole("alert");
    expect(main().textContent).not.toContain("올린 자료가 없습니다");
  });

  it("기본 가짜 클라이언트(client 안 넘김)도 sample-study 에 허용 1개 이상 · 금지 1개 이상의 합성 자료를 가진다", async () => {
    await renderApp(FILES);
    await ready();
    await waitRows();
    const states = [...table().querySelectorAll("[data-material]")].map((r) => r.getAttribute("data-ai-access"));
    expect(states).toContain("allow");
    expect(states).toContain("deny");
    for (const r of table().querySelectorAll("[data-material]")) expect(r.querySelector("[data-cell=extraction]")?.textContent?.trim()).toBe("추출 상태 정보 없음");
  });
});

describe("올리기 — 작업 중 자료 목록", () => {
  it("입력 “자료 파일 고르기”(file, multiple)는 키보드 초점이 닿는다 (tabindex=-1 아님)", async () => {
    await boot();
    const input = fileInput();
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("tabindex")).not.toBe("-1");
    expect(input.disabled).toBe(false);
  });

  it("파일을 고르면 uploadMaterial 한 번 · 영수증 전에는 “올리는 중”만, 새 행도 성공 말도 없다 · 영수증 뒤 다시 읽어 행이 생긴다", async () => {
    const mc = createMaterialsClient();
    const { container } = await boot(mc);
    await waitRows();
    const release = mc.hold();
    const before = table().querySelectorAll("[data-material]").length;
    await userEvent.setup().upload(fileInput(), file("added-synthetic.txt", "합성 새 파일"));
    await waitFor(() => expect(mc.uploads).toHaveLength(1));
    expect(mc.uploads[0]).toMatchObject({ name: "added-synthetic.txt" });
    expect(mc.uploads[0].key).toBeTruthy();
    await waitFor(() => expect(statusText()).toContain("올리는 중"));
    expect(statusText()).not.toContain("접수 확인 중");
    expect(statusText()).not.toMatch(/접수\s*\d|접수됨/);
    expect(table().querySelectorAll("[data-material]").length).toBe(before);
    expect(container.textContent).not.toContain("added-synthetic.txt");
    release();
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    await waitFor(() => expect(table().textContent).toContain("added-synthetic.txt"));
    expect(table().querySelectorAll("[data-material]").length).toBe(before + 1);
    expect(mc.reads.length).toBeGreaterThanOrEqual(2); // 영수증 뒤 다시 읽음
  });

  it("파일 여러 개 = 파일마다 한 번, 멱등 키는 서로 다르다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await userEvent.setup().upload(fileInput(), [file("a-synthetic.txt", "가"), file("b-synthetic.txt", "나")]);
    await waitFor(() => expect(mc.uploads).toHaveLength(2));
    expect(new Set(mc.uploads.map((u) => u.key)).size).toBe(2);
    expect(mc.uploads.map((u) => u.name).sort()).toEqual(["a-synthetic.txt", "b-synthetic.txt"]);
  });

  it("거절(PesApiError)이면 role=alert 에 서버 메시지, 행은 그대로", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const before = table().querySelectorAll("[data-material]").length;
    mc.failNext(rejection("저장 공간 한도를 넘었습니다(합성)", "conflict"));
    await userEvent.setup().upload(fileInput(), file());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("저장 공간 한도를 넘었습니다(합성)");
    expect(table().querySelectorAll("[data-material]").length).toBe(before);
    expect(statusText()).not.toMatch(/접수\s*\d/);
  });

  it("시간 초과(TimeoutError)는 실패가 아니라 “접수 확인 중” 유지 — 같은 파일을 다시 올리면 같은 멱등 키", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    mc.loseReplyNext();
    const user = userEvent.setup();
    const f = file("retry-synthetic.txt", "다시");
    await user.upload(fileInput(), f);
    await waitFor(() => expect(mc.uploads).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.upload(fileInput(), f);
    await waitFor(() => expect(mc.uploads).toHaveLength(2));
    expect(mc.uploads[1].key).toBe(mc.uploads[0].key);
  });

  it("행의 “새 버전 올리기: <제목>” 은 그 자료의 object_id 로 보낸다 (원본을 덮어쓰지 않고 새 버전 → v2)", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const input = within(rowOf("mat-1")).getByLabelText(/새 버전 올리기.*합성 자료 1/, { selector: "input[type=file]" });
    await userEvent.setup().upload(input as HTMLInputElement, file("v2-synthetic.txt", "두 번째 판"));
    await waitFor(() => expect(mc.uploads).toHaveLength(1));
    expect(mc.uploads[0]).toMatchObject({ object_id: "mat-1", name: "v2-synthetic.txt" });
    await waitFor(() => expect(cell("mat-1", "version").textContent).toMatch(/v2\b/));
    expect(table().querySelectorAll('[data-material="mat-1"]')).toHaveLength(1);
  });
});

describe("생성 화면(/new) — “내 자료” 칸은 담기만 한다", () => {
  const region = () => screen.getByRole("region", { name: "내 자료" });

  it("main 안 region “내 자료”(제목 h2) · 파일 입력이 있고, 고르기만으로는 서버에 올리지 않는다", async () => {
    const mc = createMaterialsClient();
    await boot(mc, NEW);
    expect(region().querySelector("h2")?.textContent).toContain("내 자료");
    const user = userEvent.setup();
    await user.upload(within(region()).getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, file("staged-synthetic.csv", "a,b\n1,2", "text/csv"));
    await waitFor(() => expect(region().textContent).toContain("staged-synthetic.csv"));
    expect(region().textContent).toMatch(/CSV/);
    expect(region().textContent).toMatch(/아직 올리지 않/);
    expect(mc.uploads).toHaveLength(0);
    expect(mc.accessCalls).toHaveLength(0);
  });

  it("담은 파일의 AI 참조 스위치는 기본 허용, 대화 상자 없이 “올릴 때부터 금지”로 바꿀 수 있다 · 정직한 안내가 있다 · 빼기", async () => {
    const mc = createMaterialsClient();
    await boot(mc, NEW);
    const user = userEvent.setup();
    await user.upload(within(region()).getByLabelText("자료 파일 고르기", { selector: "input[type=file]" }) as HTMLInputElement, file("staged-synthetic.txt"));
    const sw = await within(region()).findByRole("switch", { name: /AI 참조.*staged-synthetic\.txt/ });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    expect(screen.queryByRole("dialog")).toBeNull(); // 아직 나간 게 없으니 확인 대화 상자 없음
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(region().textContent).toMatch(/올릴 때부터 AI 참조 금지/);
    const notice = region().querySelector("[data-deny-notice]")?.textContent ?? "";
    expect(notice).toMatch(/B/);
    expect(notice).toMatch(/직접 읽/);
    expect(notice).toMatch(/막지 못/);
    expect(region().textContent).not.toMatch(OVERCLAIM);
    await user.click(within(region()).getByRole("button", { name: /빼기.*staged-synthetic\.txt/ }));
    expect(region().textContent).not.toContain("staged-synthetic.txt");
    expect(mc.uploads).toHaveLength(0);
  });

  it("목록 읽기를 부르지 않는다(프로젝트가 아직 없다) — 가짜 클라이언트 호출 0", async () => {
    const mc = createMaterialsClient();
    await boot(mc, NEW);
    expect(region().querySelector("h2")?.textContent).toContain("내 자료");
    expect(mc.reads).toHaveLength(0);
  });
});

describe("AI 참조 스위치", () => {
  it("행마다 role=switch, 이름에 제목, aria-checked 가 허용=true · 금지=false · 상태 모름(null)은 스위치 없이 “AI 참조 상태 정보 없음”", async () => {
    await boot();
    await waitRows();
    expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("true");
    expect(switchOf("mat-1").getAttribute("aria-label") ?? switchOf("mat-1").textContent).toContain("합성 자료 1");
    expect(switchOf("mat-2").getAttribute("aria-checked")).toBe("false");
    expect(within(rowOf("mat-4")).queryByRole("switch")).toBeNull();
    expect(cell("mat-4", "ai-access").textContent).toContain("AI 참조 상태 정보 없음");
    expect(rowOf("mat-4").getAttribute("data-ai-access")).toBe("unknown");
  });

  it("끄기: 스위치 → 대화 상자 “AI 참조 끄기”(취소 · 동사 단추 · 이유) — 열기만으로는 클라이언트를 부르지 않는다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1"));
    const d = await dialogOf("AI 참조 끄기");
    expect(within(d).getByRole("button", { name: "취소" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "AI 참조 끄기" })).toBeTruthy();
    expect(within(d).getByRole("textbox", { name: "이유" })).toBeTruthy();
    expect(mc.accessCalls).toHaveLength(0);
    await user.click(within(d).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mc.accessCalls).toHaveLength(0);
    expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("true");
  });

  it("끄기 성공: 영수증 전에는 스위치 그대로 + “접수 확인 중”, 두 번 눌러도 한 번 · 영수증 뒤 접수 번호 · 값 바뀜 · 초점이 스위치", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1"));
    const d = await dialogOf("AI 참조 끄기");
    await user.type(within(d).getByRole("textbox", { name: "이유" }), "민감 자료");
    const release = mc.hold();
    const verb = within(d).getByRole("button", { name: "AI 참조 끄기" });
    await user.click(verb);
    await user.click(verb);
    await waitFor(() => expect(mc.accessCalls).toHaveLength(1));
    expect(verb.getAttribute("aria-disabled")).toBe("true");
    expect(verb.hasAttribute("disabled")).toBe(false);
    expect(statusText()).toContain("접수 확인 중");
    expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("true"); // 낙관적 갱신 없음
    expect(statusText()).not.toMatch(/접수\s*\d|꺼졌|껐/);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("false"));
    expect(rowOf("mat-1").getAttribute("data-ai-access")).toBe("deny");
    expect(statusText()).toMatch(/접수\s*0?7\d\d/);
    expect(document.activeElement).toBe(switchOf("mat-1"));
    expect(mc.accessCalls[0]).toMatchObject({ slug: "sample-study", edition: 1, file_policy_id: "fp-1", input: { ai_access: "deny", reason: "민감 자료" } });
    expect(mc.accessCalls[0].key).toBeTruthy();
  });

  it("이유를 비우면 reason 키 자체를 보내지 않는다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1"));
    await user.click(within(await dialogOf("AI 참조 끄기")).getByRole("button", { name: "AI 참조 끄기" }));
    await waitFor(() => expect(mc.accessCalls).toHaveLength(1));
    expect(Object.keys(mc.accessCalls[0].input)).toEqual(["ai_access"]);
  });

  it("다시 켜기: 대화 상자 “AI 참조 다시 허용” → allow", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-2"));
    const d = await dialogOf("AI 참조 다시 허용");
    await user.click(within(d).getByRole("button", { name: "AI 참조 다시 허용" }));
    await waitFor(() => expect(switchOf("mat-2").getAttribute("aria-checked")).toBe("true"));
    expect(mc.accessCalls[0]).toMatchObject({ file_policy_id: "fp-2", input: { ai_access: "allow" } });
  });

  it("같은 값(서버 changed:false)은 “바뀐 것 없음” — 스위치 그대로, 변화 말 없음", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1")); // 화면은 allow 로 보지만
    const d = await dialogOf("AI 참조 끄기");
    mc.store.find((x) => x.object_id === "mat-1")!.ai_access = "deny"; // 그사이 다른 곳에서 이미 껐다
    await user.click(within(d).getByRole("button", { name: "AI 참조 끄기" }));
    await waitFor(() => expect(statusText()).toContain("바뀐 것 없음"));
    expect(statusText()).not.toMatch(/꺼졌|켜졌/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("거절(PesApiError)이면 role=alert 에 서버 메시지 · 대화 상자와 이유 그대로 · 스위치 그대로", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1"));
    const d = await dialogOf("AI 참조 끄기");
    await user.type(within(d).getByRole("textbox", { name: "이유" }), "이유 글");
    mc.failNext(rejection("소유자만 바꿀 수 있습니다(합성)"));
    await user.click(within(d).getByRole("button", { name: "AI 참조 끄기" }));
    const alert = await within(d).findByRole("alert");
    expect(alert.textContent).toContain("소유자만 바꿀 수 있습니다(합성)");
    expect((within(d).getByRole("textbox", { name: "이유" }) as HTMLTextAreaElement).value).toBe("이유 글");
    expect(screen.getByRole("dialog", { name: "AI 참조 끄기" })).toBeTruthy();
    expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("true");
    expect(statusText()).not.toMatch(/접수\s*\d/);
  });

  it("시간 초과는 “접수 확인 중”(실패 아님) 유지, 다시 누르면 같은 멱등 키 → 서버가 재생한 영수증으로 마무리", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1"));
    const d = await dialogOf("AI 참조 끄기");
    mc.loseReplyNext();
    await user.click(within(d).getByRole("button", { name: "AI 참조 끄기" }));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("true");
    await user.click(within(screen.getByRole("dialog", { name: "AI 참조 끄기" })).getByRole("button", { name: "AI 참조 끄기" }));
    await waitFor(() => expect(mc.accessCalls).toHaveLength(2));
    expect(mc.accessCalls[1].key).toBe(mc.accessCalls[0].key);
    await waitFor(() => expect(switchOf("mat-1").getAttribute("aria-checked")).toBe("false"));
  });

  it("목록을 다시 읽으면(다른 곳에서 바뀐 값) 스위치는 서버 값을 따른다 — 화면이 값을 기억해 덮어쓰지 않는다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.upload(fileInput(), file("trigger-synthetic.txt")); // 업로드 뒤 목록 재읽기를 일으킨다
    mc.store.find((x) => x.object_id === "mat-3")!.ai_access = "deny";
    await waitFor(() => expect(table().textContent).toContain("trigger-synthetic.txt"));
    expect(switchOf("mat-3").getAttribute("aria-checked")).toBe("false");
  });
});

describe("정직한 금지 안내 (SEL-111: 통제 불가 경로를 ‘제외 보장’으로 표시하지 않는다)", () => {
  it("끄기 대화 상자: AI 도구 · MCP · 프롬프트에서 제외 + B 로컬 직접 읽기는 못 막음 + 이미 나간 내용 회수 불가, 과장 없음", async () => {
    await boot();
    await waitRows();
    await userEvent.setup().click(switchOf("mat-1"));
    const d = await dialogOf("AI 참조 끄기");
    const t = d.textContent ?? "";
    expect(t).toMatch(/AI 도구/);
    expect(t).toMatch(/MCP/);
    expect(t).toMatch(/프롬프트/);
    expect(t).toMatch(/제외/);
    expect(t).toMatch(/B/);
    expect(t).toMatch(/직접 읽/);
    expect(t).toMatch(/막지 못/);
    expect(t).toMatch(/회수/);
    expect(t).not.toMatch(OVERCLAIM);
  });

  it("표 위 상시 안내 [data-deny-notice] 도 같은 사실을 말하고, 사람 화면에서는 계속 보인다고 알린다", async () => {
    await boot();
    await waitRows();
    const notice = main().querySelector("[data-deny-notice]");
    expect(notice).not.toBeNull();
    const t = notice!.textContent ?? "";
    expect(t).toMatch(/AI 도구/);
    expect(t).toMatch(/MCP/);
    expect(t).toMatch(/프롬프트/);
    expect(t).toMatch(/B/);
    expect(t).toMatch(/직접 읽/);
    expect(t).toMatch(/막지 못/);
    expect(t).toMatch(/사람 화면|이 화면에서는 계속 보입니다/);
    expect(t).not.toMatch(OVERCLAIM);
    // 안내가 [data-print=hide] 가 아니라도 되지만, 화면 전체에 과장 낱말이 없어야 한다
    expect(main().textContent).not.toMatch(OVERCLAIM);
  });

  it("금지된 행에는 “AI 참조 금지” 글(색만으로 알리지 않음)이 있다", async () => {
    await boot();
    await waitRows();
    expect(cell("mat-2", "ai-access").textContent).toMatch(/금지/);
    expect(cell("mat-1", "ai-access").textContent).toMatch(/허용/);
  });
});

describe("미리보기 — 같은 출처 문서로 열지 않는다 (SEL-102)", () => {
  const open = async (id: string, title: string) => {
    const user = userEvent.setup();
    await user.click(within(rowOf(id)).getByRole("button", { name: new RegExp(`미리보기.*${title}`) }));
    return findPane(new RegExp(`미리보기.*${title}`));
  };

  it("text/plain: getMaterialPreview 한 번 · <pre> 에 글자로만 — 본문의 <script> · <b> 가 요소가 되지 않는다", async () => {
    const html = "<script>window.__pwned = 1</script><b>굵게</b>\n둘째 줄";
    const mc = createMaterialsClient(MATERIALS, { "blob-1": previewOf({ blob_id: "blob-1", bytes: new TextEncoder().encode(html) }) });
    await boot(mc);
    await waitRows();
    const pane = await open("mat-1", "합성 자료 1");
    await waitFor(() => expect(pane.querySelector("pre")?.textContent).toContain("<b>굵게</b>"));
    expect(mc.previewCalls).toEqual(["blob-1"]);
    expect(pane.querySelector("pre b, pre script")).toBeNull();
    expect(pane.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(pane.querySelector("pre")?.textContent).toContain("둘째 줄");
  });

  it("iframe·object·embed 가 없다 — 안전하지 않은 형식은 문서 요소로 열지 않고 내려받기만 준다", async () => {
    const mc = createMaterialsClient(MATERIALS, {
      "blob-2": previewOf({ blob_id: "blob-2", content_type: "application/octet-stream", inline: false, sandbox: "sandbox", bytes: new TextEncoder().encode("<html><script>alert(1)</script></html>") }),
    });
    await boot(mc);
    await waitRows();
    const pane = await open("mat-2", "합성 보고서");
    await waitFor(() => expect(pane.textContent).toMatch(/내려받기/));
    expect(pane.textContent).toMatch(/미리볼 수 없|미리보기.*(안 됩니다|되지 않)/);
    expect(document.querySelectorAll("iframe, object, embed, frame, frameset")).toHaveLength(0);
    expect(document.body.innerHTML).not.toContain("alert(1)</script>"); // 본문이 문서에 박히지 않는다
  });

  it("image/png 는 <img> 로 (blob 주소) — 대체 글이 있다", async () => {
    const rows = [m(5, { title: "합성 그림", original_name: "pic-synthetic.png", media_type: "image/png" })];
    const mc = createMaterialsClient(rows, { "blob-5": previewOf({ blob_id: "blob-5", content_type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }) });
    await boot(mc);
    await waitRows();
    const pane = await open("mat-5", "합성 그림");
    const img = await within(pane).findByRole("img");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.getAttribute("alt")).toBeTruthy();
  });

  it("새 탭으로 여는 링크는 모두 rel=noopener (화면 전체)", async () => {
    await boot();
    await waitRows();
    await open("mat-1", "합성 자료 1");
    for (const a of document.querySelectorAll("a[target=_blank]")) expect(a.getAttribute("rel") ?? "").toMatch(/noopener/);
    // 미리보기 바이트의 서버 주소로 직접 가는 링크(세션 헤더 없이 같은 출처로 열림)는 없다
    for (const a of document.querySelectorAll("a[href]")) expect(a.getAttribute("href")).not.toMatch(/\/files\/[^/]+\/preview/);
  });

  it("실패(예: 바이트 변조 409)는 role=alert 에 서버 메시지, 내용은 보이지 않는다", async () => {
    const mc = createMaterialsClient(MATERIALS, { "blob-1": rejection("저장된 바이트가 지문과 다릅니다(합성)", "conflict") });
    await boot(mc);
    await waitRows();
    const pane = await open("mat-1", "합성 자료 1");
    const alert = await within(pane).findByRole("alert");
    expect(alert.textContent).toContain("저장된 바이트가 지문과 다릅니다(합성)");
    expect(pane.querySelector("pre, img, iframe")).toBeNull();
  });

  it("금지(deny) 파일도 사람은 미리볼 수 있다", async () => {
    const mc = createMaterialsClient(MATERIALS, { "blob-2": previewOf({ blob_id: "blob-2", bytes: new TextEncoder().encode("금지 파일의 합성 본문") }) });
    await boot(mc);
    await waitRows();
    const pane = await open("mat-2", "합성 보고서");
    await waitFor(() => expect(pane.querySelector("pre")?.textContent).toContain("금지 파일의 합성 본문"));
  });

  it("Esc 로 닫으면 초점이 미리보기 단추로 돌아온다", async () => {
    await boot();
    await waitRows();
    const btn = within(rowOf("mat-1")).getByRole("button", { name: /미리보기.*합성 자료 1/ });
    const user = userEvent.setup();
    await user.click(btn);
    await findPane(/미리보기.*합성 자료 1/);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(pane(/미리보기.*합성 자료 1/)).toBeNull());
    expect(document.activeElement).toBe(btn);
  });
});

describe("키보드 · 접근성", () => {
  it("Tab 으로 스위치에 닿고 Space 가 대화 상자를 열고, Esc 가 닫고 초점이 그 스위치로 돌아온다 (마우스 없이)", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const sw = switchOf("mat-1");
    const user = userEvent.setup();
    sw.focus();
    expect(document.activeElement).toBe(sw);
    await user.keyboard(" ");
    const d = await dialogOf("AI 참조 끄기");
    expect(d.contains(document.activeElement)).toBe(true); // 초점이 대화 상자 안으로
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(sw);
    expect(mc.accessCalls).toHaveLength(0);
  });

  it("Enter 로도 연다", async () => {
    await boot();
    await waitRows();
    switchOf("mat-1").focus();
    await userEvent.setup().keyboard("{Enter}");
    await dialogOf("AI 참조 끄기");
  });

  it("Tab 만으로 대화 상자 단추를 모두 지나고 대화 상자 밖으로 나가지 않는다 (초점 가둠)", async () => {
    await boot();
    await waitRows();
    const user = userEvent.setup();
    switchOf("mat-1").focus();
    await user.keyboard(" ");
    const d = await dialogOf("AI 참조 끄기");
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(d.contains(document.activeElement)).toBe(true);
    }
  });

  it("상태 알림(role=status)은 polite 이고 경고(role=alert)와 섞이지 않는다", async () => {
    const mc = createMaterialsClient();
    await boot(mc);
    await waitRows();
    const user = userEvent.setup();
    await user.click(switchOf("mat-1"));
    await user.click(within(await dialogOf("AI 참조 끄기")).getByRole("button", { name: "AI 참조 끄기" }));
    await waitFor(() => expect(statusText()).toMatch(/접수\s*\d/));
    for (const s of screen.getAllByRole("status")) {
      const live = s.getAttribute("aria-live");
      expect(live === null || live === "polite").toBe(true);
    }
  });

  it("휴대폰(390, 굵은 포인터)에서도 스위치 · 미리보기 · 올리기가 있다", async () => {
    const mc = createMaterialsClient();
    await boot(mc, FILES, { width: 390, coarse: true });
    await waitRows();
    expect(switchOf("mat-1")).toBeTruthy();
    expect(within(rowOf("mat-1")).getByRole("button", { name: /미리보기/ })).toBeTruthy();
    expect(fileInput()).toBeTruthy();
  });
});
