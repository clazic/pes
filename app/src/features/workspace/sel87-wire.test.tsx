// SEL-87 — 서버가 채우는 작업 공간 칸(AI 연결 정책 · 전송 8값 · run 상태 · 과거 승인)을 앱이 DB 값 그대로 읽고 지어내지 않는다 (Vitest, jsdom).
// 구현 전에는 사전 · 타입 · 화면이 새 값을 몰라 실패하는 것이 정상. 서버 쪽 정한 모양은 tests/test_sel87_workspace_ai.test.ts 머리말.
//
// 해석 (leader 결정 + 서버 시험 머리말):
//   - AiDispatchView.state 는 DB 8값(prepared authorized sent response adopted blocked failed unknown). 사전 STATUS.dispatch 가 8값 모두 사람 말을 가진다
//     (모르는 값만 '미상'). 취소 시도는 state 가 아니라 별도 칸 `cancel_state`(= "requested" 이면 취소 시도 · "cancelled" 이면 취소됨) — 서버는 근거가 생길 때만 보낸다.
//     기존 시험(u1d-ai-chip)이 쓰는 state:"cancel_requested" · "cancelled" 사전 항목은 그대로 둔다(기존 시험을 깨지 않는다).
//   - dispatch.resolution("charged" | "not_charged")는 있으면 '정리됨' 말이 붙고, state 는 그대로 unknown 으로 보인다. 없으면 말이 없다.
//   - RunStatus 는 DB 8값 + handed_off. blocked_usage 는 사전에 사람 말이 있다('사용량 멈춤' 뜻 — 정확한 낱말은 /사용량/ 을 포함). run.stage 는 null 일 수 있다
//     (화면이 'null' · 'undefined' 를 글로 내지 않고 행은 그대로 그린다).
//   - 서버가 안 보낸 칸(run_permissions · external_stop · cancel_state · ai_connection)을 HTTP 클라이언트가 채우지 않는다: getWorkspace 는 서버 data 를 그대로 돌려준다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE } from "@/api/fixture";
import { createHttpClient } from "@/api/http-client";
import { FORMAT_VERSION, type AiDispatchView, type RunView, type WorkspaceView } from "@/api/types";
import { STATUS, lookup } from "@/components/pes/status-registry";
import { chipButton, fakeBoot, httpBoot, runPanel, statePanel, unstubServer, withAi } from "@/test/u1d";

afterEach(() => {
  unstubServer();
  cleanup();
});

const DB_DISPATCH = ["prepared", "authorized", "sent", "response", "adopted", "blocked", "failed", "unknown"] as const;
const DB_RUN = ["queued", "running", "waiting_human", "blocked_usage", "succeeded", "failed", "cancelled", "interrupted"] as const;

// 타입 수준: 아래 값이 types.ts 에 들어가야 typecheck 가 통과한다
const typed_dispatches = DB_DISPATCH.map((state, i): AiDispatchView => ({ id: `d${i}`, run_id: "r1", state }));
const typed_run_without_stage: RunView = { id: "run-x", stage: null, mode: "A", status: "blocked_usage" };
const typed_resolved: AiDispatchView = { id: "dr", run_id: "r1", state: "unknown", resolution: "charged" };
const typed_cancel: AiDispatchView = { id: "dc", run_id: "r1", state: "sent", cancel_state: "requested" };

describe("사전: DB 값마다 사람 말", () => {
  it("전송 8값 모두 사람 말이 있고(미상 아님) 서로 다른 글이다", () => {
    const labels = DB_DISPATCH.map((v) => lookup("dispatch", v).label);
    for (const [i, l] of labels.entries()) expect(l, DB_DISPATCH[i]).not.toMatch(/^미상/);
    expect(new Set(labels).size, "'sent' 와 'unknown' 같은 서로 다른 사실이 같은 말로 뭉개지지 않는다").toBeGreaterThanOrEqual(7);
    expect(lookup("dispatch", "unknown").label).toMatch(/알 수 없음|unknown/i);
    expect(lookup("dispatch", "blocked").label).not.toBe(lookup("dispatch", "failed").label);
  });

  it("실행 8값 + handed_off 모두 사람 말이 있고 blocked_usage 는 사용량 멈춤을 뜻하는 말이다", () => {
    for (const v of [...DB_RUN, "handed_off"]) expect(lookup("run", v).label, v).not.toMatch(/^미상/);
    expect(lookup("run", "blocked_usage").label).toMatch(/사용량/);
    expect(lookup("run", "blocked_usage").label).not.toBe(lookup("run", "interrupted").label);
    expect(Object.keys(STATUS.run)).toEqual(expect.arrayContaining([...DB_RUN, "handed_off"]));
  });

  it("DB 의 값 목록(마이그레이션 SQL)과 사전이 어긋나지 않는다", () => {
    const dir = resolve(process.cwd(), "..", "scripts", "pes_core", "migrations"); // vitest 는 app/ 에서 돈다
    const initial = readFileSync(resolve(dir, "001_initial.sql"), "utf8");
    const ai = readFileSync(resolve(dir, "002_ai_connections.sql"), "utf8");
    const dispatch = [...(/CREATE TABLE outbound_dispatches[\s\S]*?state TEXT NOT NULL CHECK \(state IN\s*\(([^)]*)\)/.exec(initial)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const runs = [...(/CREATE TABLE runs_new[\s\S]*?status TEXT NOT NULL CHECK \(status IN\s*\(([^)]*)\)/.exec(ai)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(dispatch.length).toBe(8);
    expect(runs.length).toBe(8);
    for (const v of dispatch) expect(Object.keys(STATUS.dispatch), `dispatch ${v}`).toContain(v);
    for (const v of runs) expect(Object.keys(STATUS.run), `run ${v}`).toContain(v);
  });

  it("타입 값이 만들어진다(typecheck 가 본 시험)", () => {
    expect(typed_dispatches).toHaveLength(8);
    expect(typed_run_without_stage.stage).toBeNull();
    expect(typed_resolved.resolution).toBe("charged");
    expect(typed_cancel.cancel_state).toBe("requested");
  });
});

describe("화면: 서버 DB 값을 그대로 보여 준다", () => {
  it("전송 8값이 각자 data-state 와 서로 다른 글로 그려진다 (cancel_state 없이는 '취소 시도'가 나오지 않는다)", async () => {
    const dispatches = DB_DISPATCH.map((state) => ({ id: `d-${state}`, run_id: "run-1", state }));
    const { open } = fakeBoot(withAi({ policy: "denied", dispatches }));
    const { user } = await open();
    await user.click(chipButton());
    const panel = statePanel()!;
    const seen = new Set<string>();
    for (const state of DB_DISPATCH) {
      const item = panel.querySelector<HTMLElement>(`[data-dispatch="d-${state}"]`)!;
      expect(item, state).not.toBeNull();
      expect(item.getAttribute("data-state")).toBe(state);
      expect(item.textContent, `${state}: 사전의 사람 말`).toContain((STATUS.dispatch as Record<string, { label: string }>)[state]?.label ?? "(사전에 없음)");
      expect(item.textContent).not.toMatch(/취소 시도/);
      seen.add((STATUS.dispatch as Record<string, { label: string }>)[state]?.label ?? state);
    }
    expect(seen.size, "서로 다른 사실이 같은 말로 뭉개지지 않는다").toBeGreaterThanOrEqual(7);
  });

  it("cancel_state 가 requested 인 전송만 '취소 시도'로 보이고 state(sent)는 그대로 남는다", async () => {
    const dispatches = [
      { id: "d-sent", run_id: "r", state: "sent" },
      { id: "d-try", run_id: "r", state: "sent", cancel_state: "requested" },
    ];
    const { open } = fakeBoot(withAi({ policy: "denied", dispatches }));
    const { user } = await open();
    await user.click(chipButton());
    const panel = statePanel()!;
    expect(panel.querySelector('[data-dispatch="d-sent"]')!.textContent).not.toMatch(/취소 시도/);
    const tried = panel.querySelector<HTMLElement>('[data-dispatch="d-try"]')!;
    expect(tried.textContent).toMatch(/취소 시도/);
    expect(tried.getAttribute("data-state")).toBe("sent");
  });

  it("resolution 이 있는 unknown 은 정리 결과 말이 붙어도 state 는 unknown, 정리 안 된 unknown 에는 그 말이 없다", async () => {
    const dispatches = [
      { id: "d-ch", run_id: "r", state: "unknown", resolution: "charged" },
      { id: "d-nc", run_id: "r", state: "unknown", resolution: "not_charged" },
      { id: "d-open", run_id: "r", state: "unknown" },
    ];
    const { open } = fakeBoot(withAi({ policy: "denied", dispatches }));
    const { user } = await open();
    await user.click(chipButton());
    const panel = statePanel()!;
    const item = (id: string) => panel.querySelector<HTMLElement>(`[data-dispatch="${id}"]`)!;
    expect(item("d-ch").getAttribute("data-state")).toBe("unknown");
    expect(item("d-ch").textContent).toMatch(/청구/);
    expect(item("d-nc").textContent).toMatch(/청구/);
    expect(item("d-ch").textContent).not.toBe(item("d-nc").textContent);
    expect(item("d-open").textContent).not.toMatch(/청구/);
  });

  it("run: blocked_usage 는 자기 말로 보이고(중단됨 · 실패와 다름), stage 가 null 인 run 도 행이 그려지며 'null' 글자가 없다", async () => {
    const runs = [
      { id: "run-bu", stage: "research", mode: "A", status: "blocked_usage" },
      { id: "run-ns", stage: null, mode: "B", status: "failed" },
    ];
    const { open } = fakeBoot(withAi({ policy: "allowed" }, { runs }));
    await open();
    const panel = runPanel();
    const bu = panel.querySelector<HTMLElement>('[data-run="run-bu"]')!;
    expect(bu.getAttribute("data-status")).toBe("blocked_usage");
    expect(bu.textContent).toMatch(/사용량/);
    expect(bu.textContent).not.toMatch(/중단됨|실패/);
    const ns = panel.querySelector<HTMLElement>('[data-run="run-ns"]')!;
    expect(ns).not.toBeNull();
    expect(ns.textContent).toMatch(/실패/);
    expect(ns.textContent).not.toMatch(/null|undefined/);
  });
});

describe("HTTP 클라이언트: 서버가 준 값을 그대로, 안 준 칸은 만들지 않는다", () => {
  const server: Record<string, unknown> = {
    ...({ slug: "sample-study", title: "합성", edition: 1, mode: "A", current: { stage: "research", round_id: null }, stages: [], turn: { side: "you" } } as object),
    ai_connection: { policy: "corrupt", dispatches: [{ id: "d1", run_id: "r1", state: "adopted" }, { id: "d2", run_id: "r1", state: "unknown", resolution: "not_charged" }] },
    runs: [{ id: "r1", stage: null, mode: "A", status: "blocked_usage" }],
    actions: [{ action: "submissions.create", enabled: true, disabled_reason: null }],
  };

  async function read(data: unknown): Promise<WorkspaceView | null> {
    const fetchImpl = (async () => new Response(JSON.stringify({ format_version: FORMAT_VERSION, request_id: "r", data }), { status: 200 })) as unknown as typeof fetch;
    const client = createHttpClient({ session: "synthetic-session", projects: { "sample-study": "pj-1" }, fetch: fetchImpl });
    return client.getWorkspace("sample-study", 1);
  }

  it("서버의 ai_connection · runs 를 한 글자도 바꾸지 않고 돌려준다", async () => {
    const got = (await read(server)) as unknown as Record<string, unknown>;
    expect(got.ai_connection).toEqual(server.ai_connection);
    expect(got.runs).toEqual(server.runs);
  });

  it("서버가 run_permissions · external_stop · cancel_state · past_approval 을 안 보내면 클라이언트도 만들지 않는다", async () => {
    const got = (await read(server)) as unknown as Record<string, any>;
    expect(Object.hasOwn(got, "run_permissions")).toBe(false);
    expect(Object.hasOwn(got.runs[0], "external_stop")).toBe(false);
    expect(Object.hasOwn(got.ai_connection.dispatches[0], "cancel_state")).toBe(false);
    expect(JSON.stringify(got)).not.toMatch(/past_approval/);
  });

  it("서버가 ai_connection 을 안 보내면(옛 서버) 칸이 없는 채로 — 켜짐으로 채우지 않는다", async () => {
    const { ai_connection: _a, runs: _r, ...old } = server;
    const got = (await read(old)) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(got, "ai_connection")).toBe(false);
    expect(Object.hasOwn(got, "runs")).toBe(false);
  });

  it("화면: 서버 corrupt 는 '차단 중', run_permissions 없음은 '정보 없음'으로 그려지고 지어낸 외부 앱 질문이 없다", async () => {
    await httpBoot({ ...WORKSPACE, ai_connection: server.ai_connection, runs: server.runs } as unknown as WorkspaceView);
    expect(chipButton().getAttribute("data-state")).toBe("blocked");
    const panel = runPanel();
    expect(panel.querySelector("[data-permission]")).toBeNull();
    expect(panel.textContent).toMatch(/정보 없음/);
  });
});
