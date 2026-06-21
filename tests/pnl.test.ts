import { test } from "node:test";
import assert from "node:assert/strict";
import { PnLCalculator } from "../src/utils/pnlCalculator";
import { Position, TradeHistory } from "../src/interfaces";

function pos(p: Partial<Position>): Position {
  return {
    conditionId: "c1", tokenId: "up", title: "BTC up?", outcome: "UP",
    size: 0, avgPrice: 0, timestamp: new Date(), ...p,
  };
}
function trade(t: Partial<TradeHistory>): TradeHistory {
  return {
    marketId: "m1", conditionId: "c1", tokenId: "up", side: "BUY", price: 0,
    size: 0, usdcSize: 0, fees: 0, strategyName: "s", paperTrade: true,
    timestamp: new Date(), ...t,
  };
}

test("position PnL = (currentPrice - avgPrice) * size", () => {
  const p = pos({ size: 100, avgPrice: 0.4 });
  const r = PnLCalculator.calculatePositionPnL(p, 0.6);
  assert.equal(r.costBasis, 40);
  assert.equal(r.currentValue, 60);
  assert.equal(r.unrealizedPnL, 20);
  assert.equal(r.unrealizedPnLPercent, 50);
});

test("realized PnL via FIFO matching", () => {
  const trades = [
    trade({ side: "BUY", price: 0.4, size: 100 }),
    trade({ side: "BUY", price: 0.5, size: 100 }),
    trade({ side: "SELL", price: 0.7, size: 150 }),
  ];
  // FIFO: sell 100 @0.7 vs buy 0.4 -> +30 ; sell 50 @0.7 vs buy 0.5 -> +10 => 40
  const { realizedPnL } = PnLCalculator.calculateRealizedPnL(trades);
  assert.equal(Math.round(realizedPnL * 100) / 100, 40);
});

test("settlement: winner at 1.0, loser at 0.0", () => {
  // Hold 100 UP @0.6 and 80 DOWN @0.4; UP wins (settle UP=1, DOWN=0).
  const positions = [
    pos({ tokenId: "up", outcome: "UP", size: 100, avgPrice: 0.6 }),
    pos({ tokenId: "down", outcome: "DOWN", size: 80, avgPrice: 0.4 }),
  ];
  const prices = new Map([["up", 1.0], ["down", 0.0]]);
  const m = PnLCalculator.calculateMarketPnL(positions, [], "c1", prices)!;
  // cost = 60 + 32 = 92 ; payout = 100 + 0 = 100 ; pnl = 8
  assert.equal(m.totalCostBasis, 92);
  assert.equal(m.totalCurrentValue, 100);
  assert.equal(Math.round(m.totalPnL * 100) / 100, 8);
});

test("market PnL is null when no positions for conditionId", () => {
  assert.equal(PnLCalculator.calculateMarketPnL([], [], "nope", new Map()), null);
});
