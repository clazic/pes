/**
 * SEL-127 — closed_materials (한 번에 만드는 닫힌 집합) 가 낱개 판정(file_ai_denied · material_object_denied)과 같은 답을 내는지 지킨다.
 * 두 길이 따로 어긋나면 GET changes · GET materials 와 다른 AI 출구가 서로 다른 자료를 숨긴다. 합성 값만 쓴다.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { closed_materials, file_ai_denied, material_object_denied } from "../scripts/pes_core/commands/file_access.ts";
import { assert_ok, with_api } from "./helpers/api_env.ts";
import { http_blob, set_access, text_bytes, upload_material } from "./helpers/sel115_env.ts";

test("closed_materials 의 닫힌 blob·자료 객체 집합이 file_ai_denied · material_object_denied 와 모든 자료에서 같다", async () => {
  await with_api(async (env) => {
    const add = async (label: string, object_id?: string) => {
      const blob = await http_blob(env, text_bytes(label, `SECRET-${label}`), { name: `합성-${label}.txt` });
      const res = await upload_material(env, { blob_id: blob.blob_id, ...(object_id === undefined ? {} : { object_id }) });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json.data as { object_id: string; version_id: string; blob_id: string; file_policy_id: string };
    };
    const open = await add("open");
    const v1_closed = await add("v1-closed");
    const v2_of_closed = await add("v2-open", v1_closed.object_id);
    const v2_closed = await add("v2-only-closed-base");
    const v2_closed_later = await add("v2-closed-later", v2_closed.object_id);
    assert_ok(await set_access(env, v1_closed.file_policy_id, "deny"));
    assert_ok(await set_access(env, v2_closed_later.file_policy_id, "deny"));
    // a file the project holds without any material (reserved only)
    const loose = await http_blob(env, text_bytes("loose", "LOOSE"), { name: "합성-loose.txt" });

    const project_id = env.p.project_id;
    const closed = closed_materials(env.db, project_id);
    const objects = [open, v1_closed, v2_closed].map((m) => m.object_id);
    for (const object_id of objects) {
      assert.equal(closed.objects.has(object_id), material_object_denied(env.db, project_id, object_id), `object ${object_id}`);
    }
    const blobs = [open, v1_closed, v2_of_closed, v2_closed, v2_closed_later].map((m) => m.blob_id).concat(loose.blob_id);
    for (const blob_id of blobs) {
      assert.equal(closed.denied_blobs.has(blob_id), file_ai_denied(env.db, project_id, blob_id), `blob ${blob_id}`);
    }
    assert.ok(closed.objects.has(v1_closed.object_id) && closed.objects.has(v2_closed.object_id) && !closed.objects.has(open.object_id));
    // the allowed later version of a closed material is closed with it (its blob, policy and version), the open material is not
    assert.ok(closed.blobs.has(v2_of_closed.blob_id) && closed.policies.has(v2_of_closed.file_policy_id) && closed.versions.has(v2_of_closed.version_id));
    assert.ok(!closed.blobs.has(open.blob_id) && !closed.policies.has(open.file_policy_id) && !closed.versions.has(open.version_id));
    assert.ok(!closed.blobs.has(loose.blob_id), "a file with no material and no deny is not closed");
  });
});

/**
 * SEL-127 리뷰 F1-4 — 경계 사례에서도 closed_materials 가 낱개 판정(material_object_denied · file_ai_denied)과 같은 답을 낸다.
 * 기존 시험의 단언은 바꾸지 않고, 그 뒤에 경계 사례마다 같은 비교를 한다. 합성 값만 쓴다.
 */
test("경계 사례(이력만 deny · 같은 blob 두 객체 · allow 되돌림 · deny 뒤 판 추가 · 보관 객체)에서도 closed_materials 와 낱개 판정이 같다", async () => {
  await with_api(async (env) => {
    const add = async (label: string, object_id?: string) => {
      const blob = await http_blob(env, text_bytes(label, `SECRET-${label}`), { name: `합성-${label}.txt` });
      const res = await upload_material(env, { blob_id: blob.blob_id, ...(object_id === undefined ? {} : { object_id }) });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json.data as { object_id: string; version_id: string; blob_id: string; file_policy_id: string };
    };
    const project_id = env.p.project_id;
    /** every object and blob named here must get the same answer from the set and from the per-item function */
    const same = (objects: string[], blobs: string[]) => {
      const closed = closed_materials(env.db, project_id);
      for (const object_id of objects) {
        assert.equal(closed.objects.has(object_id), material_object_denied(env.db, project_id, object_id), `object ${object_id}`);
      }
      for (const blob_id of blobs) {
        assert.equal(closed.denied_blobs.has(blob_id), file_ai_denied(env.db, project_id, blob_id), `blob ${blob_id}`);
      }
      return closed;
    };

    // 1) 이력만 deny: 정책 행은 allow, 가장 새 이력 행은 deny
    const hist = await add("hist-only");
    assert_ok(await set_access(env, hist.file_policy_id, "deny"));
    env.db.run("UPDATE file_policies SET ai_access = 'allow' WHERE project_id = ? AND id = ?", project_id, hist.file_policy_id);
    let closed = same([hist.object_id], [hist.blob_id]);
    assert.ok(file_ai_denied(env.db, project_id, hist.blob_id), "a deny in the newest history row alone closes the file");
    assert.ok(closed.objects.has(hist.object_id));

    // 2) 같은 blob 이 두 객체에 붙음: 닫힌 A 의 허용 v2 blob 을 열린 B 가 새 자료로 쓴다
    const a_v1 = await add("two-obj-a");
    assert_ok(await set_access(env, a_v1.file_policy_id, "deny"));
    const a_v2 = await add("two-obj-a-v2", a_v1.object_id);
    const b = await upload_material(env, { blob_id: a_v2.blob_id });
    assert.equal(b.status, 201, `same blob reuse answered ${b.status} ${JSON.stringify(b.json)}`);
    if (b.status === 201) {
      const b_obj = (b.json.data as { object_id: string }).object_id;
      closed = same([a_v1.object_id, b_obj], [a_v1.blob_id, a_v2.blob_id]);
      assert.ok(closed.objects.has(a_v1.object_id) && !closed.objects.has(b_obj), "A (closed) hides, B (open) stays");
    } else {
      closed = same([a_v1.object_id], [a_v1.blob_id, a_v2.blob_id]);
    }

    // 3) allow 로 되돌림: deny 가 풀리면 두 길 모두 연다
    const back = await add("back-to-allow");
    assert_ok(await set_access(env, back.file_policy_id, "deny"));
    assert_ok(await set_access(env, back.file_policy_id, "allow"));
    closed = same([back.object_id], [back.blob_id]);
    assert.ok(!closed.objects.has(back.object_id) && !file_ai_denied(env.db, project_id, back.blob_id), "allow again opens the file and its object");

    // 4) deny 뒤 판 추가: 닫힌 객체에 새 판을 올려도 객체는 닫힌 채로 남고, 새 판도 닫힌 집합에 든다
    const grow = await add("deny-then-version");
    assert_ok(await set_access(env, grow.file_policy_id, "deny"));
    const grow_v2 = await add("deny-then-version-v2", grow.object_id);
    closed = same([grow.object_id], [grow.blob_id, grow_v2.blob_id]);
    assert.ok(closed.objects.has(grow.object_id) && closed.versions.has(grow_v2.version_id), "the new version of a closed object is closed with it");

    // 5) 보관 객체: archived_at 이 있어도 두 길 모두 같은 답(같은 FROM, archived_at 을 거르지 않는다)
    const archived = await add("archived-closed");
    assert_ok(await set_access(env, archived.file_policy_id, "deny"));
    env.db.run("UPDATE objects SET archived_at = 1 WHERE project_id = ? AND id = ?", project_id, archived.object_id);
    closed = same([archived.object_id], [archived.blob_id]);
    assert.ok(closed.objects.has(archived.object_id), "an archived closed material stays closed");
  });
});
