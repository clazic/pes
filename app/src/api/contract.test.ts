// SEL-81 U1a (R1 필수 4) — 가짜 클라이언트는 "API 계약 모양"의 합성 응답이어야 한다 (Vitest, node 환경 불필요 — jsdom 그대로).
// 기준: 승인 시안 docs/plan/mockups/dashboard-v2-react/src/api/types.ts + docs/plan/stage-1-api.md (봉투 format_version "1.0" · 오류 봉투 · 쓰기 멱등 키 · 영수증).
//  - 읽기 DTO 는 시안처럼 봉투 없는 값. 시각은 ISO 8601. 화면 글자(한국어 시각 · '높음' 같은 말 · 접수 글)는 DTO 가 아니라 화면이 만든다.
//  - 쓰기(오류 확인)는 `acknowledgeAlert(slug, edition, alertId, idempotencyKey)` → CommandResult{format_version, request_id, receipt{receipt_no, tx_id, committed_at, idempotency_key, replayed}, data}.
//  - 거절은 던져진 오류의 `.body` 가 ApiError{format_version, error{code(영어), message(한국어), retryable}, request_id}.
//  - 경로 이름은 stage-1-api 6절의 이름(P/workspace · P/submissions …)으로 types.ts 의 READS/COMMANDS 에 둔다.
import { describe, expect, it } from "vitest";
import { createFakeClient } from "@/api/fake-client";
import * as types from "@/api/types";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TIME_KEY = /(^|_)(at|since|last_signal|time)$|^(at|since|last_signal)$/;

// 계약은 모양만 본다 — 시그니처 형식 오류로 typecheck 가 깨지지 않게 느슨한 타입으로 부른다
type Loose = {
  listProjects(): Promise<unknown>;
  getWorkspace(slug: string, edition: number): Promise<unknown>;
  getRound(slug: string, edition: number, stage: string, round: string): Promise<unknown>;
  acknowledgeAlert(slug: string, edition: number, alertId: string, idempotencyKey?: string): Promise<unknown>;
};
const client = () => createFakeClient() as unknown as Loose;
const SLUG = "sample-study";

function walk(v: unknown, path: string, visit: (key: string, value: unknown, path: string) => void) {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, visit));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      visit(k, x, `${path}.${k}`);
      walk(x, `${path}.${k}`, visit);
    }
}

async function everything() {
  const c = client();
  const out: Record<string, unknown> = {
    projects: await c.listProjects(),
    workspace: await c.getWorkspace(SLUG, 1),
  };
  for (const [stage, round] of [["plan", "start"], ["plan", "1"], ["research", "start"], ["research", "1"], ["research", "2"]] as const) out[`round:${stage}/${round}`] = await c.getRound(SLUG, 1, stage, round);
  return out;
}

describe("읽기 DTO — 시각은 ISO, 화면 글자는 DTO 에 없다", () => {
  it("시각 필드(at · since · last_signal · *_at)는 모두 ISO 8601 이다", async () => {
    const bad: string[] = [];
    let seen = 0;
    walk(await everything(), "$", (k, v, p) => {
      if (TIME_KEY.test(k) && typeof v === "string") {
        seen++;
        if (!ISO.test(v)) bad.push(`${p} = ${JSON.stringify(v)}`);
      }
    });
    expect(seen, "시각 필드가 하나도 없다 — 보낸 답·알림에는 시각이 있어야 한다").toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("'11월 2일 10:12' 같은 한국어 시각 글이 값에 없다", async () => {
    const bad: string[] = [];
    walk(await everything(), "$", (_k, v, p) => {
      if (typeof v === "string" && /\d{1,2}월\s*\d{1,2}일|오전|오후|방금\b/.test(v) && !/paragraphs/.test(p) && !/\.(title|text|detail|help|prompt|meta|answer)$/.test(p)) bad.push(`${p} = ${v}`);
    });
    expect(bad).toEqual([]);
  });

  it("중요도는 말('높음'·'보통'·'낮음')이 아니라 기계 값이다", async () => {
    const c = client();
    const r = (await c.getRound(SLUG, 1, "research", "2")) as { questions: Record<string, unknown>[] };
    for (const q of r.questions) {
      const imp = q.importance;
      expect(["높음", "보통", "낮음"], `importance=${String(imp)}`).not.toContain(imp);
      if (imp !== undefined) expect(typeof imp === "number" || /^[a-z][a-z_]*$/.test(String(imp)), `importance=${String(imp)}`).toBe(true);
    }
  });

  it("화면용 이름 필드(stage_label · source_label · 라운드 label)를 DTO 에 싣지 않는다 — 화면이 키로 만든다", async () => {
    const bad: string[] = [];
    walk(await everything(), "$", (k, _v, p) => {
      if (k === "stage_label" || k === "source_label") bad.push(p);
    });
    expect(bad).toEqual([]);
  });

  it("영수증 번호 글('접수 0101')이 아니라 영수증 객체(tx_id·committed_at)가 보낸 답에 붙는다", async () => {
    const r = (await client().getRound(SLUG, 1, "plan", "start")) as { questions: { sent?: Record<string, unknown> }[] };
    const sent = r.questions.find((q) => q.sent)?.sent;
    expect(sent, "보낸 답이 있는 질문").toBeTruthy();
    expect(sent!.receipt_no ?? sent!.tx_id, "영수증 표시 자리").toBeTruthy();
    expect(typeof sent!.tx_id).toBe("string");
    expect(String(sent!.committed_at ?? sent!.at)).toMatch(ISO);
    expect(sent!.idempotency_key === undefined || typeof sent!.idempotency_key === "string").toBe(true);
  });
});

describe("쓰기 — 멱등 키 하나 · 영수증 · 오류 봉투", () => {
  async function firstAlertId() {
    const r = (await client().getRound(SLUG, 1, "research", "2")) as { alerts: { id: string }[] };
    return r.alerts[0]!.id;
  }
  const isApiError = (e: unknown) => {
    const body = (e as { body?: Record<string, unknown> } | null)?.body;
    expect(body, "던진 오류의 .body 가 ApiError 여야 한다").toBeTruthy();
    expect(body!.format_version).toBe("1.0");
    expect(typeof body!.request_id).toBe("string");
    const err = body!.error as Record<string, unknown>;
    expect(err.code, "영어 고정 코드").toMatch(/^[a-z][a-z_]*$/);
    expect(typeof err.message).toBe("string");
    expect(err.message as string, "한국어 문장").toMatch(/[가-힣]/);
    expect(typeof err.retryable).toBe("boolean");
    return err;
  };

  it("성공하면 CommandResult — format_version · request_id · receipt{receipt_no, tx_id, committed_at(ISO), idempotency_key, replayed=false}", async () => {
    const c = client();
    const id = await firstAlertId();
    const res = (await c.acknowledgeAlert(SLUG, 1, id, "key-1")) as Record<string, unknown>;
    expect(res.format_version).toBe("1.0");
    expect(typeof res.request_id).toBe("string");
    const receipt = res.receipt as Record<string, unknown>;
    expect(typeof receipt.receipt_no).toBe("string");
    expect(typeof receipt.tx_id).toBe("string");
    expect(String(receipt.committed_at)).toMatch(ISO);
    expect(receipt.idempotency_key).toBe("key-1");
    expect(receipt.replayed).toBe(false);
    expect(res.data).toBeDefined();
  });

  it("같은 키 · 같은 요청을 다시 보내면 처음 영수증을 그대로 돌려주고(replayed=true) 두 번 처리하지 않는다", async () => {
    const c = client();
    const id = await firstAlertId();
    const a = (await c.acknowledgeAlert(SLUG, 1, id, "key-2")) as { receipt: Record<string, unknown> };
    const b = (await c.acknowledgeAlert(SLUG, 1, id, "key-2")) as { receipt: Record<string, unknown> };
    expect(b.receipt.tx_id).toBe(a.receipt.tx_id);
    expect(b.receipt.receipt_no).toBe(a.receipt.receipt_no);
    expect(b.receipt.committed_at).toBe(a.receipt.committed_at);
    expect(b.receipt.replayed).toBe(true);
  });

  it("같은 키로 다른 요청을 보내면 거부한다(다른 요청에 영수증을 재생하지 않음)", async () => {
    const c = client();
    const id = await firstAlertId();
    await c.acknowledgeAlert(SLUG, 1, id, "key-3");
    const e = await c.acknowledgeAlert(SLUG, 1, "al-없음", "key-3").then(
      () => null,
      (x) => x,
    );
    expect(e, "거부되어야 한다").not.toBeNull();
    expect(isApiError(e).retryable).toBe(false);
  });

  it("멱등 키가 없으면 쓰지 않고 ApiError 로 거절한다", async () => {
    const c = client();
    const id = await firstAlertId();
    const e = await c.acknowledgeAlert(SLUG, 1, id, undefined).then(
      () => null,
      (x) => x,
    );
    expect(e, "키 없는 쓰기는 거절").not.toBeNull();
    isApiError(e);
    const after = (await c.getRound(SLUG, 1, "research", "2")) as { alerts: { id: string; acknowledged?: unknown }[] };
    expect(after.alerts.find((a) => a.id === id)?.acknowledged, "거절된 쓰기는 상태를 바꾸지 않는다").toBeFalsy();
  });

  it("없는 알림은 ApiError(영어 코드 · 한국어 메시지 · retryable=false) 로 거절한다 — 그냥 Error 가 아니다", async () => {
    const e = await client().acknowledgeAlert(SLUG, 1, "al-없음", "key-4").then(
      () => null,
      (x) => x,
    );
    expect(e).not.toBeNull();
    expect(isApiError(e).retryable).toBe(false);
  });
});

describe("경로 이름은 stage-1-api 의 이름", () => {
  const t = types as unknown as Record<string, unknown>;
  it("FORMAT_VERSION = '1.0'", () => {
    expect(t.FORMAT_VERSION).toBe("1.0");
  });
  it("READS.workspace = GET P/workspace · COMMANDS['submission.create'] = POST P/submissions (시안 types.ts 와 같은 표)", () => {
    const reads = t.READS as Record<string, { method: string; path: string }> | undefined;
    const commands = t.COMMANDS as Record<string, { method: string; path: string }> | undefined;
    expect(reads?.workspace).toMatchObject({ method: "GET", path: "P/workspace" });
    expect(commands?.["submission.create"]).toMatchObject({ method: "POST", path: "P/submissions" });
  });
  it("가짜 클라이언트는 읽기에 대해 없는 프로젝트·판을 null 이 아니라 ApiError 로 알리지 않아도 되지만 모르는 slug 에 자료를 지어내지 않는다", async () => {
    const c = client();
    expect(await c.getWorkspace("no-such", 1)).toBeNull();
    expect(await c.getRound("no-such", 1, "research", "2")).toBeNull();
    expect(await c.getRound(SLUG, 1, "research", "0")).toBeNull();
  });
});
