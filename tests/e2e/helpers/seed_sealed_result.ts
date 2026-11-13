// SEL-126 F2 — 봉인한 라운드(결과 글 있음)를 가진 합성 프로젝트를 짓고 JSON 한 줄을 찍는다: { root, home, pes_home, slug, project_id }.
// seed_workspace.ts 와 같은 방식(plain Node, 임시 HOME / USERPROFILE / PES_HOME, DB 만 — project.json 없음). 모두 합성 자료다.
import { unlinkSync } from "node:fs";

import { add_artifact, create_object } from "../../../scripts/pes_core/content.ts";
import type { ApiEnv } from "../../helpers/api_env.ts";
import { make_cli_env, SLUG } from "../../helpers/cli_write_env.ts";
import { seal } from "../../helpers/editions_env.ts";
import { make_form, single_spec } from "../../helpers/sel90_env.ts";

export const SEALED_BODY = "# 합성 결과 글\n\n봉인된 라운드의 결과 문단 MARK-F2-SEALED 입니다.";

const c = await make_cli_env();
unlinkSync(c.project_json);
const env = c.env as unknown as ApiEnv;
env.seq = 0;
const form = await make_form(env, [single_spec("합성 질문")], "f2");
const obj = (await create_object(env.service, env.ctx("f2-o"), { kind: "artifact", edition_id: env.p.edition_id })).result as { object_id: string };
const ver = (await add_artifact(env.service, env.ctx("f2-v"), { object_id: obj.object_id, artifact_kind: "chapter", title: "합성 결과 f2", summary: "합성 요약", body_md: SEALED_BODY })).result as { version_id: string };
await seal(env, form.round_id, [{ object_id: obj.object_id, version_id: ver.version_id }], "f2-seal");
const { p } = env;
env.db.close();
console.log(JSON.stringify({ root: env.home.root, home: env.home.env.HOME, pes_home: env.home.env.PES_HOME, slug: SLUG, project_id: p.project_id }));
