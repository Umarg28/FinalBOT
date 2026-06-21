import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRebalanceConfig } from "../src/config/rebalanceConfig";
import type { RebalanceConfig } from "../src/config/rebalanceConfig";

// A known-good baseline (only the fields the validator inspects matter).
const good = {
  target_yes_ratio: 0.5,
  edge_threshold: 0.58,
  trend_threshold: 0.65,
  tilt_threshold: 0.59,
  price_stop_threshold: 0.9,
  stop_add_threshold: 0.8,
  late_entry_threshold: 0.7,
  slippage_buffer: 0.005,
  limit_price_offset: 0.003,
  bankroll_total: 100,
  min_trade_size: 0.01,
  max_trade_size: 26,
  sizing_1h_max_trade: 14,
  sizing_15m_max_trade: 26,
  order_type: "limit",
} as unknown as RebalanceConfig;

test("valid config produces no errors", () => {
  assert.deepEqual(validateRebalanceConfig(good), []);
});

test("rejects probability out of range", () => {
  const bad = { ...good, target_yes_ratio: 1.5 } as RebalanceConfig;
  assert.ok(validateRebalanceConfig(bad).some((e) => e.includes("target_yes_ratio")));
});

test("rejects non-monotonic regime thresholds", () => {
  const bad = { ...good, edge_threshold: 0.8 } as RebalanceConfig; // edge > trend
  assert.ok(validateRebalanceConfig(bad).some((e) => e.includes("edge_threshold")));
});

test("rejects min_trade_size > max_trade_size", () => {
  const bad = { ...good, min_trade_size: 50 } as RebalanceConfig;
  assert.ok(validateRebalanceConfig(bad).some((e) => e.includes("min_trade_size")));
});

test("rejects invalid order_type", () => {
  const bad = { ...good, order_type: "stop" } as unknown as RebalanceConfig;
  assert.ok(validateRebalanceConfig(bad).some((e) => e.includes("order_type")));
});

test("rejects negative bankroll", () => {
  const bad = { ...good, bankroll_total: -5 } as RebalanceConfig;
  assert.ok(validateRebalanceConfig(bad).some((e) => e.includes("bankroll_total")));
});
