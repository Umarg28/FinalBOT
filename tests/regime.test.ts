import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRegimeAdjustment, RegimeThresholds } from "../src/strategies/regime";

const T: RegimeThresholds = {
  edge_threshold: 0.58,
  trend_threshold: 0.65,
  price_stop_threshold: 0.9,
};

test("NORMAL when both sides below edge threshold", () => {
  const r = applyRegimeAdjustment(10, 10, 0.55, 0.45, T, false);
  assert.equal(r.regime, "NORMAL");
  assert.equal(r.upAmount, 10);
  assert.equal(r.downAmount, 10);
  assert.equal(r.suppressedSide, null);
});

test("STOP zeros the losing side when winner >= stop threshold", () => {
  const r = applyRegimeAdjustment(10, 10, 0.92, 0.08, T, false);
  assert.equal(r.regime, "STOP");
  assert.equal(r.downAmount, 0);
  assert.equal(r.upAmount, 10);
  assert.equal(r.suppressedSide, "DOWN");
});

test("STOP applies even during flip recovery", () => {
  const r = applyRegimeAdjustment(10, 10, 0.08, 0.92, T, true);
  assert.equal(r.regime, "STOP");
  assert.equal(r.upAmount, 0);
  assert.equal(r.suppressedSide, "UP");
});

test("TREND zeros loser between trend and stop thresholds", () => {
  const r = applyRegimeAdjustment(10, 8, 0.7, 0.3, T, false);
  assert.equal(r.regime, "TREND");
  assert.equal(r.downAmount, 0);
});

test("TREND is skipped during flip recovery (falls through to NORMAL)", () => {
  const r = applyRegimeAdjustment(10, 8, 0.7, 0.3, T, true);
  assert.equal(r.regime, "NORMAL");
  assert.equal(r.downAmount, 8);
});

test("EDGE reduces loser to 25% then clamps to 50% of winner", () => {
  // up wins; down base 8 -> 25% = 2, clamp to min(2, 10*0.5=5) = 2
  const r = applyRegimeAdjustment(10, 8, 0.6, 0.4, T, false);
  assert.equal(r.regime, "EDGE");
  assert.equal(r.downAmount, 2);
  assert.equal(r.upAmount, 10);
});

test("EDGE clamp binds when 25% exceeds 50% of winner", () => {
  // up wins but tiny (2); down base 40 -> 25% = 10, clamp to min(10, 2*0.5=1) = 1
  const r = applyRegimeAdjustment(2, 40, 0.6, 0.4, T, false);
  assert.equal(r.regime, "EDGE");
  assert.equal(r.downAmount, 1);
});
