// Server-made identifiers shared by Node, Workers, and browsers.
// Web Crypto's randomUUID is available in all of them.

export function new_id(): string {
  return globalThis.crypto.randomUUID();
}
