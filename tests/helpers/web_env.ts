// Harness for the local-screen DB/API conversion tests (stage 2 PR18, SEL-51). Everything is synthetic.
//
// What it gives the tests:
//   - start_server(): `python3 -I -X utf8 scripts/serve.py <PES_HOME> <port>` in an isolated HOME / USERPROFILE / PES_HOME
//     (the same isolation as run_py), optional PES_DB_CORE flag, a known PES_LOCAL_SESSION_SECRET, and a stop() that kills it.
//     `-X utf8` because `python -I` ignores PYTHONIOENCODING (Windows pipes default to cp1252).
//   - http(): fetch with explicit Origin (undici allows it; a browser would not) and no redirect following.
//   - page_data(): the JSON a template embeds (`<script id="data" type="application/json">`).
//   - normalize_data() / subset_diffs(): a semantic comparison of two such blobs. "Same screen" means every fact the
//     v0.15 blob carries is also in the DB-backed blob (the DB blob may carry more); times, built stamps, file names and
//     roots are normalised away. No pixel comparison anywhere.
//   - ASK_SPEC: one question form that covers __other, show_if, required and recommended.
//   - CRLF: every file read back goes through read_lf (Windows text mode).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { make_cli_env, PES_PY, SLUG, type CliEnv } from "./cli_write_env.ts";
import { PY, plain_legacy, root_forms, run_py, seed, write_json, write_legacy, type HomeLike } from "./cli_read_env.ts";
import { hub_blocked_argv } from "./hub_block.ts";

export const SERVE_PY = join(PES_PY, "..", "serve.py");
/** The last main commit whose screens (render / ask / hub / serve) are pure v0.15. */
export const WEB_BASELINE_REF = "36bc6a2";
export const SESSION_SECRET = "synthetic-owner-session-secret-sel51";

export function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export interface Server {
  port: number;
  origin: string;
  url: string;
  stop(): Promise<void>;
}

export interface ServerOptions {
  /** PES_DB_CORE value; "1" by default. undefined runs the server as v0.15. */
  flag?: string | undefined;
  /** Another serve.py (a baseline checkout). */
  script?: string;
  extra?: Record<string, string | undefined>;
}

/** Start serve.py for the isolated home of `c` and wait until /ping answers. Always stop() it (finally). */
export async function start_server(c: HomeLike, opts: ServerOptions = {}): Promise<Server> {
  const port = await free_port();
  const env: Record<string, string | undefined> = {
    ...c.env.home.env,
    PES_OWNER: undefined,
    PES_TOKEN: undefined,
    PES_DB_CORE: "flag" in opts ? opts.flag : "1",
    PES_LOCAL_SESSION_SECRET: SESSION_SECRET,
    ...opts.extra,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  assert.equal(env.HOME, c.env.home.env.HOME, "the server runs in the isolated HOME");
  assert.equal(env.USERPROFILE, c.env.home.env.HOME);
  assert.ok(env.PES_HOME !== undefined && env.PES_HOME.length > 0, "PES_HOME is set (isolated)");
  const child: ChildProcess = spawn(PY, hub_blocked_argv(["-I", "-X", "utf8", opts.script ?? SERVE_PY, env.PES_HOME as string, String(port)]), {
    env: env as NodeJS.ProcessEnv,
    cwd: c.env.home.root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const url = `http://127.0.0.1:${port}`;
  const server: Server = {
    port,
    origin: url,
    url,
    async stop() {
      if (exited) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
        setTimeout(resolve, 3000).unref();
      });
    },
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`serve.py exited early: ${stderr}`);
    try {
      const res = await fetch(`${url}/ping`);
      if (res.ok) return server;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await server.stop();
  throw new Error(`serve.py did not start in 30 s: ${stderr}`);
}

export async function with_server<T>(c: HomeLike, opts: ServerOptions, fn: (s: Server) => Promise<T>): Promise<T> {
  const server = await start_server(c, opts);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

export interface Http {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

export interface HttpOptions {
  method?: string;
  /** Origin header. undefined = the server's own origin, null = send none. */
  origin?: string | null;
  headers?: Record<string, string>;
  body?: string;
}

export async function http(server: Server, path: string, opts: HttpOptions = {}): Promise<Http> {
  const headers: Record<string, string> = { ...opts.headers };
  const origin = opts.origin === undefined ? (opts.method && opts.method !== "GET" ? server.origin : null) : opts.origin;
  if (origin !== null) headers.Origin = origin;
  const res = await fetch(`${server.url}${path}`, { method: opts.method ?? "GET", headers, body: opts.body, redirect: "manual" });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, text, json };
}

export function post_feedback(server: Server, slug: string, body: unknown, opts: HttpOptions = {}): Promise<Http> {
  return http(server, `/${slug}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Page data

/** The JSON a template embeds. Throws when the page has none. */
export function page_data(html: string): any {
  const m = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, "the page embeds its data (<script id=\"data\" type=\"application/json\">)");
  return JSON.parse(m![1]!);
}

/** Keys whose values are clocks, file names or paths, not content. */
const VOLATILE_KEYS = new Set(["built", "built_date", "reports_built", "time", "updated", "file", "path", "root", "bytes", "since"]);

export function normalize_data(value: unknown, roots: string[]): unknown {
  const all = roots.flatMap(root_forms).sort((x, y) => y.length - x.length);
  const text = (s: string): string => {
    let out = s;
    for (const root of all) out = out.split(root).join("<ROOT>");
    return out
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?/g, "<TS>")
      .replace(/\d{8}-\d{6}/g, "<STAMP>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!VOLATILE_KEYS.has(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/**
 * Every fact in `old` must be in `now` (objects: every key of old, recursively; arrays: same length, element-wise;
 * scalars: equal). `now` may carry more. Returns the differences (empty = same screen).
 */
export function subset_diffs(old: unknown, now: unknown, path = "$"): string[] {
  if (old === null || typeof old !== "object") return Object.is(old, now) || old === now ? [] : [`${path}: ${JSON.stringify(old)} != ${JSON.stringify(now)}`];
  if (Array.isArray(old)) {
    if (!Array.isArray(now)) return [`${path}: array expected`];
    if (old.length !== now.length) return [`${path}: length ${old.length} != ${now.length}`];
    return old.flatMap((x, i) => subset_diffs(x, now[i], `${path}[${i}]`));
  }
  if (now === null || typeof now !== "object" || Array.isArray(now)) return [`${path}: object expected`];
  return Object.entries(old as Record<string, unknown>).flatMap(([k, v]) =>
    k in (now as object) ? subset_diffs(v, (now as Record<string, unknown>)[k], `${path}.${k}`) : [`${path}.${k}: missing`],
  );
}

export function expect_same_screen(old: unknown, now: unknown, what: string): void {
  const diffs = subset_diffs(old, now);
  assert.deepEqual(diffs.slice(0, 12), [], `${what}: DB 화면이 v0.15 화면과 다르다 (${diffs.length}곳)`);
}

// ---------------------------------------------------------------------------
// Synthetic project

/** One form with every question feature: recommended, __other, show_if, required, multi, text, textarea. */
export const ASK_SPEC = {
  id: "plan-start",
  stage: "plan",
  stage_label: "기획",
  kind: "stage_start",
  title: "기획 시작 질문",
  intro: "합성 안내문",
  questions: [
    {
      id: "scope",
      type: "single",
      label: "범위는?",
      required: true,
      other: true,
      options: [
        { value: "narrow", label: "좁게", recommended: true },
        { value: "wide", label: "넓게" },
      ],
    },
    {
      id: "channels",
      type: "multi",
      label: "채널은?",
      options: [
        { value: "web", label: "웹", recommended: true },
        { value: "print", label: "인쇄" },
      ],
    },
    { id: "why-wide", type: "text", label: "넓게 하는 이유는?", show_if: { id: "scope", in: ["wide"] } },
    { id: "memo", type: "textarea", label: "덧붙일 조건", required: true },
  ],
};

export const ASK_ANSWERS = { scope: "wide", channels: ["web"], "why-wide": "합성 이유", memo: "합성 메모", scope__other: "합성 기타" };

export function feedback_body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    round: 0,
    kind: "stage_start",
    stage: "plan",
    spec: "plan-start",
    text: "[단계 시작 질문 · 기획]\n범위는?: 넓게",
    answers: ASK_ANSWERS,
    note: "",
    ...over,
  };
}

export function write_spec(c: CliEnv, spec: unknown = ASK_SPEC, name = "ask-spec.json"): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(spec), "utf8");
  return file;
}

/** Files directly under a project's feedback/ folder (answers v0.15 wrote there). */
export function feedback_files(c: CliEnv): string[] {
  const dir = join(c.folder, "feedback");
  return existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")).sort() : [];
}

export function ensure_dir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function read_text_lf(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** Run a pes.py step in the DB (flag "1") or v0.15 (undefined) mode and require success. */
export function step(c: CliEnv, flag: string | undefined, args: string[], script?: string): string {
  const res = run_py(c, args, { flag, ...(script !== undefined ? { script } : {}) });
  assert.equal(res.status, 0, `${args.join(" ")}: exit ${res.status}\n${res.stderr}${res.stdout}`);
  return res.stdout;
}

// ---------------------------------------------------------------------------
// Shared setups of the test_web_*.test.ts files

export const REPO = join(import.meta.dirname, "..", "..");

export function roots_of(c: CliEnv, extra: string[] = []): string[] {
  return [c.env.home.root, `/private${c.env.home.root}`, REPO, ...extra];
}

/** DB 로 서비스하는 프로젝트 폴더에는 project.json 이 없다(pes.py init 이 만든 폴더). make_cli_env 가 깐 옛 파일을 지운다. */
export function rm_default_json(c: CliEnv): void {
  unlinkSync(c.project_json);
}

/** 기획 R1 을 봉인한 뒤 R2: 항목 둘을 보강하고 다시 봉인한다 — 타임라인·항목×라운드(스냅샷 2개 이상)가 보이게. */
export function second_round(c: CliEnv, flag: string | undefined): void {
  step(c, flag, ["round-start", SLUG, "plan"]);
  step(c, flag, ["merge", SLUG, "plan", write_json(c, "r2.json", [{ id: 2, kind: "topic", title: "합성 기획 항목 둘", summary: "합성 요약 둘 (보강)", status: "done" }])]);
  step(c, flag, ["render", SLUG, "plan"]);
}

/** v0.15: 시작 질문 폼 → 기획 라운드 1 → 항목 합치기 → 노트 → 단계 봉인·화면. 모두 project.json 으로. */
export async function build_old(): Promise<CliEnv> {
  const c = await make_cli_env();
  write_legacy(c.folder, plain_legacy(SLUG));
  step(c, undefined, ["ask", SLUG, write_spec(c)]);
  seed(c, undefined);
  writeFileSync(join(c.folder, "..", ".pes-hub"), "1", "utf8"); // render 가 홈 허브도 다시 짓는다 (v0.15)
  step(c, undefined, ["render", SLUG, "plan"]);
  second_round(c, undefined);
  return c;
}

/** 같은 일을 DB 로(PES_DB_CORE=1). 폴더의 project.json 은 다른 주제의 옛 파일로 남아 있다 — 화면이 그것을 읽으면 틀린다. */
export async function build_db(): Promise<CliEnv> {
  const c = await make_cli_env();
  step(c, "1", ["ask", SLUG, write_spec(c)]);
  seed(c, "1");
  writeFileSync(join(c.folder, "..", ".pes-hub"), "1", "utf8");
  step(c, "1", ["render", SLUG, "plan"]); // DB 에서는 단계 봉인(스냅샷)이다. 같은 라운드에 두 번째 render 는 이미 봉인돼 거절될 수 있다.
  second_round(c, "1");
  return c;
}

export interface Pages {
  dash: any;
  ask: any;
  hub: any;
}

/**
 * 사용자가 보는 화면 = 서버가 내주는 페이지. 파일로 미리 지어 두든 요청 때 DB 에서 짓든 구현의 선택이다 —
 * 시험은 같은 URL 로 받은 페이지가 품은 데이터만 본다. (v0.15 는 render·ask·hub 가 지은 파일을 정적으로 서빙한다.)
 */
export async function pages(c: CliEnv, flag: string | undefined): Promise<Pages> {
  return with_server(c, { flag }, async (s) => {
    const get = async (path: string) => {
      const r = await http(s, path);
      assert.equal(r.status, 200, `${path}: ${r.status}`);
      return page_data(r.text);
    };
    return { dash: await get(`/${SLUG}/`), ask: await get(`/${SLUG}/ask-plan-start.html`), hub: await get("/") };
  });
}

/** DB 프로젝트 하나(project.json 없음) + 시작 질문 폼 + 기획 라운드 1 + 봉인. */
export async function db_with_form(): Promise<CliEnv> {
  const c = await make_cli_env();
  rm_default_json(c);
  step(c, "1", ["ask", SLUG, write_spec(c)]);
  seed(c, "1");
  writeFileSync(join(c.folder, "..", ".pes-hub"), "1", "utf8");
  step(c, "1", ["render", SLUG, "plan"]);
  second_round(c, "1");
  return c;
}

export const sub_count = (c: CliEnv): number => Number(c.env.db.get<{ n: number | bigint }>("SELECT count(*) AS n FROM submissions")!.n);
export const commit_count = (c: CliEnv): number => c.commits().length;
export const pending_names = (c: CliEnv): string[] =>
  step(c, "1", ["pending", SLUG]).split("\n").map((x) => x.trim()).filter(Boolean).map((x) => x.split(/[\\/]/).pop()!);

export { SLUG };

/**
 * 대시보드 템플릿의 한 가지 의도된 차이(leader 결정, SEL-51 보강): 항목 path·shots 링크를 safeUrl/safeRel 로 거르는 보안 수정.
 * 기준본(36bc6a2)과 다른 줄이 있어도 그 줄들이 모두 path·shots·safeUrl 을 다루는 줄일 때만 같다고 본다. 그 밖의 차이는 그대로 실패.
 */
export function url_fix_diffs(old_text: string, now_text: string): string[] {
  if (old_text === now_text) return [];
  const count = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const line of text.split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(old_text);
  const b = count(now_text);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, n] of a) for (let i = 0; i < n - (b.get(line) ?? 0); i += 1) removed.push(line);
  for (const [line, n] of b) for (let i = 0; i < n - (a.get(line) ?? 0); i += 1) added.push(line);
  const about_urls = /\bit\.path\b|\bshots\b|\bsafeUrl\b|\bsafeRel\b|\.path\b/;
  const out: string[] = [];
  if (removed.length > 6 || added.length > 8) out.push(`다른 줄이 너무 많다(없어짐 ${removed.length}, 생김 ${added.length})`);
  for (const line of removed) if (!about_urls.test(line)) out.push(`기준본 줄이 URL 수정과 무관하게 바뀜: ${line.slice(0, 120)}`);
  for (const line of added) if (!about_urls.test(line)) out.push(`새 줄이 URL 수정과 무관: ${line.slice(0, 120)}`);
  if (!added.some((line) => /\bsafe(Url|Rel)\b/.test(line))) out.push("새 줄 어디에도 safeUrl/safeRel 이 없다");
  return out;
}
