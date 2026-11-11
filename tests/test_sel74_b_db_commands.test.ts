// SEL-74 B — the five DB-only commands (context · claim · submit · wait · complete) exist in scripts/pes.ts.
// The 0.15 pes.py had them only on its PES_DB_CORE=1 path (arguments, one JSON line on stdout, exit codes); pes.ts must give the same
// arguments, output and exit codes WITHOUT any flag. Written before the code: they fail until `node scripts/pes.ts claim …` exists.
// Fixture: make_cli_env() — a DB project (isolated HOME) + a folder whose 0.15 project.json must never change. Credentials: no PES_TOKEN =
// the human owner of the local DB; PES_TOKEN=<agent token> = that agent. PES_OWNER is a lock label, never a credential.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { new_artifact } from "./helpers/blob_env.ts";
import { expect_rejected, json_out, with_cli, type CliEnv, SLUG } from "./helpers/cli_write_env.ts";
import { start } from "./helpers/editions_env.ts";
import { use_home_guard } from "./helpers/home_guard.ts";
import { ts_run } from "./helpers/sel74_env.ts";
import { state_signature, table_counts } from "./helpers/state_signature.ts";

use_home_guard();

function write_json(c: CliEnv, name: string, value: unknown): string {
  const file = join(c.env.home.root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

function guard_of(out: { run_id: string; lease_id: string; fence: string | number }): string[] {
  return ["--run", out.run_id, "--lease", out.lease_id, "--fence", String(out.fence)];
}

test("B1: one round with an agent token — context (no receipt) · claim · submit · wait · re-claim --run · old fence refused · complete; project.json never written", () =>
  with_cli(async (c) => {
    const agent = await c.agent("worker");
    await start(c.env, c.stages.plan, "b1-start");
    const art = await new_artifact(c.env, "b1-artifact");
    const tok = { PES_TOKEN: agent.token };
    const project_json = c.sig(c.project_json);

    const receipts = c.commits().length;
    const context_run = ts_run(c, ["context", SLUG], tok);
    const context = json_out(context_run);
    assert.match(context.digest, /^[0-9a-f]{64}$/, "context prints one JSON object with a sha256 digest");
    assert.equal(context.lease, null);
    assert.equal(c.commits().length, receipts, "context is a read — no receipt");
    expect_rejected(ts_run(c, ["context", SLUG], { PES_TOKEN: "garbage-token" }), "garbage token");

    const before = c.commits().length;
    const claimed = json_out(ts_run(c, ["claim", SLUG], tok));
    assert.match(String(claimed.fence), /^[1-9][0-9]*$/);
    const claim_commit = c.commits_since(before).find((m) => m.action === "run.claimed");
    assert.ok(claim_commit, "a run.claimed receipt");
    assert.equal(claim_commit.via, "cli");
    assert.equal(claim_commit.actor_id, agent.actor_id, "the token holder is the actor, not the owner");
    const guard = guard_of(claimed);

    const results = write_json(c, "b1-results.json", [{ op: "append_version", object_id: art.object_id, title: "CLI 결과" }]);
    const n_submit = c.commits().length;
    json_out(ts_run(c, ["submit", SLUG, ...guard, "--file", results], tok));
    const submitted = c.commits_since(n_submit).find((m) => m.action === "result.submitted");
    assert.ok(submitted, "a result.submitted receipt");
    assert.equal(submitted.actor_id, agent.actor_id);
    assert.equal(submitted.run_id, claimed.run_id);
    assert.equal(submitted.lease_id, claimed.lease_id);
    assert.equal(String(submitted.fence), String(claimed.fence));

    // `{"results": [...]}` is accepted as well as a bare array
    const wrapped = write_json(c, "b1-wrapped.json", { results: [{ op: "append_version", object_id: art.object_id, title: "감싼 결과" }] });
    json_out(ts_run(c, ["submit", SLUG, ...guard, "--file", wrapped], tok));

    const waited = json_out(ts_run(c, ["wait", SLUG, ...guard, "--reason", "waiting_human"], tok));
    assert.equal(waited.status, "waiting_human");

    const claim2 = json_out(ts_run(c, ["claim", SLUG, "--run", claimed.run_id], tok));
    assert.equal(String(claim2.fence), String(BigInt(claimed.fence) + 1n), "resuming is a new claim — fence + 1");
    const n = c.commits().length;
    expect_rejected(ts_run(c, ["submit", SLUG, ...guard, "--file", results], tok), "old fence submit");
    assert.equal(c.commits().length, n, "a refused write leaves no receipt");

    const done = json_out(ts_run(c, ["complete", SLUG, ...guard_of(claim2), "--status", "succeeded"], tok));
    assert.equal(done.status, "succeeded");
    assert.deepEqual(c.sig(c.project_json), project_json, "project.json is byte- and mtime-identical (nothing writes the old file)");
  }));

test("B2: the owner (no PES_TOKEN) reads context; an agent without the scope cannot claim and no run appears", () =>
  with_cli(async (c) => {
    const reader = await c.agent("reader", ["context:read"]);
    await start(c.env, c.stages.plan, "b2-start");
    assert.equal(json_out(ts_run(c, ["context", SLUG])).lease, null, "the human owner reads");
    const runs = table_counts(c.env.db).runs;
    expect_rejected(ts_run(c, ["claim", SLUG], { PES_TOKEN: reader.token }), "claim without run:claim");
    assert.equal(table_counts(c.env.db).runs, runs);
    assert.equal(json_out(ts_run(c, ["context", SLUG], { PES_TOKEN: reader.token })).lease, null, "context:read is enough for context");
  }));

test("B3: claim flags --mode/--runtime/--provider/--model are the 0.15 ones: the same refusal for an external token claiming mode A", () =>
  with_cli(async (c) => {
    const agent = await c.agent("flags");
    const before = state_signature(c.env.db);
    const res = ts_run(c, ["claim", SLUG, "--mode", "A", "--runtime", "pes_builtin", "--provider", "opencode-go", "--model", "synthetic-model"], { PES_TOKEN: agent.token });
    expect_rejected(res, "external token, mode A");
    assert.equal(state_signature(c.env.db), before, "no run, lease or receipt");
    const ok = json_out(ts_run(c, ["claim", SLUG], { PES_TOKEN: agent.token }));
    const row = c.env.db.get<{ mode: string; actor_id: string }>("SELECT mode, actor_id FROM runs WHERE id = ?", ok.run_id);
    assert.deepEqual({ ...row }, { mode: "B", actor_id: agent.actor_id }, "the default claim is mode B by the token's actor");
  }));

test("B4: argument errors keep 0.15's exit 2 and Korean lines — unknown argument, missing --file, missing guard flag, fence not an integer", () =>
  with_cli(async (c) => {
    const agent = await c.agent("args");
    const tok = { PES_TOKEN: agent.token };
    const g = json_out(ts_run(c, ["claim", SLUG], tok));
    const file = write_json(c, "b4.json", []);
    const before = state_signature(c.env.db);
    const cases: Array<[string[], RegExp, string]> = [
      [["claim", SLUG, "--bogus", "x"], /알 수 없는 인자: --bogus/, "unknown argument"],
      [["claim", SLUG, "positional"], /알 수 없는 인자: positional/, "positional after the project"],
      [["submit", SLUG, ...guard_of(g)], /--file <결과\.json> 필요/, "submit without --file"],
      [["wait", SLUG, "--lease", g.lease_id, "--fence", String(g.fence)], /--run 필요/, "wait without --run"],
      [["complete", SLUG, "--run", g.run_id, "--fence", String(g.fence)], /--lease 필요/, "complete without --lease"],
      [["submit", SLUG, "--run", g.run_id, "--lease", g.lease_id, "--file", file], /--fence 필요/, "submit without --fence"],
      [["wait", SLUG, "--run", g.run_id, "--lease", g.lease_id, "--fence", "abc"], /--fence 는 정수여야 합니다/, "fence is a word"],
      [["wait", SLUG, "--run", g.run_id, "--lease", g.lease_id, "--fence", "1.5"], /--fence 는 정수여야 합니다/, "fence is a fraction"],
    ];
    for (const [args, pattern, what] of cases) {
      const res = ts_run(c, args, tok);
      assert.equal(res.status, 2, `${what}: exit 2 (got ${res.status}: ${res.stderr})`);
      assert.match(res.stderr, pattern, what);
      assert.equal(res.stdout, "", `${what}: nothing on stdout`);
      assert.doesNotMatch(res.stderr, /\n\s+at |node:internal|Traceback/, `${what}: no stack trace`);
    }
    assert.equal(state_signature(c.env.db), before, "argument errors write nothing");
  }));

test("B5: guard violations — other run/lease, fence off by one / 0 / negative / huge — are refused by submit · wait · complete with no receipt; the right guard still works", () =>
  with_cli(async (c) => {
    const agent = await c.agent("guard");
    const art = await new_artifact(c.env, "b5-art");
    const g = json_out(ts_run(c, ["claim", SLUG], { PES_TOKEN: agent.token }));
    const results = write_json(c, "b5.json", [{ op: "append_version", object_id: art.object_id, title: "x" }]);
    const bad: Array<[string, string[]]> = [
      ["other run", ["--run", "no-such-run", "--lease", g.lease_id, "--fence", String(g.fence)]],
      ["other lease", ["--run", g.run_id, "--lease", "no-such-lease", "--fence", String(g.fence)]],
      ["fence + 1", ["--run", g.run_id, "--lease", g.lease_id, "--fence", String(BigInt(g.fence) + 1n)]],
      ["fence 0", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "0"]],
      ["fence -1", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "-1"]],
      ["fence huge", ["--run", g.run_id, "--lease", g.lease_id, "--fence", "99999999999999999999"]],
    ];
    const before = state_signature(c.env.db);
    for (const [name, guard] of bad) {
      for (const cmd of [["submit", "--file", results], ["wait"], ["complete"]]) {
        const res = ts_run(c, [cmd[0] as string, SLUG, ...guard, ...cmd.slice(1)], { PES_TOKEN: agent.token });
        expect_rejected(res, `${cmd[0]} / ${name}`);
        assert.doesNotMatch(res.stderr, /\n\s+at |node:internal/, `${cmd[0]} / ${name}: no stack trace`);
      }
    }
    assert.equal(state_signature(c.env.db), before, "no receipt, no event");
    assert.equal(ts_run(c, ["complete", SLUG, ...guard_of(g)], { PES_TOKEN: agent.token }).status, 0, "the right guard completes");
  }));

test("B6: another agent's token cannot use a guard it does not hold", () =>
  with_cli(async (c) => {
    const holder = await c.agent("holder");
    const thief = await c.agent("thief");
    const g = json_out(ts_run(c, ["claim", SLUG], { PES_TOKEN: holder.token }));
    const before = state_signature(c.env.db);
    expect_rejected(ts_run(c, ["wait", SLUG, ...guard_of(g)], { PES_TOKEN: thief.token }), "wait with another agent's guard");
    expect_rejected(ts_run(c, ["complete", SLUG, ...guard_of(g)], { PES_TOKEN: thief.token }), "complete with another agent's guard");
    assert.equal(state_signature(c.env.db), before);
  }));

test("B7: a project that is not in the DB (or no project) is refused with one Korean line, exit 1, and the folder is untouched", () =>
  with_cli(async (c) => {
    const agent = await c.agent("nowhere");
    const folder = c.sig(c.project_json);
    for (const args of [["context", "no-such-project"], ["claim", "no-such-project"], ["wait", "no-such-project", "--run", "r", "--lease", "l", "--fence", "1"]]) {
      const res = ts_run(c, args, { PES_TOKEN: agent.token });
      assert.equal(res.status, 1, `${args[0]}: exit 1 (${res.stderr})`);
      assert.equal(res.stdout, "");
      assert.equal(res.stderr.trim().split("\n").length, 1, `${args[0]}: one line`);
    }
    assert.deepEqual(c.sig(c.project_json), folder);
  }));

test("B8: the usage page lists the five commands and the command table of pes.ts has them (no 'not in the TypeScript edition' refusal)", async () => {
  const { CMDS } = await import("../scripts/pes_core/cli_main.ts");
  for (const name of ["context", "claim", "submit", "wait", "complete"]) assert.ok(CMDS.includes(name), `${name} is in CMDS`);
  const { USAGE } = await import("../scripts/pes_core/cli_usage.ts");
  for (const name of ["context", "claim", "submit", "wait", "complete"]) assert.match(USAGE, new RegExp(`\\n\\s+${name}\\b`), `${name} is on the usage page`);
});
