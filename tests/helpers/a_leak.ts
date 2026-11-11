// SEL-52 final review 2/2 (N1..N6) shared helpers: every way a provider can hand the api key back (plain, a piece,
// base64, url-encoded, \uXXXX-escaped inside JSON, escaped again inside JSON), and one scan of EVERY surface
// where a key must never appear (tables, files, log lines, executor result, DTO, export, next requests).
// Synthetic only: SYNTHETIC_KEY is an invented canary. No real provider, key, keychain or money is involved.

import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { export_project } from "../../scripts/pes_core/backup.ts";
import { KEY_MIDDLE, SYNTHETIC_KEY, everything_stored, type AEnv } from "./a_builtin_env.ts";

// ---------------------------------------------------------------------------
// encodings of the key

/** every character as \uXXXX (lower or upper case hex), the way a JSON string can spell any text */
export function uni(text: string, upper = false): string {
  return Array.from(text)
    .map((c) => {
      const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    })
    .join("");
}

/** every character as %xx */
export function pct(text: string, upper = false): string {
  return Array.from(text)
    .map((c) => {
      const hex = c.charCodeAt(0).toString(16).padStart(2, "0");
      return `%${upper ? hex.toUpperCase() : hex}`;
    })
    .join("");
}

export const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
export const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/**
 * Level n of "the key hidden in JSON strings": level 1 is the key itself; level n+1 is a JSON text whose value is
 * the \u-escaped level n. Put into a tool-call `arguments` string through uni(), level 1 is the review's N1 case
 * (after the second JSON.parse the argument IS the key), level 2 and 3 need a third and a fourth decoding.
 */
export function nested(level: number, key: string = SYNTHETIC_KEY): string {
  let text = key;
  for (let i = 1; i < level; i += 1) text = `{"v":"${uni(text)}"}`;
  return text;
}

export interface Disguise {
  label: string;
  /** the text a provider echoes (it never carries a quote or a backslash problem: it is a JSON string value) */
  text: string;
}

/** Text-shaped reflections: plain, a piece, base64, base64url, unpadded base64, %xx (both cases), \u escapes. */
export const DISGUISES: Disguise[] = [
  { label: "plain key", text: SYNTHETIC_KEY },
  { label: "key inside a sentence", text: `내 키는 ${SYNTHETIC_KEY} 입니다` },
  { label: "a piece of the key (the middle 12)", text: `조각 ${KEY_MIDDLE} 끝` },
  { label: "base64 of the key", text: b64(SYNTHETIC_KEY) },
  { label: "base64url of the key, no padding", text: b64url(SYNTHETIC_KEY) },
  { label: "base64 of a piece", text: b64(KEY_MIDDLE) },
  { label: "%xx of the key (lower case)", text: pct(SYNTHETIC_KEY) },
  { label: "%xx of the key (upper case)", text: pct(SYNTHETIC_KEY, true) },
  { label: "%xx of a piece", text: pct(KEY_MIDDLE) },
  { label: "\\u escapes of the key, written as text", text: uni(SYNTHETIC_KEY) },
];

// ---------------------------------------------------------------------------
// the scan

function decode_layers(text: string): string[] {
  const out = [text];
  const unicode = text.replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  out.push(unicode);
  const percent = (s: string): string => s.replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  out.push(percent(text), percent(unicode));
  return out;
}

/** which forms of the key a text carries (empty = clean). Looks through \u escapes (any depth of backslashes) and %xx. */
export function key_forms_in(text: string): string[] {
  const found = new Set<string>();
  const needles: Array<[string, string]> = [
    ["the key", SYNTHETIC_KEY],
    ["a piece of the key", KEY_MIDDLE],
    ["base64 of the key", b64(SYNTHETIC_KEY)],
    ["base64url of the key", b64url(SYNTHETIC_KEY)],
    ["base64 of a piece", b64(KEY_MIDDLE)],
    ["base64url of a piece", b64url(KEY_MIDDLE)],
  ];
  for (const layer of decode_layers(text)) {
    for (const [name, needle] of needles) if (layer.includes(needle)) found.add(name);
    // a base64 text may itself hide behind a \u / %xx layer; look at the bytes a long base64 run decodes to
    for (const run of layer.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
      let decoded = "";
      try {
        decoded = Buffer.from(run, "base64").toString("latin1");
      } catch {
        decoded = "";
      }
      if (decoded.includes(SYNTHETIC_KEY) || decoded.includes(KEY_MIDDLE)) found.add("a base64 run that decodes to the key");
    }
  }
  return [...found];
}

export function assert_clean(text: string, where: string): void {
  const forms = key_forms_in(text);
  assert.deepEqual(forms, [], `the api key (${forms.join(", ")}) must not appear in ${where}`);
}

let export_no = 0;

/** Everything an export of the project would carry, as one searchable string. */
export function exported_text(env: AEnv): string {
  export_no += 1;
  const dir = join(env.home.root, `final2-export-${export_no}`);
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, "bundle");
  export_project(env.db, env.objects, env.p.project_id, bundle);
  const walk = (path: string): string[] =>
    readdirSync(path).flatMap((name) => {
      const full = join(path, name);
      return statSync(full).isDirectory() ? walk(full) : [readFileSync(full).toString("latin1")];
    });
  return walk(bundle).join("\n");
}

/**
 * The key (in any disguise) is in no table row, stored file, log line, executor result, connection DTO, export,
 * or request PES sent. `extra` are more values to scan (a test() answer, a thrown message, ...).
 */
export async function assert_key_nowhere(env: AEnv, res: unknown, where: string, ...extra: unknown[]): Promise<void> {
  assert_clean(everything_stored(env), `${where}: any table row or stored file`);
  assert_clean(env.logs.join("\n"), `${where}: the log lines`);
  assert_clean(JSON.stringify(res ?? null), `${where}: the executor result`);
  assert_clean(exported_text(env), `${where}: an export`);
  assert_clean(env.fake.body_text_without_auth(), `${where}: what PES sent`);
  try {
    const list = await env.conns.list(env.ctx(`leak-list-${export_no}`));
    assert_clean(JSON.stringify(list), `${where}: the connection DTOs`);
  } catch {
    // a missing connection (a refused registration) has no DTO to scan
  }
  extra.forEach((value, i) => {
    assert_clean(typeof value === "string" ? value : JSON.stringify(value ?? null), `${where}: extra value ${i + 1}`);
  });
}

/** any caught error as text (message + code), for a leak scan */
export function error_text(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message} ${(error as { code?: string }).code ?? ""}`;
  return String(error);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function count_rows(env: AEnv, table: string): number {
  return Number(env.db.get<{ n: bigint }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0n);
}
