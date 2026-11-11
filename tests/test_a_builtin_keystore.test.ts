// SEL-52 (PR19) the three OS key stores (macOS Keychain, Windows Credential Manager, Linux Secret Service) driven
// by an INJECTED fake `exec`. No real keychain, no real child process: the fake records what would have been run.
// 1차 리뷰 R6 (+ R5-b): the secret is never in the argument list or the environment; quote / backslash secrets
// survive the macOS `security -i` quoting; a secret with a line break is refused before anything runs; deleting an
// entry that is not there is not an error (exit 44 on macOS, exit 3 on Windows); a real failure is an error whose
// message does not carry the tool's output.

import assert from "node:assert/strict";
import { test } from "node:test";

import { KEY_SERVICE, KeyStoreError, os_key_store, type ExecFn, type ExecResult, type KeyStore } from "../scripts/pes_core/a_runtime/keystore.ts";

type Platform = "darwin" | "win32" | "linux";
const PLATFORMS: Platform[] = ["darwin", "win32", "linux"];

const REF = "pes-ai-conn-synthetic-1";
const PLAIN = "sk-synthetic-keystore-canary-71c2e9";
/** quotes, backslashes, a single quote, a dollar, a backtick, a space, and a trailing backslash */
const TRICKY = 'sk-"q"\\b\\\\c \'s\' $HOME `x` end\\';

interface Call {
  program: string;
  args: readonly string[];
  input: string | undefined;
  env: Record<string, string> | undefined;
}

class FakeExec {
  readonly calls: Call[] = [];
  next: ExecResult | ((call: Call) => ExecResult | Promise<ExecResult>) = { code: 0, stdout: "", stderr: "" };
  readonly fn: ExecFn = async (program, args, input, env) => {
    const call: Call = { program, args: [...args], input, env };
    this.calls.push(call);
    return typeof this.next === "function" ? await this.next(call) : this.next;
  };
}

function store_for(platform: Platform, exec: FakeExec): KeyStore {
  return os_key_store({ platform, exec: exec.fn });
}

/** everything an observer of the process list / environment could see of one call */
function visible_of(call: Call): string {
  return JSON.stringify([call.program, call.args, call.env ?? {}]);
}

/** a minimal reader of one `security -i` command line: words, with "double quoted" words and \\ \" escapes inside */
function parse_security_line(line: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === " ") {
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let word = "";
      for (;;) {
        assert.ok(i < line.length, "a quoted word is closed");
        const c = line[i]!;
        if (c === "\\") {
          assert.ok(i + 1 < line.length, "no dangling escape");
          word += line[i + 1]!;
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          break;
        }
        word += c;
        i += 1;
      }
      words.push(word);
      continue;
    }
    let word = "";
    while (i < line.length && line[i] !== " ") {
      word += line[i]!;
      i += 1;
    }
    words.push(word);
  }
  return words;
}

// ---------------------------------------------------------------------------------------------------------
// the secret is not on the command line

for (const platform of PLATFORMS) {
  test(`${platform}: put hands the secret over on standard input only — not in the arguments, not in the environment`, async () => {
    for (const secret of [PLAIN, TRICKY]) {
      const exec = new FakeExec();
      await store_for(platform, exec).put(REF, secret);
      assert.equal(exec.calls.length, 1, "one tool run");
      const call = exec.calls[0]!;
      assert.equal(visible_of(call).includes(secret), false, "the secret is not in the program, arguments or environment");
      assert.equal(visible_of(call).includes(PLAIN), false);
      assert.equal(typeof call.input, "string", "the secret goes in on standard input");
      if (platform !== "darwin") assert.equal(call.input, secret, "as is (macOS wraps it in a quoted command; see the quoting test)");
    }
  });

  test(`${platform}: get and delete have no secret to hide, but the reference is only ever a safe name`, async () => {
    const exec = new FakeExec();
    exec.next = { code: 0, stdout: `${PLAIN}\n`, stderr: "" };
    const store = store_for(platform, exec);
    await store.get(REF);
    await store.delete(REF);
    assert.equal(exec.calls.length, 2);
    for (const call of exec.calls) {
      assert.equal(call.input === undefined || call.input === "", true, "nothing is sent on standard input");
      const text = visible_of(call);
      assert.ok(text.includes(REF) || text.includes(KEY_SERVICE), "the call names the entry");
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// quoting

test("darwin: a secret with quotes and backslashes comes out of `security -i` quoting exactly as it went in", async () => {
  for (const secret of [PLAIN, TRICKY, '"', "\\", '\\"', '""\\\\"', "a b  c"]) {
    const exec = new FakeExec();
    await store_for("darwin", exec).put(REF, secret);
    const call = exec.calls[0]!;
    assert.equal(call.program, "security");
    assert.deepEqual([...call.args], ["-i"], "the commands come on standard input, so the secret is not an argument");
    const input = call.input!;
    assert.equal(input.endsWith("\n"), true);
    assert.equal(input.indexOf("\n"), input.length - 1, "exactly one command line — no second command can be smuggled in");
    const words = parse_security_line(input.slice(0, -1));
    assert.equal(words[0], "add-generic-password");
    const value_of = (flag: string): string | undefined => {
      const at = words.indexOf(flag);
      return at < 0 ? undefined : words[at + 1];
    };
    assert.equal(value_of("-w"), secret, `the password word decodes back to the secret: ${JSON.stringify(secret)}`);
    assert.equal(value_of("-a"), REF);
    assert.equal(value_of("-s"), KEY_SERVICE);
    assert.ok(words.includes("-U"), "an existing entry is updated, not duplicated");
    assert.equal(words.length, 8, "no extra word came out of the secret");
  }
});

test("win32: the names travel in the environment, the secret on standard input as is", async () => {
  const exec = new FakeExec();
  await store_for("win32", exec).put(REF, TRICKY);
  const call = exec.calls[0]!;
  assert.match(call.program, /powershell/i);
  assert.equal(call.input, TRICKY, "stdin is the secret, byte for byte");
  assert.equal(call.env?.["PES_KC_ACCOUNT"], REF);
  assert.equal(call.env?.["PES_KC_SERVICE"], KEY_SERVICE);
  assert.equal(call.args.some((a) => a.includes(REF)), false, "the script text does not embed the name either");
});

test("linux: secret-tool gets the secret on standard input, exactly (no added newline)", async () => {
  const exec = new FakeExec();
  await store_for("linux", exec).put(REF, TRICKY);
  const call = exec.calls[0]!;
  assert.equal(call.program, "secret-tool");
  assert.equal(call.args[0], "store");
  assert.equal(call.input, TRICKY);
  assert.ok(call.args.includes(REF) && call.args.includes(KEY_SERVICE));
});

// ---------------------------------------------------------------------------------------------------------
// a secret with a line break (or a NUL) is refused before anything runs

for (const platform of PLATFORMS) {
  test(`${platform}: a secret with a line break or NUL is refused and no tool is run`, async () => {
    const hostile = [
      "abc\ndef",
      "abc\r\ndef",
      "abc\rdef",
      "abc\n",
      "\nabc",
      "abc\u0000def",
      'x"\nadd-generic-password -a evil -s evil -w "y',
    ];
    for (const secret of hostile) {
      const exec = new FakeExec();
      await assert.rejects(
        async () => {
          await store_for(platform, exec).put(REF, secret);
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes("evil"), false, "the message does not echo the secret");
          assert.equal(error.message.includes("abc"), false, "the message does not echo the secret");
          return true;
        },
        `${platform}: ${JSON.stringify(secret)}`,
      );
      assert.equal(exec.calls.length, 0, `${platform}: nothing was run for ${JSON.stringify(secret)}`);
    }
  });

  test(`${platform}: a reference with characters outside the safe alphabet is refused and no tool is run`, async () => {
    for (const ref of ["", "a b", 'a"b', "a;b", "a\nb", "../x", "a/b", "$(x)", "x".repeat(201)]) {
      const exec = new FakeExec();
      const store = store_for(platform, exec);
      for (const action of [() => store.put(ref, PLAIN), () => store.get(ref), () => store.delete(ref)]) {
        await assert.rejects(async () => {
          await action();
        }, KeyStoreError);
      }
      assert.equal(exec.calls.length, 0, `${platform}: ${JSON.stringify(ref)} ran nothing`);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// get

test("get: a missing entry is undefined, a present one comes back without the tool's trailing newline (macOS)", async () => {
  const mac = new FakeExec();
  mac.next = { code: 0, stdout: `${PLAIN}\n`, stderr: "" };
  assert.equal(await store_for("darwin", mac).get(REF), PLAIN);
  mac.next = { code: 0, stdout: `${PLAIN}\r\n`, stderr: "" };
  assert.equal(await store_for("darwin", mac).get(REF), PLAIN);
  mac.next = { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
  assert.equal(await store_for("darwin", mac).get(REF), undefined);

  const win = new FakeExec();
  win.next = { code: 0, stdout: PLAIN, stderr: "" };
  assert.equal(await store_for("win32", win).get(REF), PLAIN);
  win.next = { code: 3, stdout: "", stderr: "" };
  assert.equal(await store_for("win32", win).get(REF), undefined);

  const lin = new FakeExec();
  lin.next = { code: 0, stdout: PLAIN, stderr: "" };
  assert.equal(await store_for("linux", lin).get(REF), PLAIN);
  lin.next = { code: 1, stdout: "", stderr: "" };
  assert.equal(await store_for("linux", lin).get(REF), undefined);
  lin.next = { code: 0, stdout: "", stderr: "" };
  assert.equal(await store_for("linux", lin).get(REF), undefined, "an empty answer is 'not there'");
});

// ---------------------------------------------------------------------------------------------------------
// delete

test("delete: an entry that is not there is not an error (macOS 44, Windows 3); a real failure is", async () => {
  const mac = new FakeExec();
  mac.next = { code: 44, stdout: "", stderr: "could not be found" };
  await store_for("darwin", mac).delete(REF);
  mac.next = { code: 0, stdout: "", stderr: "" };
  await store_for("darwin", mac).delete(REF);
  mac.next = { code: 1, stdout: "", stderr: "denied" };
  await assert.rejects(async () => {
    await store_for("darwin", mac).delete(REF);
  }, KeyStoreError);
  mac.next = { code: 45, stdout: "", stderr: "" };
  await assert.rejects(async () => {
    await store_for("darwin", mac).delete(REF);
  }, KeyStoreError, "only 44 means 'already gone'");

  const win = new FakeExec();
  win.next = { code: 3, stdout: "", stderr: "" };
  await store_for("win32", win).delete(REF);
  win.next = { code: 0, stdout: "", stderr: "" };
  await store_for("win32", win).delete(REF);
  win.next = { code: 1, stdout: "", stderr: "access denied" };
  await assert.rejects(async () => {
    await store_for("win32", win).delete(REF);
  }, KeyStoreError);

  const lin = new FakeExec();
  lin.next = { code: 0, stdout: "", stderr: "" };
  await store_for("linux", lin).delete(REF);
  lin.next = { code: 1, stdout: "", stderr: "no secret service" };
  await assert.rejects(async () => {
    await store_for("linux", lin).delete(REF);
  }, KeyStoreError);
});

// ---------------------------------------------------------------------------------------------------------
// failures never carry the tool's output

for (const platform of PLATFORMS) {
  test(`${platform}: a failing tool gives an error whose message holds neither its output nor the secret`, async () => {
    const exec = new FakeExec();
    exec.next = { code: 7, stdout: `leak-out ${PLAIN}`, stderr: `leak-err ${PLAIN}` };
    const store = store_for(platform, exec);
    for (const action of [() => store.put(REF, PLAIN)]) {
      await assert.rejects(
        async () => {
          await action();
        },
        (error: unknown) => {
          assert.ok(error instanceof KeyStoreError);
          for (const text of [error.message, String(error.stack ?? "").split("\n")[0] ?? ""]) {
            assert.equal(text.includes("leak-"), false);
            assert.equal(text.includes(PLAIN), false);
          }
          return true;
        },
      );
    }
  });

  test(`${platform}: a tool that cannot be started is an error, not a hang, and not a secret in the message`, async () => {
    const exec = new FakeExec();
    exec.next = () => {
      throw new Error("spawn missing-tool ENOENT");
    };
    await assert.rejects(async () => {
      await store_for(platform, exec).put(REF, PLAIN);
    }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(PLAIN), false);
      return true;
    });
  });
}

test("an unknown platform has no key store", () => {
  assert.throws(() => os_key_store({ platform: "plan9", exec: new FakeExec().fn }), KeyStoreError);
});

test("where() names the place for each platform", () => {
  const exec = new FakeExec();
  assert.match(store_for("darwin", exec).where(), /keychain/i);
  assert.match(store_for("win32", exec).where(), /credential/i);
  assert.match(store_for("linux", exec).where(), /secret/i);
  assert.equal(exec.calls.length, 0, "naming the place runs nothing");
});
