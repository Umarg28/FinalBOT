import { test } from "node:test";
import assert from "node:assert/strict";
import RiskManager, { evaluateOrderRisk, RiskLimits } from "../src/services/riskManager";

const limits: RiskLimits = {
  maxOrderNotionalUsdc: 50,
  maxTotalExposureUsdc: 200,
  maxDailyLossUsdc: 100,
};

test("evaluateOrderRisk rejects oversized single order", () => {
  const d = evaluateOrderRisk(60, limits, {
    openExposureUsdc: 0, dailyRealizedLossUsdc: 0, killSwitchTripped: false });
  assert.equal(d.allowed, false);
});

test("evaluateOrderRisk rejects when exposure cap would be exceeded", () => {
  const d = evaluateOrderRisk(40, limits, {
    openExposureUsdc: 180, dailyRealizedLossUsdc: 0, killSwitchTripped: false });
  assert.equal(d.allowed, false);
});

test("evaluateOrderRisk rejects when kill-switch tripped", () => {
  const d = evaluateOrderRisk(10, limits, {
    openExposureUsdc: 0, dailyRealizedLossUsdc: 100, killSwitchTripped: true });
  assert.equal(d.allowed, false);
});

test("evaluateOrderRisk allows a sane order", () => {
  const d = evaluateOrderRisk(40, limits, {
    openExposureUsdc: 100, dailyRealizedLossUsdc: 0, killSwitchTripped: false });
  assert.equal(d.allowed, true);
});

test("RiskManager tracks exposure across fills", () => {
  const rm = new RiskManager(limits);
  rm.recordFill(40);
  rm.recordFill(40);
  // 80 open; a 40 order brings to 120 <= 200 ok
  assert.equal(rm.checkOrder(40).allowed, true);
  rm.recordFill(150); // 230 open
  assert.equal(rm.checkOrder(10).allowed, false);
});

test("RiskManager trips kill-switch after cumulative daily loss", () => {
  const rm = new RiskManager(limits);
  rm.recordRealizedPnL(-60);
  assert.equal(rm.isKillSwitchTripped(), false);
  rm.recordRealizedPnL(-50); // total 110 >= 100
  assert.equal(rm.isKillSwitchTripped(), true);
  assert.equal(rm.checkOrder(1).allowed, false);
});

test("RiskManager resets daily counters at UTC day boundary", () => {
  const day1 = Date.parse("2026-01-01T23:00:00Z");
  const day2 = Date.parse("2026-01-02T01:00:00Z");
  const rm = new RiskManager(limits, day1);
  rm.recordRealizedPnL(-150, day1);
  assert.equal(rm.isKillSwitchTripped(), true);
  // New UTC day -> counters roll, kill-switch clears.
  assert.equal(rm.checkOrder(10, day2).allowed, true);
  assert.equal(rm.isKillSwitchTripped(), false);
});

test("RiskManager exposure never goes negative", () => {
  const rm = new RiskManager(limits);
  rm.recordFill(-50);
  assert.equal(rm.getState().openExposureUsdc, 0);
});
