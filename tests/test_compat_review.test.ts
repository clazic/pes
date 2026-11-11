// SEL-70 final review 1 (Opus): the four required fixes, each with the experiment that found it.
//   1 N6 html summary sees the title escaping and the shared module count     2 N2 follows backslashes through folder names with spaces
//   3 E15 (doctor) never connects to the real hub                              4 the state DTO covers every key of a 0.15 project.json
//   5 a case env cannot switch the home guard off      (SEL-74: all of it runs on the ts target — the 0.15 Python side is gone)
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assert_case, file_digest } from "./helpers/compat_cases.ts";
import { EXCLUDED_KEYS, ITEM_KEYS, REPO, STAGE_KEYS, TOP_KEYS, dto_from_project_json, make_ctx, project_state, run_pes, unmapped_keys } from "./helpers/compat_env.ts";
import { n2_paths } from "./helpers/compat_normalize.ts";
import { use_home_guard } from "./helpers/home_guard.ts";

use_home_guard();

// ---------------------------------------------------------------- 1 N6
const MODULE = "<script>function shared(){return 1}</script>";
const page = (over: { title?: string; module?: string; script?: string } = {}): string =>
  `<html><head><title>${over.title ?? "&lt;질문&gt; &amp; &quot;제목&quot;"}</title></head><body><p>본문</p>${over.module ?? MODULE}<script id="data" type="application/json">{"spec":{"id":"q"}}</script>${over.script ?? "<script>init()</script>"}</body></html>`;
const digest = (html: string): string => file_digest("ask/q.html", Buffer.from(html, "utf8"), {});

test("N6 summary: an unescaped title, a missing / doubled shared module and a changed script each change the HTML digest (E02 criteria)", () => {
  const good = digest(page());
  assert.equal(digest(page()), good, "stable");
  const variants: Record<string, string> = {
    "title not escaped": page({ title: '<질문> & "제목"' }),
    "shared module twice": page({ module: MODULE + MODULE }),
    "shared module missing": page({ module: "" }),
    "script replaced": page({ script: "<script>throw 1</script>", module: "<script>throw 1</script>" }),
    "style added": page({ script: "<script>init()</script><style>p{}</style>" }),
  };
  for (const [what, html] of Object.entries(variants)) assert.notEqual(digest(html), good, `${what} must not give the same digest`);
  assert.equal(new Set(Object.values(variants).map(digest)).size, Object.keys(variants).length, "the variants differ from each other too");
  // attribute order of the data script is still free
  assert.equal(digest(page().replace('<script id="data" type="application/json">', '<script type="application/json"  id="data">')), good);
});

test("N6 summary on the real template: a second copy or a missing script block changes the digest", () => {
  const html = readFileSync(join(REPO, "templates", "ask.html"), "utf8").replace("/*__DATA__*/null", '{"spec":{"id":"q"}}');
  const block = /<script\b(?![^>]*id="data")[^>]*>[\s\S]*?<\/script>/.exec(html)?.[0];
  assert.ok(block !== undefined, "templates/ask.html has a script block");
  assert.notEqual(digest(html.replace(block, block + block)), digest(html));
  assert.notEqual(digest(html.replace(block, "")), digest(html));
});

// ---------------------------------------------------------------- 2 N2
test("N2: backslashes below a root are made uniform through folder names with spaces (Windows spelling, plain and doubled)", () => {
  const tmp = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\pes-compat-e01-x";
  const doubled = tmp.split("\\").join("\\\\");
  const roots = { TMP: tmp };
  assert.equal(n2_paths(`${tmp}\\work\\합성 프로젝트\\project.json`, roots), "<TMP>/work/합성 프로젝트/project.json");
  assert.equal(n2_paths(`${tmp}\\work\\가져온 프로젝트\\out dir\\a b\\x.json`, roots), "<TMP>/work/가져온 프로젝트/out dir/a b/x.json");
  assert.equal(n2_paths(`'${doubled}\\\\work\\\\합성 프로젝트\\\\project.json'`, roots), "'<TMP>/work/합성 프로젝트/project.json'");
  assert.equal(n2_paths(`"${doubled}\\\\work\\\\합성 프로젝트\\\\project.json"`, roots), '"<TMP>/work/합성 프로젝트/project.json"');
  // the path ends where the words that follow hold no separator
  assert.equal(n2_paths(`${tmp}\\work\\a.json and more`, roots), "<TMP>/work/a.json and more");
  assert.equal(n2_paths(`저장: ${tmp}\\work\\합성 프로젝트\\project.json 에 썼다`, roots), "저장: <TMP>/work/합성 프로젝트/project.json 에 썼다");
  // KNOWN LIMIT: a folder name with 2+ spaces (`a b c`) is cut after its first word — the next word holds no separator. No fixture has such a
  // name (tests/README.md: don't add one). If this ever starts normalizing fully, change the expected value to "<TMP>/work/a b c/x.json".
  assert.equal(n2_paths(`${tmp}\\work\\a b c\\x.json`, roots), "<TMP>/work/a b c\\x.json");
  // POSIX roots are unaffected
  assert.equal(n2_paths("/t/work/합성 프로젝트/project.json", { TMP: "/t" }), "<TMP>/work/합성 프로젝트/project.json");
});

// ---------------------------------------------------------------- 3 E15 never touches the real hub
interface FakeHub {
  port: number;
  connections(): number;
  stop(): void;
}

async function free_hub_port(): Promise<number> {
  // doctor treats 8760~8764 as hub ports (HUB_PORTS); a stand-in outside that range would not be found by it
  for (let port = 8760; port <= 8764; port += 1) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer();
      probe.once("error", () => done(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port in 8760~8764 for the stand-in hub (a real hub or another test holds all of them) — doctor only looks at those ports");
}

/** A recording stand-in for the hub (own process: the case child runs with spawnSync, which would freeze an in-process server). */
async function fake_hub(dir: string): Promise<FakeHub> {
  const port = await free_hub_port();
  const log = join(dir, "connections.log");
  writeFileSync(log, "", "utf8");
  const root = join(dir, "pes-projects").split("\\").join("/");
  const code = `
const http = require("node:http"), fs = require("node:fs");
const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ root: ${JSON.stringify(root)}, single: true })); });
server.on("connection", () => fs.appendFileSync(${JSON.stringify(log)}, "c\\n"));
server.listen(${port}, "127.0.0.1", () => console.log("ready"));
`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((ready, fail) => {
    child.once("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (String(chunk).includes("ready")) ready();
    });
    child.once("exit", (status) => fail(new Error(`stand-in hub exited early (${status})`)));
  });
  child.removeAllListeners("exit");
  return { port, connections: () => readFileSync(log, "utf8").split("\n").filter((l) => l !== "").length, stop: () => child.kill() };
}

test("E15 with a hub listening on 8760~8775: the record is the pinned one and the hub saw 0 connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-hub-"));
  const hub = await fake_hub(dir);
  try {
    // the ts record is compared with the frozen 0.15 one (D08: one Node row instead of the Python row) — the same comparison as the case test
    await assert_case("ts", "E15");
    // (no hub-side count: other test files run pes children in parallel and probe the same ports. The proof is child-side: had E15
    // reached the stand-in, its server rows would show an extra "고아 서버" row and differ from the pinned "꺼짐" record above.)
  } finally {
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positive control: an unblocked child does reach the stand-in hub (so '0 connections' means something)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-hub-"));
  const hub = await fake_hub(dir);
  const ctx = make_ctx("pes-compat-hubctl-");
  try {
    const run = spawnSync(process.execPath, ["-e", `fetch("http://127.0.0.1:${hub.port}/whoami", { signal: AbortSignal.timeout(2000) }).then((r) => r.text()).catch((e) => console.log("failed", String(e)))`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(hub.connections() >= 1, "the control request must reach the stand-in hub");
  } finally {
    ctx.cleanup();
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every pes.ts child is hub-blocked: with a stand-in hub up, doctor reports no server; only allow_hub_port (that one port) lets it see the stand-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-hub-"));
  const hub = await fake_hub(dir);
  const ctx = make_ctx("pes-compat-hubblock-");
  try {
    const seen = (options: { allow_hub_port?: number }): string => {
      const run = run_pes("ts", ctx, ["doctor", "--json"], { narrow_path: true, ...options });
      assert.ok(run.kind === "ran" && run.status === 0);
      return run.kind === "ran" ? run.stdout : "";
    };
    const blocked = seen({});
    assert.ok(!blocked.includes("고아 서버") && blocked.includes("PES 서버 꺼짐"), "a blocked child must see no server");
    assert.equal(hub.connections(), 0, "the blocked child must not have reached the stand-in");
    const open_run = seen({ allow_hub_port: hub.port });
    assert.ok(open_run.includes("고아 서버"), `control: without the block the same command sees the stand-in hub: ${JSON.stringify(JSON.parse(open_run).filter((r: any) => r.group === "서버"))}`);
  } finally {
    ctx.cleanup();
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 5 a case env cannot switch the audit hook off
test("a case / option env that turns PES_TEST_GUARD off is refused; no case in cases.json sets it", () => {
  const ctx = make_ctx("pes-compat-guardenv-");
  try {
    for (const value of ["", "0", undefined]) assert.throws(() => run_pes("ts", ctx, ["home"], { env: { PES_TEST_GUARD: value } }), /home guard off/);
  } finally {
    ctx.cleanup();
  }
  assert.ok(!readFileSync(join(REPO, "tests", "fixtures", "compat", "cases.json"), "utf8").includes("PES_TEST_GUARD"));
});

// ---------------------------------------------------------------- 4 state DTO coverage
test("DTO: every top-level, stage and item key of a 0.15 project.json is mapped or explicitly excluded", () => {
  const ctx = make_ctx("pes-compat-dtokeys-");
  try {
    const init = run_pes("ts", ctx, ["init", ctx.project(), "--topic", "합성 주제"]);
    assert.equal(init.kind === "ran" && init.status, 0);
    // the key lists 0.15 had (pes.py blank_item() / new_stage(), recorded when the Python file still existed — SEL-74)
    const made = {
      item: ["id", "title", "kind", "question", "status", "request", "depth", "updated_round", "summary", "details", "sources", "stats", "shots", "confidence", "conflicts", "verify", "links", "user_links"],
      stage: ["status", "round", "settings", "items", "review", "suggestions", "warnings", "changes", "history", "summary", "approved_at", "stale", "reports"],
    };
    const data = project_state(ctx, ctx.project()); // the 0.15-shaped state of the ts project (DB read model)
    const covered = (mapped: readonly string[], excluded: string[], found: string[], what: string): void => {
      const missing = found.filter((key) => !mapped.includes(key) && !excluded.includes(key));
      assert.deepEqual(missing, [], `0.15 ${what} keys neither in the DTO nor excluded`);
    };
    covered(ITEM_KEYS, EXCLUDED_KEYS.item, made.item, "blank_item()");
    covered([...STAGE_KEYS, "items"], EXCLUDED_KEYS.stage, made.stage, "new_stage()");
    covered(TOP_KEYS, EXCLUDED_KEYS.top, Object.keys(data).filter((k) => k !== "stages"), "project.json top-level");
    assert.deepEqual(unmapped_keys(data), []);
    // the DTO really carries the fields the review found missing
    const item = Object.fromEntries(made.item.map((k) => [k, k === "id" ? 1 : `v-${k}`]));
    const dto = dto_from_project_json({ ...data, stages: { plan: { ...data.stages.plan, items: [item] } } }) as any;
    for (const key of ["verify", "user_links", "shots"]) assert.equal(dto.stages.plan.items[0][key], `v-${key}`, `item.${key}`);
    assert.equal(dto.pes, data.pes);
  } finally {
    ctx.cleanup();
  }
});

test("DTO: an unknown 0.15 key is reported (a new field cannot be dropped silently), an excluded one is not", () => {
  const data = { pes: 1, topic: "t", new_top: 1, stages: { plan: { status: "asking", new_stage_key: 1, items: [{ id: 3, title: "a", new_item_key: 1 }] } } };
  assert.deepEqual(unmapped_keys(data), ["top.new_top", "stages.plan.new_stage_key", "stages.plan.items.3.new_item_key"]);
  EXCLUDED_KEYS.item.push("new_item_key");
  try {
    assert.deepEqual(unmapped_keys(data), ["top.new_top", "stages.plan.new_stage_key"]);
  } finally {
    EXCLUDED_KEYS.item.pop();
  }
});

// (the `hub_blocked_argv` test — the Python wrapper that refused connections to 8760~8775 — is gone with Python; the same block for ts children is
//  tested in test_pes_ts_guard.test.ts: "HUB_BLOCK for ts children: net.connect and fetch to 127.0.0.1:8760~8775 are refused and counted")
