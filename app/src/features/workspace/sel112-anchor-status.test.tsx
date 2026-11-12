// SEL-112 U4b — 앵커 4상태(exact · moved · ambiguous · lost) 표시 · 후보 고르기 · 다시 붙이기 · 해결과 반영 구분 · 답글 (Vitest, jsdom). 계약: src/test/sel112.ts 머리말.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BODY,
  GRIN,
  QUOTE_A,
  QUOTE_REPEAT,
  VER1,
  alertText,
  annotationRegion,
  apiFail,
  article,
  blockWith,
  blocks,
  boot,
  clearSelection,
  cpAt,
  followup,
  selectText,
  statusTexts,
  thread,
  threadEl,
  threadOf,
  toolButton,
  toolbar,
} from "@/test/sel112";

afterEach(() => {
  cleanup();
  clearSelection();
});

const LABEL = { exact: /그대로/, moved: /위치 바뀜/, ambiguous: /후보 여럿/, lost: /원문 없음/ } as const;

describe("네 상태를 숨기지 않고 낱말로 보여 준다", () => {
  it("한 글에 exact · moved · ambiguous · lost 스레드가 모두 있으면 각각 상태 낱말이 보인다(색만이 아니다)", async () => {
    const moved = cpAt(BODY, "첫째는 현행 유지다.");
    await boot({
      threads: [
        thread("th-exact", { status: "exact" }),
        thread("th-moved", { status: "moved", quote: "첫째는 현행 유지다.", at: moved }),
        thread("th-amb", { status: "ambiguous", quote: QUOTE_REPEAT, candidates: [cpAt(BODY, QUOTE_REPEAT, 0), cpAt(BODY, QUOTE_REPEAT, 1)] }),
        thread("th-lost", { status: "lost", quote: "지워진 문장입니다." }),
      ],
    });
    await blocks();
    for (const [id, status] of [["th-exact", "exact"], ["th-moved", "moved"], ["th-amb", "ambiguous"], ["th-lost", "lost"]] as const) {
      const el = await threadOf(id);
      expect(el.getAttribute("data-anchor-status"), id).toBe(status);
      expect(el.textContent, id).toMatch(LABEL[status]);
      // 다른 상태 낱말은 섞이지 않는다
      for (const other of Object.keys(LABEL) as (keyof typeof LABEL)[]) if (other !== status) expect(el.textContent, `${id} ≠ ${other}`).not.toMatch(LABEL[other]);
    }
  });

  it("인용문은 어떤 상태에서도 늘 보인다(lost 포함)", async () => {
    await boot({ threads: [thread("th-lost", { status: "lost", quote: "지워진 문장입니다." }), thread("th-exact")] });
    expect((await threadOf("th-lost")).textContent).toContain("지워진 문장입니다.");
    expect((await threadOf("th-exact")).textContent).toContain(QUOTE_A);
  });

  it("첨언 목록은 이름 있는 region '첨언' 하나이고 스레드마다 제목(헤딩)이 있다", async () => {
    await boot({ threads: [thread("th-exact"), thread("th-lost", { status: "lost" })] });
    await threadOf("th-exact");
    const region = annotationRegion();
    expect(within(region).getAllByRole("heading").length).toBeGreaterThanOrEqual(2);
  });

  it("스레드가 없으면 '첨언 없음' 안내가 있고 오류처럼 보이지 않는다", async () => {
    await boot();
    await blocks();
    const region = annotationRegion();
    expect(region.textContent).toMatch(/첨언이 없|첨언 없음|아직 첨언/);
    expect(alertText()).toBe("");
  });
});

describe("글 안 표시는 현재 위치(code point)에 정확히 붙는다 — 추측하지 않는다", () => {
  async function markOf(id: string): Promise<HTMLElement> {
    return waitFor(() => {
      const m = document.querySelector<HTMLElement>(`mark[data-thread="${id}"]`);
      if (!m) throw new Error(`mark ${id} 가 아직 없다`);
      return m;
    });
  }
  /** mark 앞에 같은 블록에서 몇 UTF-16 글자가 있는가 */
  const offsetInBlock = (m: HTMLElement) => {
    const block = m.closest<HTMLElement>("[data-cp-start]")!;
    const r = document.createRange();
    r.selectNodeContents(block);
    r.setEndBefore(m);
    return r.toString().length;
  };

  it("한글 문단 · 이모지 뒤 · 표 칸 · 반복 인용의 두 번째 자리에 정확히 표시된다", async () => {
    const second = cpAt(BODY, QUOTE_REPEAT, 1);
    await boot({
      threads: [
        thread("th-ko", { status: "exact" }),
        thread("th-emoji", { status: "exact", quote: "가족 문장이다.", at: cpAt(BODY, "가족 문장이다.") }),
        thread("th-cell", { status: "exact", quote: `${GRIN}2`, at: cpAt(BODY, `${GRIN}2`) }),
        thread("th-rep", { status: "exact", quote: QUOTE_REPEAT, at: second }),
      ],
    });
    await blocks();
    expect((await markOf("th-ko")).textContent).toBe(QUOTE_A);
    expect((await markOf("th-emoji")).textContent).toBe("가족 문장이다.");
    expect((await markOf("th-cell")).textContent).toBe(`${GRIN}2`);
    expect((await markOf("th-cell")).closest("td, th")).not.toBeNull();
    const rep = await markOf("th-rep");
    expect(rep.textContent).toBe(QUOTE_REPEAT);
    const block = rep.closest<HTMLElement>("[data-cp-start]")!;
    expect(offsetInBlock(rep)).toBe((block.textContent ?? "").lastIndexOf(QUOTE_REPEAT)); // 첫 자리가 아니라 두 번째 자리
    expect(offsetInBlock(rep)).toBeGreaterThan(0);
  });

  it("moved 는 current 위치(옮겨진 자리)에 표시되고 원래 위치에는 표시하지 않는다", async () => {
    const now = cpAt(BODY, "첫째는 현행 유지다.");
    await boot({ threads: [thread("th-moved", { status: "moved", quote: "첫째는 현행 유지다.", at: now })] });
    const m = await markOf("th-moved");
    expect(m.textContent).toBe("첫째는 현행 유지다.");
    expect(document.querySelectorAll('mark[data-thread="th-moved"]')).toHaveLength(1);
  });

  it("ambiguous · lost 는 글에 표시하지 않는다(후보 하나를 골라 칠하지 않는다) — 목록에는 있다", async () => {
    await boot({
      threads: [
        thread("th-amb", { status: "ambiguous", quote: QUOTE_REPEAT, candidates: [cpAt(BODY, QUOTE_REPEAT, 0), cpAt(BODY, QUOTE_REPEAT, 1)] }),
        thread("th-lost", { status: "lost", quote: "지워진 문장입니다." }),
      ],
    });
    await threadOf("th-amb");
    await threadOf("th-lost");
    expect(article().querySelectorAll("mark[data-thread]")).toHaveLength(0);
  });

  it("표시(mark)는 장식이 아닌 정보 — 같은 스레드로 가는 접근 가능한 이름이 있다(스레드 번호 또는 첨언 표시)", async () => {
    await boot({ threads: [thread("th-ko", { status: "exact" })] });
    const m = await markOf("th-ko");
    const label = m.getAttribute("aria-label") ?? m.getAttribute("title") ?? m.querySelector(".sr-only")?.textContent ?? m.getAttribute("aria-describedby") ?? "";
    expect(label).toMatch(/첨언|th-ko/);
  });
});

describe("ambiguous — 후보를 사람이 고른다(자동 선택 없음)", () => {
  const cands = () => [cpAt(BODY, QUOTE_REPEAT, 0), cpAt(BODY, QUOTE_REPEAT, 1)];
  const init = () => ({ threads: [thread("th-amb", { status: "ambiguous", quote: QUOTE_REPEAT, candidates: cands() })] });

  it("후보 수만큼 radio 가 있고 아무것도 미리 고르지 않았으며, 화면을 불러온 것만으로 쓰기 0", async () => {
    const { u4 } = await boot(init());
    const el = await threadOf("th-amb");
    const group = within(el).getByRole("radiogroup", { name: "후보" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(2);
    for (const r of radios) expect((r as HTMLInputElement).checked || r.getAttribute("aria-checked") === "true").toBe(false);
    expect(u4.writes()).toHaveLength(0);
  });

  it("각 후보는 본문 앞뒤 글과 함께 보여 구분되고(서로 다른 이름), 후보 위치를 data 로 가진다", async () => {
    await boot(init());
    const el = await threadOf("th-amb");
    const radios = within(el).getAllByRole("radio");
    const names = radios.map((r) => r.getAttribute("aria-label") ?? el.querySelector(`label[for="${r.id}"]`)?.textContent ?? r.closest("label")?.textContent ?? "");
    expect(new Set(names).size).toBe(2);
    cands().forEach((c, i) => expect(radios[i]!.closest("[data-start-cp], [data-candidate]")?.getAttribute("data-start-cp") ?? radios[i]!.getAttribute("data-start-cp")).toBe(String(c.start_cp)));
  });

  it("고르기 전 '이 후보로 붙이기' 는 aria-disabled 이고 누르면 호출 0", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-amb");
    const attach = within(el).getByRole("button", { name: "이 후보로 붙이기" });
    expect(attach.getAttribute("aria-disabled")).toBe("true");
    await user.click(attach);
    expect(u4.writes()).toHaveLength(0);
  });

  it("두 번째 후보를 고르고 붙이면 그 후보 위치로 reanchorAnnotation(현재 글 버전) — 영수증 뒤에 상태가 바뀐다", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-amb");
    const radios = within(el).getAllByRole("radio");
    await user.click(radios[1]!);
    await user.click(within(el).getByRole("button", { name: "이 후보로 붙이기" }));
    await waitFor(() => expect(u4.callsOf("reanchorAnnotation")).toHaveLength(1));
    const call = u4.callsOf("reanchorAnnotation")[0]!;
    expect(call.id).toBe("th-amb");
    expect(call.input).toMatchObject({ ...cands()[1], version_id: VER1 });
    expect(call.key).toMatch(/\S/);
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    await waitFor(() => expect(threadEl("th-amb")!.getAttribute("data-anchor-status")).not.toBe("ambiguous"));
    const mark = document.querySelector<HTMLElement>('mark[data-thread="th-amb"]');
    expect(mark?.textContent).toBe(QUOTE_REPEAT);
  });

  it("붙이는 동안(영수증 전)에는 아직 ambiguous 로 남고 성공 말이 없다", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-amb");
    await user.click(within(el).getAllByRole("radio")[0]!);
    const release = u4.hold();
    await user.click(within(el).getByRole("button", { name: "이 후보로 붙이기" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(threadEl("th-amb")!.getAttribute("data-anchor-status")).toBe("ambiguous");
    expect(statusTexts()).not.toMatch(/접수 \d{4}/);
    expect(article().querySelectorAll("mark[data-thread]")).toHaveLength(0);
    release();
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
  });

  it("거절(예: 사람 아님 human_required): role=alert 에 서버 문장, 상태와 고른 후보 그대로", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-amb");
    await user.click(within(el).getAllByRole("radio")[1]!);
    u4.failNext(apiFail("human_required", "이 일은 사람 소유자만 할 수 있습니다."));
    await user.click(within(el).getByRole("button", { name: "이 후보로 붙이기" }));
    await waitFor(() => expect(alertText()).toMatch(/사람 소유자만/));
    expect(threadEl("th-amb")!.getAttribute("data-anchor-status")).toBe("ambiguous");
    expect(within(threadEl("th-amb")!).getAllByRole("radio")[1]!.getAttribute("aria-checked") === "true" || (within(threadEl("th-amb")!).getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
  });

  it("키보드: radiogroup 은 화살표로 옮기고 Space 로 고를 수 있다(접근성)", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-amb");
    const radios = within(el).getAllByRole("radio");
    radios[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(radios[1]);
    await user.keyboard(" ");
    expect(radios[1]!.getAttribute("aria-checked") === "true" || (radios[1] as HTMLInputElement).checked).toBe(true);
    expect(u4.writes()).toHaveLength(0); // 고르기만으로는 쓰지 않는다
  });
});

describe("lost — 지우지 않고, 사람이 새 구간을 골라 다시 붙인다", () => {
  const init = () => ({ threads: [thread("th-lost", { status: "lost", quote: "지워진 문장입니다.", body: "이 문장을 다시 살려 주세요." })] });

  it("인용 · 메시지가 그대로 있고 삭제 단추가 없다", async () => {
    await boot(init());
    const el = await threadOf("th-lost");
    expect(el.textContent).toContain("지워진 문장입니다.");
    expect(el.textContent).toContain("이 문장을 다시 살려 주세요.");
    expect(within(el).queryByRole("button", { name: /삭제|지우기|없애기/ })).toBeNull();
    expect(el.getAttribute("data-state")).toBe("open");
  });

  it("'다시 붙이기' → '새 구간을 고르세요' 안내 → 글에서 선택 → 도구는 '이 구간에 붙이기' 하나 → reanchorAnnotation(선택 위치, code point)", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-lost");
    await blocks();
    await user.click(within(el).getByRole("button", { name: "다시 붙이기" }));
    await waitFor(() => expect(statusTexts()).toMatch(/새 구간을 고르세요/));
    selectText(blockWith("가족 문장이다."), "가족 문장이다.");
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(within(toolbar()!).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["이 구간에 붙이기"]);
    await user.click(toolButton("이 구간에 붙이기"));
    await waitFor(() => expect(u4.callsOf("reanchorAnnotation")).toHaveLength(1));
    const call = u4.callsOf("reanchorAnnotation")[0]!;
    expect(call.id).toBe("th-lost");
    expect(call.input).toMatchObject({ ...cpAt(BODY, "가족 문장이다."), version_id: VER1 });
    expect(call.input.start_cp).not.toBe(BODY.indexOf("가족 문장이다.")); // UTF-16 가 아니라 code point
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
  });

  it("다시 붙이기를 시작만 하고 그만두면(Esc · 취소) 호출 0 · 상태 lost 그대로", async () => {
    const { u4, user } = await boot(init());
    const el = await threadOf("th-lost");
    await user.click(within(el).getByRole("button", { name: "다시 붙이기" }));
    await user.keyboard("{Escape}");
    expect(u4.writes()).toHaveLength(0);
    expect(threadEl("th-lost")!.getAttribute("data-anchor-status")).toBe("lost");
  });
});

describe("해결 ≠ 반영", () => {
  it("해결 메뉴는 네 갈래(글 수정 · 다음 라운드 할 일 · 앞 단계 다시 열기 · 그냥 닫기)", async () => {
    const { user } = await boot({ threads: [thread("th-1")] });
    const el = await threadOf("th-1");
    await user.click(within(el).getByRole("button", { name: /^해결/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual(["글 수정", "다음 라운드 할 일", "앞 단계 다시 열기", "그냥 닫기"]);
  });

  it("'그냥 닫기' → 대화 상자 '첨언 해결' → 이유 필수(빈 이유는 호출 0 · aria-invalid) → resolveAnnotation(none, 이유)", async () => {
    const { u4, user } = await boot({ threads: [thread("th-1")] });
    const el = await threadOf("th-1");
    await user.click(within(el).getByRole("button", { name: /^해결/ }));
    await user.click(await screen.findByRole("menuitem", { name: "그냥 닫기" }));
    const dialog = await screen.findByRole("dialog", { name: "첨언 해결" });
    await user.click(within(dialog).getByRole("button", { name: "해결 기록" }));
    expect(u4.callsOf("resolveAnnotation")).toHaveLength(0);
    expect(within(dialog).getByRole("textbox", { name: "해결 이유" }).getAttribute("aria-invalid")).toBe("true");
    await user.type(within(dialog).getByRole("textbox", { name: "해결 이유" }), "더 고칠 것이 없어 닫는다");
    await user.click(within(dialog).getByRole("button", { name: "해결 기록" }));
    await waitFor(() => expect(u4.callsOf("resolveAnnotation")).toHaveLength(1));
    expect(u4.callsOf("resolveAnnotation")[0]!.input).toMatchObject({ resolution: "none", reason: "더 고칠 것이 없어 닫는다" });
    expect(u4.callsOf("resolveAnnotation")[0]!.id).toBe("th-1");
  });

  it("해결만 한 스레드: '해결됨' 이라 쓰고 '반영됨' 이라 쓰지 않으며, 글 본문은 그대로, 후속 적용 호출 0", async () => {
    const { u4, user } = await boot({ threads: [thread("th-1")] });
    const el = await threadOf("th-1");
    const before = article().textContent;
    await user.click(within(el).getByRole("button", { name: /^해결/ }));
    await user.click(await screen.findByRole("menuitem", { name: "다음 라운드 할 일" }));
    const dialog = await screen.findByRole("dialog", { name: "첨언 해결" });
    await user.type(within(dialog).getByRole("textbox", { name: "해결 이유" }), "다음 라운드에서 다룬다");
    await user.click(within(dialog).getByRole("button", { name: "해결 기록" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    await waitFor(() => expect(threadEl("th-1")!.getAttribute("data-state")).toBe("resolved"));
    const t = threadEl("th-1")!;
    expect(t.textContent).toMatch(/해결됨/);
    expect(t.textContent).not.toMatch(/반영됨/);
    expect(document.body.textContent).not.toMatch(/반영됨/);
    expect(u4.callsOf("applyFollowup")).toHaveLength(0);
    expect(article().textContent).toBe(before);
  });

  it("해결 요청이 가는 동안(영수증 전)에는 아직 open 이고 '해결됨' 이라 쓰지 않는다", async () => {
    const { u4, user } = await boot({ threads: [thread("th-1")] });
    const el = await threadOf("th-1");
    await user.click(within(el).getByRole("button", { name: /^해결/ }));
    await user.click(await screen.findByRole("menuitem", { name: "그냥 닫기" }));
    const dialog = await screen.findByRole("dialog", { name: "첨언 해결" });
    await user.type(within(dialog).getByRole("textbox", { name: "해결 이유" }), "닫는다");
    const release = u4.hold();
    await user.click(within(dialog).getByRole("button", { name: "해결 기록" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(threadEl("th-1")!.getAttribute("data-state")).toBe("open");
    expect(threadEl("th-1")!.textContent).not.toMatch(/해결됨/);
    release();
    await waitFor(() => expect(threadEl("th-1")!.getAttribute("data-state")).toBe("resolved"));
  });

  it("해결됨 + 후속 제안 상태: '해결됨' 과 '반영 전' 이 함께 보이고 '적용' 은 없다", async () => {
    const f = followup("fu-1", "th-1", { kind: "next_round_task", proposed_body_md: null, proposed_version_id: null, base_version_id: null, description: "R3 에서 근거 자료 더 찾기" });
    await boot({ threads: [thread("th-1", { state: "resolved", resolution: { resolution: "next_round_task", reason: "다음 라운드에서", followup_id: "fu-1" }, followups: [f] })] });
    const t = await threadOf("th-1");
    expect(t.textContent).toMatch(/해결됨/);
    expect(t.textContent).toMatch(/반영 전|아직 반영/);
    expect(t.textContent).not.toMatch(/적용|반영됨/);
    expect(t.querySelector('[data-followup="fu-1"]')?.getAttribute("data-state")).toBe("proposed");
  });

  it("후속이 applied 면 '적용' 이라 쓰고 결과 버전 링크가 있다 — 해결 여부와 따로", async () => {
    const f = followup("fu-1", "th-1", { state: "applied", result_version_id: "ver-r2-2", applied_tx_id: "tx-9001", version_no: "2" });
    await boot({ threads: [thread("th-1", { state: "open", followups: [f] })] });
    const t = await threadOf("th-1");
    expect(t.getAttribute("data-state")).toBe("open"); // 적용은 스레드를 해결하지 않는다
    const fu = t.querySelector('[data-followup="fu-1"]') as HTMLElement;
    expect(fu.getAttribute("data-state")).toBe("applied");
    expect(fu.textContent).toMatch(/적용/);
    expect(t.textContent).not.toMatch(/해결됨/);
  });

  it("해결된 스레드: 답글은 aria-disabled + 이유('해결'), 해결 메뉴는 없다", async () => {
    await boot({ threads: [thread("th-1", { state: "resolved", resolution: { resolution: "none", reason: "닫음", followup_id: null } })] });
    const t = await threadOf("th-1");
    const reply = within(t).getByRole("button", { name: "답글" });
    expect(reply.getAttribute("aria-disabled")).toBe("true");
    const reasonId = reply.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toMatch(/해결/);
    expect(within(t).queryByRole("button", { name: /^해결$|^해결 / })).toBeNull();
  });

  it("그사이 다른 곳에서 해결돼 409 already_resolved 면 서버 문장을 보이고 스레드를 다시 읽는다(성공 말 없음)", async () => {
    const { u4, user } = await boot({ threads: [thread("th-1")] });
    const el = await threadOf("th-1");
    await user.click(within(el).getByRole("button", { name: /^해결/ }));
    await user.click(await screen.findByRole("menuitem", { name: "그냥 닫기" }));
    const dialog = await screen.findByRole("dialog", { name: "첨언 해결" });
    await user.type(within(dialog).getByRole("textbox", { name: "해결 이유" }), "닫는다");
    const reads = u4.reads.length;
    u4.failNext(apiFail("already_resolved", "이미 해결된 첨언입니다."));
    await user.click(within(dialog).getByRole("button", { name: "해결 기록" }));
    await waitFor(() => expect(alertText()).toMatch(/이미 해결된 첨언/));
    expect(statusTexts()).not.toMatch(/접수 \d{4}/);
    await waitFor(() => expect(u4.reads.length).toBeGreaterThan(reads));
  });
});

describe("답글", () => {
  it("답글을 보내면 영수증 뒤에 메시지가 늘고, 보내는 동안은 '접수 확인 중'", async () => {
    const { u4, user } = await boot({ threads: [thread("th-1")] });
    const el = await threadOf("th-1");
    await user.click(within(el).getByRole("button", { name: "답글" }));
    const box = await within(threadEl("th-1")!).findByRole("textbox", { name: "답글" });
    await user.type(box, "확인했습니다.");
    const release = u4.hold();
    await user.click(within(threadEl("th-1")!).getByRole("button", { name: "답글 보내기" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    expect(threadEl("th-1")!.textContent).not.toContain("확인했습니다.\n");
    expect(u4.threads[0]!.messages).toHaveLength(1);
    release();
    await waitFor(() => expect(statusTexts()).toMatch(/접수 \d{4}/));
    await waitFor(() => expect(threadEl("th-1")!.textContent).toContain("확인했습니다."));
    expect(u4.callsOf("replyAnnotation")[0]!.input).toEqual({ body_md: "확인했습니다." });
  });

  it("작성자 종류를 서버가 주지 않으면(by: null) '사람' 이나 'AI' 라고 쓰지 않는다", async () => {
    const t = thread("th-1");
    t.messages[0]!.by = null;
    await boot({ threads: [t] });
    const el = await threadOf("th-1");
    const msg = el.querySelector<HTMLElement>(`[data-message="th-1-m1"]`) ?? el;
    expect(msg.textContent).not.toMatch(/\bAI\b|사람이 쓴|AI가 쓴/);
  });

  it("OBJ 상수가 결과 글과 같은 객체를 가리킨다(다른 객체의 스레드는 보이지 않는다)", async () => {
    const other = thread("th-other");
    other.target_object_id = "obj-other";
    await boot({ threads: [thread("th-1"), other] });
    await threadOf("th-1");
    expect(threadEl("th-other")).toBeNull();
  });
});
