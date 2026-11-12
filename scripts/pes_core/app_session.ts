// One-time app codes (SEL-85, U1b follow-up A): how `pes open <slug> --app` hands the owner's session to the web app.
//
// The CLI used to put the session itself in the address fragment (#pes=…); an address in a browser history, a bookmark or a terminal log then held a
// working session for as long as the session secret lives. Now the fragment holds a CODE: random, kept only in the memory of the server process,
// valid for one exchange and for a short time (60 s by default). The app trades it for the session with `POST /api/v1/app-session {code}` and the
// code is gone the moment it is read.
//
// Rules this module keeps (the HTTP side is scripts/serve.ts):
//  - memory only: the table lives in this object; nothing here reads or writes a file, a database or a log line, and no text of a code or a session
//    is ever put into an error message.
//  - a code is 32 random bytes (crypto) in base64url (43 characters). The table is keyed by the SHA-256 of the code, so a lookup compares hashes
//    (no timing signal about the code text) and the table never holds the code itself.
//  - `take` finds and removes in one synchronous step: of any number of concurrent exchanges of one code, exactly one gets the session.
//  - an expired code is removed when it is met and by every `issue`/`take` sweep; the table is also capped, the oldest code goes first.
//  - the session handed out is the SERVER's own owner session (the issuer proved it holds it before a code was made — see serve.ts); a caller never
//    chooses which session a code stands for.
//  - request budget: the exchange endpoint takes no credential, so every attempt (good or bad) counts against a sliding minute window.

import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_CODE_TTL_MS = 60_000;
const MAX_CODE_TTL_MS = 10 * 60_000;
const MAX_LIVE_CODES = 64;
const WINDOW_MS = 60_000;
/** Exchange attempts per minute for the whole server (the endpoint has no credential to count them against). */
export const EXCHANGE_ATTEMPTS_PER_MINUTE = 120;
/** Code requests per minute (the caller holds the owner session; this only bounds a runaway loop). */
export const ISSUE_REQUESTS_PER_MINUTE = 60;
/** What the exchange accepts as a code: base64url, 20~128 characters (ours are 43). */
export const CODE_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface AppHandoff {
  session: string;
  projects: Record<string, string>;
}

interface Entry {
  expires_at: number;
  handoff: AppHandoff;
}

const key_of = (code: string): string => createHash("sha256").update(code, "utf8").digest("hex");

/** PES_APP_CODE_TTL_MS: whole milliseconds, 1 … 10 minutes; anything else is the default 60 s. */
export function code_ttl_ms(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9][0-9]{0,8}$/.test(raw)) return DEFAULT_CODE_TTL_MS;
  return Math.min(Number(raw), MAX_CODE_TTL_MS);
}

/** `{slug: id}` of the projects the code opens, or null when the shape is wrong (a closed shape: the CLI sends one or a few entries). */
export function valid_projects(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_LIVE_CODES) return null;
  const out: Record<string, string> = {};
  for (const [slug, id] of entries) {
    if (!SLUG.test(slug) || typeof id !== "string" || id === "" || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) return null;
    out[slug] = id;
  }
  return out;
}

export class AppCodes {
  readonly #table = new Map<string, Entry>();
  readonly #ttl_ms: number;
  readonly #now: () => number;
  readonly #exchange_hits: number[] = [];
  readonly #issue_hits: number[] = [];

  constructor(options: { ttl_ms?: number; now?: () => number } = {}) {
    this.#ttl_ms = options.ttl_ms ?? DEFAULT_CODE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Makes a one-time code for `handoff` (the table keeps its own copy). */
  issue(handoff: AppHandoff): string {
    const now = this.#now();
    this.#sweep(now);
    while (this.#table.size >= MAX_LIVE_CODES) {
      const oldest = this.#table.keys().next();
      if (oldest.done === true) break;
      this.#table.delete(oldest.value);
    }
    const code = randomBytes(32).toString("base64url");
    this.#table.set(key_of(code), { expires_at: now + this.#ttl_ms, handoff: { session: handoff.session, projects: { ...handoff.projects } } });
    return code;
  }

  /** Reads and removes in one step. null for an unknown, used or expired code — the three look the same to the caller. */
  take(code: string): AppHandoff | null {
    const now = this.#now();
    this.#sweep(now);
    const key = key_of(code);
    const entry = this.#table.get(key);
    if (entry === undefined) return null;
    this.#table.delete(key);
    return entry.expires_at > now ? entry.handoff : null;
  }

  /** Counts one exchange attempt; retry_after_ms when the minute's budget is spent, else null. */
  exchange_wait(): number | null {
    return this.#spend(this.#exchange_hits, EXCHANGE_ATTEMPTS_PER_MINUTE);
  }

  /** Counts one code request; retry_after_ms when the minute's budget is spent, else null. */
  issue_wait(): number | null {
    return this.#spend(this.#issue_hits, ISSUE_REQUESTS_PER_MINUTE);
  }

  #spend(hits: number[], limit: number): number | null {
    const now = this.#now();
    while (hits.length > 0 && (hits[0] as number) <= now - WINDOW_MS) hits.shift();
    if (hits.length >= limit) return Math.min(WINDOW_MS, Math.max(1, (hits[0] as number) + WINDOW_MS - now));
    hits.push(now);
    return null;
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#table) if (entry.expires_at <= now) this.#table.delete(key);
  }
}
