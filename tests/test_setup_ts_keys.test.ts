// SEL-72 (PR26c): the API-key screen of scripts/setup.ts (`keys`, internal `keys-serve <token>`) — SYNTHETIC keys and a temp HOME only.
//
// Safety: the screen binds a port that the test injects through PES_KEYS_PORT (a free ephemeral port; setup.py's fixed 8759 is the
// default when the variable is absent and is never used by a test, and 8760~8775 are the hub ports). Keys are made-up strings. The
// child sees an empty temp HOME and a PATH with no tools (and cannot see /opt/homebrew or /usr/local: permission allow-list), so the
// only registration that can succeed is the one that writes ~/.claude/settings.json of the TEMP home (LAW_OC); kosis / vworld
// registration fail with "미설치" and nothing leaves the machine. No real key store, no real Claude settings, no browser (`--no-open`).
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";

import { make_ctx, type CompatCtx } from "./helpers/compat_env.ts";
import { KEYS_PORT_ENV, free_port, run_ts_setup, spawn_ts_setup, type TsSrvLive } from "./helpers/compat_ts_srv.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

const LAW_KEY = "SYNTHETICLAWKEY99";
const KOSIS_KEY = "SYNTHETICKOSISKEY1";
const VWORLD_KEY = "SYNTHETIC-VWORLD-KEY.2";
const SECRETS = [LAW_KEY, KOSIS_KEY, VWORLD_KEY];

interface Screen {
  live: TsSrvLive;
  port: number;
  token: string;
  base: string;
}

async function wait_for(url: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status > 0) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function start_screen(ctx: CompatCtx, token = "synthetic-token-0123456789"): Promise<Screen> {
  const port = await free_port();
  const live = spawn_ts_setup(ctx, ["keys-serve", token], { narrow_path: true, env: { [KEYS_PORT_ENV]: String(port) } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await wait_for(`${base}/ping`);
  } catch (error) {
    live.kill();
    throw new Error(`${(error as Error).message}\nstdout: ${live.out()}\nstderr: ${live.err()}`);
  }
  return { live, port, token, base };
}

function page_data(html: string): { token: string; status: Array<Record<string, string>>; keys: Array<Record<string, unknown>> } {
  const match = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match !== null, "the page embeds its data as <script id=\"data\" type=\"application/json\">");
  return JSON.parse((match[1] as string).replace(/<\\\//g, "</"));
}

async function post(screen: Screen, path: string, body: unknown, origin: string | null = screen.base, raw?: Buffer): Promise<{ status: number; type: string | null; cache: string | null; text: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  const response = await fetch(`${screen.base}${path}`, { method: "POST", headers, body: raw ?? JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, type: response.headers.get("content-type"), cache: response.headers.get("cache-control"), text: await response.text() };
}

function log_lines(ctx: CompatCtx): string[] {
  const file = join(ctx.home_dir, ".pes", "setup.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "") : [];
}

function assert_no_secret(text: string, what: string): void {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${what} contains a key in full`);
}

test("screen: /ping, the token gate, and the page (title, embedded status + keys, no key material, </ escaped)", { timeout: 90_000 }, async () => {
  const ctx = make_ctx("pes-keys-page-");
  const screen = await start_screen(ctx);
  try {
    const ping = await fetch(`${screen.base}/ping`);
    assert.equal(ping.status, 200);
    assert.equal(ping.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(ping.headers.get("cache-control"), "no-store");
    assert.equal(await ping.text(), '{"ok":true}');
    assert.equal((await fetch(`${screen.base}/ping?x=1`)).status, 200, "the query string is ignored for /ping");

    for (const path of ["/", "/?t=", "/?t=wrong", `/?t=${screen.token}&x=1`, `/index.html?t=${screen.token}`, "/key", "/finish"]) {
      const denied = await fetch(`${screen.base}${path}`);
      assert.equal(denied.status, 403, path);
      assert.equal(denied.headers.get("content-type"), "text/plain; charset=utf-8", path);
      assert.equal(denied.headers.get("cache-control"), "no-store", path);
      assert.equal(await denied.text(), "주소가 바뀌었습니다. Claude 가 알려 준 주소로 다시 여세요.", path);
    }

    const ok = await fetch(`${screen.base}/?t=${screen.token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const html = await ok.text();
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /<title>PES 설치 — API 키<\/title>/);
    assert.ok(html.includes("'/key'") && html.includes("'/finish'") && html.includes("마치기"), "the page posts to /key and /finish");
    const data = page_data(html);
    assert.equal(data.token, screen.token);
    assert.deepEqual(data.keys.map((k) => Object.keys(k)), [["id", "label", "check", "url", "steps", "has"], ["id", "label", "check", "url", "steps", "has"], ["id", "label", "check", "url", "steps", "has"]], "the registration functions are not sent to the page");
    assert.deepEqual(data.keys.map((k) => [k.id, k.check, k.has, k.url]), [
      ["kosis", "key-kosis", false, "https://kosis.kr/openapi/"],
      ["vworld", "key-vworld", false, "https://www.vworld.kr/dev/v4dv_apikey_s001.do"],
      ["law", "key-law", false, "https://open.law.go.kr/LSO/openApi/cuAskList.do"],
    ]);
    assert.equal(data.keys[0]?.label, "KOSIS (통계청 국가통계포털) API 키");
    assert.equal(data.keys[2]?.label, "법령 API (국가법령정보 공동활용) — LAW_OC");
    assert.equal((data.keys[0]?.steps as string[]).length, 3);
    assert.ok(data.status.length >= 11 && data.status.every((row) => ["name", "state", "label", "detail", "group"].every((key) => key in row)), "status = the rows of `check`");
    assert.ok(!data.status.some((row) => row.name === "python"));
    assert.equal(html.split("</script>").length - 1, 2, "exactly two script elements: the data cannot close its own tag (`</` inside it is written <\\/)");
  } finally {
    screen.live.kill();
    ctx.cleanup();
  }
});

test("POST rules: Origin = this screen's own port (127.0.0.1 or localhost), token, body < 8192 bytes, id + value format, unknown path → 404 — and nothing registers on a refusal", { timeout: 90_000 }, async () => {
  const ctx = make_ctx("pes-keys-rules-");
  const screen = await start_screen(ctx);
  try {
    const good = { token: screen.token, id: "kosis", value: "x".repeat(3) };
    const refused = { status: 403, type: "application/json; charset=utf-8", cache: "no-store", text: '{"ok":false}' };
    for (const origin of [null, "", "null", "http://127.0.0.1:8759", `http://127.0.0.1:${screen.port + 1}`, `http://127.0.0.1:${screen.port}/`, `https://127.0.0.1:${screen.port}`, "https://evil.example"]) {
      assert.deepEqual(await post(screen, "/key", good, origin), refused, `Origin ${JSON.stringify(origin)} (8759 is setup.py's default port; this screen runs on the injected one)`);
      assert.deepEqual(await post(screen, "/finish", { token: screen.token }, origin), refused);
    }
    // right Origin, wrong / missing token
    for (const body of [{ id: "kosis", value: "abc" }, { token: "nope", id: "kosis", value: "abc" }, { token: 5, id: "kosis", value: "abc" }]) {
      assert.deepEqual(await post(screen, "/key", body), refused, JSON.stringify(body));
    }
    assert.deepEqual(await post(screen, "/key", null, screen.base, Buffer.from("not json")), refused, "a body that is not JSON counts as {} → token mismatch");
    assert.deepEqual(await post(screen, "/key", null, screen.base, Buffer.alloc(0)), refused, "an empty body counts as {}");
    // a body of 8192 bytes or more is not read: {} → token mismatch, even with the right token inside
    const pad = (total: number): Buffer => {
      const head = `{"token":"${screen.token}","id":"zzz","value":"abc","pad":"`;
      const tail = '"}';
      return Buffer.from(head + "p".repeat(total - head.length - tail.length) + tail, "utf8");
    };
    assert.deepEqual(await post(screen, "/key", null, screen.base, pad(8192)), refused, "8192 bytes: ignored");
    assert.equal((await post(screen, "/key", null, screen.base, pad(8191))).status, 200, "8191 bytes: read (the id is unknown → the format answer)");
    // other origin spelling that is allowed
    assert.equal((await post(screen, "/key", { token: screen.token, id: "zzz", value: "abc" }, `http://localhost:${screen.port}`)).status, 200);

    // format: unknown id, characters outside [A-Za-z0-9+/=_\-.@], length 2..200 — all answered 200 {ok:false,msg}
    const format = { ok: false, msg: "형식이 맞지 않습니다" };
    for (const [id, value] of [["zzz", "abc"], ["kosis", "a"], ["kosis", ""], ["kosis", "has space"], ["kosis", "bang!"], ["kosis", "한글키"], ["kosis", "a".repeat(201)], ["kosis", "semi;colon"], ["law", "back\\slash"], [undefined, "abc"], ["kosis", undefined], ["kosis", 12345]] as Array<[unknown, unknown]>) {
      const answer = await post(screen, "/key", { token: screen.token, id, value });
      assert.equal(answer.status, 200, `${String(id)}/${String(value)}`);
      assert.equal(answer.type, "application/json; charset=utf-8");
      assert.equal(answer.cache, "no-store");
      if (id === "kosis" && value === 12345) assert.equal(JSON.parse(answer.text).ok, false, "a number is stringified; kosis is not installed here");
      else assert.deepEqual(JSON.parse(answer.text), format, `${String(id)}/${String(value)}`);
      assert.equal(answer.text.includes("\\u"), false, "Korean text goes out as UTF-8, not \\u escapes (ensure_ascii=False)");
    }
    const unknown = await post(screen, "/nothing", { token: screen.token });
    assert.deepEqual([unknown.status, unknown.text, unknown.type], [404, '{"ok":false}', "application/json; charset=utf-8"]);
    assert.deepEqual(log_lines(ctx).filter((l) => /SETUP keys/.test(l)), [], "no finish line yet");
  } finally {
    screen.live.kill();
    ctx.cleanup();
  }
});

test("registration with synthetic keys: kosis / vworld fail as 'not installed' (nothing leaves the machine), LAW_OC is written to the TEMP home's ~/.claude/settings.json; /finish logs the summary and ends the process with 0", { timeout: 120_000 }, async () => {
  const ctx = make_ctx("pes-keys-register-");
  const settings = join(ctx.home_dir, ".claude", "settings.json");
  mkdirSync(join(ctx.home_dir, ".claude"), { recursive: true });
  const before_settings = JSON.stringify({ model: "synthetic-model", env: { OTHER: "keep-me" }, permissions: { allow: ["Bash(ls)"] } }, null, 2);
  writeFileSync(settings, before_settings, "utf8");
  const screen = await start_screen(ctx);
  try {
    const kosis = await post(screen, "/key", { token: screen.token, id: "kosis", value: KOSIS_KEY });
    assert.deepEqual(JSON.parse(kosis.text), { ok: false, msg: "키 확인 실패: kosis 미설치" });
    const vworld = await post(screen, "/key", { token: screen.token, id: "vworld", value: VWORLD_KEY });
    assert.deepEqual(JSON.parse(vworld.text), { ok: false, msg: "vworld 미설치" });
    const law = await post(screen, "/key", { token: screen.token, id: "law", value: LAW_KEY });
    assert.deepEqual(JSON.parse(law.text), { ok: true, msg: "Claude Code 설정(env)에 등록 (korean-law 미설치라 접속 확인은 나중에)" });
    assert_no_secret(kosis.text + vworld.text + law.text, "an answer");

    // the settings file of the temp home: backup first, then LAW_OC added, everything else kept, indent 2, UTF-8
    assert.equal(readFileSync(`${settings}.bak-pes`, "utf8"), before_settings, "settings.json.bak-pes is a copy of the file as it was");
    const written = readFileSync(settings, "utf8");
    const parsed = JSON.parse(written);
    assert.deepEqual(parsed, { model: "synthetic-model", env: { OTHER: "keep-me", LAW_OC: LAW_KEY }, permissions: { allow: ["Bash(ls)"] } });
    assert.equal(written, JSON.stringify(parsed, null, 2), "json.dumps(ensure_ascii=False, indent=2), no trailing newline");

    // the page now knows, and shows the key masked only
    const html = await (await fetch(`${screen.base}/?t=${screen.token}`)).text();
    const data = page_data(html);
    assert.equal(data.keys.find((k) => k.id === "law")?.has, true);
    assert.equal(data.keys.find((k) => k.id === "kosis")?.has, false);
    assert.equal(data.status.find((r) => r.name === "key-law")?.detail, "SY*************99");
    assert_no_secret(html, "the page");

    // the log: one KEY line per attempt, never a key
    const keylog = log_lines(ctx);
    assert.deepEqual(keylog.map((l) => l.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, "")), ["KEY kosis fail", "KEY vworld fail", "KEY law ok"]);
    assert.ok(keylog.every((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /.test(l)));
    // a second try on the same id replaces its result in place (kosis stays first in the summary)
    await post(screen, "/key", { token: screen.token, id: "kosis", value: KOSIS_KEY });

    const finish = await post(screen, "/finish", { token: screen.token });
    assert.deepEqual([finish.status, finish.text, finish.type], [200, '{"ok":true}', "application/json; charset=utf-8"]);
    const exit = await Promise.race([screen.live.exited, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    assert.deepEqual(exit === null ? null : exit.status, 0, "the screen process ends with exit 0 after /finish");
    const lines = log_lines(ctx).map((l) => l.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, ""));
    assert.equal(lines[lines.length - 1], "SETUP keys kosis=fail vworld=fail law=ok");
    assert_no_secret(log_lines(ctx).join("\n"), "setup.log");
    assert_no_secret(screen.live.out() + screen.live.err(), "the screen's output");
    assert.equal(screen.live.err(), "");
  } finally {
    screen.live.kill();
    ctx.cleanup();
  }
});

test("registration refusals: a settings.json that is not JSON stays as it was (backup made) and the answer is ok:false with an '오류: ' message; with no settings file none is invented as a backup", { timeout: 120_000 }, async () => {
  const ctx = make_ctx("pes-keys-badsettings-");
  const settings = join(ctx.home_dir, ".claude", "settings.json");
  const screen = await start_screen(ctx);
  try {
    // no settings yet: created, no backup
    const first = await post(screen, "/key", { token: screen.token, id: "law", value: LAW_KEY });
    assert.equal(JSON.parse(first.text).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { env: { LAW_OC: LAW_KEY } });
    assert.ok(!existsSync(`${settings}.bak-pes`), "nothing to back up the first time");
    // broken settings: the answer says so, the file is untouched
    writeFileSync(settings, "{ this is not json", "utf8");
    const broken = await post(screen, "/key", { token: screen.token, id: "law", value: "ANOTHERSYNTHETICKEY" });
    const answer = JSON.parse(broken.text);
    assert.equal(answer.ok, false);
    assert.match(answer.msg, /^오류: /);
    assert.equal(readFileSync(settings, "utf8"), "{ this is not json", "the user's file is not overwritten");
    assert.equal(readFileSync(`${settings}.bak-pes`, "utf8"), "{ this is not json");
    assert.ok(!answer.msg.includes("ANOTHERSYNTHETICKEY"));
    assert.equal(log_lines(ctx).filter((l) => l.endsWith("KEY law fail")).length, 1);
  } finally {
    screen.live.kill();
    ctx.cleanup();
  }
});

test("/finish with nothing registered logs 'SETUP keys none'", { timeout: 60_000 }, async () => {
  const ctx = make_ctx("pes-keys-none-");
  const screen = await start_screen(ctx);
  try {
    assert.equal((await post(screen, "/finish", { token: screen.token })).status, 200);
    const exit = await Promise.race([screen.live.exited, new Promise<null>((r) => setTimeout(() => r(null), 10_000))]);
    assert.equal(exit === null ? null : exit.status, 0);
    assert.match(log_lines(ctx).join("\n"), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d SETUP keys none$/m);
  } finally {
    screen.live.kill();
    ctx.cleanup();
  }
});

test("PES_KEYS_PORT that is not a TCP port → exit 2 with a message that names the variable (never a stack trace)", () => {
  const ctx = make_ctx("pes-keys-badport-");
  try {
    for (const bad of ["abc", "0", "-5", "65536", "80.5"]) {
      const run = run_ts_setup(ctx, ["keys-serve", "synthetic-token"], { narrow_path: true, env: { [KEYS_PORT_ENV]: bad }, timeout_ms: 20_000 });
      assert.equal(run.status, 2, `port ${bad}`);
      assert.match(run.stderr, /PES_KEYS_PORT/, `port ${bad}`);
      assert.doesNotMatch(run.stderr, /^\s+at .+:\d+:\d+\)?$/m, `port ${bad}: no stack trace`);
    }
  } finally {
    ctx.cleanup();
  }
});

test("`keys --no-open`: prints the screen's address and the WATCH line, returns 0 with the screen still up (detached), records its pid; /finish ends it", { timeout: 120_000 }, async () => {
  const ctx = make_ctx("pes-keys-cmd-");
  const port = await free_port();
  const env = { [KEYS_PORT_ENV]: String(port) };
  let pid: number | undefined;
  try {
    const run = run_ts_setup(ctx, ["keys", "--no-open"], { narrow_path: true, env, allow_child_process: true, timeout_ms: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const out = run.stdout.split("\n");
    const url = /^http:\/\/127\.0\.0\.1:(\d+)\/\?t=([A-Za-z0-9_-]{22})$/.exec(out[0] as string);
    assert.ok(url !== null, `first line is the address with a 22-character urlsafe token: ${out[0]}`);
    assert.equal(Number(url[1]), port);
    const log_posix = `${ctx.home_dir.split(sep).join("/")}/.pes/setup.log`;
    assert.equal(out[1], `WATCH tail -n0 -F ${log_posix} | grep --line-buffered 'SETUP keys'`);
    assert.equal(out.length, 3, "two lines and the final newline");

    const info = JSON.parse(readFileSync(join(ctx.home_dir, ".pes", "setup-keys.json"), "utf8")) as { pid: number };
    pid = info.pid;
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.ok(existsSync(join(ctx.home_dir, ".pes", "setup-keys.out")));

    // the screen outlives the command that started it
    const page = await fetch(run.stdout.split("\n")[0] as string);
    assert.equal(page.status, 200);
    const screen: Screen = { live: undefined as unknown as TsSrvLive, port, token: url[2] as string, base: `http://127.0.0.1:${port}` };
    assert.equal((await post(screen, "/finish", { token: screen.token })).status, 200);
    const end = Date.now() + 10_000;
    let up = true;
    while (up && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      up = await fetch(`${screen.base}/ping`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
    }
    assert.equal(up, false, "the screen process ended after /finish");
    assert.match(log_lines(ctx).join("\n"), /SETUP keys none$/m);
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    ctx.cleanup();
  }
});

test("`keys --no-open --wait`: the address, the waiting notice, then the summary line once the person presses 마치기", { timeout: 120_000 }, async () => {
  const ctx = make_ctx("pes-keys-wait-");
  const port = await free_port();
  const live = spawn_ts_setup(ctx, ["keys", "--no-open", "--wait"], { narrow_path: true, env: { [KEYS_PORT_ENV]: String(port) }, allow_child_process: true });
  let pid: number | undefined;
  try {
    const end = Date.now() + 30_000;
    while (!/\?t=[A-Za-z0-9_-]{22}\n/.test(live.out()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const url = /^(http:\/\/127\.0\.0\.1:\d+\/\?t=([A-Za-z0-9_-]{22}))$/m.exec(live.out());
    assert.ok(url !== null, `address printed: ${live.out()}\n${live.err()}`);
    const screen: Screen = { live, port, token: url[2] as string, base: `http://127.0.0.1:${port}` };
    pid = (JSON.parse(readFileSync(join(ctx.home_dir, ".pes", "setup-keys.json"), "utf8")) as { pid: number }).pid;
    assert.ok(!live.out().includes("SETUP keys"), "still waiting");
    assert.equal(JSON.parse((await post(screen, "/key", { token: screen.token, id: "law", value: LAW_KEY })).text).ok, true);
    assert.equal(JSON.parse((await post(screen, "/key", { token: screen.token, id: "kosis", value: KOSIS_KEY })).text).ok, false);
    assert.equal((await post(screen, "/finish", { token: screen.token })).status, 200);
    const exit = await Promise.race([live.exited, new Promise<null>((r) => setTimeout(() => r(null), 30_000))]);
    assert.deepEqual(exit === null ? null : exit.status, 0, `${live.out()}\n${live.err()}`);
    assert.deepEqual(live.out().split("\n"), [url[1], "브라우저의 API 키 화면에서 '마치기'를 누르면 이어서 진행합니다 (건너뛰려면 Ctrl+C).", "SETUP keys law=ok kosis=fail", ""]);
    assert_no_secret(live.out() + live.err(), "the command's output");
  } finally {
    live.kill();
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
    }
    ctx.cleanup();
  }
});

test("`keys` when the port is taken by another program: exit 1, '포트 <n> 사용 중 …' on stderr, nothing printed on stdout, the other program is left alone", { timeout: 60_000 }, async () => {
  const ctx = make_ctx("pes-keys-busy-");
  const holder = createServer((socket) => socket.end("HOLDER"));
  try {
    const port = await new Promise<number>((done) => holder.listen(0, "127.0.0.1", () => done((holder.address() as { port: number }).port)));
    const run = run_ts_setup(ctx, ["keys", "--no-open"], { narrow_path: true, env: { [KEYS_PORT_ENV]: String(port) }, allow_child_process: true, timeout_ms: 30_000 });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.equal(run.stderr, `포트 ${port} 사용 중 — 다른 프로그램을 끄거나 잠시 뒤 다시\n`);
    assert.ok(!existsSync(join(ctx.home_dir, ".pes", "setup-keys.json")), "no screen was started");
    const answer = await new Promise<string>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString("utf8")));
      socket.on("close", () => done(text));
      socket.on("error", () => done("ERROR"));
    });
    assert.equal(answer, "HOLDER", "the program that held the port still answers");
  } finally {
    holder.close();
    ctx.cleanup();
  }
});
