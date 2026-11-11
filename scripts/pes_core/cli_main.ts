// `node scripts/pes.ts <command>` — the TypeScript CLI (SEL-71 / PR26b-1): argument rules, exit codes and text of v0.15's scripts/pes.py,
// the state in the database through the core. This file is the skeleton (dispatch, usage, unknown commands) and the WRITE commands;
// the read / report / server commands (list hub open which doctor pending digest show report assemble web serve watch) are SEL-77's (cli_read, cli_server, cli_doctor).
//
// Rules this file keeps:
//   * every business write is one core call (cli_bridge.handle_request -> CommandService); no SQL here, no project.json / .pes-lock;
//   * files the user sees (ask-*.html, index.html, snapshots/*.json, ask/*.json, rounds/*/qa-brief.md, feedback.log) are written
//     like 0.15 wrote them — UTF-8, LF line ends and "/" in stored paths on every OS (D10);
//   * where 0.15 died with a Python traceback the exit code stays and the message is one plain Korean line (D11).

import { cmd_ask, cmd_ask_prep } from "./cli_ask.ts";
import { cmd_doctor } from "./cli_doctor.ts";
import { cmd_home, cmd_remote, cmd_stop } from "./cli_home.ts";
import { cmd_assemble, cmd_digest, cmd_pending, cmd_report, cmd_show, cmd_web } from "./cli_read.ts";
import { cmd_approve, cmd_render, cmd_reopen, cmd_round_start } from "./cli_rounds.ts";
import { cmd_chat, cmd_init, cmd_lock, cmd_mark, cmd_merge, cmd_note, cmd_qa, cmd_qa_brief, cmd_status, cmd_unlock } from "./cli_records.ts";
import { cmd_hub, cmd_list, cmd_open, cmd_serve, cmd_watch, cmd_which } from "./cli_server.ts";
import { cmd_set } from "./cli_set.ts";
import { Die, die, output } from "./cli_support.ts";
import { USAGE } from "./cli_usage.ts";

type Command = (args: string[]) => Promise<void>;

/** The write commands (SEL-71). */
const WRITE_COMMANDS: Record<string, Command> = {
  init: cmd_init,
  "ask-prep": cmd_ask_prep,
  ask: cmd_ask,
  "round-start": cmd_round_start,
  merge: cmd_merge,
  render: cmd_render,
  approve: cmd_approve,
  reopen: cmd_reopen,
  status: cmd_status,
  mark: cmd_mark,
  chat: cmd_chat,
  note: cmd_note,
  set: cmd_set,
  remote: cmd_remote,
  "qa-brief": cmd_qa_brief,
  qa: cmd_qa,
  stop: cmd_stop,
  home: cmd_home,
  lock: cmd_lock,
  unlock: cmd_unlock,
};

/** SEL-77: the read / report / server / doctor commands. */
const READ_COMMANDS: Record<string, Command> = {
  pending: cmd_pending,
  digest: cmd_digest,
  show: cmd_show,
  report: cmd_report,
  assemble: cmd_assemble,
  web: cmd_web,
  serve: cmd_serve,
  hub: cmd_hub,
  open: cmd_open,
  list: cmd_list,
  watch: cmd_watch,
  which: cmd_which,
  doctor: cmd_doctor,
};

/** Same table as scripts/pes.py CMDS (minus the five DB-only commands), in the same order. */
export const CMDS: readonly string[] = [
  "init", "ask-prep", "ask", "round-start", "merge", "render", "approve", "reopen", "status", "pending", "mark", "chat", "assemble", "report",
  "digest", "show", "note", "set", "web", "remote", "qa-brief", "qa", "serve", "stop", "watch", "list", "hub", "home", "open", "doctor", "which",
  "lock", "unlock",
];

/** A name pes.py has that this file has no command for: a plain Korean line (never reached while the two tables above cover CMDS). */
function not_yet(name: string): Command {
  return () => Promise.resolve(die(`${name}: 이 명령은 TypeScript 판(node scripts/pes.ts)에 없습니다`, 1));
}

function table(): Record<string, Command> {
  const out: Record<string, Command> = {};
  for (const name of CMDS) out[name] = WRITE_COMMANDS[name] ?? READ_COMMANDS[name] ?? not_yet(name);
  return out;
}

function flush(): void {
  if (output.out.length > 0) process.stdout.write(output.out.join(""));
  output.out.length = 0;
}

/** Runs one command line and sets the exit code. Python's `main`: a bare `list hub home doctor stop remote` gets a `--` argument. */
export async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  if (args.length === 1 && ["list", "hub", "home", "doctor", "stop", "remote"].includes(args[0] as string)) args.push("--");
  const commands = table();
  if (args.length < 2 || !Object.hasOwn(commands, args[0] as string)) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    await (commands[args[0] as string] as Command)(args.slice(1));
    flush();
  } catch (error) {
    flush();
    if (error instanceof Die) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exit_code;
      return;
    }
    // an unexpected error is one plain line, never a stack trace (D11); PES_DEBUG=1 shows it
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${args[0]}: 예상하지 못한 오류로 끝났습니다 — ${text.split("\n")[0]}\n`);
    if (process.env.PES_DEBUG === "1" && error instanceof Error && error.stack !== undefined) process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  }
}
