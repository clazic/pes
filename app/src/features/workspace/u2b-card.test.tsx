// SEL-91 U2b — 질문 카드 · 필터 · 이동(J/K) · 값 구분 · 이전된 합성 프로젝트 (Vitest, jsdom, 가짜 클라이언트).
// 계약: src/test/u2b.ts 머리말. 구현은 아직 없다 — 실패해야 정상(요구사항 때문에 실패).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { CURRENT } from "@/test/contract";
import { migratedSynthetic } from "@/test/u1d";
import { activeItemId, aside, badge, boot, chip, closedPanel, filterGroup, filterRadio, item, LEGACY_QUESTIONS, leaks, openOrder, OPEN_IDS, position } from "@/test/u2b";
import { query } from "@/test/render-app";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("질문 카드", () => {
  it("문장 · 유형 · 중요도 · 필수가 따로 칩으로 보인다 (중요도와 필수는 서로 다른 노드)", async () => {
    await boot();
    expect(openOrder()).toEqual(OPEN_IDS);
    expect(item("q-21").textContent).toContain("대출 수 자료의 정의가 2021년에 바뀌었어요");
    expect(chip("q-21", "required")?.textContent).toBe("필수");
    expect(chip("q-21", "importance")?.textContent).toMatch(/중요도 높음/);
    expect(chip("q-21", "required")).not.toBe(chip("q-21", "importance"));
    expect(chip("q-21", "kind")?.textContent).toBe("하나 고르기");
    expect(chip("q-23", "kind")?.textContent).toBe("여러 개 고르기");
    expect(chip("q-22", "kind")?.textContent).toBe("글로 답하기");
  });

  it("중요도와 필수는 독립이다: 높음이어도 필수가 없을 수 있고, 낮음이어도 필수일 수 있다", async () => {
    const { client } = await boot({
      questions: [
        { id: "q-21", number: 21, version: 1, required: false, importance: "high", source: "ai", text: "높음이지만 선택", kind: "free_text", options: [], status: "open", direction: "ask_human" },
        { id: "q-22", number: 22, version: 1, required: true, importance: "low", source: "ai", text: "낮음이지만 필수", kind: "free_text", options: [], status: "open", direction: "ask_human" },
      ],
    });
    expect(client).toBeTruthy();
    expect(chip("q-21", "importance")?.textContent).toMatch(/높음/);
    expect(chip("q-21", "required")).toBeNull();
    expect(chip("q-22", "importance")?.textContent).toMatch(/낮음/);
    expect(chip("q-22", "required")?.textContent).toBe("필수");
  });

  it("재확인 필요 배지와 옛 답 있음 배지: 새 버전 질문에만, 옛 답은 자동으로 채워지지 않는다", async () => {
    await boot();
    expect(badge("q-21", "recheck")?.textContent).toBe("재확인 필요");
    expect(badge("q-21", "old-answer")?.textContent).toBe("옛 답 있음");
    expect(badge("q-22", "recheck")).toBeNull();
    expect(badge("q-22", "old-answer")).toBeNull();
    // 옛 답은 새 답 칸으로 승계되지 않는다
    for (const radio of within(item("q-21")).getAllByRole("radio")) expect(radio).not.toBeChecked();
    for (const box of item("q-21").querySelectorAll("textarea,input[type=text]")) expect((box as HTMLInputElement).value).toBe("");
    expect(chip("q-21", "version")?.textContent).toBe("버전 2");
  });

  it("옛 답 보기를 누르면 옛 답이 읽기 전용 글로 펼쳐지고 어떤 입력 칸에도 들어가지 않는다", async () => {
    const { user } = await boot();
    const open = within(item("q-21")).getByRole("button", { name: /옛 답 보기/ });
    expect(open).toHaveAttribute("aria-expanded", "false");
    await user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    const old = item("q-21").querySelector('[data-field-kind="old-answer"]') as HTMLElement;
    expect(old.textContent).toContain("한 줄로 이어 주세요.");
    expect(old.querySelector("input,textarea")).toBeNull();
    for (const box of item("q-21").querySelectorAll("textarea,input")) expect((box as HTMLInputElement).value).not.toContain("한 줄로 이어 주세요.");
  });

  it("버전 기록: 최신이 먼저, 옛 버전 글이 읽힌다", async () => {
    const { user, calls } = await boot();
    await user.click(within(item("q-21")).getByRole("button", { name: "질문 21 버전 기록" }));
    await waitFor(() => expect(calls("getQuestionVersions").length).toBe(1));
    const list = await within(item("q-21")).findByRole("list", { name: /버전 기록/ });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].textContent).toMatch(/버전 2/);
  });

  it("show_if 가 있으면 어느 질문의 어떤 답일 때 보이는지 한 줄로 알린다", async () => {
    await boot();
    expect(item("q-23").textContent).toMatch(/질문 21.*이어 보기.*보임/);
    expect(item("q-22").textContent).not.toMatch(/고르면 보임/);
  });

  it("방향: 내가 AI에게 묻는 질문은 따로 표시된다", async () => {
    await boot();
    expect(chip("q-24", "direction")?.textContent).toBe("내가 AI에게");
    expect(chip("q-22", "direction")?.textContent).toBe("AI가 나에게");
  });
});

describe("답 · 의견 · 기본값 · 추천은 서로 다르게 보인다", () => {
  it("기본값과 추천은 표시만 되고 선택지·답 칸을 미리 채우지 않는다", async () => {
    await boot();
    const def = item("q-21").querySelector('[data-field-kind="default"]') as HTMLElement;
    const rec = item("q-21").querySelector('[data-field-kind="recommendation"]') as HTMLElement;
    expect(def.textContent).toMatch(/기본값/);
    expect(def.textContent).toMatch(/따로 보기/);
    expect(rec.textContent).toMatch(/AI 추천/);
    expect(rec.textContent).toMatch(/이어 보기/);
    expect(rec.textContent).toMatch(/추세를 한눈에/);
    expect(def).not.toBe(rec);
    expect(def.contains(rec) || rec.contains(def)).toBe(false);
    for (const radio of within(item("q-21")).getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("기본값을 고르는 건 사람이 고르는 일이다 — 고르기 전에는 '답 없음'으로 읽힌다", async () => {
    const { user } = await boot();
    const radio = within(item("q-21")).getByRole("radio", { name: /따로 보기/ });
    expect(radio).not.toBeChecked();
    await user.click(radio);
    expect(radio).toBeChecked();
    // 눌러도 기록(보낸 답)이 생기지 않는다 — 제출 전에는 답이 아니다
    expect(item("q-21").querySelector('[data-field-kind="answer"]')).toBeNull();
  });

  it("의견 칸은 답과 다른 노드이고, 보낸 답은 의견이 아닌 별도 표시다", async () => {
    await boot({
      questions: [
        { id: "q-22", number: 22, version: 1, required: false, importance: "normal", source: "ai", text: "보낸 답이 있는 질문", kind: "free_text", options: [], status: "open", direction: "ask_human", sent: { answer: "공개 통계 표 먼저", receipt_no: "0777", tx_id: "tx-777", committed_at: "2026-11-10T10:00:00+09:00" } },
        { id: "q-21", number: 21, version: 1, required: false, importance: "normal", source: "ai", text: "답 전 질문", kind: "free_text", options: [], status: "open", direction: "ask_human" },
      ],
    });
    const ans = item("q-22").querySelector('[data-field-kind="answer"]') as HTMLElement;
    expect(ans.textContent).toMatch(/공개 통계 표 먼저/);
    expect(ans.textContent).toMatch(/0777/);
    const op = item("q-21").querySelector('[data-field-kind="opinion"]') as HTMLElement;
    expect(op.querySelector("textarea")?.id).toBe("q-21-opinion");
    expect(item("q-21").querySelector('[data-field-kind="answer"]')).toBeNull();
    expect(op.textContent).not.toMatch(/AI 추천|기본값/);
  });
});

describe("필터", () => {
  it("전체 · 높음 · 재확인 · 내가 AI에게 라디오와 개수", async () => {
    await boot();
    expect(within(filterGroup()).getAllByRole("radio")).toHaveLength(4);
    expect(filterRadio("전체")).toHaveAccessibleName("전체 4");
    expect(filterRadio("높음")).toHaveAccessibleName("높음 2");
    expect(filterRadio("재확인")).toHaveAccessibleName("재확인 1");
    expect(filterRadio("내가 AI에게")).toHaveAccessibleName("내가 AI에게 1");
    expect(filterRadio("전체")).toBeChecked();
  });

  it("높음: 중요도 높음인 열린 질문만 남는다. 필수 여부와는 무관", async () => {
    const { user } = await boot();
    await user.click(filterRadio("높음"));
    expect(openOrder()).toEqual(["q-21", "q-24"]);
    expect(position()?.textContent).toBe("1/2");
  });

  it("재확인: 재확인 필요 질문만", async () => {
    const { user } = await boot();
    await user.click(filterRadio("재확인"));
    expect(openOrder()).toEqual(["q-21"]);
  });

  it("내가 AI에게: 방향이 사람→AI 인 질문만", async () => {
    const { user } = await boot();
    await user.click(filterRadio("내가 AI에게"));
    expect(openOrder()).toEqual(["q-24"]);
  });

  it("전체로 돌아오면 모두 돌아오고, 닫힌 질문은 어느 필터에서도 개수에 들지 않는다", async () => {
    const { user } = await boot();
    await user.click(filterRadio("높음"));
    await user.click(filterRadio("전체"));
    expect(openOrder()).toEqual(OPEN_IDS);
    expect(filterRadio("전체")).toHaveAccessibleName("전체 4");
  });

  it("필터가 비면 빈 상태 글이 읽힌다(빈 화면 아님)", async () => {
    const { user } = await boot({ questions: [{ id: "q-22", number: 22, version: 1, required: false, importance: "normal", source: "ai", text: "하나", kind: "free_text", options: [], status: "open", direction: "ask_human" }] });
    await user.click(filterRadio("재확인"));
    expect(openOrder()).toEqual([]);
    expect(aside().textContent).toMatch(/해당하는 질문이 없/);
    expect(position()?.textContent).toMatch(/^0\/0$/);
  });

  it("필터를 키보드로 고를 수 있다(방향키 · 초점이 라디오 그룹 안)", async () => {
    const { user } = await boot();
    filterRadio("전체").focus();
    await user.keyboard("{ArrowRight}");
    expect(filterRadio("높음")).toBeChecked();
    expect(openOrder()).toEqual(["q-21", "q-24"]);
  });
});

describe("이동: 3/12 ↑↓ · J/K", () => {
  it("처음 1/4, 다음 질문 단추로 2/4 — 초점이 그 질문 항목으로 가고 URL 의 focus 가 따라간다", async () => {
    const { user, router } = await boot();
    expect(position()?.textContent).toBe("1/4");
    await user.click(within(aside()).getByRole("button", { name: "다음 질문" }));
    expect(position()?.textContent).toBe("2/4");
    expect(activeItemId()).toBe("q-22");
    await waitFor(() => expect(query(router).get("focus")).toBe("q-22"));
    await user.click(within(aside()).getByRole("button", { name: "이전 질문" }));
    expect(position()?.textContent).toBe("1/4");
    expect(activeItemId()).toBe("q-21");
  });

  it("가장자리에서는 돌아 넘기지 않고 단추가 aria-disabled", async () => {
    const { user } = await boot();
    const prev = within(aside()).getByRole("button", { name: "이전 질문" });
    expect(prev).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("j");
    await user.keyboard("j");
    await user.keyboard("j");
    await user.keyboard("j");
    await user.keyboard("j");
    expect(position()?.textContent).toBe("4/4");
    expect(activeItemId()).toBe("q-24");
    expect(within(aside()).getByRole("button", { name: "다음 질문" })).toHaveAttribute("aria-disabled", "true");
  });

  it("J = 다음, K = 이전. 질문 밖(처음)에서 J 는 첫 질문으로", async () => {
    const { user } = await boot();
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("j");
    expect(activeItemId()).toBe("q-21");
    await user.keyboard("j");
    expect(activeItemId()).toBe("q-22");
    await user.keyboard("k");
    expect(activeItemId()).toBe("q-21");
  });

  it("글 입력 칸에서는 J/K 가 글자로 들어가고 이동하지 않는다", async () => {
    const { user } = await boot();
    const box = document.getElementById("q-22") as HTMLTextAreaElement;
    await user.click(box);
    await user.keyboard("jkjk");
    expect(box.value).toBe("jkjk");
    expect(document.activeElement).toBe(box);
    const op = document.getElementById("q-22-opinion") as HTMLTextAreaElement;
    await user.click(op);
    await user.keyboard("kj");
    expect(op.value).toBe("kj");
    expect(document.activeElement).toBe(op);
  });

  it("IME 조합 중에는 J/K 를 무시한다 (isComposing · keyCode 229)", async () => {
    await boot();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", isComposing: true });
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", keyCode: 229 });
    expect(activeItemId()).toBeNull();
    expect(position()?.textContent).toBe("1/4");
    // 대조: 조합이 아닌 J 는 움직인다
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    expect(activeItemId()).toBe("q-21");
  });

  it("Ctrl/Alt/Meta 와 함께 누르면 무시한다", async () => {
    await boot();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", metaKey: true });
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ", altKey: true });
    expect(activeItemId()).toBeNull();
    // 대조: 보통 J 는 움직인다(위 무시가 '아무것도 안 함'이 아님을 확인)
    fireEvent.keyDown(document.body, { key: "j", code: "KeyJ" });
    expect(activeItemId()).toBe("q-21");
  });

  it("필터가 걸려 있으면 보이는 질문만 오간다 (n/m 의 m 도 보이는 수)", async () => {
    const { user } = await boot();
    await user.click(filterRadio("높음"));
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard("j");
    expect(activeItemId()).toBe("q-21");
    await user.keyboard("j");
    expect(activeItemId()).toBe("q-24");
    expect(position()?.textContent).toBe("2/2");
  });

  it("닫힌 질문(철회·보류·합쳐짐)은 이동에서 건너뛴다", async () => {
    const { user } = await boot();
    for (let i = 0; i < 8; i++) await user.keyboard("j");
    expect(activeItemId()).toBe("q-24");
  });

  it("단추 이름에 화살표 글자만 있지 않다: 읽는 이름이 있고 J/K 단축키를 알린다", async () => {
    await boot();
    const next = within(aside()).getByRole("button", { name: "다음 질문" });
    const prev = within(aside()).getByRole("button", { name: "이전 질문" });
    expect(next.getAttribute("aria-keyshortcuts")).toMatch(/\bJ\b/i);
    expect(prev.getAttribute("aria-keyshortcuts")).toMatch(/\bK\b/i);
  });
});

describe("닫힌 질문은 지워지지 않고 표시된다", () => {
  it("철회됨 · 보류됨 · 합쳐짐이 서로 다른 말로 보이고 답 칸이 없다", async () => {
    await boot();
    const closed = closedPanel();
    const row = (id: string) => closed.querySelector<HTMLElement>(`[data-question="${id}"]`) as HTMLElement;
    expect(row("q-26").dataset.status).toBe("withdrawn");
    expect(row("q-26").textContent).toMatch(/철회됨/);
    expect(row("q-27").dataset.status).toBe("deferred");
    expect(row("q-27").textContent).toMatch(/보류됨/);
    expect(row("q-28").dataset.status).toBe("merged");
    expect(row("q-28").textContent).toMatch(/질문 22.*합쳐짐|합쳐짐.*질문 22/);
    for (const id of ["q-26", "q-27", "q-28"]) {
      expect(row(id).querySelector("textarea,input,[role=radio]")).toBeNull();
      expect(row(id).textContent).not.toMatch(/삭제됨/);
    }
  });
});

describe("이전된 합성 프로젝트(중요도 없음 · legacy_unverified)는 깨지지 않는다", () => {
  it("칸이 없는 옛 질문도 그려지고 undefined/null 이 새지 않는다", async () => {
    await boot({ questions: LEGACY_QUESTIONS, workspace: migratedSynthetic() });
    expect(openOrder()).toEqual(["q-21", "q-22"]);
    expect(chip("q-21", "importance")?.textContent).toBe("중요도 미정");
    expect(chip("q-21", "required")?.textContent).toBe("필수");
    expect(chip("q-22", "kind")?.textContent).toBe("글로 답하기");
    expect(chip("q-22", "direction")?.textContent).toBe("AI가 나에게");
    expect(leaks(aside())).toEqual([]);
    expect(badge("q-21", "recheck")).toBeNull();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("필터 개수는 0 이고 이동·답 입력이 그대로 된다", async () => {
    const { user } = await boot({ questions: LEGACY_QUESTIONS, workspace: migratedSynthetic() });
    expect(filterRadio("높음")).toHaveAccessibleName("높음 0");
    expect(filterRadio("재확인")).toHaveAccessibleName("재확인 0");
    expect(filterRadio("전체")).toHaveAccessibleName("전체 2");
    await user.click(document.getElementById("q-21") as HTMLElement);
    await user.type(document.getElementById("q-21") as HTMLElement, "답");
    expect((document.getElementById("q-21") as HTMLTextAreaElement).value).toBe("답");
  });

  it("고치기 form 이 열리고 중요도는 '미정'으로 시작한다 (중요도를 지어내지 않는다)", async () => {
    const { user } = await boot({ questions: LEGACY_QUESTIONS, workspace: migratedSynthetic() });
    await user.click(within(item("q-21")).getByRole("button", { name: "질문 21 고치기" }));
    const form = within(aside()).getByRole("form", { name: "질문 21 고치기" });
    expect(within(form).getByLabelText("중요도")).toHaveDisplayValue("미정");
    expect(within(form).getByLabelText("방향")).toHaveDisplayValue(/AI가 사람에게 묻기/);
  });
});

describe("지난 라운드", () => {
  it("읽기 전용: 고치기·옮기기·정리 도구가 켜져 있지 않다", async () => {
    await boot({}, "/p/sample-study/e/1/s/plan/r/1");
    const tools = screen.queryAllByRole("button", { name: /^질문 \d+ (고치기|위로 옮기기|아래로 옮기기|정리)$/ });
    for (const b of tools) expect(b).toHaveAttribute("aria-disabled", "true");
    const add = screen.queryByRole("button", { name: "질문 더하기" });
    if (add) expect(add).toHaveAttribute("aria-disabled", "true");
  });
});

describe("화면 글자", () => {
  it("낱말 'Go' 가 없다", async () => {
    await boot();
    expect(document.body.textContent ?? "").not.toMatch(/\bGo\b/);
    expect(CURRENT).toBeTruthy();
  });
});
