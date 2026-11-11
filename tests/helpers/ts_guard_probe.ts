// Stub child for the TS guard self-test (tests/test_pes_ts_guard.test.ts). NOT the product: it does one thing per argument and, like
// product code that "handles" a failure, CATCHES every error and prints `caught <code>` — the guard must still have reported it.
//   read <path> | stat <path> | list <path> | exists <path> | write <path> | sqlite <path> | async-read <path> | rename <from> <to>
//   connect <port> | fetch <port> | ok-read <path>
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { connect } from "node:net";

const [op, a, b] = process.argv.slice(2) as [string, string, string | undefined];
const say = (text: string): void => void process.stdout.write(`${text}\n`);
try {
  if (op === "read" || op === "ok-read") say(`read ${readFileSync(a, "utf8").length}`);
  else if (op === "stat") say(`stat ${statSync(a).isDirectory()}`);
  else if (op === "list") say(`list ${readdirSync(a).length}`);
  else if (op === "exists") say(`exists ${existsSync(a)}`);
  else if (op === "write") {
    mkdirSync(a, { recursive: true });
    writeFileSync(`${a}/probe.txt`, "x");
    say("write ok");
  } else if (op === "sqlite") say(`sqlite ${new DatabaseSync(a).prepare("select 1 as n").get()?.n}`);
  else if (op === "async-read") say(`async-read ${(await readFile(a, "utf8")).length}`);
  else if (op === "rename") {
    renameSync(a, b as string);
    say("rename ok");
  } else if (op === "connect") {
    await new Promise<void>((done) => {
      const socket = connect({ port: Number(a), host: "127.0.0.1" });
      socket.once("connect", () => {
        say("connected");
        socket.destroy();
        done();
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        say(`caught ${error.code}`);
        done();
      });
    });
  } else if (op === "fetch") {
    try {
      await fetch(`http://127.0.0.1:${a}/whoami`);
      say("fetched");
    } catch (error) {
      say(`caught ${String((error as { cause?: { code?: string } }).cause?.code ?? error)}`);
    }
  } else say(`unknown op ${op}`);
} catch (error) {
  say(`caught ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
}
