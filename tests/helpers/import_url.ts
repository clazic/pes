// SEL-125 — the value of a child's `--import` (argv or NODE_OPTIONS) for a module given by its file path.
// Node's ESM loader reads `--import` as a URL specifier: on Windows an absolute path like `D:\a\pes\tests\helpers\x.ts` is read as a URL with
// the scheme `d:` and fails with ERR_UNSUPPORTED_ESM_URL_SCHEME. A `file://` URL works on every OS, so every `--import` of an absolute path goes through this.
// (A relative `./tests/helpers/…` spelling is a relative URL already and needs no change — package.json / CI use that.)
import { pathToFileURL } from "node:url";

/** `file://` URL of `path`. `windows` picks the path rules (default: this OS) — the tests pass `true` to check Windows spellings on any OS. */
export function import_url(path: string, windows: boolean = process.platform === "win32"): string {
  return pathToFileURL(path, { windows }).href;
}
