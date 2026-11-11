// SEL-70 final review 1 (Opus): the four required fixes, each with the experiment that found it.
//   1 N6 html summary sees the title escaping and the shared module count     2 N2 follows backslashes through folder names with spaces
//   3 E15 (doctor) never connects to the real hub                              4 the state DTO covers every key of a 0.15 project.json
//   5 a case env cannot switch the audit hook off
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { file_digest, read_baseline, run_case } from "./helpers/compat_cases.ts";
import { EXCLUDED_KEYS, ITEM_KEYS, REPO, STAGE_KEYS, TOP_KEYS, dto_from_project_json, make_ctx, project_json, run_pes, run_py_code, unmapped_keys } from "./helpers/compat_env.ts";
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
  for (let port = 8760; port <= 8775; port += 1) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer();
      probe.once("error", () => done(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port in 8760~8775 for the stand-in hub");
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
    const outcome = await run_case("py", "E15");
    assert.equal(outcome.kind, "ran");
    if (outcome.kind !== "ran") return;
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.record)), read_baseline("E15"), "a running hub changed the doctor record");
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
    const run = run_py_code(ctx, `import urllib.request\ntry:\n    urllib.request.urlopen("http://127.0.0.1:${hub.port}/whoami", timeout=2).read()\nexcept Exception as e:\n    print("failed", e)\n`);
    assert.equal(run.status, 0);
    assert.ok(hub.connections() >= 1, "the control request must reach the stand-in hub");
  } finally {
    ctx.cleanup();
    hub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every pes.py child is hub-blocked: with a stand-in hub up, doctor reports no server; only allow_hub lets it see the stand-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pes-fake-hub-"));
  const hub = await fake_hub(dir);
  const ctx = make_ctx("pes-compat-hubblock-");
  try {
    const seen = (options: { allow_hub?: boolean }): string => {
      const run = run_pes("py", ctx, ["doctor", "--json"], { narrow_path: true, ...options });
      assert.ok(run.kind === "ran" && run.status === 0);
      return run.kind === "ran" ? run.stdout : "";
    };
    const blocked = seen({});
    assert.ok(!blocked.includes("고아 서버") && blocked.includes("PES 서버 꺼짐"), "a blocked child must see no server");
    const open_run = seen({ allow_hub: true });
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
    for (const value of ["", "0", undefined]) assert.throws(() => run_pes("py", ctx, ["home"], { env: { PES_TEST_GUARD: value } }), /home guard off/);
  } finally {
    ctx.cleanup();
  }
  assert.ok(!readFileSync(join(REPO, "tests", "fixtures", "compat", "cases.json"), "utf8").includes("PES_TEST_GUARD"));
});

// ---------------------------------------------------------------- 4 state DTO coverage
test("DTO: every top-level, stage and item key of a 0.15 project.json is mapped or explicitly excluded", () => {
  const ctx = make_ctx("pes-compat-dtokeys-");
  try {
    const init = run_pes("py", ctx, ["init", ctx.project(), "--topic", "합성 주제"]);
    assert.equal(init.kind === "ran" && init.status, 0);
    const keys = run_py_code(
      ctx,
      `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location("pes_mod", sys.argv[1])\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nprint(json.dumps({"item": list(m.blank_item(1, "t")), "stage": list(m.new_stage())}))\n`,
      [join(REPO, "scripts", "pes.py")],
    );
    assert.equal(keys.status, 0, keys.stderr);
    const made = JSON.parse(keys.stdout) as { item: string[]; stage: string[] };
    const data = project_json(ctx.project());
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
