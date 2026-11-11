// tests/test_serve.py (same-second simultaneous submissions) → TS (SEL-70, PR26a; table 8: test_feedback_collision).
// 12 submissions whose answer-file name collides on purpose (fixed server clock + barriers around the existence check, injected
// into the child server only — tests/helpers/compat_inject.ts). 0.15 serialises the handler and must lose no answer;
// the second test is the positive control with the serialised server of the pytest file.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ServeProcess, make_ctx, make_serve_home, type CompatCtx } from "./helpers/compat_env.ts";
import { COLLISION_COUNT, COLLISION_NAME, COLLISION_ROUND, COLLISION_STAGE, collision_injection } from "./helpers/compat_inject.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

class AnswerLoss extends Error {}

async function with_server(serialize: boolean, run: (server: ServeProcess, project: string) => Promise<void>): Promise<void> {
  const ctx: CompatCtx = make_ctx("pes-collision-");
  const root = make_serve_home(ctx);
  const project = join(root, "synthetic");
  const server = new ServeProcess(ctx, root, { sitecustomize: collision_injection(join(project, "feedback"), COLLISION_NAME, COLLISION_COUNT, serialize) });
  try {
    await server.start();
    await run(server, project);
  } finally {
    await server.stop();
    ctx.cleanup();
  }
}

async function submit_concurrently(server: ServeProcess, count: number) {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_x, index) => server.post("/synthetic/feedback", { stage: COLLISION_STAGE, round: COLLISION_ROUND, kind: "feedback", text: `동시 답 ${index}` })),
  );
  return settled;
}

/** Transport, thread and HTTP-level regressions are asserted on their own: the answer-loss check below must not swallow them. */
function assert_requests_ok(settled: PromiseSettledResult<{ status: number; json(): any }>[], count: number): void {
  assert.equal(settled.length, count);
  const failures = settled.filter((s) => s.status === "rejected");
  assert.deepEqual(failures.map((f) => String((f as PromiseRejectedResult).reason)), [], "transport failures");
  for (const s of settled) {
    const value = (s as PromiseFulfilledResult<{ status: number; json(): any }>).value;
    assert.equal(value.status, 200);
    assert.equal(value.json().ok, true);
  }
}

function answer_files(project: string): string[] {
  const dir = join(project, "feedback");
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort() : [];
}

/** A description when the stored answers differ from what was sent (lost, overwritten or corrupt files), otherwise null. */
function answer_loss(project: string, count: number): string | null {
  const files = answer_files(project);
  const texts = new Set<string>();
  const corrupt: string[] = [];
  for (const name of files) {
    try {
      texts.add(JSON.parse(readFileSync(join(project, "feedback", name), "utf8")).text);
    } catch (error) {
      corrupt.push(`${name}: ${String(error)}`);
    }
  }
  const expected = new Set(Array.from({ length: count }, (_x, index) => `동시 답 ${index}`));
  const same = texts.size === expected.size && [...expected].every((t) => texts.has(t));
  if (files.length !== count || !same || corrupt.length > 0) return `응답 ${count}개, 파일 ${files.length}개, 깨진 파일 ${corrupt.length > 0 ? corrupt.join(", ") : "없음"}`;
  return null;
}

test("simultaneous submissions in the same second do not lose answers (SEL-31 fixed in 0.15)", { timeout: 120_000 }, async () => {
  await with_server(false, async (server, project) => {
    const settled = await submit_concurrently(server, COLLISION_COUNT);
    assert_requests_ok(settled as PromiseSettledResult<{ status: number; json(): any }>[], COLLISION_COUNT);
    const loss = answer_loss(project, COLLISION_COUNT);
    if (loss !== null) throw new AnswerLoss(`같은 초 동시 제출로 답이 유실됨: ${loss}`);
    // The injected clock really made every candidate name collide: the 12 files share one second and differ by suffix only.
    const stem = COLLISION_NAME.replace(/\.json$/, "");
    assert.ok(answer_files(project).every((name) => name === COLLISION_NAME || name.startsWith(`${stem}-`)), answer_files(project).join(","));
    assert.ok(answer_files(project).includes(COLLISION_NAME));
  });
});

test("the collision check passes on a server that serialises requests (positive control)", { timeout: 120_000 }, async () => {
  await with_server(true, async (server, project) => {
    const settled = await submit_concurrently(server, COLLISION_COUNT);
    assert_requests_ok(settled as PromiseSettledResult<{ status: number; json(): any }>[], COLLISION_COUNT);
    assert.equal(answer_loss(project, COLLISION_COUNT), null);
    assert.equal(new Set(answer_files(project)).size, COLLISION_COUNT);
  });
});
