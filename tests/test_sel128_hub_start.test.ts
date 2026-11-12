/**
 * SEL-128 [3단계] 첫 페이지(프로젝트 목록)의 '프로젝트 시작' 버튼 — 서버·CLI·첫 페이지 HTML 쪽 (tester, 작성 모드). 구현 전이라 실패가 정상.
 *
 * 세션 방식 결정 (leader, 2026-11-13 — 안 C): 새 신뢰 경로 없음, 기존 SEL-85 1회 코드 장치만 넓힌다.
 *   - `pes hub --open` · `pes list --open` 이 소유자 세션으로 `POST /api/v1/app-session/codes {projects:{}}` 를 불러 빈 projects 코드를 받고
 *     첫 페이지 주소 `http://127.0.0.1:<port>/#code=<코드>` 를 연다. PES_NO_BROWSER=1 이면 그 주소 한 줄을 출력(list 는 목록 줄 뒤 마지막 줄).
 *     브라우저로 열 때는 명령 인자에만 조각이 있고 CLI 출력에는 조각·세션이 없다. `--open` 없는 hub/list 는 지금처럼 조각 없는 주소·목록만.
 *   - 서버 변경 0 이 목표: 코드 발급(valid_projects 는 {} 허용)·교환(Origin 이 정확히 127.0.0.1:<port>)·POST /api/v1/projects(x-pes-session + Origin 검사)는 그대로.
 *     구현이 서버를 바꿔야 하면 이 시험의 해당 줄 근거를 머리말에 남긴다.
 *   - 첫 페이지 JS(templates/hub.html): 렌더·요청 전에 history.replaceState 로 #code 를 지우고, POST /api/v1/app-session 을 한 번(credentials omit·재시도 없음·시간 제한),
 *     세션은 sessionStorage 에만(앱과 같은 키 `pes-app-handoff` = {session, projects}) — localStorage·쿠키·HTML 에 없음. (동작은 tests/e2e/sel128_*.spec.ts)
 *   - POST /api/v1/projects 본문: {slug, topic, owner_display_name} 은 API 가 모두 요구한다. 이름(slug)을 비우면 첫 페이지 JS 가 정한다(서버 변경 없이 — 모양 ^[a-z0-9][a-z0-9-]{0,63}$).
 *     owner_display_name 은 비지 않은 문자열이면 된다.
 * 거절 시험(출처·세션): 거절한 요청은 DB·PES 홈 폴더를 바꾸지 않는다(빈 홈이면 DB 파일도 만들지 않는다).
 * Origin 없음 + 소유자 세션은 지금도 허용(CLI·curl)이라 이 시험은 그 조합을 고정하지 않는다 — 없는 세션·낯선 출처만 거절을 본다.
 * 첫 페이지 디자인 불변: tests/fixtures/sel128/hub_style_before.css 의 모든 줄이 새 <style> 에 그대로 있고 표 행 템플릿(hub_row_before.txt)도 그대로다.
 * 실제 홈·실제 허브 포트 0: 임시 홈 + 주입된 빈 포트.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { run_ts_cli } from "./helpers/compat_ts.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { CODE, CREATE, EXCHANGE, SECRET, start_empty, type Empty } from "./helpers/sel128_env.ts";

use_home_guard();

const FIX = join(import.meta.dirname, "fixtures", "sel128");
const BODY = { slug: "synthetic-start", topic: "합성 시작 주제", owner_display_name: "합성 소유자" };
const variants = [SECRET, Buffer.from(SECRET).toString("base64"), Buffer.from(SECRET).toString("base64url"), Buffer.from(SECRET).toString("hex")];
const leaks = (text: string): string[] => variants.filter((v) => text.includes(v));

const address_lines = (stdout: string): string[] => stdout.split(/\r?\n/).filter((l) => /^http:\/\/127\.0\.0\.1:\d+\/#code=/.test(l));

async function with_empty(prefix: string, body: (f: Empty) => Promise<void>): Promise<void> {
  const f = await start_empty(prefix);
  try {
    await body(f);
  } finally {
    await f.cleanup();
  }
}

test("1 pes hub --open (PES_NO_BROWSER=1): 빈 홈에서 첫 페이지 주소 한 줄 http://127.0.0.1:<포트>/#code=<코드> — 세션 없음, 코드는 빈 projects 로 한 번 교환된다", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-hubopen-", async (f) => {
    const out = f.run(["hub", "--open"]);
    assert.equal(out.status, 0, out.stderr);
    const lines = address_lines(out.stdout);
    assert.equal(lines.length, 1, `one address line, got ${JSON.stringify(out.stdout)}`);
    assert.deepEqual(leaks(out.stdout + out.stderr), []);
    const url = new URL(lines[0] as string);
    assert.equal(url.origin, f.server.origin());
    assert.equal(url.pathname, "/");
    assert.equal(url.search, "");
    const code = url.hash.replace(/^#code=/, "");
    assert.match(code, CODE);
    const ok = await f.server.post(EXCHANGE, { code });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json().data, { session: SECRET, projects: {} });
    assert.match(ok.headers["cache-control"] ?? "", /no-store/);
    assert.equal((await f.server.post(EXCHANGE, { code })).status, 401, "한 번 쓰면 끝");
  });
});

test("1 pes hub --open <폴더> (--open 이 앞에 와도): 폴더 인자를 잃지 않는다 — 허브 index.html 은 그 폴더에 만들어지고 PES 홈에는 안 생긴다", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-hubfolder-", async (f) => {
    const alt = join(f.ctx.home_dir, "alt-hub-root");
    mkdirSync(alt, { recursive: true });
    // 허브 파일은 서버를 켜기 전에 쓰인다. 시험 권한에서는 자식 프로세스(서버)를 못 켜므로 종료 상태는 보지 않는다
    f.run(["hub", "--open", alt]);
    assert.ok(existsSync(join(alt, "index.html")), "허브 index.html 이 인자로 준 폴더에 있다");
    assert.ok(!existsSync(join(f.root, "index.html")), "PES 홈에는 허브가 생기지 않는다");
  });
});

test("1 pes list --open: 목록 줄(빈 홈이면 '프로젝트 없음') 뒤 마지막 줄이 같은 꼴의 첫 페이지 주소 — 코드는 그 한 줄에만", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-listopen-", async (f) => {
    const out = f.run(["list", "--open"]);
    assert.equal(out.status, 0, out.stderr);
    const all = out.stdout.split(/\r?\n/).filter((l) => l !== "");
    const addr = address_lines(out.stdout);
    assert.equal(addr.length, 1);
    assert.equal(all[all.length - 1], addr[0], "주소가 마지막 줄");
    assert.ok(all.slice(0, -1).every((l) => !l.includes("#code=")));
    assert.deepEqual(leaks(out.stdout + out.stderr), []);
    const code = new URL(addr[0] as string).hash.replace(/^#code=/, "");
    const ok = await f.server.post(EXCHANGE, { code });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json().data.projects, {});
  });
});

test("1 호출마다 다른 코드 · --open 없는 hub/list 는 지금처럼 조각 없는 주소·목록만(코드를 만들지 않는다)", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-plain-", async (f) => {
    const a = address_lines(f.run(["hub", "--open"]).stdout)[0];
    const b = address_lines(f.run(["hub", "--open"]).stdout)[0];
    assert.ok(a && b && a !== b);
    const plain = f.run(["hub"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(!plain.stdout.includes("#") && !plain.stdout.includes("code="), plain.stdout);
    assert.match(plain.stdout.trim(), /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const list = f.run(["list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.ok(!list.stdout.includes("#code="));
  });
});

test("1 서버가 이 세션을 받아들이지 않으면(--open) 실패한다 — 한국어 한 줄, 세션·코드 출력 없음, 코드 발급 없음", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-wrongsession-", async (f) => {
    const out = f.run(["hub", "--open"], { PES_LOCAL_SESSION_SECRET: "synthetic-other-session-0123456789abcdef" });
    assert.notEqual(out.status, 0);
    assert.equal(address_lines(out.stdout).length, 0);
    assert.ok(!(out.stdout + out.stderr).includes("synthetic-other-session"));
    assert.match(out.stderr, /[가-힣]/);
  });
});

test("1 브라우저로 열 때(PES_NO_BROWSER 없음) 명령 인자에만 #code= 가 있고 CLI 출력에는 조각·세션이 없다", { timeout: 120_000, skip: process.platform === "win32" ? "rundll32 can't be faked on Windows" : false }, async () => {
  await with_empty("pes-sel128-browser-", async (f) => {
    const bin = mkdtempSync(join(tmpdir(), "pes-sel128-bin-"));
    const log = join(bin, "args.log");
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\n`, "utf8");
      chmodSync(join(bin, name), 0o755);
    }
    const out = run_ts_cli(f.ctx, ["hub", "--open"], {
      allow_child_process: true,
      extra_read: [bin],
      env: { PES_HUB_PORTS: `${f.server.port}-${f.server.port}`, PES_NO_BROWSER: "", PES_LOCAL_SESSION_SECRET: SECRET, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    } as any);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!out.stdout.includes("#code=") && !out.stdout.includes("code="), "출력에 조각 없음");
    assert.deepEqual(leaks(out.stdout + out.stderr), []);
    for (let i = 0; i < 60 && !existsSync(log); i += 1) await new Promise((r) => setTimeout(r, 100));
    const args = readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.equal(args.length, 1, `브라우저 명령 인자 하나, got ${JSON.stringify(args)}`);
    assert.match(args[0] as string, new RegExp(`^http://127\\.0\\.0\\.1:${f.server.port}/#code=[A-Za-z0-9_-]{20,}$`));
    assert.deepEqual(leaks(args.join("\n")), []);
  });
});

test("2 교환은 정확히 127.0.0.1:<포트> Origin 에서만 — 다른 Origin·Origin 없음·localhost 는 403 이고 코드는 그대로 남는다(새 신뢰 경로 없음)", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-origin-", async (f) => {
    const code = new URL(address_lines(f.run(["hub", "--open"]).stdout)[0] as string).hash.replace(/^#code=/, "");
    for (const origin of [null, "http://evil.example", `http://localhost:${f.server.port}`, "null"]) {
      const res = await f.server.post(EXCHANGE, { code }, origin);
      assert.equal(res.status, 403, String(origin));
      assert.deepEqual(leaks(res.text()), []);
    }
    assert.equal((await f.server.post(EXCHANGE, { code })).status, 200, "맞는 Origin 에서는 아직 교환된다");
  });
});

test("3 첫 페이지 HTML: '프로젝트 시작' 버튼이 있고(빈 홈 포함), 세션·코드가 없고, 지금의 CSS 줄과 표 행 템플릿이 그대로다 — 디자인 불변", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-html-", async (f) => {
    assert.equal(f.run(["hub"]).status, 0);
    const page = await f.server.request("/");
    assert.equal(page.status, 200);
    const html = page.text();
    assert.ok(html.includes("프로젝트 시작"), "버튼 문구");
    assert.deepEqual(leaks(html), []);
    assert.ok(!/#code=/.test(html) && !html.includes("localStorage") && !html.includes("document.cookie"));
    const style = /<style>([\s\S]*?)<\/style>/.exec(html);
    assert.ok(style);
    const have = new Set((style[1] as string).split("\n").map((l) => l.trimEnd()));
    const missing = readFileSync(join(FIX, "hub_style_before.css"), "utf8").split("\n").filter((l) => l.trim() !== "" && !have.has(l.trimEnd()));
    assert.deepEqual(missing, [], "기존 CSS 줄이 바뀌거나 사라졌다");
    const row = readFileSync(join(FIX, "hub_row_before.txt"), "utf8").trim();
    assert.ok(html.includes(row), "표 행 템플릿 불변");
    // 이전 안내 문구 자리에 버튼이 오고, 첫 문장은 그대로
    assert.ok(html.includes("진행 상태는 단계 이름 아래에 표시됩니다."));
    // 첫 페이지 JS 규칙(동작은 e2e): 요청 전에 조각 지우기 → 교환 → sessionStorage(앱과 같은 키)
    const script = html.slice(html.lastIndexOf("<script>"));
    const replace_at = script.indexOf("replaceState");
    const exchange_at = script.indexOf("/api/v1/app-session");
    assert.ok(replace_at >= 0 && exchange_at > replace_at, "replaceState 가 교환 요청보다 앞");
    assert.ok(script.includes("pes-app-handoff") && script.includes("sessionStorage"));
    assert.ok(/credentials:\s*['"]omit['"]/.test(script), "교환은 credentials omit");
    // SEL-130: 프로젝트를 만드는 길은 앱의 /new 하나 — 첫 페이지에는 만들기 요청 코드도 대화 상자도 없다(첫 페이지는 세션을 넘겨 /new 로 보낼 뿐)
    assert.ok(!/idempotency-key/i.test(html) && !html.includes("/api/v1/projects") && !/<dialog/i.test(html) && !html.includes("pes-start-dlg"), "첫 페이지에 만들기 요청·대화 상자 코드 없음");
    assert.ok(script.includes("location.assign('/new')"), "버튼은 같은 탭을 /new 로 보낸다");
  });
});

// ---------------------------------------------------------------- 거절: DB·폴더 변화 0
const REFUSALS: { name: string; opts: { session?: string | null; origin?: string | null }; status: number }[] = [
  { name: "세션 없음", opts: { session: null }, status: 401 },
  { name: "세션 없음 · Origin 없음", opts: { session: null, origin: null }, status: 401 },
  { name: "틀린 세션", opts: { session: "synthetic-wrong-session-0123456789" }, status: 401 },
  { name: "맞는 세션 · 낯선 Origin", opts: { origin: "http://evil.example" }, status: 403 },
  { name: "맞는 세션 · localhost Origin(허용 목록에 없음)", opts: { origin: "http://localhost:1" }, status: 403 },
  { name: "맞는 세션 · Origin: null", opts: { origin: "null" }, status: 403 },
  { name: "세션 없음 · 낯선 Origin", opts: { session: null, origin: "http://evil.example" }, status: 403 },
];

test("4 거절(빈 홈): 세션 없음·틀린 세션·낯선 Origin 은 401/403 이고 DB 파일도 폴더도 만들어지지 않는다", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-refuse-empty-", async (f) => {
    const tree = f.tree();
    assert.equal(f.db_exists(), false);
    for (const r of REFUSALS) {
      const res = await f.create(BODY, r.opts);
      assert.equal(res.status, r.status, r.name);
      assert.deepEqual(leaks(res.text()), [], r.name);
      assert.equal(f.db_exists(), false, `${r.name}: DB 생성 없음`);
      assert.deepEqual(f.tree(), tree, `${r.name}: 폴더 변화 없음`);
    }
  });
});

test("4 거절(프로젝트가 있는 홈): 같은 거절들이 프로젝트 목록·폴더를 바꾸지 않는다", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-refuse-seeded-", async (f) => {
    assert.equal((await f.create(BODY, { key: "seed-1" })).status, 201);
    const slugs = f.slugs();
    const tree = f.tree();
    assert.deepEqual(slugs, [BODY.slug]);
    for (const r of REFUSALS) {
      const res = await f.create({ ...BODY, slug: "synthetic-refused" }, { key: "refused-1", ...r.opts });
      assert.equal(res.status, r.status, r.name);
      assert.deepEqual(f.slugs(), slugs, `${r.name}: DB 변화 없음`);
      assert.deepEqual(f.tree(), tree, `${r.name}: 폴더 변화 없음`);
    }
  });
});

test("4 요청 모양이 틀리면 400 이고 아무것도 만들지 않는다 — 주제 없음·빈 주제·대문자·한글·너무 긴 slug·모르는 필드", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-invalid-", async (f) => {
    assert.equal((await f.create(BODY, { key: "seed-1" })).status, 201);
    const slugs = f.slugs();
    const tree = f.tree();
    const bad: unknown[] = [
      { slug: "synthetic-two", owner_display_name: "합성 소유자" },
      { ...BODY, slug: "synthetic-two", topic: "" },
      { ...BODY, slug: "Synthetic-Two" },
      { ...BODY, slug: "한글이름" },
      { ...BODY, slug: "a".repeat(65) },
      { ...BODY, slug: "synthetic-two", extra: 1 },
    ];
    let n = 0;
    for (const body of bad) {
      const res = await f.create(body, { key: `bad-${n++}` });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.deepEqual(f.slugs(), slugs);
    assert.deepEqual(f.tree(), tree);
  });
});

// ---------------------------------------------------------------- 멱등·중복
test("5 같은 요청(같은 Idempotency-Key·같은 본문)을 두 번 보내도 프로젝트는 1개 — 두 번째는 replayed, 같은 project_id", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-idem-", async (f) => {
    const a = await f.create(BODY, { key: "create-1" });
    const b = await f.create(BODY, { key: "create-1" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json().replayed, false);
    assert.equal(b.json().replayed, true);
    assert.equal(b.json().data.project_id, a.json().data.project_id);
    assert.deepEqual(f.slugs(), [BODY.slug]);
    const reuse = await f.create({ ...BODY, topic: "다른 주제" }, { key: "create-1" });
    assert.equal(reuse.status, 409);
    assert.equal(reuse.json().error.code, "idempotency_key_reuse");
    assert.deepEqual(f.slugs(), [BODY.slug]);
  });
});

test("5 이름(slug) 중복은 409 conflict 이고 아무것도 더 만들지 않는다 — 첫 페이지가 '이미 있는 이름' 한 줄로 보일 근거", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-dup-", async (f) => {
    assert.equal((await f.create(BODY, { key: "k1" })).status, 201);
    const tree = f.tree();
    const dup = await f.create({ ...BODY, topic: "다른 주제" }, { key: "k2" });
    assert.equal(dup.status, 409);
    assert.equal(dup.json().error.code, "conflict");
    assert.deepEqual(f.slugs(), [BODY.slug]);
    assert.deepEqual(f.tree(), tree);
  });
});

test("6 pes remote 로 허용한 주소(trusted_origins)에서도 소유자 세션이 있으면 만들 수 있고, 없으면 거절 — 단 코드 교환은 그 주소에서 안 된다(127.0.0.1 만)", { timeout: 120_000 }, async () => {
  await with_empty("pes-sel128-remote-", async (f) => {
    const remote = "https://pes-remote.example.test:8443";
    mkdirSync(join(f.ctx.home_dir, ".pes"), { recursive: true });
    writeFileSync(join(f.ctx.home_dir, ".pes", "config.json"), JSON.stringify({ trusted_origins: [remote] }), "utf8");
    const denied = await f.create(BODY, { key: "r1", session: null, origin: remote });
    assert.equal(denied.status, 401);
    assert.equal(f.db_exists(), false);
    const made = await f.create(BODY, { key: "r2", origin: remote });
    assert.equal(made.status, 201, made.text());
    assert.deepEqual(f.slugs(), [BODY.slug]);
    const code = new URL(address_lines(f.run(["hub", "--open"]).stdout)[0] as string).hash.replace(/^#code=/, "");
    assert.equal((await f.server.post(EXCHANGE, { code }, remote)).status, 403);
  });
});

test("7 CREATE 상수와 API 문서: POST /api/v1/projects 는 localSession 하나 — 에이전트 토큰은 안 된다(문서·실제 일치)", () => {
  assert.equal(CREATE, "/api/v1/projects");
  const spec = readFileSync(join(import.meta.dirname, "..", "docs", "api", "openapi-v1.yaml"), "utf8").replace(/\r\n/g, "\n"); // Windows 체크아웃(autocrlf)의 CRLF 도 LF 로
  const block = /\n {2}\/api\/v1\/projects:\n {4}post:([\s\S]*?)\n {2}\/api\/v1\/projects\/\{id\}\/context:/.exec(spec);
  assert.ok(block);
  assert.ok(/security: \[\{ localSession: \[\] \}\]/.test(block[1] as string));
});
