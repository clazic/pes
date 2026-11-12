// SEL-114 REF1b — 이전 프로젝트 참고자료 화면(작업 중 목록 · 생성 화면 “참고 프로젝트” 칸) · 붙이기 · 떼기 · 다른 버전으로 다시 고정 · 인용 표시. 구현 전이라 실패가 정상.
// 계약(주소 · 이름 · 문구 · 클라이언트 모양)은 src/test/sel114.ts 머리말. 합성 자료뿐, 네트워크 0(가짜 클라이언트).
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "@/test/render-app";
import { NotConnectedError } from "@/api/types";
import { ready } from "@/test/ui";
import {
  CANDIDATES,
  NEW,
  OVERCLAIM,
  REFERENCES,
  REFS,
  boot,
  cell,
  contentOf,
  createReferencesClient,
  main,
  ref,
  rejection,
  rowOf,
  statusText,
  table,
  waitRows,
  type ReferencesClient,
} from "@/test/sel114";

afterEach(cleanup);

const dialogOf = (name: string) => screen.findByRole("dialog", { name });
const radioOf = (scope: HTMLElement, name: RegExp | string) => within(scope).getByRole("radio", { name }) as HTMLElement;
const checked = (el: HTMLElement) => el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked === true;
const pane = (name: RegExp) => screen.queryByRole("dialog", { name }) ?? screen.queryByRole("region", { name });
const findPane = (name: RegExp) => waitFor(() => { const el = pane(name); if (!el) throw new Error("칸이 없다"); return el; });
const isDisabled = (el: HTMLElement) => el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled === true;

async function openAttach(rc: ReferencesClient) {
  const user = userEvent.setup();
  await boot(rc);
  await waitRows();
  await user.click(screen.getByRole("button", { name: "참고 프로젝트 붙이기" }));
  const dlg = await dialogOf("참고 프로젝트 붙이기");
  await within(dlg).findByRole("radio", { name: /합성 지역통계/ });
  return { user, dlg };
}

describe("자리 · 목록 — 상태 · 고정 버전 · 새 버전 고지", () => {
  it("/references: main 하나, 화면 제목 h1 “참고 프로젝트”, caption “참고 프로젝트” 표(th scope=col), 사이드바 링크가 이 화면을 가리킨다", async () => {
    await boot();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(main().querySelector("h1[data-screen-title]")?.textContent).toContain("참고 프로젝트");
    await waitRows();
    const heads = [...table().querySelectorAll("thead th")];
    expect(heads.length).toBeGreaterThan(3);
    for (const th of heads) expect(th.getAttribute("scope")).toBe("col");
    const link = screen.getAllByRole("link", { name: /참고 프로젝트/ }).find((a) => a.getAttribute("href") === REFS);
    expect(link).toBeTruthy();
    expect(link!.getAttribute("aria-current")).toBe("page");
  });

  it("상태 낱말(색만으로 알리지 않는다): 고정됨 · 새 버전 있음 · 원본 없음 · 권한 없음 — 행 data-state 와 함께", async () => {
    await boot();
    await waitRows();
    expect(rowOf("ref-1").getAttribute("data-state")).toBe("new_version");
    expect(cell("ref-1", "state").textContent).toContain("새 버전 있음");
    expect(rowOf("ref-2").getAttribute("data-state")).toBe("pinned");
    expect(cell("ref-2", "state").textContent).toContain("고정됨");
    expect(rowOf("ref-3").getAttribute("data-state")).toBe("source_missing");
    expect(cell("ref-3", "state").textContent).toContain("원본 없음");
    expect(rowOf("ref-4").getAttribute("data-state")).toBe("no_permission");
    expect(cell("ref-4", "state").textContent).toContain("권한 없음");
  });

  it("원본 보관됨은 자기 낱말을 가진다 (원본 없음과 섞지 않는다)", async () => {
    const rc = createReferencesClient([ref(6, { state: "source_archived", source_label: "합성 보관본" })]);
    await boot(rc);
    await waitRows();
    expect(cell("ref-6", "state").textContent).toContain("원본 보관됨");
    expect(cell("ref-6", "state").textContent).not.toContain("원본 없음");
  });

  it("고정된 참고 프로젝트: 이름(label + key)과 고정한 버전 이름이 보인다", async () => {
    await boot();
    await waitRows();
    expect(cell("ref-2", "name").textContent).toContain("합성 물가");
    expect(cell("ref-2", "name").textContent).toContain("synthetic-b");
    expect(cell("ref-2", "version").textContent).toContain("1판 완료본");
  });

  it("새 버전 있음 고지: 고정 버전은 그대로이고 저절로 바뀌지 않는다는 말이 새 버전 행에만 있다", async () => {
    await boot();
    await waitRows();
    expect(cell("ref-1", "state").textContent).toMatch(/저절로 바뀌지 않/);
    expect(cell("ref-1", "version").textContent).toContain("1판 완료본"); // 새 버전이 있어도 고정한 버전을 보인다
    expect(cell("ref-2", "state").textContent).not.toMatch(/저절로 바뀌지 않|새 버전/);
  });

  it("원본 없음(tombstone): 이름(label · key)과 고정했던 버전 이름이 그대로 남고, 다시 고정 · 내용 보기 단추는 없고 떼기는 있다", async () => {
    await boot();
    await waitRows();
    expect(cell("ref-3", "name").textContent).toContain("합성 폐기본");
    expect(cell("ref-3", "name").textContent).toContain("synthetic-gone");
    expect(cell("ref-3", "version").textContent).toContain("1판 완료본");
    const row = rowOf("ref-3");
    expect(within(row).queryByRole("button", { name: /다시 고정/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /내용 보기/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "떼기: 합성 폐기본" })).toBeTruthy();
  });

  it("권한 없음: 이름 · key · label · id 어느 것도 없고 “권한 없음” · “내용 비공개”만 — 다시 고정 · 내용 보기 없음, 떼기는 있다", async () => {
    await boot();
    await waitRows();
    const row = rowOf("ref-4");
    const text = row.textContent ?? "";
    expect(text).toContain("권한 없음");
    expect(text).toContain("내용 비공개");
    expect(text).not.toMatch(/synthetic|pj-|s-[a-d]\d|합성 (장기요양|물가|병원|폐기본)/);
    expect(within(row).queryByRole("button", { name: /다시 고정|내용 보기/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "떼기: 권한 없는 참고 프로젝트" })).toBeTruthy();
    expect(row.getAttribute("data-ai-delivery")).not.toBe("allowed");
  });

  it("행이 0 이면 표 대신 “붙인 참고 프로젝트가 없습니다”(오류 아님) + 붙이기 단추", async () => {
    await boot(createReferencesClient([]));
    await screen.findByText("붙인 참고 프로젝트가 없습니다");
    expect(within(main()).queryByRole("table")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "참고 프로젝트 붙이기" })).toBeTruthy();
  });

  it("읽기 실패는 role=alert (빈 상태로 위장하지 않는다)", async () => {
    const rc = createReferencesClient();
    rc.breakRead();
    await boot(rc);
    await screen.findByRole("alert");
    expect(screen.queryByText("붙인 참고 프로젝트가 없습니다")).toBeNull();
  });

  it("기본 가짜 클라이언트(client 안 넘김)도 sample-study 에 고정됨 · 새 버전 있음 · 원본 없음 · 권한 없음을 하나씩 가진다", async () => {
    await renderApp(REFS);
    await ready();
    await waitRows();
    const states = new Set([...table().querySelectorAll("[data-reference]")].map((r) => r.getAttribute("data-state")));
    for (const s of ["pinned", "new_version", "source_missing", "no_permission"]) expect(states.has(s), s).toBe(true);
  });
});

describe("AI 전달 — Go 꺼짐으로 AI 에게 안 가는 참고 프로젝트 (사람에게는 내용이 보인다)", () => {
  it("allowed true → “AI 전달 가능”, false → “AI 전달 안 됨” + 이유 (원본 Go 꺼짐 · 이 프로젝트 Go 꺼짐 · 원본 없음)", async () => {
    await boot();
    await waitRows();
    expect(rowOf("ref-1").getAttribute("data-ai-delivery")).toBe("allowed");
    expect(cell("ref-1", "ai-delivery").textContent).toContain("AI 전달 가능");
    expect(rowOf("ref-2").getAttribute("data-ai-delivery")).toBe("withheld");
    expect(cell("ref-2", "ai-delivery").textContent).toContain("AI 전달 안 됨");
    expect(cell("ref-2", "ai-delivery").textContent).toMatch(/원본 프로젝트.*Go.*꺼/);
    expect(cell("ref-5", "ai-delivery").textContent).toContain("AI 전달 안 됨");
    expect(cell("ref-5", "ai-delivery").textContent).toMatch(/이 프로젝트.*Go.*꺼/);
    expect(cell("ref-3", "ai-delivery").textContent).toContain("AI 전달 안 됨");
    expect(cell("ref-3", "ai-delivery").textContent).toContain("원본 없음");
  });

  it("처음 보는 이유 값은 그대로 찍지 않고 “AI 전달 안 됨”만 — 이유를 지어내지 않는다", async () => {
    const rc = createReferencesClient([ref(7, { ai_delivery: { allowed: false, withheld_reason: "weird_new_reason_x" } })]);
    await boot(rc);
    await waitRows();
    expect(cell("ref-7", "ai-delivery").textContent).toContain("AI 전달 안 됨");
    expect(cell("ref-7", "ai-delivery").textContent).not.toContain("weird_new_reason_x");
  });

  it("서버가 ai_delivery 를 안 주면(null) “AI 전달 정보 없음” — 전달 가능으로 간주하지 않는다", async () => {
    const rc = createReferencesClient([ref(8, { ai_delivery: null })]);
    await boot(rc);
    await waitRows();
    expect(rowOf("ref-8").getAttribute("data-ai-delivery")).toBe("unknown");
    expect(cell("ref-8", "ai-delivery").textContent).toContain("AI 전달 정보 없음");
    expect(cell("ref-8", "ai-delivery").textContent).not.toContain("AI 전달 가능");
  });

  it("상시 안내 [data-ai-notice]: AI 전달이 안 되는 참고 프로젝트도 이 화면에서는 계속 보인다고 말하고, 과장 낱말이 없다", async () => {
    await boot();
    await waitRows();
    const notice = main().querySelector("[data-ai-notice]");
    expect(notice).toBeTruthy();
    expect(notice!.textContent).toContain("이 화면에서는 계속 보입니다");
    expect(notice!.textContent).not.toMatch(OVERCLAIM);
    expect(main().textContent).not.toMatch(OVERCLAIM);
  });

  it("AI 전달이 안 되는 참고 프로젝트도 사람은 내용을 본다 (내용 보기 단추가 있고 getReference 가 불린다)", async () => {
    const rc = createReferencesClient();
    await boot(rc);
    await waitRows();
    expect(within(rowOf("ref-2")).getByRole("button", { name: "내용 보기: 합성 물가" })).toBeTruthy();
    await userEvent.setup().click(within(rowOf("ref-2")).getByRole("button", { name: "내용 보기: 합성 물가" }));
    const p = await findPane(/참고 내용: 합성 물가/);
    expect(rc.detailCalls).toEqual(["ref-2"]);
    expect(within(p).getAllByText(/합성 물가 (최종 보고서|출처)/).length).toBeGreaterThan(0);
  });
});

describe("인용 — 프로젝트 · 버전 표시", () => {
  it("내용 보기: region “참고 내용: <label>” · 읽기 전용 안내 · 항목마다 [data-citation] 에 프로젝트 label 과 고정한 버전 이름", async () => {
    const rc = createReferencesClient();
    await boot(rc);
    await waitRows();
    await userEvent.setup().click(within(rowOf("ref-1")).getByRole("button", { name: "내용 보기: 합성 장기요양" }));
    const p = await findPane(/참고 내용: 합성 장기요양/);
    expect(rc.detailCalls).toEqual(["ref-1"]);
    expect(p.textContent).toContain("읽기 전용");
    await waitFor(() => expect(p.querySelectorAll("[data-citation]").length).toBe(2));
    for (const c of p.querySelectorAll("[data-citation]")) {
      expect(c.textContent).toContain("합성 장기요양");
      expect(c.textContent).toContain("1판 완료본"); // 새 버전이 있어도 인용은 고정한 버전
    }
  });

  it("본문은 글자로만 — 본문의 <script> · <b> 가 요소가 되지 않는다", async () => {
    const evil = contentOf(REFERENCES[1], [{ body_md: "<script>window.__pwned=1</script><b>굵게</b> 합성 본문" }]);
    const rc = createReferencesClient(REFERENCES, CANDIDATES, { "ref-2": evil });
    await boot(rc);
    await waitRows();
    await userEvent.setup().click(within(rowOf("ref-2")).getByRole("button", { name: "내용 보기: 합성 물가" }));
    const p = await findPane(/참고 내용: 합성 물가/);
    await waitFor(() => expect(p.textContent).toContain("합성 본문"));
    expect(p.querySelector("script")).toBeNull();
    expect(p.querySelector("b")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("출처 항목의 주소는 rel=noopener 로만 새 탭에 열린다", async () => {
    await boot();
    await waitRows();
    await userEvent.setup().click(within(rowOf("ref-1")).getByRole("button", { name: "내용 보기: 합성 장기요양" }));
    const p = await findPane(/참고 내용: 합성 장기요양/);
    await waitFor(() => expect(p.querySelectorAll("[data-citation]").length).toBe(2));
    for (const a of main().querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) expect(a.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("읽기 실패(PesApiError)는 role=alert 에 서버 메시지, 내용은 보이지 않는다", async () => {
    const rc = createReferencesClient(REFERENCES, CANDIDATES, { "ref-1": rejection("이 참고 프로젝트를 읽을 권한이 없습니다(합성)", "forbidden") });
    await boot(rc);
    await waitRows();
    await userEvent.setup().click(within(rowOf("ref-1")).getByRole("button", { name: "내용 보기: 합성 장기요양" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("이 참고 프로젝트를 읽을 권한이 없습니다(합성)");
    expect(document.querySelector("[data-citation]")).toBeNull();
  });
});

describe("붙이기 — 작업 중 (고정할 버전을 함께 정한다)", () => {
  it("대화 상자: 후보 프로젝트 radiogroup · 고를 때까지 버전 칸은 비어 있다 · 이미 붙인 프로젝트는 “이미 붙임” 글과 함께 disabled · 열기만으로 attach 호출 0", async () => {
    const rc = createReferencesClient();
    const { dlg } = await openAttach(rc);
    expect(rc.candidateCalls).toEqual([{ slug: "sample-study", edition: 1 }]);
    expect(rc.attaches).toHaveLength(0);
    expect(within(dlg).getByRole("radiogroup", { name: "참고할 프로젝트" })).toBeTruthy();
    const attachedRadio = radioOf(dlg, /합성 장기요양/);
    expect(isDisabled(attachedRadio) || (attachedRadio as HTMLInputElement).disabled).toBe(true);
    expect(dlg.textContent).toContain("이미 붙임");
    expect(within(dlg).queryByRole("radio", { name: /1판 완료본/ })).toBeNull();
    expect(isDisabled(within(dlg).getByRole("button", { name: "붙이기" }))).toBe(true);
  });

  it("프로젝트를 고르면 그 프로젝트의 스냅숏이 나오고 추천(완료본)이 기본으로 골라진다 · 승인 안 된 스냅숏은 “승인 안 됨” 글", async () => {
    const { user, dlg } = await openAttach(createReferencesClient());
    await user.click(radioOf(dlg, /합성 지역통계/));
    const group = await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    expect(checked(radioOf(group, /1판 완료본/))).toBe(true);
    expect(checked(radioOf(group, /2판 R1 승인본/))).toBe(false);
    const unapproved = radioOf(group, /2판 진행 중/);
    expect(unapproved.closest("label")?.textContent ?? group.textContent).toContain("승인 안 됨");
    expect(radioOf(group, /1판 완료본/).closest("label")?.textContent ?? "").not.toContain("승인 안 됨");
  });

  it("범위 체크박스 “최종 보고서” · “조사 출처”는 기본 켜짐, 둘 다 끄면 붙이기가 aria-disabled(요청 없음)", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    const rep = within(dlg).getByRole("checkbox", { name: "최종 보고서" });
    const src = within(dlg).getByRole("checkbox", { name: "조사 출처" });
    expect((rep as HTMLInputElement).checked || rep.getAttribute("aria-checked") === "true").toBe(true);
    expect((src as HTMLInputElement).checked || src.getAttribute("aria-checked") === "true").toBe(true);
    await user.click(rep);
    await user.click(src);
    const go = within(dlg).getByRole("button", { name: "붙이기" });
    expect(isDisabled(go)).toBe(true);
    await user.click(go);
    expect(rc.attaches).toHaveLength(0);
  });

  it("붙이기 보낸 값: 고른 프로젝트 · 고정할 버전 id · 켜진 범위 — 다른 스냅숏을 골랐으면 그 id (승인 안 된 것도 고를 수 있다)", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    const group = await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    await user.click(radioOf(group, /2판 진행 중/));
    await user.click(within(dlg).getByRole("checkbox", { name: "조사 출처" }));
    await user.click(within(dlg).getByRole("button", { name: "붙이기" }));
    await waitFor(() => expect(rc.attaches).toHaveLength(1));
    expect(rc.attaches[0]).toMatchObject({ slug: "sample-study", edition: 1, input: { referenced_project_id: "pj-c", source_snapshot_id: "s-c3", scope: ["final_report"] } });
    expect(rc.attaches[0].key).toBeTruthy();
  });

  it("기본 선택 그대로 붙이면 추천 스냅숏 · 기본 범위(최종 보고서 + 조사 출처)를 보낸다", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    await user.click(within(dlg).getByRole("button", { name: "붙이기" }));
    await waitFor(() => expect(rc.attaches).toHaveLength(1));
    expect(rc.attaches[0].input).toMatchObject({ referenced_project_id: "pj-c", source_snapshot_id: "s-c1" });
    expect([...(rc.attaches[0].input.scope ?? [])].sort()).toEqual(["final_report", "sources"]);
  });

  it("F06: 영수증 전에는 “접수 확인 중”뿐 — 성공 말 · 새 행 없음, 단추 aria-disabled 로 두 번 눌러도 한 번 · 영수증 뒤 새 행 · 대화 상자 닫힘 · 접수 번호", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    const before = table().querySelectorAll("[data-reference]").length;
    const release = rc.hold();
    const go = within(dlg).getByRole("button", { name: "붙이기" });
    await user.click(go);
    await user.click(go);
    await waitFor(() => expect(rc.attaches).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(statusText()).not.toMatch(/접수\s*\d|접수됨/);
    expect(table().querySelectorAll("[data-reference]").length).toBe(before);
    expect(go.getAttribute("aria-disabled")).toBe("true");
    release();
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    await waitFor(() => expect(table().textContent).toContain("합성 지역통계"));
    expect(table().querySelectorAll("[data-reference]").length).toBe(before + 1);
    expect(screen.queryByRole("dialog", { name: "참고 프로젝트 붙이기" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(rc.reads.length).toBeGreaterThanOrEqual(2); // 영수증 뒤 다시 읽음 (낙관적 갱신 없음)
  });

  it("거절(PesApiError): role=alert 에 서버 메시지 · 대화 상자와 고른 값 그대로 · 행 그대로 · 성공 말 없음", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    const group = await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    await user.click(radioOf(group, /2판 R1 승인본/));
    const before = table().querySelectorAll("[data-reference]").length;
    rc.failNext(rejection("원본 프로젝트에 접근할 수 없습니다(합성)", "forbidden"));
    await user.click(within(dlg).getByRole("button", { name: "붙이기" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("원본 프로젝트에 접근할 수 없습니다(합성)");
    expect(screen.getByRole("dialog", { name: "참고 프로젝트 붙이기" })).toBeTruthy();
    expect(checked(radioOf(dlg, /2판 R1 승인본/))).toBe(true);
    expect(table().querySelectorAll("[data-reference]").length).toBe(before);
    expect(statusText()).not.toMatch(/접수\s*\d/);
  });

  it("이미 붙인 프로젝트라는 409 conflict 도 서버 메시지 그대로 안내한다 (성공 말 없음)", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    rc.failNext(rejection("이미 붙인 프로젝트입니다(합성).", "conflict"));
    await user.click(within(dlg).getByRole("button", { name: "붙이기" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("이미 붙인 프로젝트입니다(합성).");
    expect(statusText()).not.toMatch(/접수\s*\d|접수됨/);
  });

  it("시간 초과(TimeoutError)는 실패가 아니라 “접수 확인 중” 유지 — 다시 누르면 같은 멱등 키", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    rc.loseReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "붙이기" }));
    await waitFor(() => expect(rc.attaches).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(within(screen.getByRole("dialog", { name: "참고 프로젝트 붙이기" })).getByRole("button", { name: "붙이기" }));
    await waitFor(() => expect(rc.attaches).toHaveLength(2));
    expect(rc.attaches[1].key).toBe(rc.attaches[0].key);
  });

  it("후보를 못 읽으면 대화 상자 안 role=alert · 붙이기 aria-disabled · attach 호출 0 (후보를 지어내지 않는다)", async () => {
    const rc = createReferencesClient();
    rc.breakCandidates(new NotConnectedError("참고 프로젝트 후보 읽기"));
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(screen.getByRole("button", { name: "참고 프로젝트 붙이기" }));
    const dlg = await dialogOf("참고 프로젝트 붙이기");
    const alert = await within(dlg).findByRole("alert");
    expect(alert.textContent).toMatch(/아직 서버에 이어지지 않았어요|연결/);
    expect(within(dlg).queryByRole("radio")).toBeNull();
    expect(isDisabled(within(dlg).getByRole("button", { name: "붙이기" }))).toBe(true);
    await user.click(within(dlg).getByRole("button", { name: "붙이기" }));
    expect(rc.attaches).toHaveLength(0);
  });

  it("취소하면 아무것도 보내지 않고 닫힌다", async () => {
    const rc = createReferencesClient();
    const { user, dlg } = await openAttach(rc);
    await user.click(radioOf(dlg, /합성 지역통계/));
    await user.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "참고 프로젝트 붙이기" })).toBeNull());
    expect(rc.attaches).toHaveLength(0);
  });
});

describe("떼기", () => {
  const open = async (rc = createReferencesClient(), id = "ref-2", label = "합성 물가") => {
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf(id)).getByRole("button", { name: `떼기: ${label}` }));
    const dlg = await dialogOf("참고 프로젝트 떼기");
    return { rc, user, dlg };
  };

  it("확인 대화 상자: 원본은 그대로이고 이미 쓴 인용은 옛 버전 그대로임을 말한다 · 취소 · 떼기 · 열기만으로 호출 0", async () => {
    const { rc, dlg } = await open();
    expect(dlg.textContent).toContain("원본");
    expect(dlg.textContent).toContain("그대로");
    expect(dlg.textContent).toContain("인용");
    expect(within(dlg).getByRole("button", { name: "취소" })).toBeTruthy();
    expect(within(dlg).getByRole("button", { name: "떼기" })).toBeTruthy();
    expect(rc.detaches).toHaveLength(0);
  });

  it("F06: 영수증 전에는 행 그대로 + “접수 확인 중”, 두 번 눌러도 한 번 · 영수증 뒤 접수 번호 · 목록을 다시 읽어 그 행이 사라진다", async () => {
    const { rc, user, dlg } = await open();
    const release = rc.hold();
    const go = within(dlg).getByRole("button", { name: "떼기" });
    await user.click(go);
    await user.click(go);
    await waitFor(() => expect(rc.detaches).toHaveLength(1));
    expect(rc.detaches[0]).toMatchObject({ slug: "sample-study", edition: 1, ref_id: "ref-2" });
    expect(rc.detaches[0].key).toBeTruthy();
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(statusText()).not.toMatch(/접수\s*\d|접수됨/);
    expect(table().querySelector('[data-reference="ref-2"]')).not.toBeNull();
    release();
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    await waitFor(() => expect(table().querySelector('[data-reference="ref-2"]')).toBeNull());
    expect(table().querySelector('[data-reference="ref-1"]')).not.toBeNull(); // 다른 행은 그대로
    expect(screen.queryByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("거절(PesApiError)이면 role=alert 에 서버 메시지 · 대화 상자와 행 그대로", async () => {
    const { rc, user, dlg } = await open();
    rc.failNext(rejection("참고 프로젝트를 뗄 권한이 없습니다(합성)", "human_required"));
    await user.click(within(dlg).getByRole("button", { name: "떼기" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("참고 프로젝트를 뗄 권한이 없습니다(합성)");
    expect(screen.getByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeTruthy();
    expect(table().querySelector('[data-reference="ref-2"]')).not.toBeNull();
    expect(statusText()).not.toMatch(/접수\s*\d/);
  });

  it("시간 초과는 “접수 확인 중”(실패 아님) 유지, 다시 누르면 같은 멱등 키", async () => {
    const { rc, user, dlg } = await open();
    rc.loseReplyNext();
    await user.click(within(dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(rc.detaches).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(within(screen.getByRole("dialog", { name: "참고 프로젝트 떼기" })).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(rc.detaches).toHaveLength(2));
    expect(rc.detaches[1].key).toBe(rc.detaches[0].key);
  });

  it("원본 없음 행과 권한 없음 행도 뗄 수 있다", async () => {
    const a = await open(createReferencesClient(), "ref-3", "합성 폐기본");
    await a.user.click(within(a.dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(a.rc.detaches.map((d) => d.ref_id)).toEqual(["ref-3"]));
    cleanup();
    const b = await open(createReferencesClient(), "ref-4", "권한 없는 참고 프로젝트");
    await b.user.click(within(b.dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(b.rc.detaches.map((d) => d.ref_id)).toEqual(["ref-4"]));
  });

  it("취소하면 호출 0 이고 초점이 그 떼기 단추로 돌아온다", async () => {
    const { rc, user, dlg } = await open();
    await user.click(within(dlg).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeNull());
    expect(rc.detaches).toHaveLength(0);
    expect(document.activeElement).toBe(within(rowOf("ref-2")).getByRole("button", { name: "떼기: 합성 물가" }));
  });
});

describe("다른 버전으로 다시 고정", () => {
  const open = async (rc = createReferencesClient(), id = "ref-1", label = "합성 장기요양") => {
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf(id)).getByRole("button", { name: `다시 고정: ${label}` }));
    const dlg = await dialogOf("다른 버전으로 다시 고정");
    const group = await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    return { rc, user, dlg, group };
  };

  it("그 프로젝트의 스냅숏을 보이고 지금 고정된 것에 “지금 고정됨” · 새 버전 있음이면 가장 나중 스냅숏이 기본 선택 · 열기만으로 호출 0", async () => {
    const { rc, group } = await open();
    expect(rc.candidateCalls).toEqual([{ slug: "sample-study", edition: 1 }]);
    expect(rc.refreshes).toHaveLength(0);
    expect(radioOf(group, /1판 완료본/).closest("label")?.textContent ?? "").toContain("지금 고정됨");
    expect(radioOf(group, /2판 R1 승인본/).closest("label")?.textContent ?? "").not.toContain("지금 고정됨");
    expect(checked(radioOf(group, /2판 R1 승인본/))).toBe(true);
  });

  it("지금 고정된 버전을 고르면 다시 고정이 aria-disabled (서버는 409) — 새 버전이 없는 행은 처음부터 그렇다", async () => {
    const a = await open();
    await a.user.click(radioOf(a.group, /1판 완료본/));
    expect(isDisabled(within(a.dlg).getByRole("button", { name: "다시 고정" }))).toBe(true);
    await a.user.click(within(a.dlg).getByRole("button", { name: "다시 고정" }));
    expect(a.rc.refreshes).toHaveLength(0);
    cleanup();
    const b = await open(createReferencesClient(), "ref-2", "합성 물가");
    expect(checked(radioOf(b.group, /1판 완료본/))).toBe(true);
    expect(isDisabled(within(b.dlg).getByRole("button", { name: "다시 고정" }))).toBe(true);
  });

  it("보낸 값: 고른 스냅숏 id + 그 행의 rev (base_rev) — 승인 안 된 스냅숏도 고를 수 있다", async () => {
    const { rc, user, dlg, group } = await open();
    await user.click(radioOf(group, /2판 진행 중/));
    await user.click(within(dlg).getByRole("button", { name: "다시 고정" }));
    await waitFor(() => expect(rc.refreshes).toHaveLength(1));
    expect(rc.refreshes[0]).toMatchObject({ slug: "sample-study", edition: 1, ref_id: "ref-1", input: { source_snapshot_id: "s-a3", base_rev: "1" } });
    expect(rc.refreshes[0].key).toBeTruthy();
  });

  it("F06: 영수증 전에는 행의 버전 · 상태가 그대로 + “접수 확인 중”, 두 번 눌러도 한 번 · 영수증 뒤 새 버전 이름 · 고정됨 · 새 버전 고지 사라짐", async () => {
    const { rc, user, dlg } = await open();
    const release = rc.hold();
    const go = within(dlg).getByRole("button", { name: "다시 고정" });
    await user.click(go);
    await user.click(go);
    await waitFor(() => expect(rc.refreshes).toHaveLength(1));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    expect(statusText()).not.toMatch(/접수\s*\d|접수됨/);
    expect(cell("ref-1", "version").textContent).toContain("1판 완료본");
    expect(cell("ref-1", "state").textContent).toContain("새 버전 있음");
    release();
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
    await waitFor(() => expect(cell("ref-1", "version").textContent).toContain("2판 R1 승인본"));
    expect(cell("ref-1", "state").textContent).toContain("고정됨");
    expect(cell("ref-1", "state").textContent).not.toMatch(/새 버전 있음|저절로 바뀌지 않/);
    expect(screen.queryByRole("dialog", { name: "다른 버전으로 다시 고정" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("다른 곳에서 먼저 바뀌어 rev_conflict: role=alert 에 서버 메시지 · 대화 상자 그대로 · 성공 말 없음 · 목록을 다시 읽는다 — 다시 누르면 새 rev 로 보낸다", async () => {
    const { rc, user, dlg } = await open();
    rc.bumpOutside("ref-1");
    const readsBefore = rc.reads.length;
    await user.click(within(dlg).getByRole("button", { name: "다시 고정" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("그사이 다른 곳에서 바뀌었습니다");
    expect(screen.getByRole("dialog", { name: "다른 버전으로 다시 고정" })).toBeTruthy();
    expect(statusText()).not.toMatch(/접수\s*\d|접수됨/);
    await waitFor(() => expect(rc.reads.length).toBeGreaterThan(readsBefore));
    await user.click(within(screen.getByRole("dialog", { name: "다른 버전으로 다시 고정" })).getByRole("button", { name: "다시 고정" }));
    await waitFor(() => expect(rc.refreshes).toHaveLength(2));
    expect(rc.refreshes[0].input.base_rev).toBe("1");
    expect(rc.refreshes[1].input.base_rev).toBe("2");
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
  });

  it("그 밖의 409 conflict(이미 그 버전 · 원본 없음)도 서버 메시지 그대로 role=alert, 행 그대로", async () => {
    const { rc, user, dlg } = await open();
    rc.failNext(rejection("이미 그 버전으로 고정되어 있습니다(합성).", "conflict"));
    await user.click(within(dlg).getByRole("button", { name: "다시 고정" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("이미 그 버전으로 고정되어 있습니다(합성).");
    expect(cell("ref-1", "version").textContent).toContain("1판 완료본");
    expect(statusText()).not.toMatch(/접수\s*\d/);
  });

  it("후보를 못 읽으면 대화 상자 안 role=alert · 다시 고정 aria-disabled · 호출 0", async () => {
    const rc = createReferencesClient();
    rc.breakCandidates(new NotConnectedError("참고 프로젝트 후보 읽기"));
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf("ref-1")).getByRole("button", { name: "다시 고정: 합성 장기요양" }));
    const dlg = await dialogOf("다른 버전으로 다시 고정");
    await within(dlg).findByRole("alert");
    expect(isDisabled(within(dlg).getByRole("button", { name: "다시 고정" }))).toBe(true);
    expect(rc.refreshes).toHaveLength(0);
  });
});

describe("생성 화면(/new) — “참고 프로젝트” 칸은 담기만 한다", () => {
  const fresh = () => createReferencesClient(REFERENCES, CANDIDATES.map((c) => ({ ...c, attached: false })));

  it("main 안 region “참고 프로젝트”(제목 h2) · 후보 읽기는 getReferenceCandidates(null) 한 번 — 프로젝트가 아직 없어 목록 읽기 · 붙이기 호출은 0", async () => {
    const rc = fresh();
    await boot(rc, NEW);
    const region = await screen.findByRole("region", { name: "참고 프로젝트" });
    expect(main().contains(region)).toBe(true);
    expect(region.querySelector("h2")?.textContent).toContain("참고 프로젝트");
    await within(region).findByRole("radio", { name: /합성 지역통계/ });
    expect(rc.candidateCalls).toEqual([null]);
    expect(rc.reads).toHaveLength(0);
    expect(rc.attaches).toHaveLength(0);
  });

  it("고를 때 고정할 버전을 함께 정한다: 프로젝트를 고르면 추천 스냅숏이 기본 선택 · 승인 안 된 것은 “승인 안 됨”", async () => {
    const user = userEvent.setup();
    await boot(fresh(), NEW);
    const region = await screen.findByRole("region", { name: "참고 프로젝트" });
    await user.click(await within(region).findByRole("radio", { name: /합성 지역통계/ }));
    const group = await within(region).findByRole("radiogroup", { name: "고정할 버전" });
    expect(checked(radioOf(group, /1판 완료본/))).toBe(true);
    expect(radioOf(group, /2판 진행 중/).closest("label")?.textContent ?? group.textContent).toContain("승인 안 됨");
  });

  it("“담기”: 고른 프로젝트 + 버전이 담은 목록에 쌓이고 서버에는 아무것도 붙이지 않는다 · “아직 붙이지 않았습니다” 안내 · 빼기", async () => {
    const rc = fresh();
    const user = userEvent.setup();
    await boot(rc, NEW);
    const region = await screen.findByRole("region", { name: "참고 프로젝트" });
    await user.click(await within(region).findByRole("radio", { name: /합성 지역통계/ }));
    const group = await within(region).findByRole("radiogroup", { name: "고정할 버전" });
    await user.click(radioOf(group, /2판 R1 승인본/));
    await user.click(within(region).getByRole("button", { name: "담기" }));
    const list = await within(region).findByRole("list", { name: "담은 참고 프로젝트" });
    const item = list.querySelector<HTMLElement>("[data-staged]")!;
    expect(item.textContent).toContain("합성 지역통계");
    expect(item.textContent).toContain("2판 R1 승인본");
    expect(region.textContent).toMatch(/아직.*붙이지 않/);
    expect(rc.attaches).toHaveLength(0);
    expect(statusText()).not.toMatch(/접수\s*\d/);
    await user.click(within(item).getByRole("button", { name: "빼기: 합성 지역통계" }));
    await waitFor(() => expect(within(region).queryByRole("list", { name: "담은 참고 프로젝트" })?.querySelectorAll("[data-staged]").length ?? 0).toBe(0));
    expect(rc.attaches).toHaveLength(0);
  });

  it("같은 프로젝트를 두 번 담지 않는다 (담은 프로젝트는 후보에서 disabled)", async () => {
    const user = userEvent.setup();
    await boot(fresh(), NEW);
    const region = await screen.findByRole("region", { name: "참고 프로젝트" });
    await user.click(await within(region).findByRole("radio", { name: /합성 지역통계/ }));
    await within(region).findByRole("radiogroup", { name: "고정할 버전" });
    await user.click(within(region).getByRole("button", { name: "담기" }));
    await within(region).findByRole("list", { name: "담은 참고 프로젝트" });
    const again = radioOf(region, /합성 지역통계/);
    expect(isDisabled(again) || (again as HTMLInputElement).disabled).toBe(true);
  });

  it("프로젝트를 안 골랐으면 담기가 aria-disabled · 후보를 못 읽으면 칸 안 role=alert (다른 칸은 그려진다)", async () => {
    const rc = fresh();
    await boot(rc, NEW);
    const region = await screen.findByRole("region", { name: "참고 프로젝트" });
    await within(region).findByRole("radio", { name: /합성 지역통계/ });
    expect(isDisabled(within(region).getByRole("button", { name: "담기" }))).toBe(true);
    cleanup();
    const broken = fresh();
    broken.breakCandidates(new NotConnectedError("참고 프로젝트 후보 읽기"));
    await boot(broken, NEW);
    const region2 = await screen.findByRole("region", { name: "참고 프로젝트" });
    await within(region2).findByRole("alert");
    expect(broken.attaches).toHaveLength(0);
  });
});

describe("키보드 · 접근성", () => {
  it("Tab 으로 “참고 프로젝트 붙이기” 단추에 닿고 Enter 가 열고, Esc 가 닫고 초점이 그 단추로 돌아온다 (마우스 없이)", async () => {
    const user = userEvent.setup();
    await boot();
    await waitRows();
    const btn = screen.getByRole("button", { name: "참고 프로젝트 붙이기" });
    btn.focus();
    expect(document.activeElement).toBe(btn);
    await user.keyboard("{Enter}");
    await dialogOf("참고 프로젝트 붙이기");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "참고 프로젝트 붙이기" })).toBeNull());
    expect(document.activeElement).toBe(btn);
  });

  it("방향키가 후보 프로젝트와 버전 라디오를 옮기고 고른다", async () => {
    const user = userEvent.setup();
    const rc = createReferencesClient();
    await boot(rc);
    await waitRows();
    await user.click(screen.getByRole("button", { name: "참고 프로젝트 붙이기" }));
    const dlg = await dialogOf("참고 프로젝트 붙이기");
    const proj = await within(dlg).findByRole("radio", { name: /합성 지역통계/ });
    proj.focus();
    await user.keyboard(" ");
    const group = await within(dlg).findByRole("radiogroup", { name: "고정할 버전" });
    const first = radioOf(group, /1판 완료본/);
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(checked(radioOf(group, /2판 R1 승인본/))).toBe(true);
    expect(checked(radioOf(group, /1판 완료본/))).toBe(false);
  });

  it("대화 상자 안에 초점이 갇힌다: Tab 을 여러 번 눌러도 대화 상자 밖으로 나가지 않는다", async () => {
    const user = userEvent.setup();
    await boot();
    await waitRows();
    await user.click(screen.getByRole("button", { name: "참고 프로젝트 붙이기" }));
    const dlg = await dialogOf("참고 프로젝트 붙이기");
    await within(dlg).findByRole("radio", { name: /합성 지역통계/ });
    for (let i = 0; i < 14; i++) {
      await user.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
  });

  it("떼기 · 다시 고정 대화 상자도 Esc 로 닫고 초점이 연 단추로 돌아온다", async () => {
    const user = userEvent.setup();
    await boot();
    await waitRows();
    const detach = within(rowOf("ref-2")).getByRole("button", { name: "떼기: 합성 물가" });
    await user.click(detach);
    await dialogOf("참고 프로젝트 떼기");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "참고 프로젝트 떼기" })).toBeNull());
    expect(document.activeElement).toBe(detach);
    const refresh = within(rowOf("ref-1")).getByRole("button", { name: "다시 고정: 합성 장기요양" });
    await user.click(refresh);
    await dialogOf("다른 버전으로 다시 고정");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "다른 버전으로 다시 고정" })).toBeNull());
    expect(document.activeElement).toBe(refresh);
  });

  it("행마다 단추 이름에 참고 프로젝트 이름이 들어 있어 화면 읽기에서 구분된다 (같은 이름의 단추가 둘 이상 없다)", async () => {
    await boot();
    await waitRows();
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "").filter((n) => /^(떼기|다시 고정|내용 보기):/.test(n));
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(names.length);
  });

  it("상태 알림(role=status)은 polite 이고 경고(role=alert)와 섞이지 않는다", async () => {
    const rc = createReferencesClient();
    const user = userEvent.setup();
    await boot(rc);
    await waitRows();
    await user.click(within(rowOf("ref-2")).getByRole("button", { name: "떼기: 합성 물가" }));
    const dlg = await dialogOf("참고 프로젝트 떼기");
    const release = rc.hold();
    await user.click(within(dlg).getByRole("button", { name: "떼기" }));
    await waitFor(() => expect(statusText()).toContain("접수 확인 중"));
    for (const s of screen.getAllByRole("status")) expect(s.getAttribute("aria-live") ?? "polite").not.toBe("assertive");
    for (const a of screen.queryAllByRole("alert")) expect(a.textContent).not.toContain("접수 확인 중");
    release();
    await waitFor(() => expect(statusText()).toMatch(/접수\s*0?7\d\d/));
  });

  it("휴대폰(390, 굵은 포인터)에서도 붙이기 · 떼기 · 다시 고정 · 내용 보기가 있다", async () => {
    await renderApp(REFS, { width: 390, coarse: true }, { client: createReferencesClient().client });
    await ready();
    await waitRows();
    expect(screen.getByRole("button", { name: "참고 프로젝트 붙이기" })).toBeTruthy();
    expect(within(rowOf("ref-1")).getByRole("button", { name: /다시 고정/ })).toBeTruthy();
    expect(within(rowOf("ref-1")).getByRole("button", { name: /내용 보기/ })).toBeTruthy();
    expect(within(rowOf("ref-2")).getByRole("button", { name: /떼기/ })).toBeTruthy();
  });
});
