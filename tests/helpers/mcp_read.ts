// SEL-53 (Codex 최종 1/2 회귀) 한 곳에 모은 "MCP로 읽기" 이름. 도구 이름·인자 이름은 구현(senior)이 정한다 —
// 바뀌면 이 파일만 고친다. 지금 후보는 이 파일의 상수다.
//
//   READ_TOOL            버전 본문을 읽는 도구. 인자 {object_id, version_id}. 읽기 전용이라 idempotency_key가 필요 없다.
//                        결과는 API `GET /objects/{o}/versions/{v}`의 data와 같다(project_id, object_id, kind, version_id,
//                        version_no, is_current, content_hash, content, files). 거부(권한·다른 프로젝트·AI 참조 금지)도
//                        API와 같은 code로 돌려준다.
//   INPUTS_CURSOR_ARG    pes_context가 입력 목록을 이어 읽을 때 받는 커서 인자 이름.
//   INPUTS_NEXT_FIELDS   pes_context 결과에서 "다음 커서"가 올 수 있는 필드 이름들(처음 찾은 것을 쓴다).
//   inputs_has_more      (또는 has_more) false면 끝. 없으면 다음 커서가 없을 때 끝.
//   pes_context가 스스로 끝까지 읽어 inputs에 전부 담는 설계여도 이 helper는 통과한다(다음 커서가 없으면 멈춘다).

import assert from "node:assert/strict";

import type { FakeMcpClient, ToolOutcome } from "./adapter_b_env.ts";

export const READ_TOOL = "pes_read";
export const INPUTS_CURSOR_ARG = "inputs_cursor";
export const INPUTS_NEXT_FIELDS = ["inputs_next_cursor", "next_cursor"] as const;

/** 도구 결과 그대로 (성공이든 거부든). */
export const read_version_raw = (client: FakeMcpClient, object_id: string, version_id: string): Promise<ToolOutcome> =>
  client.tool(READ_TOOL, { object_id, version_id });

/** 성공해야 하는 읽기. */
export const read_version = (client: FakeMcpClient, object_id: string, version_id: string): Promise<any> =>
  client.ok(READ_TOOL, { object_id, version_id });

/** pes_context를 커서로 끝까지 이어 읽어 모든 inputs를 모은다. */
export async function read_all_inputs(client: FakeMcpClient, run_id?: string): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | null = null;
  for (let call_no = 0; call_no < 40; call_no += 1) {
    const args: Record<string, unknown> = {};
    if (run_id !== undefined) args.run_id = run_id;
    if (cursor !== null) args[INPUTS_CURSOR_ARG] = cursor;
    const out = await client.ok("pes_context", args);
    assert.ok(Array.isArray(out.inputs), "inputs is an array");
    all.push(...out.inputs);
    let next: string | null = null;
    for (const field of INPUTS_NEXT_FIELDS) {
      if (typeof out[field] === "string" && out[field].length > 0) {
        next = out[field];
        break;
      }
    }
    // An API-style answer always carries a next cursor; has_more:false (or an empty page) is the end.
    if (out.inputs_has_more === false || out.has_more === false || out.inputs.length === 0) return all;
    if (next === null || next === cursor) return all;
    cursor = next;
  }
  assert.fail("the cursor never ended after 40 calls");
}
