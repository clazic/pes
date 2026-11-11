// pes.ts: round-start, render, approve, reopen (SEL-71) — the 0.15 flow of a stage on top of the database's rounds and snapshots.
// 0.15 let `approve` run on any stage and `render` on any round; the database wants an open round to seal and a sealed one to approve.
// The core ops `compat_render` / `compat_approve` / `compat_reopen` (cli_bridge.ts) close that gap (implicit rounds that the read model
// does not count as rounds); this file prints 0.15's text and writes 0.15's files.

import { need_project, slug_of } from "./cli_records.ts";
import { build_index, legacy_project, save_snapshot } from "./cli_screens.ts";
import { LABEL, arg_at, bridge, is_record, missing_args, pdir, say, stage_arg } from "./cli_support.ts";

type Dict = Record<string, unknown>;

export async function cmd_round_start(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "round-start"));
  const s = stage_arg(args[1] === undefined ? missing_args("round-start") : args[1]);
  const slug = await need_project(d);
  const data = await bridge("round-start", slug, { stage: s, dir: d, any_order: true });
  say(`${LABEL[s]} R${String(data.round_no)} 시작`);
}

async function project_of(slug: string): Promise<Dict> {
  return legacy_project((await bridge("read_project", slug)).project as Dict);
}

export async function cmd_render(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "render"));
  let s: string | undefined;
  if (args.length > 1) s = stage_arg(args[1]);
  const slug = await need_project(d);
  if (s === undefined) s = String((await project_of(slug)).current);
  const before = ((await project_of(slug)).stages as Record<string, Dict>)[s] as Dict;
  if (Number(before.round) > 0) {
    // the open round (if it has anything to seal) is sealed in the database; the folder keeps the 0.15 snapshot file either way
    await bridge("compat_render", slug, { stage: s, dir: d });
    const after = ((await project_of(slug)).stages as Record<string, Dict>)[s] as Dict;
    save_snapshot(d, s, after);
  }
  say(await build_index(d, slug));
}

function report_formats(p: Dict): string[] {
  const settings = is_record(p.settings) ? p.settings : {};
  const formats = settings.stage_reports;
  return Array.isArray(formats) && formats.length > 0 ? formats.map(String) : ["md", "html", "eli5"];
}

export async function cmd_approve(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "approve"));
  const s = stage_arg(args[1] === undefined ? missing_args("approve") : args[1]);
  const slug = await need_project(d);
  const data = await bridge("compat_approve", slug, { stage: s, dir: d });
  const p = await project_of(slug);
  const msg: string[] = [`${LABEL[s]} 승인`];
  if (s === "plan") msg.push(`조사 항목 ${Number(data.handed_over ?? 0)}개 생성 (기존 조사 재사용 ${Number(data.reused ?? 0)}개)`);
  const next = data.next as { key: string; status: string } | null | undefined;
  if (next !== null && next !== undefined) msg.push(`다음 단계: ${LABEL[next.key]} (상태 ${next.status})`);
  else msg.push("모든 단계 완료");
  msg.push(`단계 보고서를 만드세요: report ${d} ${s}  (형식: ${report_formats(p).join(", ")})`);
  msg.push(`대화에서 나온 결정·선호가 파일에 없으면 note 로 남기세요. 그 뒤 대화를 비워도(/clear) \`/pes:run ${slug_of(d)}\`로 이어집니다.`);
  await build_index(d, slug);
  say(msg.join("\n"));
}

export async function cmd_reopen(args: string[]): Promise<void> {
  const d = pdir(arg_at(args, 0, "reopen"));
  const s = stage_arg(args[1] === undefined ? missing_args("reopen") : args[1]);
  const slug = await need_project(d);
  const data = await bridge("compat_reopen", slug, { stage: s, dir: d });
  const marked = ((data.marked as string[] | undefined) ?? []).map((k) => LABEL[k]);
  await build_index(d, slug);
  say(`${LABEL[s]} 다시 열림${marked.length > 0 ? ` · 다시 확인 필요 표시: ${marked.join(", ")}` : ""}`);
}

