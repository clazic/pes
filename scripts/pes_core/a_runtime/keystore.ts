// Where an AI connection's api key lives (stage 2 PR19).
//
// A key is never a table column, an event field, a log line or a command payload. It is stored through the
// KeyStore interface: the local app uses the operating system's own secret store (macOS Keychain, Windows
// Credential Manager, Linux Secret Service), a web server would plug in its secret store (WEB4). Tests inject an
// in-memory store; nothing in the test run ever reaches an OS keychain.
//
// The OS backends below take an injected `exec` function. The real one (spawning the operating system's tool) is
// created only when os_key_store() is called without one, which is a run-time decision of the composition point,
// never of a test. The secret is handed to the tool on standard input, not on the command line, so it does not
// show up in a process list.

import { spawn } from "node:child_process";

export interface KeyStore {
  put(ref: string, secret: string): void | Promise<void>;
  get(ref: string): string | undefined | Promise<string | undefined>;
  delete(ref: string): void | Promise<void>;
  /** A human-readable name of the place the secrets live ("macOS Keychain", ...). */
  where(): string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program; `input` goes to its standard input. Must not log its arguments or its input. */
export type ExecFn = (program: string, args: readonly string[], input?: string, env?: Record<string, string>) => Promise<ExecResult>;

export const KEY_SERVICE = "pes-ai-connection";

/** A locked keychain or an open password dialog can keep the OS tool waiting for ever; no caller waits longer than this. */
export const KEY_EXEC_TIMEOUT_MS = 15_000;

export type KeyStorePlatform = "darwin" | "win32" | "linux";

export class KeyStoreError extends Error {
  override name = "KeyStoreError";
  constructor(message: string) {
    super(message);
  }
}

/** The OS tool did not finish in time (the tool was killed). */
export class KeyStoreTimeoutError extends KeyStoreError {
  override name = "KeyStoreTimeoutError";
  constructor() {
    super("the key store did not answer in time");
  }
}

/**
 * The default exec: a real child process, killed after `timeout_ms`. Only os_key_store() without an injected exec
 * ever reaches it.
 */
export function make_spawn_exec(timeout_ms: number = KEY_EXEC_TIMEOUT_MS): ExecFn {
  return (program, args, input, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...(env ?? {}) },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timed_out = false;
      const timer = setTimeout(() => {
        timed_out = true;
        child.kill("SIGKILL");
        // Do not wait for a "close" that may never come (a child that ignores the kill, or a grandchild holding the pipes).
        reject(new KeyStoreTimeoutError());
      }, timeout_ms);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timed_out) return;
        resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input ?? "");
    });
}

export const spawn_exec: ExecFn = make_spawn_exec();

/** A secret that carries a line break or a NUL could add a second command line (`security -i`) or cut the value short. */
function safe_secret(secret: string): string {
  if (/[\r\n\0]/.test(secret)) throw new KeyStoreError("the key has a line break or a NUL character, which is not allowed");
  return secret;
}

// A reference is a name we generate (pes-ai-<connection id>); keep it to a safe alphabet so it can be handed to
// a command line or a script without quoting surprises.
const SAFE_REF = /^[A-Za-z0-9._:-]{1,200}$/;

function safe_ref(ref: string): string {
  if (!SAFE_REF.test(ref)) throw new KeyStoreError("the key reference has characters that are not allowed");
  return ref;
}

/** A failure message that never carries the tool's output (it may hold a secret). */
function failed(action: string, result: ExecResult): KeyStoreError {
  return new KeyStoreError(`the key store could not ${action} (exit ${result.code})`);
}

// ---------------------------------------------------------------------------
// macOS: `security -i` reads its commands from standard input, so the secret never appears in an argument list.

function quote_for_security(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class MacKeyStore implements KeyStore {
  readonly #exec: ExecFn;
  constructor(exec: ExecFn) {
    this.#exec = exec;
  }
  where(): string {
    return "macOS Keychain";
  }
  async put(ref: string, secret: string): Promise<void> {
    const line = `add-generic-password -U -a ${quote_for_security(safe_ref(ref))} -s ${quote_for_security(KEY_SERVICE)} -w ${quote_for_security(safe_secret(secret))}\n`;
    const result = await this.#exec("security", ["-i"], line);
    if (result.code !== 0) throw failed("save the key", result);
  }
  async get(ref: string): Promise<string | undefined> {
    const result = await this.#exec("security", ["find-generic-password", "-a", safe_ref(ref), "-s", KEY_SERVICE, "-w"]);
    if (result.code !== 0) return undefined;
    return result.stdout.replace(/\r?\n$/, "");
  }
  async delete(ref: string): Promise<void> {
    const result = await this.#exec("security", ["delete-generic-password", "-a", safe_ref(ref), "-s", KEY_SERVICE]);
    // 44 = the item was not there: already gone is fine.
    if (result.code !== 0 && result.code !== 44) throw failed("delete the key", result);
  }
}

// ---------------------------------------------------------------------------
// Windows: the Credential Locker (PasswordVault) through Windows PowerShell; names in the environment, secret on stdin.

const PS_PREAMBLE =
  "$ErrorActionPreference='Stop';" +
  "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];" +
  "$v=New-Object Windows.Security.Credentials.PasswordVault;";

class WindowsKeyStore implements KeyStore {
  readonly #exec: ExecFn;
  constructor(exec: ExecFn) {
    this.#exec = exec;
  }
  where(): string {
    return "Windows Credential Manager";
  }
  #run(script: string, ref: string, input?: string): Promise<ExecResult> {
    return this.#exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PS_PREAMBLE + script],
      input,
      { PES_KC_SERVICE: KEY_SERVICE, PES_KC_ACCOUNT: safe_ref(ref) },
    );
  }
  async put(ref: string, secret: string): Promise<void> {
    const result = await this.#run(
      "$s=[Console]::In.ReadToEnd();$v.Add((New-Object Windows.Security.Credentials.PasswordCredential($env:PES_KC_SERVICE,$env:PES_KC_ACCOUNT,$s)))",
      ref,
      safe_secret(secret),
    );
    if (result.code !== 0) throw failed("save the key", result);
  }
  async get(ref: string): Promise<string | undefined> {
    const result = await this.#run(
      "try{$c=$v.Retrieve($env:PES_KC_SERVICE,$env:PES_KC_ACCOUNT);$c.RetrievePassword();[Console]::Out.Write($c.Password)}catch{exit 3}",
      ref,
    );
    return result.code === 0 ? result.stdout : undefined;
  }
  async delete(ref: string): Promise<void> {
    const result = await this.#run(
      "try{$c=$v.Retrieve($env:PES_KC_SERVICE,$env:PES_KC_ACCOUNT);$v.Remove($c)}catch{exit 3}",
      ref,
    );
    if (result.code !== 0 && result.code !== 3) throw failed("delete the key", result);
  }
}

// ---------------------------------------------------------------------------
// Linux: libsecret's secret-tool (the secret comes from standard input).

class LinuxKeyStore implements KeyStore {
  readonly #exec: ExecFn;
  constructor(exec: ExecFn) {
    this.#exec = exec;
  }
  where(): string {
    return "Linux Secret Service (secret-tool)";
  }
  async put(ref: string, secret: string): Promise<void> {
    const result = await this.#exec(
      "secret-tool",
      ["store", "--label=PES AI connection key", "service", KEY_SERVICE, "account", safe_ref(ref)],
      safe_secret(secret),
    );
    if (result.code !== 0) throw failed("save the key", result);
  }
  async get(ref: string): Promise<string | undefined> {
    const result = await this.#exec("secret-tool", ["lookup", "service", KEY_SERVICE, "account", safe_ref(ref)]);
    if (result.code !== 0 || result.stdout.length === 0) return undefined;
    return result.stdout;
  }
  async delete(ref: string): Promise<void> {
    const result = await this.#exec("secret-tool", ["clear", "service", KEY_SERVICE, "account", safe_ref(ref)]);
    if (result.code !== 0) throw failed("delete the key", result);
  }
}

export interface OsKeyStoreOptions {
  /** Test seam and composition seam; the default spawns the real operating system tool. */
  exec?: ExecFn;
  platform?: string;
}

/**
 * The key store of the current operating system. Nothing runs until a method is called, and a method call runs
 * `exec` (a real child process unless one was injected).
 */
export function os_key_store(options: OsKeyStoreOptions = {}): KeyStore {
  const exec = options.exec ?? spawn_exec;
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return new MacKeyStore(exec);
  if (platform === "win32") return new WindowsKeyStore(exec);
  if (platform === "linux") return new LinuxKeyStore(exec);
  throw new KeyStoreError(`no OS key store is known for the platform: ${platform}`);
}
