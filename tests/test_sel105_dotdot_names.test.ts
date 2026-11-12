/**
 * SEL-105 (결함 후보, 보안 경계) — 경로 '밖' 판정이 `..cache` 같은 정상 하위 이름을 밖으로 본다.
 * 근본: `path.relative()` 결과를 `rel.startsWith("..")` 로 판정하면 첫 칸이 `..cache`·`...` 인 안쪽 폴더도 "부모로 나감"이 된다.
 * 맞는 판정은 `rel === ".." || rel.startsWith("..\<sep>")` (+ `isAbsolute`). SEL-103 1차 리뷰(logs/SEL-103-r1.md 권장 2)가 지적.
 *
 * ── 판정 지점(scripts/ 에서 `startsWith("..")` 를 쓰는 곳 전부; grep 결과) ────────────────────────────
 *   P1 scripts/pes_core/cli_home.ts:155  inside_pes_home(d)  — 옛 서버 root 가 PES 홈 '안'인가(안이면 정지 대상). `..x` 폴더를 밖으로 봐 놓친다.
 *   P2 scripts/pes_core/cli_home.ts:275  inside(path, parent) — `pes home <새 폴더>` 가 "서로 안에 들어 있으면 옮길 수 없다"로 거절하는 판정.
 *                                        `<홈>/..cache` 를 새 홈으로 주면 '밖'으로 봐 홈을 자기 안으로 옮기려 든다(거절이 빠진다).
 *   P3 scripts/serve.ts:361              in_report_zone 의 zone() — 파일이 root 안인가. 첫 낱말이 SLUG(영숫자로 시작)·reports/out 이어야 의미가 있어
 *                                        `..x` 첫 낱말로는 오판이 겉으로 드러나지 않는다(관찰 불가) → 소스 계약(S1)으로 막고, 동작은 회귀 가드(E3)로 둔다.
 *   (이미 맞는 곳) scripts/pes_core/backup.ts:324 · scripts/pes_core/migration.ts:454 는 `rel === ".." || rel.startsWith(`..${sep}`)` — 회귀 가드(S1 이 같은 패턴 금지를 지킨다).
 *   (제품 밖, 같은 버그 — 이 이슈 범위 밖이면 별도) tests/helpers/ts_child_guard.ts:54 · tests/helpers/home_guard.ts:101.
 *   (정확 비교라 문제 없음) scripts/serve.ts:326 `word === ".."`, scripts/pes_core/files.ts:187, legacy.ts, migration.ts:392, backup.ts:173.
 *
 * ── 시험 ↔ 지점 ──────────────────────────────────────────────────────────────────────────────────
 *   S1  소스 계약: scripts/**\/*.ts 어디에도 `.startsWith("..")` 가 없다                                  — P1 P2 P3 (지금 실패)
 *   U1  inside_pes_home: `..x`·`..cache`·`...`·`..a/b` 는 안쪽(true)                                        — P1 (지금 실패)
 *   U2  inside_pes_home: 홈 자신·`<홈>/..`(부모)·`<홈>/../x`(형제)·바깥 심볼릭 링크·Windows `..\x` 는 밖(false) — P1 (보안 경계 가드, 지금 통과)
 *   U3  inside_pes_home: 안쪽 `..cache` 를 가리키는 링크는 안, 바깥을 가리키는 링크는 밖                    — P1 (링크는 환경에 따라 건너뜀)
 *   H1  e2e `pes home <홈>/..cache` 는 거절(exit 1, 아무것도 옮기거나 쓰지 않음); `<홈>/..x/y`·`<홈>/...` 도    — P2 (지금 실패)
 *   H2  e2e `pes home <새>  --from <새>/..cache` (옛 폴더가 새 폴더 안) 도 거절                              — P2 (지금 실패)
 *   H3  e2e 진짜 안/위(`<홈>/sub`·부모·`<홈>/../형제 가 아닌 부모`)는 계속 거절, 형제는 계속 허용             — P2 (회귀 가드)
 *   H4  e2e 링크로 `<홈>/..cache` 를 가리키는 새 폴더는 거절, 바깥을 가리키면 허용                          — P2
 *   H5  e2e Windows 구분자 `..\x`(win32 에서만)                                                            — P2
 *   E1  e2e serve 정적 응답: `/<옛 프로젝트>/..cache/a.txt` · `/..cache/a.txt`(홈 바로 아래) 가 200 + 본문   — P3 (회귀 가드; 동작은 이미 정상)
 *   E2  e2e serve: 진짜 부모 이동(`/../x`·`/%2e%2e/x`·`/..%5cx`·`/..%2fx`·바깥 링크)은 여전히 거절            — P3 (보안 경계 가드)
 *   E3  e2e serve: `reports/..cache/p.html` 은 sandbox, `..cache/p.html`(reports 밖)은 sandbox 아님         — P3 (zone 판정 회귀 가드)
 *
 * 스스로 정한 해석: (a) "대소문자" 요구는 `..Cache`·`..CACHE` 도 안쪽(이름일 뿐)으로, 대소문자만 다른 부모 이동은 없다(`..` 는 대소문자가 없다)로 읽었다.
 * (b) 새 인터페이스는 만들지 않는다 — 기존 `inside_pes_home`(export)·`pes home`·serve 응답으로만 본다. 소스 계약 S1 은 정규식(`startsWith\(\s*["'`]\.\.["'`]\s*\)`) 금지만 단언한다.
 * 합성 fixture, 임시 HOME·USERPROFILE·PES_HOME. 실제 홈은 열지 않는다(공개 저장소: 실제 이름 없음).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { REPO, make_ctx, pes } from "./helpers/compat_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { raw_http, serve_fixture } from "./helpers/serve_ts_env.ts";

use_home_guard();

const ctx = make_ctx("pes-sel105-");
after(() => ctx.cleanup());

function can_link(): boolean {
  const probe = join(ctx.tmp, "probe-link");
  try {
    symlinkSync(ctx.tmp, probe, "dir");
    return true;
  } catch {
    return false;
  }
}
const LINKS = can_link();

// ── S1 소스 계약 ─────────────────────────────────────────────────────────────────────────────────
function ts_files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...ts_files(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("S1 scripts/ 어디에도 `rel.startsWith(\"..\")` 같은 느슨한 부모 판정이 없다 (`..cache` 는 안쪽 이름이다) — 맞는 꼴은 rel === \"..\" || rel.startsWith(`..${sep}`)", () => {
  const bad = /startsWith\(\s*["'`]\.\.["'`]\s*\)/;
  const hits: string[] = [];
  for (const file of ts_files(join(REPO, "scripts"))) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (bad.test(line.replace(/\/\/.*$/, ""))) hits.push(`${file.slice(REPO.length + 1)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, [], `느슨한 '..' 판정 ${hits.length}곳 (cli_home.ts·serve.ts 가 알려진 곳)`);
});

// ── U1~U3 inside_pes_home (export) — 자식 node 에서 임시 HOME/PES_HOME 으로 ─────────────────────────
const CLI_HOME_URL = pathToFileURL(join(REPO, "scripts", "pes_core", "cli_home.ts")).href;

function judge(paths: string[]): boolean[] {
  const script = `import { inside_pes_home } from ${JSON.stringify(CLI_HOME_URL)};
const paths = JSON.parse(process.env.SEL105_PATHS);
process.stdout.write(JSON.stringify(paths.map((p) => inside_pes_home(p))));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...ctx.env, SEL105_PATHS: JSON.stringify(paths), PYTHONIOENCODING: "utf-8" } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as boolean[];
}

function home_with(...rel: string[]): string {
  const home = ctx.pes_home;
  for (const r of rel) mkdirSync(join(home, ...r.split("/")), { recursive: true });
  return home;
}

test("U1 inside_pes_home: 홈 아래 `..x`·`..cache`·`..Cache`·`...`·`..a/b`·`..` 로 시작하는 이름 은 안쪽(true)", () => {
  const home = home_with("..x", "..cache", "..Cache", "...", "..a/b", "..hidden.d/deep/er");
  const inside = ["..x", "..cache", "..Cache", "..CACHE", "...", "....", "..a", "..a/b", "..hidden.d/deep/er"].map((r) => join(home, ...r.split("/")));
  assert.deepEqual(judge(inside), inside.map(() => true), inside.join("\n"));
  // 대조: 평범한 하위 폴더
  assert.deepEqual(judge([join(home, "proj"), join(home, "a", "b")]), [true, true]);
});

test("U2 inside_pes_home: 홈 자신·부모(`<홈>/..`)·형제(`<홈>/../x`)·루트·무관한 폴더는 밖(false) — 보안 경계 약화 없음", () => {
  const home = home_with("..cache");
  const parent = dirname(home);
  const outside = [home, join(home, ".."), join(home, "..", "x"), join(home, "..", "..", "y"), parent, join(parent, "..cache"), join(parent, `${home.split(/[\\/]/).pop()}..cache`), resolve(home, "..", "..")];
  assert.deepEqual(judge(outside), outside.map(() => false), outside.join("\n"));
  // `<홈>/..cache/../x` = `<홈>/x` 는 안, `<홈>/..cache/../../x` = 형제는 밖 (정규화 뒤 판정)
  assert.deepEqual(judge([join(home, "..cache", "..", "x"), join(home, "..cache", "..", "..", "x")]), [true, false]);
});

test("U3 inside_pes_home: 링크 — 안쪽 `..cache` 를 가리키면 안, 바깥을 가리키면 밖", { skip: !LINKS && "symlink 불가" }, () => {
  const home = home_with("..cache");
  const outside = join(ctx.tmp, "outside-dir");
  mkdirSync(outside, { recursive: true });
  const to_inside = join(ctx.tmp, "link-to-dotdot-cache");
  const to_outside = join(home, "link-out");
  symlinkSync(join(home, "..cache"), to_inside, "dir");
  symlinkSync(outside, to_outside, "dir");
  assert.deepEqual(judge([to_inside, to_outside]), [true, false]);
});

// ── H1~H5 `pes home` e2e (inside() 판정) ──────────────────────────────────────────────────────────
const cfg_exists = (c: typeof ctx): boolean => existsSync(join(c.home_dir, ".pes", "config.json"));

/** 각 e2e 시험은 자기 임시 홈을 쓴다 — 앞 시험이 실패해 설정을 써도 다음 시험을 흔들지 않는다. */
function with_ctx(prefix: string, body: (c: typeof ctx) => void): void {
  const c = make_ctx(prefix);
  try {
    body(c);
  } finally {
    c.cleanup();
  }
}

test("H1 `pes home <홈>/..cache`(·`..x/y`·`...`): 새 폴더가 옛 홈 안이므로 거절 — exit 1, 폴더를 만들지 않고 설정도 쓰지 않는다", () => {
  for (const rel of ["..cache", "..x/y", "...", "..CACHE"]) {
    with_ctx("pes-sel105-h1-", (c) => {
      mkdirSync(c.pes_home, { recursive: true });
      const next = join(c.pes_home, ...rel.split("/"));
      const run = pes(c, "home", next);
      assert.equal(run.code, 1, `${rel}: ${run.out}${run.err}`);
      assert.match(run.err, /서로 안에 들어 있으면 옮길 수 없습니다/, rel);
      assert.equal(existsSync(next), false, `${rel}: 거절한 명령은 새 폴더를 만들지 않는다`);
      assert.equal(cfg_exists(c), false, `${rel}: 거절한 명령은 설정 파일을 쓰지 않는다`);
    });
  }
});

test("H2 `pes home <새> --from <새>/..cache`: 옛 폴더가 새 폴더 안에 있어도 거절", () => {
  with_ctx("pes-sel105-h2-", (c) => {
    const next = join(c.tmp, "h2-new");
    const old = join(next, "..cache");
    mkdirSync(old, { recursive: true });
    const run = pes(c, "home", next, "--from", old);
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.err, /서로 안에 들어 있으면 옮길 수 없습니다/);
    assert.equal(cfg_exists(c), false);
  });
});

test("H3 진짜 안/위 는 계속 거절(`<홈>/sub`·부모), 형제는 계속 허용 — 경계는 그대로, 이름만 구분", () => {
  with_ctx("pes-sel105-h3-", (c) => {
    const home = c.pes_home;
    mkdirSync(home, { recursive: true });
    for (const next of [join(home, "sub"), dirname(home), join(home, "x", "..", "sub")]) {
      const run = pes(c, "home", next);
      assert.equal(run.code, 1, `${next}: ${run.out}${run.err}`);
      assert.match(run.err, /서로 안에 들어 있으면/, next);
    }
    assert.equal(cfg_exists(c), false);
    // 허용: 형제 — `<홈>/../h3-sibling`
    const run = pes(c, "home", join(home, "..", "h3-sibling"));
    assert.equal(run.code, 0, run.out + run.err);
    assert.match(run.out, /h3-sibling/);
    assert.ok(cfg_exists(c));
  });
});

test("H4 `pes home <링크>` — 링크가 옛 홈의 `..cache` 를 가리키면 거절, 바깥을 가리키면 허용", { skip: !LINKS && "symlink 불가" }, () => {
  const ctx2 = make_ctx("pes-sel105-h4-");
  try {
    const home = ctx2.pes_home;
    mkdirSync(join(home, "..cache"), { recursive: true });
    const outside = join(ctx2.tmp, "outside-dir");
    mkdirSync(outside, { recursive: true });
    const into = join(ctx2.tmp, "alias-in");
    const out = join(ctx2.tmp, "alias-out");
    symlinkSync(join(home, "..cache"), into, "dir");
    symlinkSync(outside, out, "dir");
    const refused = pes(ctx2, "home", into);
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.match(refused.err, /서로 안에 들어 있으면/);
    const allowed = pes(ctx2, "home", out);
    assert.equal(allowed.code, 0, allowed.out + allowed.err);
  } finally {
    ctx2.cleanup();
  }
});

test("H5 Windows 구분자: `<홈>\\..cache` 는 거절, `<홈>\\..\\x`(형제)는 허용", { skip: process.platform !== "win32" && "win32 전용" }, () => {
  const ctx2 = make_ctx("pes-sel105-h5-");
  try {
    const home = ctx2.pes_home;
    mkdirSync(home, { recursive: true });
    const dotted = pes(ctx2, "home", `${home}\\..cache`);
    assert.equal(dotted.code, 1, dotted.out + dotted.err);
    const parent = pes(ctx2, "home", `${home}\\..`);
    assert.equal(parent.code, 1, parent.out + parent.err);
    const sibling = pes(ctx2, "home", `${home}\\..\\h5-sibling`);
    assert.equal(sibling.code, 0, sibling.out + sibling.err);
  } finally {
    ctx2.cleanup();
  }
});

// ── E1~E3 serve e2e ───────────────────────────────────────────────────────────────────────────────
const LEG = "leg";
const HTML = "<!doctype html><title>t</title><script>1</script>";

test("E1 serve 정적 응답: `..cache`·`...` 폴더의 파일이 200 + 본문 그대로 (옛 프로젝트 안과 홈 바로 아래)", { timeout: 180_000 }, async () => {
  const fx = await serve_fixture("pes-sel105-e1-", {
    no_db: true,
    legacy_only: [LEG],
    files: {
      [`${LEG}/..cache/a.txt`]: "inside-project",
      [`${LEG}/.../b.txt`]: "dots",
      [`${LEG}/..cache/..x/c.txt`]: "nested",
      "..cache/home-level.txt": "inside-home",
    },
  });
  try {
    for (const [path, body] of [
      [`/${LEG}/..cache/a.txt`, "inside-project"],
      [`/${LEG}/.../b.txt`, "dots"],
      [`/${LEG}/..cache/..x/c.txt`, "nested"],
      [`/..cache/home-level.txt`, "inside-home"],
    ] as const) {
      const answer = await fx.server.request(path);
      assert.equal(answer.status, 200, path);
      assert.equal(answer.text(), body, path);
    }
  } finally {
    await fx.cleanup();
  }
});

test("E2 serve: 진짜 부모 이동(`/../x`·`%2e%2e`·`..%5c`·`..%2f`·`..cache/../..`·바깥 링크)은 여전히 거절 — 홈 밖 파일이 새지 않는다", { timeout: 180_000 }, async () => {
  const fx = await serve_fixture("pes-sel105-e2-", {
    no_db: true,
    legacy_only: [LEG],
    files: { [`${LEG}/..cache/a.txt`]: "ok", "../outside.txt": "OUTSIDE-SECRET" },
  });
  try {
    const targets = [
      "/../outside.txt",
      "/%2e%2e/outside.txt",
      "/..%5coutside.txt",
      "/..%2foutside.txt",
      `/${LEG}/../../outside.txt`,
      `/${LEG}/..cache/../../../outside.txt`,
      `/${LEG}/..cache/%2e%2e/%2e%2e/%2e%2e/outside.txt`,
      `/${LEG}/..cache/..%5c..%5c..%5coutside.txt`,
      "//..//outside.txt",
    ];
    for (const target of targets) {
      const raw = await raw_http(fx.server.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      assert.doesNotMatch(raw.text, /OUTSIDE-SECRET/, `${target} leaked a file outside the PES home`);
    }
    if (LINKS) {
      symlinkSync(join(fx.root, "..", "outside.txt"), join(fx.root, LEG, "..cache", "link-out.txt"));
      const answer = await fx.server.request(`/${LEG}/..cache/link-out.txt`);
      assert.notEqual(answer.status, 200, "홈 밖을 가리키는 링크는 `..cache` 안에서도 거절");
      assert.doesNotMatch(answer.text(), /OUTSIDE-SECRET/);
    }
    assert.equal((await fx.server.request(`/${LEG}/..cache/a.txt`)).status, 200, "대조: 정상 하위 이름은 열린다");
  } finally {
    await fx.cleanup();
  }
});

test("E3 serve: `..cache` 아래 html 은 어디서나 sandbox, 옛 화면 예외(프로젝트 폴더 바로 아래 index.html)는 `..cache` 이름에 흔들리지 않는다 (SEL-102 계약)", { timeout: 180_000 }, async () => {
  const fx = await serve_fixture("pes-sel105-e3-", {
    no_db: true,
    legacy_only: [LEG],
    files: { [`${LEG}/reports/..cache/p.html`]: HTML, [`${LEG}/reports/p.html`]: HTML, [`${LEG}/..cache/p.html`]: HTML, [`${LEG}/..cache/index.html`]: HTML },
  });
  try {
    const csp = async (path: string): Promise<string | undefined> => {
      const answer = await fx.server.request(path);
      assert.equal(answer.status, 200, path);
      const v = answer.headers["content-security-policy"];
      return Array.isArray(v) ? v.join(", ") : v;
    };
    assert.match((await csp(`/${LEG}/reports/p.html`)) ?? "", /sandbox/, "대조: reports/ 의 html 은 sandbox");
    assert.match((await csp(`/${LEG}/reports/..cache/p.html`)) ?? "", /sandbox/, "reports/..cache/ 의 html 도 sandbox");
    // SEL-102: 정적 폴백의 html 은 옛 화면(프로젝트 폴더 바로 아래 index.html·ask-*.html)만 빼고 모두 sandbox — reports 밖도 마찬가지.
    assert.match((await csp(`/${LEG}/..cache/p.html`)) ?? "", /sandbox/, "reports 밖 `..cache` 의 html 도 sandbox(SEL-102)");
    assert.match((await csp(`/${LEG}/..cache/index.html`)) ?? "", /sandbox/, "`..cache/index.html` 은 프로젝트 폴더 바로 아래가 아니라 옛 화면 예외 아님");
  } finally {
    await fx.cleanup();
  }
});
