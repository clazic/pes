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
