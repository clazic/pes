/**
 * SEL-47 r1 회귀 R1 — 세션 비밀·커서 키를 설정하지 않은 기본 상태에서도 changes 커서가 프로세스 사이에서 유지된다.
 *
 * 브리지(scripts/pes_core/api_bridge.ts)는 요청마다 새 Node 프로세스다. 격리 HOME 에 PES_LOCAL_SESSION_SECRET 도
 * ~/.pes/config.json 도 없는 상태(실제 설치의 기본)에서:
 *   - GET changes 가 준 next_cursor 를 다른 프로세스에서 쓰면 400 cursor_invalid 가 아니라 200 이다.
 *   - 비밀은 격리 HOME 의 ~/.pes 아래 파일에 저장되고(POSIX 권한 0600), 그 원문은 어떤 응답·stderr 에도 없다.
 *   - 환경변수로 비밀을 주면 그것이 우선한다 (환경변수 키로 서명된 커서는 환경변수 없이는 거부).
 * 실제 ~/.pes 는 건드리지 않는다: 모든 자식 프로세스는 임시 HOME/PES_HOME 으로만 실행한다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isolated_home } from "./helpers/isolated_home.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(HERE, "..", "scripts", "pes_core", "api_bridge.ts");
const BOOT = resolve(HERE, "helpers", "bootstrap_agent.ts");
const SCOPES = "context:read,run:claim,run:submit,file:write,file:read";

type Env = Record<string, string | undefined>;

function run(script: string, args: string[], env: Env, input?: string) {
  const out = spawnSync(process.execPath, [script, ...args], { env: env as NodeJS.ProcessEnv, input, encoding: "utf8" });
  assert.equal(out.status, 0, `${script} exited ${out.status}: ${out.stderr}`);
  return out;
}

function clean_env(env: Env): Env {
  const copy = { ...env };
  delete copy.PES_LOCAL_SESSION_SECRET;
  return copy;
}

function bridge(env: Env, method: string, path: string, token: string) {
  const request = { method, path, headers: { authorization: `Bearer ${token}` }, body_b64: null };
  const out = run(BRIDGE, [], env, JSON.stringify(request));
  const reply = JSON.parse(out.stdout) as { status: number; headers: Record<string, string>; body_b64: string };
  const text = Buffer.from(reply.body_b64, "base64").toString("utf8");
  return { status: reply.status, text, json: JSON.parse(text), stderr: out.stderr };
}

/** Regular files under ~/.pes that are neither the database (and its WAL files) nor a directory. */
function secret_candidates(home: string): string[] {
  const dir = join(home, ".pes");
  return readdirSync(dir).filter((name) => {
    if (/^pes\.db($|-)/.test(name)) return false;
    return statSync(join(dir, name)).isFile();
  });
}

test("with no secret configured, a changes cursor from one bridge process works in another process", () => {
  const iso = isolated_home("pes-sel47-secret-");
  try {
    const env = clean_env(iso.env);
    const boot = JSON.parse(run(BOOT, ["synthetic-secret", SCOPES], env).stdout) as { project_id: string; token: string };
    const base = `/api/v1/projects/${boot.project_id}/changes`;
    const first = bridge(env, "GET", `${base}?limit=1`, boot.token);
    assert.equal(first.status, 200, first.text);
    const cursor = first.json.data.next_cursor as string;
    assert.equal(typeof cursor, "string");
    assert.ok(cursor.length > 0);

    const second = bridge(env, "GET", `${base}?cursor=${encodeURIComponent(cursor)}&limit=1`, boot.token);
    assert.equal(second.status, 200, `the cursor must survive a new process: ${second.text}`);
    assert.notEqual(second.json.error?.code, "cursor_invalid");

    const third = bridge(env, "GET", `${base}?cursor=${encodeURIComponent(second.json.data.next_cursor)}&limit=100`, boot.token);
    assert.equal(third.status, 200, third.text);

    // a tampered cursor is still refused (the key is stable, not ignored)
    const flipped = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    const bad = bridge(env, "GET", `${base}?cursor=${encodeURIComponent(flipped)}`, boot.token);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "cursor_invalid");
  } finally {
    iso.cleanup();
  }
});

test("the secret lives in a 0600 file under the isolated ~/.pes and its text appears in no response or log", () => {
  const iso = isolated_home("pes-sel47-secret-");
  try {
    const env = clean_env(iso.env);
    const boot = JSON.parse(run(BOOT, ["synthetic-secret2", SCOPES], env).stdout) as { project_id: string; token: string };
    const base = `/api/v1/projects/${boot.project_id}/changes`;
    const first = bridge(env, "GET", `${base}?limit=1`, boot.token);
    assert.equal(first.status, 200, first.text);
    const second = bridge(env, "GET", `${base}?cursor=${encodeURIComponent(first.json.data.next_cursor)}`, boot.token);
    assert.equal(second.status, 200, second.text);

    const home = env.HOME as string;
    const files = secret_candidates(home);
    assert.ok(files.length >= 1, "a persistent secret file is created under ~/.pes on first need");
    const secrets: string[] = [];
    for (const name of files) {
      const full = join(home, ".pes", name);
      if (process.platform !== "win32") {
        assert.equal(statSync(full).mode & 0o777, 0o600, `${name} must be readable by the owner only`);
      }
      const content = readFileSync(full, "utf8").trim();
      if (content.length >= 16 && !content.includes("\n")) secrets.push(content);
    }
    assert.ok(secrets.length >= 1, "one of the files holds a single-line secret of at least 16 characters");
    for (const secret of secrets) {
      for (const seen of [first.text, second.text, first.stderr, second.stderr]) {
        assert.ok(!seen.includes(secret), "the secret text never reaches a response or stderr");
      }
    }
    // a second process reads the same file, it does not write a new secret
    const again = secret_candidates(home).map((name) => readFileSync(join(home, ".pes", name), "utf8"));
    assert.deepEqual(again, files.map((name) => readFileSync(join(home, ".pes", name), "utf8")));
  } finally {
    iso.cleanup();
  }
});

test("an environment secret still wins: a cursor signed under it is refused without it", () => {
  const iso = isolated_home("pes-sel47-secret-");
  try {
    const plain = clean_env(iso.env);
    const boot = JSON.parse(run(BOOT, ["synthetic-secret3", SCOPES], plain).stdout) as { project_id: string; token: string };
    const base = `/api/v1/projects/${boot.project_id}/changes`;
    const with_env = { ...plain, PES_LOCAL_SESSION_SECRET: "synthetic-env-secret-value-0123456789" };
    const first = bridge(with_env, "GET", `${base}?limit=1`, boot.token);
    assert.equal(first.status, 200, first.text);
    const cursor = encodeURIComponent(first.json.data.next_cursor);
    assert.equal(bridge(with_env, "GET", `${base}?cursor=${cursor}`, boot.token).status, 200);
    const without = bridge(plain, "GET", `${base}?cursor=${cursor}`, boot.token);
    assert.equal(without.status, 400);
    assert.equal(without.json.error.code, "cursor_invalid");
  } finally {
    iso.cleanup();
  }
});
