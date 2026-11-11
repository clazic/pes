// Test-only `--import` module (SEL-72, SEL-33 on the TS side): a server must start and answer without any reverse-DNS or host-name
// lookup. Python's HTTPServer.server_bind() called socket.getfqdn() and stalled for 30 s on some macOS runners
// (actions/runner-images#12162); serve.py avoids it, serve.ts must never have it.
//
// Every call of dns.reverse / dns.lookupService (callback, promises, Resolver) and every dns.lookup of a name that is not an IP literal
// or "localhost" is appended to the file named by PES_TEST_DNS_LOG (one line each) and then runs normally. The test asserts the file is empty.
import dns from "node:dns";
import dnsp from "node:dns/promises";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isIP } from "node:net";

const log = process.env.PES_TEST_DNS_LOG;

function note(what: string): void {
  if (log === undefined || log === "") return;
  try {
    appendFileSync(log, `${what}\n`);
  } catch {
    // the log is a test aid only
  }
}

type AnyFn = (...args: unknown[]) => unknown;
const d = dns as unknown as Record<string, AnyFn>;
const p = dnsp as unknown as Record<string, AnyFn>;

for (const name of ["reverse", "lookupService"]) {
  const original = d[name] as AnyFn;
  d[name] = function (this: unknown, ...args: unknown[]) {
    note(`dns.${name} ${String(args[0])}`);
    return original.apply(this, args);
  };
  const original_p = p[name] as AnyFn;
  p[name] = function (this: unknown, ...args: unknown[]) {
    note(`dns.promises.${name} ${String(args[0])}`);
    return original_p.apply(this, args);
  };
}

const Resolver = dns.Resolver.prototype as unknown as Record<string, AnyFn>;
const original_resolver_reverse = Resolver.reverse as AnyFn;
Resolver.reverse = function (this: unknown, ...args: unknown[]) {
  note(`Resolver.reverse ${String(args[0])}`);
  return original_resolver_reverse.apply(this, args);
};

const original_lookup = d.lookup as AnyFn;
d.lookup = function (this: unknown, ...args: unknown[]) {
  const host = args[0];
  if (typeof host === "string" && host !== "localhost" && isIP(host) === 0) note(`dns.lookup ${host}`);
  return original_lookup.apply(this, args);
} as AnyFn;
const original_lookup_p = p.lookup as AnyFn;
p.lookup = function (this: unknown, ...args: unknown[]) {
  const host = args[0];
  if (typeof host === "string" && host !== "localhost" && isIP(host) === 0) note(`dns.promises.lookup ${host}`);
  return original_lookup_p.apply(this, args);
} as AnyFn;

syncBuiltinESMExports();
