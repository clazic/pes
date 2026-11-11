// Harness for the CLI write-conversion tests (stage 2 PR15, SEL-48). Everything is synthetic.
//
// How the CLI is run: as a subprocess, `node scripts/pes.ts <args>` (behind the TS child guard), with HOME, USERPROFILE and
// PES_HOME all pointing at the temporary folders of an isolated_home. The database is the one at
// HOME/.pes/pes.db, bootstrapped by the test through the command service; the project folder is
// PES_HOME/<slug> and holds a legacy project.json fixture whose bytes and mtime must never change.
//
// There is no flag any more (SEL-74: the 0.15 Python CLI is gone, pes.ts always writes through the command service).
//
// Credentials (pinned by these tests):
//   no PES_TOKEN  -> the CLI acts as the human owner of the local database (via = "cli")
//   PES_TOKEN=<agent token from the PR10 token command> -> the CLI acts as that agent actor
//   PES_OWNER=<session id>  -> the lock session of the old CLI (lock/unlock/--force semantics)
// The five new commands print one JSON object on stdout and take their guard as flags:
//   --run <run_id> --lease <lease_id> --fence <n>

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { issue_agent_token } from "../../scripts/pes_core/actors.ts";
import { make_env, type Env } from "./blob_env.ts";
import { stage_ids, type StageKey } from "./editions_env.ts";
import { ts_run } from "./sel74_env.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..", "..");
export const SLUG = "synthetic-files";

export const LEGACY_JSON = JSON.stringify(
  { pes: 1, topic: "합성 옛 주제", slug: SLUG, current: "plan", processed: [], notes: [], stages: {} },
  null,
  1,
);

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Commit {
  id: string;
  action: string;
  via: string;
  actor_id: string;
  run_id: string | null;
  lease_id: string | null;
  fence: bigint | null;
}

export interface FileSig {
  exists: boolean;
  sha: string;
  mtime_ms: number;
}

export interface CliEnv {
  env: Env;
  slug: string;
  folder: string;
  project_json: string;
  stages: Record<StageKey, string>;
  run(args: string[], extra?: Record<string, string | undefined>): CliResult;
  commits(): Commit[];
  /** Commits made after `before` (a previous commits().length). */
  commits_since(before: number): Commit[];
  sig(path: string): FileSig;
  listing(dir: string): string[];
  agent(name: string, scopes?: readonly string[]): Promise<{ actor_id: string; token: string }>;
  close(): void;
}

export async function make_cli_env(): Promise<CliEnv> {
  const env = await make_env();
  // The CLI checks token expiry against the real clock, so issue tokens at "now", not at the fake start date.
  env.clock.advance(Math.max(0, Date.now() - env.clock.now_ms()));
  const pes_home = env.home.env.PES_HOME as string;
  assert.ok(pes_home && !pes_home.includes("pes-projects/../"), "PES_HOME is the isolated folder");
  const folder = join(pes_home, SLUG);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "project.json"), LEGACY_JSON, "utf8");
  const project_json = join(folder, "project.json");
  const stages = stage_ids(env.db, env.p.edition_id);
  let seq = 0;

  const sig = (path: string): FileSig => {
    if (!existsSync(path)) return { exists: false, sha: "", mtime_ms: 0 };
    return {
      exists: true,
      sha: createHash("sha256").update(readFileSync(path)).digest("hex"),
      mtime_ms: statSync(path).mtimeMs,
    };
  };

  const commits = (): Commit[] =>
    env.db
      .all<Commit>(
        "SELECT id, action, via, actor_id, run_id, lease_id, fence FROM mutation_commits ORDER BY rowid",
      )
      .map((row) => ({ ...row }));

  return {
    env,
    slug: SLUG,
    folder,
    project_json,
    stages,
    run(args, extra = {}) {
      // PES_OWNER / PES_TOKEN never leak in from the caller (ts_run scrubs them unless `extra` names them). PES_DB_CORE is gone
      // (there is no 0.15 mode any more) and is ignored when a test still passes it.
      const { PES_DB_CORE: _flag, ...rest } = extra;
      assert.equal(env.home.env.HOME, env.home.env.USERPROFILE, "the CLI runs in the isolated HOME");
      return ts_run({ env }, args, rest);
    },
    commits,
    commits_since: (before) => commits().slice(before),
    sig,
    listing(dir) {
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    },
    async agent(name, scopes = ["context:read", "run:claim", "run:submit", "file:write", "file:read"]) {
      seq += 1;
      const actor_id = `agent-${name}`;
      const owner = env.db.get<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM projects WHERE id = ?",
        env.p.project_id,
      );
      assert.ok(owner);
      env.db.run(
        "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)",
        actor_id,
        owner.owner_user_id,
        `합성 ${name}`,
      );
      const out = await issue_agent_token(env.service, env.ctx(`cli-token-${name}-${seq}`), {
        actor_id,
        scopes: [...scopes],
      });
      return { actor_id, token: (out.result as { token: string }).token };
    },
    close: () => env.close(),
  };
}

export async function with_cli(fn: (c: CliEnv) => Promise<void> | void): Promise<void> {
  const c = await make_cli_env();
  try {
    await fn(c);
  } finally {
    c.close();
  }
}

/** The one JSON object the five new commands print. */
export function json_out(result: CliResult): any {
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout.trim());
}

export function expect_rejected(result: CliResult, what: string): void {
  assert.notEqual(result.status, 0, `${what}: the CLI must refuse (stdout: ${result.stdout})`);
  assert.doesNotMatch(result.stderr, /Traceback|SyntaxError|ModuleNotFoundError/, `${what}: a refusal, not a crash`);
}
