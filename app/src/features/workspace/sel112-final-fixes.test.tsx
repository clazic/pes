// SEL-112 최종 검토 1 필수 2 · 3 · 4 — 실제 화면(Vitest, jsdom). 계약: src/test/sel112.ts 머리말 · 서버 U4a(scripts/pes_core/commands/annotations.ts).
//  2: 다른 사람 · 에이전트가 남긴 답글이 사건(changes)으로 오면 열린 화면의 첨언 목록이 다시 읽힌다(실제 HTTP 사건 매핑을 지난다).
//  3: 위치 판정(anchor.current)이 지금 보는 글과 다른 버전 기준이면 글 위 표시 · 후보 고르기 · 저장을 막고 다시 읽기를 안내한다(인용 · 메시지는 그대로).
//  4: 시간 초과 뒤 대화 상자를 닫았다 다시 열어도 같은 요청은 같은 멱등 키 — 서버가 커밋하고 영수증만 잃었으면 재생된다(첨언 · 할 일 두 단계 모두).
// 합성 자료뿐(실제 자료·키·경로 없음).
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { createHttpClient } from "@/api/http-client";
import { FORMAT_VERSION, type PesClient } from "@/api/types";
import { renderApp } from "@/test/render-app";
import { ready } from "@/test/ui";
import {
  BODY,
  QUOTE_A,
  QUOTE_REPEAT,
  R2,
  VER1,
  VER2,
  alertText,
  blockWith,
  blocks,
  boot,
  clearSelection,
  cpAt,
  createU4Client,
  selectText,
  statusTexts,
  thread,
  threadOf,
  toolButton,
  toolbar,
} from "@/test/sel112";

afterEach(() => {
  clearSelection();
  vi.useRealTimers();
});

const timeout = () => Object.assign(new Error("시간 초과"), { name: "TimeoutError" });

/* ───────────── 필수 2 ───────────── */

describe("필수 2 — 외부 답글이 사건으로 오면 열린 화면이 첨언을 다시 읽는다", () => {
  it("thread.replied 사건(실제 HTTP 사건 매핑) 뒤 다른 행위자의 답글이 목록에 나타난다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u4 = createU4Client({ threads: [thread("th-1")] });
    // 사건 읽기만 실제 HTTP 클라이언트(가짜 fetch)로 — 서버는 thread.replied 하나를 준다
    let served = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://app.invalid");
      const head = url.searchParams.get("cursor") === "head";
      const events = head || served++ > 0 ? [] : [{ event_seq: "77", type: "thread.replied", object_id: "msg-ai-1", before_version_id: null, after_version_id: null, at: 1 }];
      return new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "r", data: { events, next_cursor: head ? "c-head" : `c-${served}`, has_more: false, epoch: "1" } }), { status: 200 });
    });
    const http = createHttpClient({ session: "synthetic", projects: { [WORKSPACE.slug]: "pj-synthetic" }, fetch: fetchImpl as unknown as typeof fetch });
    const client = { ...u4.client, getChanges: http.getChanges } as PesClient;
    await renderApp(R2, { width: 1440 }, { client });
    await ready();
    await threadOf("th-1");
    // 화면 밖에서(에이전트가) 답글을 남긴다
    u4.threads[0]!.messages.push({ message_id: "th-1-ai", body_md: "에이전트가 남긴 답글입니다.", at: "2026-11-12T15:00:00+09:00", actor_id: "act-ai1", by: null });
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(async () => expect((await threadOf("th-1")).textContent).toContain("에이전트가 남긴 답글입니다."));
  });
});

/* ───────────── 필수 3 ───────────── */

describe("필수 3 — 판정 버전 ≠ 지금 글 버전이면 위치를 쓰지 않는다", () => {
  const cands = () => [cpAt(BODY, QUOTE_REPEAT, 0), cpAt(BODY, QUOTE_REPEAT, 1)];

  it("ambiguous 후보가 다른 버전(v2) 기준이면 v1 글에서 후보를 고를 수 없고 저장 호출 0 · 다시 읽기 안내", async () => {
    const t = thread("th-amb", { status: "ambiguous", quote: QUOTE_REPEAT, candidates: cands() });
    t.anchor.current.evaluated_version_id = VER2;
    const { u4, user } = await boot({ threads: [t] });
    const el = await threadOf("th-amb");
    expect(within(el).queryAllByRole("radio")).toHaveLength(0);
    expect(el.textContent).toContain(QUOTE_REPEAT);
    expect(el.textContent).toMatch(/다른 글 버전/);
    const again = within(el).getByRole("button", { name: "다시 읽기" });
    const before = u4.reads.filter((r) => r.method === "getAnnotations").length;
    await user.click(again);
    await waitFor(() => expect(u4.reads.filter((r) => r.method === "getAnnotations").length).toBeGreaterThan(before));
    expect(u4.callsOf("reanchorAnnotation")).toHaveLength(0);
  });

  it("exact 판정이 다른 버전 기준이면 글 위 표시(mark)를 칠하지 않는다 — 목록 · 인용은 그대로", async () => {
    const t = thread("th-ex");
    t.anchor.current.evaluated_version_id = VER2;
    await boot({ threads: [t] });
    const el = await threadOf("th-ex");
    await blocks();
    expect(document.querySelector('mark[data-thread="th-ex"]')).toBeNull();
    expect(el.textContent).toContain(QUOTE_A);
  });

  it("같은 버전이면 후보를 고르고 붙일 때 그 판정 버전을 그대로 보낸다", async () => {
    const { u4, user } = await boot({ threads: [thread("th-amb", { status: "ambiguous", quote: QUOTE_REPEAT, candidates: cands() })] });
    const el = await threadOf("th-amb");
    await user.click(within(el).getAllByRole("radio")[1]!);
    await user.click(within(el).getByRole("button", { name: "이 후보로 붙이기" }));
    await waitFor(() => expect(u4.callsOf("reanchorAnnotation")).toHaveLength(1));
    expect(u4.callsOf("reanchorAnnotation")[0]!.input).toMatchObject({ version_id: VER1, ...cands()[1] });
  });
});

/* ───────────── 필수 4 ───────────── */

/** 서버는 커밋했는데 응답(영수증)이 늦어 화면은 시간 초과를 받는다 — 한 번만 */
function commitThenTimeout<K extends "createAnnotation" | "proposeFollowup">(client: PesClient, method: K) {
  const c = client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const orig = c[method]!;
  let once = true;
  c[method] = async (...a: unknown[]) => {
    const r = await orig(...a);
    if (once) {
      once = false;
      throw timeout();
    }
    return r;
  };
}

async function openTool(user: ReturnType<typeof userEvent.setup>, tool: "첨언" | "할 일로", title: string) {
  selectText(blockWith(QUOTE_A), QUOTE_A);
  await waitFor(() => expect(toolbar()).not.toBeNull());
  await user.click(toolButton(tool));
  return screen.findByRole("dialog", { name: title });
}

describe("필수 4 — 시간 초과 뒤 닫고 다시 열어도 같은 요청은 같은 멱등 키", () => {
  it("첨언: 커밋 뒤 응답 유실 → 취소 → 다시 열어 같은 구간 · 같은 글로 보내면 같은 키 · 첨언은 하나", async () => {
    const { u4, user } = await boot();
    await blocks();
    commitThenTimeout(u4.client, "createAnnotation");
    let dialog = await openTool(user, "첨언", "첨언 달기");
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "근거를 보여 주세요.");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨언 달기" })).toBeNull());

    dialog = await openTool(user, "첨언", "첨언 달기");
    const box = within(dialog).getByRole("textbox", { name: "첨언" }) as HTMLTextAreaElement;
    // 확인 중인 요청의 글이 되살아난다(사람이 다시 칠 필요 없음)
    expect(box.value).toBe("근거를 보여 주세요.");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨언 달기" })).toBeNull());
    const calls = u4.callsOf("createAnnotation");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[1]!.input).toEqual(calls[0]!.input);
    expect(u4.threads).toHaveLength(1);
  });

  it("할 일: 첨언은 만들어졌고 제안이 시간 초과 → 닫고 다시 열어 보내면 첨언을 또 만들지 않고 제안은 같은 키", async () => {
    const { u4, user } = await boot();
    await blocks();
    commitThenTimeout(u4.client, "proposeFollowup");
    let dialog = await openTool(user, "할 일로", "다음 라운드 할 일");
    await user.type(within(dialog).getByRole("textbox", { name: "할 일" }), "근거 자료를 더 찾기");
    await user.click(within(dialog).getByRole("button", { name: "할 일로 남기기" }));
    await waitFor(() => expect(u4.callsOf("proposeFollowup")).toHaveLength(1));
    await waitFor(() => expect(statusTexts()).toMatch(/접수 확인 중/));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "다음 라운드 할 일" })).toBeNull());

    dialog = await openTool(user, "할 일로", "다음 라운드 할 일");
    const box = within(dialog).getByRole("textbox", { name: "할 일" }) as HTMLTextAreaElement;
    expect(box.value).toBe("근거 자료를 더 찾기");
    await user.click(within(dialog).getByRole("button", { name: "할 일로 남기기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "다음 라운드 할 일" })).toBeNull());
    expect(u4.callsOf("createAnnotation")).toHaveLength(1);
    const proposes = u4.callsOf("proposeFollowup");
    expect(proposes).toHaveLength(2);
    expect(proposes[1]!.key).toBe(proposes[0]!.key);
    expect(u4.threads).toHaveLength(1);
    expect(u4.threads[0]!.followups).toHaveLength(1);
    expect(alertText()).toBe("");
  });

  it("영수증을 받은 뒤에는 다시 열어도 빈 칸이고 새 요청은 새 키", async () => {
    const { u4, user } = await boot();
    await blocks();
    let dialog = await openTool(user, "첨언", "첨언 달기");
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "첫 첨언");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "첨언 달기" })).toBeNull());
    dialog = await openTool(user, "첨언", "첨언 달기");
    expect((within(dialog).getByRole("textbox", { name: "첨언" }) as HTMLTextAreaElement).value).toBe("");
    await user.type(within(dialog).getByRole("textbox", { name: "첨언" }), "첫 첨언");
    await user.click(within(dialog).getByRole("button", { name: "첨언 달기" }));
    await waitFor(() => expect(u4.callsOf("createAnnotation")).toHaveLength(2));
    const [a, b] = u4.callsOf("createAnnotation");
    expect(b!.key).not.toBe(a!.key);
  });
});
