import test from "node:test";
import assert from "node:assert/strict";
import {
  compareDecimal,
  decimalFromBigInt,
  incrementDecimal,
  isDecimalString,
  isSafeSqliteInteger,
  toBigInt,
} from "../ts-core/decimal.ts";

test("canonical decimal strings", () => {
  for (const value of ["0", "1", "12", "9007199254740993", "9223372036854775807"]) {
    assert.equal(isDecimalString(value), true, value);
  }
  for (const value of ["", "00", "01", "-1", "+1", "1.0", "1e3", " 1", 1, null]) {
    assert.equal(isDecimalString(value), false, String(value));
  }
});

test("comparison never goes through Number", () => {
  assert.equal(compareDecimal("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareDecimal("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareDecimal("42", "42"), 0);
  assert.equal(toBigInt("18446744073709551615"), 18446744073709551615n);
});

test("increment above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(incrementDecimal("9007199254740992"), "9007199254740993");
  assert.equal(decimalFromBigInt(0n), "0");
  assert.equal(incrementDecimal("0"), "1");
});

test("safe SQLite integer boundary is explicit", () => {
  assert.equal(isSafeSqliteInteger("9007199254740991"), true);
  assert.equal(isSafeSqliteInteger("9007199254740992"), false);
  assert.equal(isSafeSqliteInteger("9223372036854775807"), false);
});
