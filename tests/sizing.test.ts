import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBaseSize, applyBellCurve, adaptiveMultiplier } from "../src/strategies/sizing";
import { RebalanceConfig } from "../src/config/rebalanceConfig";

// Minimal config covering only the fields the sizing functions read.
const cfg = {
  sizing_1h_base: 0.5,
  sizing_1h_multiplier: 8,
  sizing_1h_min_trade: 0.01,
  sizing_1h_max_trade: 14,
  sizing_15m_base: 0.25,
  sizing_15m_multiplier: 12,
  sizing_15m_min_trade: 0.01,
  sizing_15m_max_trade: 26,
  sizing_5m_base: 0.15,
  sizing_5m_multiplier: 15,
  sizing_5m_min_trade: 0.01,
  sizing_5m_max_trade: 30,
  bell_curve_enabled: true,
  bell_curve_peak_multiplier: 1.5,
  bell_curve_extreme_multiplier: 0.3,
  adaptive_sizing_enabled: true,
  recovery_multiplier: 1.2,
  profit_lock_multiplier: 0.8,
  max_recovery_multiplier: 1.5,
  max_loss_per_market: 100,
} as unknown as RebalanceConfig;

test("computeBaseSize 15m linear formula", () => {
  assert.equal(computeBaseSize(0.5, "15m", cfg), 0.25 + 0.5 * 12); // 6.25
});

test("computeBaseSize clamps to max", () => {
  const big = { ...cfg, sizing_15m_multiplier: 1000 } as RebalanceConfig;
  assert.equal(computeBaseSize(1, "15m", big), 26);
});

test("computeBaseSize 5m falls back to 15m when 5m params missing", () => {
  const noneFive = { ...cfg, sizing_5m_base: undefined, sizing_5m_multiplier: undefined,
    sizing_5m_min_trade: undefined, sizing_5m_max_trade: undefined } as RebalanceConfig;
  assert.equal(computeBaseSize(0.5, "5m", noneFive), 0.25 + 0.5 * 12);
});

test("applyBellCurve peaks at 0.5 and is lower at extremes", () => {
  const mid = applyBellCurve(10, 0.5, cfg);
  const edge = applyBellCurve(10, 0.9, cfg);
  assert.equal(mid, 10 * 1.5);
  assert.ok(edge < mid);
});

test("applyBellCurve no-op when disabled", () => {
  const off = { ...cfg, bell_curve_enabled: false } as RebalanceConfig;
  assert.equal(applyBellCurve(10, 0.2, off), 10);
});

test("adaptiveMultiplier returns 0 when loss exceeds limit", () => {
  assert.equal(adaptiveMultiplier(-150, 200, cfg), 0);
});

test("adaptiveMultiplier increases when losing (full recovery scale)", () => {
  // 50% loss -> recoveryScale=1 -> 1 + (1.2-1)*1 = 1.2 (below cap 1.5)
  assert.equal(adaptiveMultiplier(-50, 100, cfg), 1.2);
});

test("adaptiveMultiplier caps recovery at max_recovery_multiplier", () => {
  const aggressive = { ...cfg, recovery_multiplier: 3 } as RebalanceConfig;
  assert.equal(adaptiveMultiplier(-50, 100, aggressive), 1.5);
});

test("adaptiveMultiplier locks profit when winning", () => {
  assert.equal(adaptiveMultiplier(20, 100, cfg), 0.8);
});

test("adaptiveMultiplier neutral returns 1", () => {
  assert.equal(adaptiveMultiplier(0, 100, cfg), 1);
});

test("adaptiveMultiplier disabled returns 1", () => {
  const off = { ...cfg, adaptive_sizing_enabled: false } as RebalanceConfig;
  assert.equal(adaptiveMultiplier(-50, 100, off), 1);
});
