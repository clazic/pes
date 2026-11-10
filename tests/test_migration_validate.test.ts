// SEL-45 (stage 2 PR12): validate_import and the import_batches.state transitions.
// Interface under test: scripts/pes_core/migration.ts (signatures in tests/helpers/migration_env.ts).
// Synthetic fixtures only (tests/fixtures/legacy/), one copy per test in an isolated HOME/PES_HOME.
//
// validate_import compares the staged project with its ORIGINAL source folder (migration-map.md
// section 9): counts, bodies, ids, links, footnotes, files (hash), unprocessed answers, report
// regeneration, and that the source still has the fingerprint recorded at import.
//
//  - clean import            -> ok=true, batch validated (project stays staging)
//  - any problem             -> NO throw, ok=false, problems listed, batch cannot be validated:
//                               staging stays staging; a validated batch that now fails goes back to staging
//  - regenerated reports differ from the original text -> a `reports_regeneration` problem (PR16; before: reported only)
//  - failed / activated batch -> ApiError "conflict" (nothing to validate)
//
// Transition table (schema values only; the schema has no 'rolled_back'):
//   staging   --validate ok-->        validated
//   staging   --validate problems-->  staging
//   validated --validate ok-->        validated   (idempotent)
//   validated --validate problems-->  staging     (no longer trustworthy)
//   validated --activate-->           activated
//   staging|validated|activated(no write) --rollback_before_write--> failed
//   failed|activated --validate-->    conflict
//   staging|activated --activate-->   conflict
//   failed    --rollback-->           conflict

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  activated,
  backup_dir_of,
  batch_row,
  blob_by_name,
  disk_path,
  CHECK_NAMES,
  copy_fixture,
  events_of,
  has_problem,
  owner_of,
  pes_home_of,
  project_status,
  rejects_api,
  run_import,
  stage,
  state_signature,
  tree_digest,
  validated,
  with_migration,
  type CheckName,
  type Env,
  type MigrationApi,
  type ValidateResult,
} from "./helpers/migration_env.ts";
import { make_broken_project } from "./helpers/legacy_env.ts";

async function validate(env: Env, mig: MigrationApi, batch_id: string, source_dir: string): Promise<ValidateResult> {
  return mig.validate_import(env.service, batch_id, { owner_actor_id: owner_of(env), source_dir });
}

function types(env: Env, project_id: string): string[] {
  return events_of(env.db, project_id).map((e) => e.type);
}

// ---------------------------------------------------------------------------
// clean import

test("a clean full import validates: every check runs, no problem, batch validated, project still staging", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const out = await validate(env, mig, s.imp.batch_id, s.dir);
    assert.equal(out.ok, true, JSON.stringify(out.report.problems));
    assert.equal(out.state, "validated");
    assert.deepEqual(out.report.problems, []);
    assert.equal(out.batch_id, s.imp.batch_id);
    assert.equal(out.project_id, s.imp.project_id);
    for (const name of CHECK_NAMES) {
      assert.equal(typeof out.report.checked[name], "number", `check ${name} reports how much it compared`);
    }
    for (const name of ["counts", "bodies", "ids", "files"] as const) {
      assert.ok(out.report.checked[name] > 0, `${name} compared something`);
    }
    // research-R1 has two feedback files that are not in `processed`
    assert.ok(out.report.checked.unprocessed_answers >= 2);
    assert.equal(batch_row(env.db, s.imp.batch_id).state, "validated");
    assert.equal(project_status(env.db, s.imp.project_id), "staging", "validating does not activate");
    assert.ok(types(env, s.imp.project_id).includes("legacy.import_validated"));
  });
});

test("the 'complete' and 'broken-parts' fixtures validate too (damaged parts are reported by the import, not a validation problem)", async () => {
  await with_migration(async (env, legacy, mig) => {
    for (const name of ["complete", "broken-parts"]) {
      const s = await stage(env, legacy, name);
      const out = await validate(env, mig, s.imp.batch_id, s.dir);
      assert.equal(out.ok, true, `${name}: ${JSON.stringify(out.report.problems)}`);
      assert.equal(batch_row(env.db, s.imp.batch_id).state, "validated");
    }
  });
});

test("regenerated reports are compared with the original and the differences are reported, not fatal", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const out = await validate(env, mig, s.imp.batch_id, s.dir);
    assert.ok(Array.isArray(out.report.regenerated_reports));
    const paths = out.report.regenerated_reports.map((r) => r.path);
    assert.ok(paths.includes("reports/plan/report.md"), `the plan report is regenerated and compared: ${paths.join(",")}`);
    for (const entry of out.report.regenerated_reports) {
      assert.equal(typeof entry.matches, "boolean");
    }
    assert.ok(out.report.checked.reports_regeneration >= 1);

  });
});

test("a hand-edited original report differs from the regenerated one (PR16): a reports_regeneration problem, ok=false, not validated", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = copy_fixture(env, "full");
    writeFileSync(join(dir, "reports", "plan", "report.md"), "# 사람이 직접 고친 보고서\n", "utf8");
    const imp = await run_import(env, legacy, dir);
    assert.equal(imp.state, "staging");
    const out = await validate(env, mig, imp.batch_id, dir);
    assert.equal(out.ok, false, "PR16: a report that differs from the real generator's output is a problem");
    assert.equal(out.state, "staging");
    assert.ok(has_problem(out.report, "reports_regeneration"), JSON.stringify(out.report.problems));
    assert.equal(out.report.problems.find((p) => p.check === "reports_regeneration")?.path, "reports/plan/report.md");
    const entry = out.report.regenerated_reports.find((r) => r.path === "reports/plan/report.md");
    assert.ok(entry, "the edited report is listed");
    assert.equal(entry.matches, false, "the difference is reported");
    assert.equal(batch_row(env.db, imp.batch_id).state, "staging");
  });
});

// ---------------------------------------------------------------------------
// each mismatch: reported, never validated

interface Tamper {
  name: string;
  expect: CheckName[];
  apply(env: Env, ids: { project_id: string; batch_id: string; dir: string }): () => void; // returns the undo
}

const TAMPERS: Tamper[] = [
  {
    name: "a body text differs from the source",
    expect: ["bodies"],
    apply(env, ids) {
      const rows = env.db.all<{ version_id: string; body_md: string }>(
        "SELECT version_id, body_md FROM artifact_versions WHERE project_id = ? AND body_md IS NOT NULL",
        ids.project_id,
      );
      assert.ok(rows.length > 0, "the fixture has body text");
      env.db.run("UPDATE artifact_versions SET body_md = body_md || ' (변조)' WHERE project_id = ? AND body_md IS NOT NULL", ids.project_id);
      return () => {
        for (const row of rows) env.db.run("UPDATE artifact_versions SET body_md = ? WHERE version_id = ?", row.body_md, row.version_id);
      };
    },
  },
  {
    name: "a legacy id no longer resolves (mapping row lost)",
    expect: ["ids", "counts"],
    apply(env, ids) {
      const row = env.db.get<Record<string, unknown>>(
        "SELECT * FROM legacy_mappings WHERE import_batch_id = ? AND new_object_id IS NOT NULL ORDER BY legacy_kind, legacy_scope, legacy_key LIMIT 1",
        ids.batch_id,
      );
      assert.ok(row);
      const copy = { ...row };
      env.db.run(
        "DELETE FROM legacy_mappings WHERE import_batch_id = ? AND legacy_kind = ? AND legacy_scope = ? AND legacy_key = ? AND content_hash = ?",
        ids.batch_id,
        copy.legacy_kind as string,
        copy.legacy_scope as string,
        copy.legacy_key as string,
        copy.content_hash as string,
      );
      return () => {
        env.db.run(
          `INSERT INTO legacy_mappings (project_id, import_batch_id, legacy_kind, legacy_scope, legacy_key, content_hash,
                                        new_object_id, new_version_id, new_row_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          copy.project_id as string,
          copy.import_batch_id as string,
          copy.legacy_kind as string,
          copy.legacy_scope as string,
          copy.legacy_key as string,
          copy.content_hash as string,
          (copy.new_object_id ?? null) as string | null,
          (copy.new_version_id ?? null) as string | null,
          (copy.new_row_id ?? null) as string | null,
        );
      };
    },
  },
  {
    name: "an object file on disk no longer has the source bytes",
    expect: ["files"],
    apply(env, ids) {
      const blob = blob_by_name(env, ids.project_id, "shot-1.png");
      const path = disk_path(env, blob);
      const original = readFileSync(path);
      writeFileSync(path, "다른 내용", "utf8");
      return () => writeFileSync(path, original);
    },
  },
  {
    name: "a footnote number no longer follows the sources[] order",
    expect: ["footnotes"],
    apply(env, ids) {
      const rows = env.db.all<{ artifact_version_id: string; citation_no: bigint }>(
        "SELECT artifact_version_id, citation_no FROM citations WHERE project_id = ?",
        ids.project_id,
      );
      assert.ok(rows.length > 0, "the fixture has footnotes");
      env.db.run("UPDATE citations SET citation_no = citation_no + 100 WHERE project_id = ?", ids.project_id);
      return () => env.db.run("UPDATE citations SET citation_no = citation_no - 100 WHERE project_id = ?", ids.project_id);
    },
  },
  {
    name: "an image row is missing (shots vs version_files)",
    expect: ["counts", "files"],
    apply(env, ids) {
      const rows = env.db.all<Record<string, unknown>>(
        "SELECT * FROM version_files WHERE project_id = ? AND role = 'image'",
        ids.project_id,
      );
      assert.ok(rows.length > 0, "the fixture has images");
      env.db.run("DELETE FROM version_files WHERE project_id = ? AND role = 'image'", ids.project_id);
      return () => {
        for (const r of rows) {
          env.db.run(
            "INSERT INTO version_files (project_id, version_id, blob_id, role, file_policy_id) VALUES (?, ?, ?, ?, ?)",
            r.project_id as string,
            r.version_id as string,
            r.blob_id as string,
            r.role as string,
            r.file_policy_id as string,
          );
        }
      };
    },
  },
  {
    name: "an unprocessed answer from feedback/*.json is not in the database",
    expect: ["unprocessed_answers", "counts", "ids"],
    apply(env, ids) {
      const before = env.db.all<{ n: bigint }>("SELECT count(*) AS n FROM answers WHERE project_id = ?", ids.project_id)[0]!.n;
      assert.ok(before > 0n, "the fixture has answers");
      env.db.exec("PRAGMA foreign_keys = OFF");
      env.db.run("DELETE FROM answers WHERE project_id = ?", ids.project_id);
      env.db.exec("PRAGMA foreign_keys = ON");
      return () => {
        // not restorable without the rows: the caller re-imports instead
      };
    },
  },
  {
    name: "the source file project.json was edited after the import",
    expect: ["source_changed"],
    apply(_env, ids) {
      const path = join(ids.dir, "project.json");
      const original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
      return () => writeFileSync(path, original);
    },
  },
  {
    name: "a source file was removed after the import",
    expect: ["source_changed"],
    apply(_env, ids) {
      const path = join(ids.dir, "shots", "shot-1.png");
      const original = readFileSync(path);
      rmSync(path);
      return () => writeFileSync(path, original);
    },
  },
  {
    name: "a new file appeared in the source folder after the import",
    expect: ["source_changed"],
    apply(_env, ids) {
      const path = join(ids.dir, "feedback", "plan-R9-20260909-090909.json");
      writeFileSync(path, JSON.stringify({ stage: "plan", round: 9, kind: "feedback", text: "나중에 생김", answers: {} }), "utf8");
      return () => rmSync(path);
    },
  },
];

for (const tamper of TAMPERS) {
  test(`mismatch -> reported, batch cannot be validated: ${tamper.name}`, async () => {
    await with_migration(async (env, legacy, mig) => {
      const s = await stage(env, legacy, "full");
      const undo = tamper.apply(env, { project_id: s.imp.project_id, batch_id: s.imp.batch_id, dir: s.dir });
      const out = await validate(env, mig, s.imp.batch_id, s.dir);

      assert.equal(out.ok, false);
      assert.equal(out.state, "staging");
      assert.ok(has_problem(out.report, ...tamper.expect), `expected one of ${tamper.expect.join("|")}: ${JSON.stringify(out.report.problems)}`);
      for (const problem of out.report.problems) assert.ok(CHECK_NAMES.includes(problem.check), `known check: ${problem.check}`);
      assert.equal(batch_row(env.db, s.imp.batch_id).state, "staging", "it did not reach validated");
      const kinds = types(env, s.imp.project_id);
      assert.ok(!kinds.includes("legacy.import_validated"));
      assert.ok(kinds.includes("legacy.import_validation_failed"), "the failure is recorded as an event");

      // a batch that is not validated cannot be activated
      const before = state_signature(env.db);
      await rejects_api(
        mig.activate_import(env.service, s.imp.batch_id, {
          owner_actor_id: owner_of(env),
          backup_dir: backup_dir_of(env, "never"),
          pes_home: pes_home_of(env),
        }),
        "conflict",
      );
      assert.equal(state_signature(env.db), before);
      assert.equal(project_status(env.db, s.imp.project_id), "staging");

      // undoing the damage lets the same batch validate (the problem list is not sticky)
      if (tamper.name.startsWith("an unprocessed answer")) return;
      undo();
      const again = await validate(env, mig, s.imp.batch_id, s.dir);
      assert.equal(again.ok, true, JSON.stringify(again.report.problems));
      assert.equal(batch_row(env.db, s.imp.batch_id).state, "validated");
    });
  });
}

test("a validated batch that no longer matches goes back to staging when it is validated again", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    env.db.run("UPDATE artifact_versions SET body_md = body_md || ' (변조)' WHERE project_id = ? AND body_md IS NOT NULL", v.imp.project_id);
    const out = await validate(env, mig, v.imp.batch_id, v.dir);
    assert.equal(out.ok, false);
    assert.equal(out.state, "staging");
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "staging");
  });
});

test("a wrong source folder is reported as source_changed, not accepted", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const wrong = copy_fixture(env, "complete");
    const out = await validate(env, mig, s.imp.batch_id, wrong);
    assert.equal(out.ok, false);
    assert.ok(has_problem(out.report, "source_changed"));
    assert.equal(batch_row(env.db, s.imp.batch_id).state, "staging");
  });
});

test("validation reads the source and the database but changes neither of them (only state and events move)", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy, "full");
    const digest = tree_digest(s.dir);
    const object_rows = env.db.all("SELECT * FROM objects ORDER BY id").length;
    const versions = env.db.all("SELECT * FROM object_versions ORDER BY id").length;
    await validate(env, mig, s.imp.batch_id, s.dir);
    assert.equal(tree_digest(s.dir), digest);
    assert.equal(env.db.all("SELECT * FROM objects ORDER BY id").length, object_rows);
    assert.equal(env.db.all("SELECT * FROM object_versions ORDER BY id").length, versions);
  });
});

// ---------------------------------------------------------------------------
// state transitions

test("validate_import on a validated batch is idempotent; on an activated or failed batch it is refused", async () => {
  await with_migration(async (env, legacy, mig) => {
    const v = await validated(env, legacy, mig);
    const again = await validate(env, mig, v.imp.batch_id, v.dir);
    assert.equal(again.ok, true);
    assert.equal(batch_row(env.db, v.imp.batch_id).state, "validated");

    const act = await mig.activate_import(env.service, v.imp.batch_id, {
      owner_actor_id: owner_of(env),
      backup_dir: backup_dir_of(env, "t1"),
      pes_home: pes_home_of(env),
    });
    assert.equal(act.state, "activated");
    const before = state_signature(env.db);
    await rejects_api(validate(env, mig, v.imp.batch_id, v.dir), "conflict");
    // activating twice is also refused
    await rejects_api(
      mig.activate_import(env.service, v.imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir: backup_dir_of(env, "t2"),
        pes_home: pes_home_of(env),
      }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
  });
});

test("a batch that failed at import (damaged project.json) cannot be validated or activated; its source stays untouched", async () => {
  await with_migration(async (env, legacy, mig) => {
    const dir = make_broken_project(env);
    const digest = tree_digest(dir);
    const imp = await run_import(env, legacy, dir);
    assert.equal(imp.state, "failed");
    const before = state_signature(env.db);
    await rejects_api(validate(env, mig, imp.batch_id, dir), "conflict");
    await rejects_api(
      mig.activate_import(env.service, imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir: backup_dir_of(env, "never"),
        pes_home: pes_home_of(env),
      }),
      "conflict",
    );
    await rejects_api(mig.rollback_before_write(env.service, imp.batch_id, { owner_actor_id: owner_of(env) }), "conflict");
    assert.equal(state_signature(env.db), before);
    assert.equal(tree_digest(dir), digest);
  });
});

test("activate_import needs a validated batch: staging is refused and nothing is written, not even the backup", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy);
    const before = state_signature(env.db);
    await rejects_api(
      mig.activate_import(env.service, s.imp.batch_id, {
        owner_actor_id: owner_of(env),
        backup_dir: backup_dir_of(env, "early"),
        pes_home: pes_home_of(env),
      }),
      "conflict",
    );
    assert.equal(state_signature(env.db), before);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(backup_dir_of(env, "early")), false);
  });
});

test("unknown batch and malformed options are refused with the closed error codes", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy);
    const owner = owner_of(env);
    await rejects_api(validate(env, mig, "no-such-batch", s.dir), "not_found");
    await rejects_api(mig.rollback_before_write(env.service, "no-such-batch", { owner_actor_id: owner }), "not_found");
    await rejects_api(
      mig.activate_import(env.service, "no-such-batch", {
        owner_actor_id: owner,
        backup_dir: backup_dir_of(env, "x"),
        pes_home: pes_home_of(env),
      }),
      "not_found",
    );
    await rejects_api(
      mig.validate_import(env.service, s.imp.batch_id, { owner_actor_id: owner } as unknown as Parameters<MigrationApi["validate_import"]>[2]),
      "invalid_payload",
    );
    await rejects_api(
      mig.activate_import(env.service, s.imp.batch_id, { owner_actor_id: owner } as unknown as Parameters<MigrationApi["activate_import"]>[2]),
      "invalid_payload",
      "conflict",
    );
  });
});

test("validate_import is for the human owner only", async () => {
  await with_migration(async (env, legacy, mig) => {
    const s = await stage(env, legacy);
    const agent = "agent-v";
    env.db.run("INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', NULL, '합성 에이전트')", agent);
    const before = state_signature(env.db);
    for (const actor of [agent, "no-such-actor"]) {
      await rejects_api(
        mig.validate_import(env.service, s.imp.batch_id, { owner_actor_id: actor, source_dir: s.dir }),
        "forbidden",
        "not_found",
      );
    }
    assert.equal(state_signature(env.db), before);
  });
});

test("a full cycle is recorded in order as events: validated, activated, rolled back is not possible after a write", async () => {
  await with_migration(async (env, legacy, mig) => {
    const a = await activated(env, legacy, mig);
    const kinds = types(env, a.imp.project_id).filter((t) => t.startsWith("legacy.import_"));
    const at = (name: string): number => kinds.indexOf(name);
    assert.ok(at("legacy.import_validated") >= 0 && at("legacy.import_activated") > at("legacy.import_validated"), kinds.join(","));
  });
});
