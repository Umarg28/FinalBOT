import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFillFromResponse, computeFee } from "../src/utils/orderFill";

test("uses explicit executedPrice/executedSize when present", () => {
  const f = parseFillFromResponse({ executedPrice: 0.42, executedSize: 100 }, "BUY", 0.45, 100);
  assert.equal(f.price, 0.42);
  assert.equal(f.size, 100);
  assert.equal(f.fromResponse, true);
});

test("derives price from maker/taker amounts for a BUY", () => {
  // BUY: pay 42 USDC (making), receive 100 shares (taking) -> price 0.42
  const f = parseFillFromResponse({ makingAmount: 42, takingAmount: 100 }, "BUY", 0.45, 100);
  assert.equal(f.price, 0.42);
  assert.equal(f.size, 100);
  assert.equal(f.fromResponse, true);
});

test("derives price from maker/taker amounts for a SELL", () => {
  // SELL: give 100 shares (making), receive 42 USDC (taking) -> price 0.42
  const f = parseFillFromResponse({ makingAmount: 100, takingAmount: 42 }, "SELL", 0.45, 100);
  assert.equal(f.price, 0.42);
  assert.equal(f.size, 100);
});

test("falls back to signal price/size when response lacks fill info", () => {
  const f = parseFillFromResponse({ success: true }, "BUY", 0.45, 100);
  assert.equal(f.price, 0.45);
  assert.equal(f.size, 100);
  assert.equal(f.fromResponse, false);
});

test("rejects out-of-range derived price and falls back", () => {
  const f = parseFillFromResponse({ price: 1.7, sizeMatched: 10 }, "BUY", 0.45, 100);
  assert.equal(f.fromResponse, false);
});

test("computeFee returns 0 for 0 bps", () => {
  assert.equal(computeFee(100, 0), 0);
});

test("computeFee computes bps correctly", () => {
  assert.equal(computeFee(100, 50), 0.5); // 50 bps of 100 = 0.5
});
