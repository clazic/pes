// pes.ts migrate (SEL-74 C / PR26e): the user's way from a 0.15 project folder to the database.
//   pes migrate <폴더|이름>   one folder of the PES home        pes migrate --all   every not-migrated folder of the PES home
// The work is the PR11 / PR12 tools in one core call (cli_bridge `migrate`): import → validate → a verified backup bundle outside the PES home →
// activate. The folder is only read — project.json and every other file keep their bytes and times (D02). A failure activates nothing.
// A project that is already in the database answers `이미 이전됨` (exit 0) and changes nothing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { Die, bridge, die, pdir, pes_home, py_json_error, say } from "./cli_support.ts";

type Outcome = { state: "migrated" | "already"; slug: string; backup_dir?: string };

/** Moves one folder; a refusal ends with a Die (one Korean line, exit 1). */
async function migrate_one(d: string): Promise<Outcome> {
  const slug = basename(d);
  if (dirname(d) !== pes_home()) return die(`PES 홈(${pes_home()}) 안의 프로젝트 폴더만 이전할 수 있습니다: ${d} — 이 폴더를 PES 홈 안으로 옮긴 뒤(복사가 아니라 이동 — 같은 이름의 사본이 둘 남지 않게) 다시 이전하세요`, 1);
  if (!existsSync(d) || !statSync(d).isDirectory()) return die(`폴더가 없습니다: ${d}`, 1);
  const file = join(d, "project.json");
  if (!existsSync(file)) return die(`project.json 없음: ${d}`, 1);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return die(`project.json 을 읽지 못했습니다: ${file} (${(error as NodeJS.ErrnoException).code ?? "읽기 오류"}) — 폴더는 그대로 두었습니다`, 1);
  }
  const broken = py_json_error(text);
  if (broken !== null) return die(`project.json 을 읽지 못했습니다: ${file} (${broken}) — 폴더는 그대로 두었습니다`, 1);
  const data: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const named = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).slug : undefined;
  if (named !== slug) {
    return die(`project.json 의 slug(${typeof named === "string" ? named : "없음"}) 가 폴더 이름(${slug}) 과 다릅니다 — 둘을 같게 맞춘 뒤 다시 하세요`, 1);
  }
  const done = await bridge("migrate", slug, { dir: d, pes_home: pes_home(), slug });
  return { state: done.state === "already" ? "already" : "migrated", slug, backup_dir: typeof done.backup_dir === "string" ? done.backup_dir : undefined };
}

function report(outcome: Outcome): string {
  return outcome.state === "already" ? `이미 이전됨: ${outcome.slug}` : `이전했습니다: ${outcome.slug} — 백업: ${outcome.backup_dir ?? ""}`;
}

async function migrate_all(): Promise<void> {
  const home = pes_home();
  const names = existsSync(home)
    ? readdirSync(home, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(home, e.name, "project.json")))
        .map((e) => e.name)
        .sort()
    : [];
  if (names.length === 0) {
    say(`이전할 폴더가 없습니다: ${home}`);
    return;
  }
  let failed = 0;
  for (const name of names) {
    try {
      say(report(await migrate_one(join(home, name))));
    } catch (error) {
      if (!(error instanceof Die)) throw error;
      failed += 1;
      say(`이전하지 못했습니다: ${name} — ${error.message}`);
    }
  }
  if (failed > 0) die(`이전하지 못한 폴더 ${failed}개 — 위 줄을 보세요`, 1);
}

export async function cmd_migrate(args: string[]): Promise<void> {
  const first = args[0];
  if (first === "--all") {
    if (args.length > 1) die(`알 수 없는 인자: ${args[1]}`, 2);
    return migrate_all();
  }
  if (first === undefined || first === "--" || first.startsWith("--")) {
    return die(`사용: migrate <폴더|이름> 또는 migrate --all${first !== undefined && first !== "--" ? ` (알 수 없는 인자: ${first})` : ""}`, 2);
  }
  if (args.length > 1) die(`알 수 없는 인자: ${args[1]}`, 2);
  say(report(await migrate_one(pdir(first))));
}
