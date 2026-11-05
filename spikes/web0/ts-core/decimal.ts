// Normalized decimal strings: rev, control_rev, fence, event_seq, version_no,
// round_no, edition_no. Never convert to JavaScript Number.

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_DECIMAL.test(value);
}

export function decimal(value: unknown, path: string): string {
  if (!isDecimalString(value)) {
    throw new TypeError(`${path}: canonical decimal string required`);
  }
  return value;
}

export function toBigInt(value: string): bigint {
  if (!isDecimalString(value)) {
    throw new TypeError(`not a canonical decimal string: ${String(value)}`);
  }
  return BigInt(value);
}

export function decimalFromBigInt(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("decimal values are non-negative");
  }
  return value.toString(10);
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left = toBigInt(a);
  const right = toBigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function incrementDecimal(value: string): string {
  return decimalFromBigInt(toBigInt(value) + 1n);
}

/** True when a SQLite/D1 INTEGER can be read back without Number precision loss. */
export function isSafeSqliteInteger(value: string): boolean {
  const n = toBigInt(value);
  return n <= 9007199254740991n; // Number.MAX_SAFE_INTEGER
}

/** Adapter rule: always CAST integer revision columns to TEXT when reading. */
export const READ_DECIMAL_SQL = "CAST({column} AS TEXT)";
