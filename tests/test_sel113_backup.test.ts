/**
 * SEL-113 REF1a — 백업·복원 회귀: 새 명령으로 만든 참조도 PR3 규칙을 지킨다 (tester, 작성 모드).
 * 있던 것: backup.ts 의 relink_missing_references — A 만 옮기면 원본이 없을 때 referenced_project_id·source_snapshot_id·latest_snapshot_id 를 NULL 로,
 *   status 를 source_missing 으로 만들고 key·label·scope 는 보존한다. 원본 자료를 함께 내보내지 않는다(test_backup_export_review.test.ts).
 *   이 파일은 reference.attach 가 만든 진짜 행으로 같은 계약을 다시 확인한다(명령이 없으면 실패).
 *
 * 정한 해석: 명령으로 만든 행은 그대로 export/import 되고, 번들 파일 어디에도 원본 보고서/출처 본문이 없다. 원본이 같은 목적지에 먼저 들어 있으면 링크와 상태를 유지한다.
 *   복원한 뒤 읽기(상태·라벨)는 'source_missing' 이다(읽기 모양은 test_sel113_api.test.ts 머리말).
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { export_project, import_bundle, verify_bundle } from "../scripts/pes_core/backup.ts";
import { connect, migrate } from "../scripts/pes_core/db.ts";
import { with_env, type Env } from "./helpers/blob_env.ts";
import { DEFAULT_SCOPE, attached, ref_row } from "./helpers/sel113_env.ts";

function files_under(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function target(env: Env, name: string) {
  const root = join(env.home.root, name);
  mkdirSync(root, { recursive: true });
  const db = connect(join(root, "pes.db"));
  migrate(db);
  return { db, objects: join(root, "objects") };
}

test("A moved alone: a reference made by reference.attach becomes source_missing in the destination; key, label, scope and pin identity survive; the source is not exported", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "bk1", { scope: ["sources", "decisions"], source_label: "이전 연구(합성)" });
    const dir = join(env.home.root, "bundle-a");
    export_project(env.db, env.objects, env.p.project_id, dir);
    assert.equal(verify_bundle(dir).ok, true);
    for (const file of files_under(dir)) {
      const text = readFileSync(file).toString("utf8");
      assert.ok(!text.includes(src.report_marker) && !text.includes(src.source_marker), `${file} holds no source text`);
    }
    const tgt = target(env, "t1");
    try {
      import_bundle(tgt.db, tgt.objects, dir);
      const row = ref_row(tgt.db, ref.reference_id);
      assert.ok(row, "the reference row came along");
      assert.equal(row.status, "source_missing");
      assert.equal(row.referenced_project_id, null);
      assert.equal(row.source_snapshot_id, null);
      assert.equal(row.latest_snapshot_id, null);
      assert.equal(row.referenced_project_key, src.p.project_id);
      assert.equal(row.source_snapshot_key, src.snapshot_id);
      assert.equal(row.source_label, "이전 연구(합성)");
      assert.deepEqual(JSON.parse(row.scope_json), ["sources", "decisions"]);
      assert.equal(row.attached_by_actor_id, env.p.actor_id);
      assert.equal(tgt.db.get("SELECT id FROM projects WHERE id = ?", src.p.project_id), undefined, "the source project was not copied");
      assert.equal(tgt.db.get("SELECT id FROM snapshots WHERE id = ?", src.snapshot_id), undefined, "nor its snapshot");
      assert.deepEqual(tgt.db.all("PRAGMA foreign_key_check"), []);
    } finally {
      tgt.db.close();
    }
  });
});

test("the source is already in the destination: the link and the 'active' status are kept after A is restored", async () => {
  await with_env(async (env) => {
    const { src, ref } = await attached(env, "bk2");
    const b_dir = join(env.home.root, "bundle-src");
    const a_dir = join(env.home.root, "bundle-cur");
    export_project(env.db, env.objects, src.p.project_id, b_dir);
    export_project(env.db, env.objects, env.p.project_id, a_dir);
    const tgt = target(env, "t2");
    try {
      import_bundle(tgt.db, tgt.objects, b_dir);
      import_bundle(tgt.db, tgt.objects, a_dir);
      const row = ref_row(tgt.db, ref.reference_id)!;
      assert.equal(row.status, "active");
      assert.equal(row.referenced_project_id, src.p.project_id);
      assert.equal(row.source_snapshot_id, src.snapshot_id);
      assert.deepEqual(JSON.parse(row.scope_json), DEFAULT_SCOPE);
      assert.deepEqual(tgt.db.all("PRAGMA foreign_key_check"), []);
    } finally {
      tgt.db.close();
    }
  });
});

test("exporting the SOURCE project does not drag the referencing project's reference rows along", async () => {
  await with_env(async (env) => {
    const { src } = await attached(env, "bk3");
    const dir = join(env.home.root, "bundle-only-src");
    export_project(env.db, env.objects, src.p.project_id, dir);
    const tgt = target(env, "t3");
    try {
      import_bundle(tgt.db, tgt.objects, dir);
      assert.equal(Number(tgt.db.get<{ n: bigint }>("SELECT count(*) AS n FROM project_references")!.n), 0);
      assert.equal(tgt.db.get("SELECT id FROM projects WHERE id = ?", env.p.project_id), undefined);
    } finally {
      tgt.db.close();
    }
  });
});
