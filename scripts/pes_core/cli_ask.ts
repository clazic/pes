// pes.ts: ask-prep and ask (SEL-71). The question bank is copied to <project>/ask/<id>.json for the AI to polish; `ask` publishes the
// polished form to the database (so answers can be stored) and writes the 0.15 page ask-<id>.html — same template, same data.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { fill } from "./cli_screens.ts";
import { need_project, read_json_file } from "./cli_records.ts";
import { KEYS, QB, STAGES, arg_at, bridge, die, is_record, missing_args, now, pdir, say, write_text } from "./cli_support.ts";

const ASK_PURPOSES = new Set(["stage_start", "review", "resume"]);
const NEW_QUESTION_TYPES = new Set(["single", "multi", "text", "textarea", "number", "scale", "file"]);
/** The answer's form key (spec) is cut at this length by the server and the core — a longer id could not be matched later. */
const FORM_KEY_MAX = 80;

type Dict = Record<string, unknown>;

function strip_private(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip_private);
  if (is_record(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, strip_private(v)]));
  return value;
}

/** An old question-bank entry as the core's `question.publish_set` wants it. Answers are not filled in. */
function legacy_question(q: Dict): Dict {
  const type = typeof q.type === "string" && NEW_QUESTION_TYPES.has(q.type) ? q.type : "text";
  const options: Dict[] = [];
  for (const o of Array.isArray(q.options) ? q.options : []) {
    if (is_record(o) && o.value !== null && o.value !== undefined && o.value !== "") {
      const item: Dict = { value: String(o.value), label: String(o.label || o.value) };
      if (o.recommended) item.recommended = true;
      options.push(item);
    } else if (typeof o === "string" && o !== "") {
      options.push({ value: o, label: o });
    }
  }
  const out: Dict = { text: String(q.label || q.id || "질문"), type, required: Boolean(q.required), allow_comment_as_answer: Boolean(q.other) };
  if (options.length > 0) out.options = options;
  const help = q.help || q.desc;
  if (typeof help === "string" && help !== "") out.help = help;
  if (is_record(q.show_if)) out.show_if = q.show_if;
  return out;
}

export async function cmd_ask_prep(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "ask-prep"));
  const which = args[1] === undefined ? missing_args("ask-prep") : args[1];
  const src = join(QB, `${which}.json`);
  if (!existsSync(src)) die(`질문 은행 없음: ${src}`, 1);
  const slug = await need_project(d);
  const spec = read_json_file(src, "질문 은행");
  if (!is_record(spec)) die(`질문 은행은 JSON 객체여야 합니다: ${src}`, 1);
  const bank_key = String(spec.id ?? which).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || which;
  await bridge("ask-prep", slug, { stage: KEYS.includes(which) ? which : null, bank_key, dir: d });
  mkdirSync(join(d, "ask"), { recursive: true });
  const out = join(d, "ask", `${String(spec.id ?? which)}.json`);
  if (!existsSync(out)) write_text(out, JSON.stringify(spec, null, 1));
  say(out);
}

export async function cmd_ask(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "ask"));
  const spec_path = pdir(args[1] === undefined ? missing_args("ask") : args[1]);
  const raw = read_json_file(spec_path, "질문 폼 파일");
  const spec = strip_private(raw);
  if (!is_record(spec)) die(`질문 폼 파일은 JSON 객체여야 합니다: ${spec_path}`, 1);
  const sid = String(spec.id || spec.stage || "ask").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "ask";
  if (sid.length > FORM_KEY_MAX) {
    die(`질문 폼 id 가 너무 깁니다: ${sid.length}자 (최대 ${FORM_KEY_MAX}자) — 폼 id 를 줄여 다시 ask 하세요`, 2);
  }
  const slug = await need_project(d);
  const stage = typeof spec.stage === "string" && KEYS.includes(spec.stage) ? spec.stage : null;
  const purpose = typeof spec.kind === "string" && ASK_PURPOSES.has(spec.kind) ? spec.kind : "stage_start";
  const rows = (Array.isArray(spec.questions) ? spec.questions : []).filter(is_record);
  const questions = rows.map(legacy_question);
  if (questions.length === 0) die("질문 폼에 질문이 없습니다", 2);
  // show_if names a question of the spec; the stored question has no such id — keep the position of the one it points at
  const where = new Map<string, number>();
  rows.forEach((q, i) => {
    if (typeof q.id === "string" && !where.has(q.id)) where.set(q.id, i);
  });
  for (const q of questions) {
    const cond = q.show_if;
    if (is_record(cond) && typeof cond.id === "string" && where.has(cond.id)) q.show_if = { ...cond, position: where.get(cond.id) };
  }
  await bridge("ask", slug, { stage, purpose, form_key: sid, questions, dir: d });
  const overview = await bridge("overview", slug);
  const status = new Map((overview.stages as Array<{ key: string; status: string }>).map((x) => [x.key, x.status]));
  if (stage !== null && purpose === "stage_start" && status.get(stage) === "pending") status.set(stage, "asking");
  const page: Dict = {
    spec,
    topic: overview.topic,
    built: now(),
    stages: STAGES.map(([key, label]) => ({ key, label, status: status.get(key) ?? "pending" })),
  };
  const out = join(d, `ask-${sid}.html`);
  mkdirSync(d, { recursive: true });
  write_text(out, fill("ask.html", String(spec.title ?? "질문"), page));
  say(out);
}

