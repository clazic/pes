/**
 * SEL-50 PR17 최종 리뷰 1/2 필수 1 회귀 (tester, 작성 모드). 구현 전이면 실패하는 것이 정상이다. 전부 합성 자료.
 *
 * 해석 R8
 *   `submit` 의 입력은 DB 결과 형식(`[{op:"append_version", object_id, …}]`)이고, 스킬이 쓰라고 하는 **제안 파일**
 *   (researcher 의 단일 객체, plan·verifier 의 배열)과 모양이 다르다. 그래서 문서는 제안 파일을 `submit` 으로 내라고 하면 안 된다 —
 *   제안 파일은 `merge`. `submit` 을 말하는 문장은 DB 결과 형식 전용임이 드러나야 한다("DB" 가 들어 있거나, 제안 파일은 submit 이
 *   아니라는 부정 문장). 문서가 `submit` 예제(JSON)를 보여 주면, 그 형식은 실제 DB 합성 프로젝트에서 claim → submit 으로 성공해야 한다.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { new_artifact } from "./helpers/blob_env.ts";
import { json_out, with_cli } from "./helpers/cli_write_env.ts";
import { start } from "./helpers/editions_env.ts";
import { code_segments, read_text, target_docs, REPO } from "./helpers/skill_docs.ts";

/** 명령 목록 문장(`context`·`merge`·`submit`… 나열)은 submit 만 따로 안내하는 것이 아니다. */
function is_command_list(s: string): boolean {
  return (s.match(/`(?:context|claim|merge|ask|note|qa|approve|set|wait|complete|render|show)`/g)?.length ?? 0) >= 2;
}

const NEGATION = /(아니|않|말고|금지|못|없|불가|거부|대신|가 아닌|이 아닌)/;

function sentences(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.。])\s+|(?<=다)\s*\|\s*/))
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function submit_sentences(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const rel of target_docs(REPO)) {
    const markdown = read_text(join(REPO, ...rel.split("/")));
    for (const s of sentences(markdown)) if (/`?\bsubmit\b`?/.test(s)) out.push({ file: rel, text: s });
  }
  return out;
}

test("문서: 제안 파일을 submit 으로 내라고 하지 않는다 (제안 파일은 merge)", () => {
  const bad = submit_sentences().filter((s) => /제안\s*(파일|JSON)/.test(s.text) && !NEGATION.test(s.text) && !(/DB/.test(s.text) && /merge/.test(s.text)));
  assert.deepEqual(
    bad.map((s) => `${s.file}: ${s.text.slice(0, 100)}`),
    [],
    "제안 파일과 submit 을 한 문장에서 같이 안내한 곳",
  );
});

test("문서: submit 을 말하는 문장은 DB 결과 형식 전용으로 구분된다", () => {
  const vague = submit_sentences().filter((s) => !/DB/.test(s.text) && !NEGATION.test(s.text) && !is_command_list(s.text));
  assert.deepEqual(
    vague.map((s) => `${s.file}: ${s.text.slice(0, 100)}`),
    [],
    "DB 결과 형식이라는 구분 없이 submit 을 안내한 문장",
  );
});

test("문서: 토큰 작업자가 제안 파일 대신 claim → submit 으로 낼 수 있다는 안내가 없다", () => {
  const hits: string[] = [];
  for (const rel of target_docs(REPO)) {
    const markdown = read_text(join(REPO, ...rel.split("/")));
    for (const s of sentences(markdown)) {
      if (/토큰/.test(s) && /claim/.test(s) && /submit/.test(s) && !/DB/.test(s)) hits.push(`${rel}: ${s.slice(0, 100)}`);
      if (/run·lease·fence/.test(s) && /submit/.test(s) && !/DB/.test(s) && !NEGATION.test(s)) hits.push(`${rel}: ${s.slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("문서: 제안 파일 안내(merge)는 그대로 있다 — researcher·writer·verifier·plan", () => {
  for (const rel of ["agents/researcher.md", "agents/writer.md", "agents/verifier.md", "skills/plan/SKILL.md"]) {
    assert.match(read_text(join(REPO, ...rel.split("/"))), /merge/, `${rel} 가 merge 안내를 잃었다`);
  }
});

// 문서가 보여 주는 submit 예제 JSON: submit 을 언급한 줄 근처(앞 6줄 이내) 또는 같은 조각의 json 코드 블록
function submit_examples(): Array<{ file: string; json: unknown }> {
  const out: Array<{ file: string; json: unknown }> = [];
  for (const rel of target_docs(REPO)) {
    const markdown = read_text(join(REPO, ...rel.split("/")));
    const lines = markdown.split("\n");
    for (const seg of code_segments(markdown)) {
      if (seg.kind !== "fence" || !/^(json|jsonc)?$/.test(seg.lang)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(seg.text);
      } catch {
        continue;
      }
      const before = lines.slice(Math.max(0, seg.line - 8), seg.line - 1).join("\n");
      if (/\bsubmit\b/.test(before)) out.push({ file: rel, json: parsed });
    }
  }
  return out;
}

test("문서의 submit 예제가 있으면 그 형식이 실제 DB 합성 프로젝트에서 claim → submit 으로 성공한다", () =>
  with_cli(async (c) => {
    await start(c.env, c.stages.plan, "doc-start");
    const art = await new_artifact(c.env, "doc-artifact");
    const examples = submit_examples();
    for (const ex of examples) {
      const items: unknown = Array.isArray(ex.json) ? ex.json : [ex.json];
      const fixed = (items as Array<Record<string, unknown>>).map((it) => ({ ...it, object_id: art.object_id }));
      const file = join(c.env.home.root, "doc-example.json");
      writeFileSync(file, JSON.stringify(fixed), "utf8");
      const agent = await c.agent(`doc-${examples.indexOf(ex)}`);
      const tok = { PES_TOKEN: agent.token };
      const claimed = json_out(c.run(["claim", c.slug], tok));
      const guard = ["--run", claimed.run_id, "--lease", claimed.lease_id, "--fence", String(claimed.fence)];
      const res = c.run(["submit", c.slug, ...guard, "--file", file], tok);
      assert.equal(res.status, 0, `${ex.file} 의 submit 예제가 실패했다: ${res.stderr}${res.stdout}`);
      json_out(c.run(["complete", c.slug, ...guard, "--status", "succeeded"], tok));
    }
  }));

test("준비물 점검: 알려진 DB 결과 형식은 같은 흐름에서 성공하고, 제안 파일 모양은 거부된다", () =>
  with_cli(async (c) => {
    await start(c.env, c.stages.plan, "doc-start2");
    const art = await new_artifact(c.env, "doc-artifact2");
    const agent = await c.agent("doc-check");
    const tok = { PES_TOKEN: agent.token };
    const claimed = json_out(c.run(["claim", c.slug], tok));
    const guard = ["--run", claimed.run_id, "--lease", claimed.lease_id, "--fence", String(claimed.fence)];
    const file = join(c.env.home.root, "shape.json");
    writeFileSync(file, JSON.stringify({ id: 1, summary: "제안 파일 모양", details: "x", sources: [] }), "utf8");
    assert.notEqual(c.run(["submit", c.slug, ...guard, "--file", file], tok).status, 0, "제안 파일 모양은 submit 이 거부한다");
    writeFileSync(file, JSON.stringify([{ op: "append_version", object_id: art.object_id, title: "DB 결과" }]), "utf8");
    assert.equal(c.run(["submit", c.slug, ...guard, "--file", file], tok).status, 0, "DB 결과 형식은 성공한다");
  }));
