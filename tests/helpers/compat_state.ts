// Shared builders of the ported tests/test_state.py (SEL-70): the research-loop library fixture and small project helpers.
import { join } from "node:path";

import { write_json, type CompatCtx } from "./compat_env.ts";

/** A synthetic research-loop state.json (tests/test_state.py::_make_library). Returns the folder to `init --import`. */
export function make_library(ctx: CompatCtx): string {
  const source = join(ctx.tmp, "research-loop");
  write_json(join(source, "state.json"), {
    round: 3,
    topic: "기존 조사",
    settings: {},
    items: [
      {
        id: 5,
        title: "기존 조사 항목",
        summary: "기존 요약",
        details: "기존 상세",
        confidence: "high",
        status: "done",
        sources: [{ url: "https://library.test/5", title: "기존 출처", method: "browser" }],
        stats: [{ name: "기존 지표", value: 5, unit: "개" }],
        shots: ["shot.png"],
        conflicts: ["기존 충돌"],
      },
      { id: 6, title: "삭제된 항목", status: "removed" },
    ],
    suggestions: [],
    warnings: [],
  });
  return source;
}

/** A fresh project folder name per test inside one ctx (pytest gave each test its own tmp_path). */
let seq = 0;
export function unique_name(prefix = "합성 프로젝트"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}
