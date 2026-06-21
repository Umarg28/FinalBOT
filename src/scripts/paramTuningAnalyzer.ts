/**
 * Param Tuning Analyzer (read-only, one-off)
 *
 * Reads all PnL history files and recent trade CSVs and reports the metrics
 * needed to make evidence-based parameter adjustments to the SHARED config in
 * inventory-rebalance-config.yaml.
 *
 * Run with:  npx ts-node src/scripts/paramTuningAnalyzer.ts
 */

import fs from 'fs';
import path from 'path';

const PAPER_DIR = path.resolve(process.cwd(), 'logs', 'paper');

// ---------- types ----------
interface Position {
  outcome: string;
  size: number;
  avgPrice: number;
  timestamp: string;
}
interface MarketPnLBlock {
  positions: Array<{ position: Position; costBasis: number; currentValue: number; unrealizedPnL: number }>;
  totalCostBasis: number;
  totalCurrentValue: number;
}
interface PnLEntry {
  marketName: string;
  conditionId: string;
  marketPnL?: MarketPnLBlock;
  totalPnl: number;
  pnlPercent: number;
  priceUp: number;
  priceDown: number;
  sharesUp: number;
  sharesDown: number;
  timestamp: number;
}

type Frame = '5m' | '15m' | '1h' | 'unknown';

// ---------- helpers ----------
function classify(name: string): Frame {
  // 1h: "April 27, 3PM ET"
  if (/\d{1,2}(AM|PM)\s*ET/i.test(name) && !/\d{1,2}:\d{2}/.test(name)) return '1h';
  // 5m vs 15m: extract minute window length
  const m = name.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*ET/i);
  if (m) {
    const startMin = parseInt(m[2], 10);
    const endMin = parseInt(m[5], 10);
    let diff = endMin - startMin;
    if (diff < 0) diff += 60;
    if (diff === 0) {
      const sH = parseInt(m[1], 10);
      const eH = parseInt(m[4], 10);
      // Hourly windows like 3PM-4PM
      if (sH !== eH) return '1h';
    }
    if (diff === 5) return '5m';
    if (diff === 15) return '15m';
    if (diff === 60) return '1h';
  }
  return 'unknown';
}

function loadAllPnLEntries(): PnLEntry[] {
  if (!fs.existsSync(PAPER_DIR)) return [];
  const files = fs.readdirSync(PAPER_DIR).filter((f) => /^pnl_history.*\.json$/.test(f));
  const seen = new Map<string, PnLEntry>();
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(PAPER_DIR, f), 'utf8');
      if (!raw.trim()) continue;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) continue;
      for (const e of parsed as PnLEntry[]) {
        if (!e || !e.conditionId) continue;
        const existing = seen.get(e.conditionId);
        if (!existing || (e.timestamp || 0) >= (existing.timestamp || 0)) {
          seen.set(e.conditionId, e);
        }
      }
    } catch { /* skip */ }
  }
  return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// ---------- summary ----------
interface FrameSummary {
  frame: Frame;
  count: number;
  totalPnl: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: number;
  avgPnl: number;
  bestMarket: number;
  worstMarket: number;
  bigLossesGT50: number;
  bigLossesGT200: number;
  upWinTotal: number;
  downWinTotal: number;
  upBuysAvgPrice: number;
  downBuysAvgPrice: number;
  upBuysCount: number;
  downBuysCount: number;
}

function summarizeByFrame(entries: PnLEntry[]): Record<Frame, FrameSummary> {
  const summaries: Record<Frame, FrameSummary> = {} as any;
  const frames: Frame[] = ['5m', '15m', '1h', 'unknown'];
  for (const f of frames) {
    summaries[f] = {
      frame: f, count: 0, totalPnl: 0, wins: 0, losses: 0, flat: 0,
      winRate: 0, avgPnl: 0, bestMarket: 0, worstMarket: 0,
      bigLossesGT50: 0, bigLossesGT200: 0,
      upWinTotal: 0, downWinTotal: 0,
      upBuysAvgPrice: 0, downBuysAvgPrice: 0,
      upBuysCount: 0, downBuysCount: 0,
    };
  }

  const upPriceSums: Record<Frame, number> = { '5m': 0, '15m': 0, '1h': 0, unknown: 0 };
  const downPriceSums: Record<Frame, number> = { '5m': 0, '15m': 0, '1h': 0, unknown: 0 };

  for (const e of entries) {
    const f = classify(e.marketName);
    const s = summaries[f];
    s.count++;
    s.totalPnl += e.totalPnl;
    if (e.totalPnl > 0.005) s.wins++;
    else if (e.totalPnl < -0.005) s.losses++;
    else s.flat++;
    if (e.totalPnl > s.bestMarket) s.bestMarket = e.totalPnl;
    if (e.totalPnl < s.worstMarket) s.worstMarket = e.totalPnl;
    if (e.totalPnl < -50) s.bigLossesGT50++;
    if (e.totalPnl < -200) s.bigLossesGT200++;

    // Winning side bucket
    if (e.priceUp >= 0.99) s.upWinTotal += e.totalPnl;
    else if (e.priceDown >= 0.99) s.downWinTotal += e.totalPnl;

    // Avg entry price by side using marketPnL positions
    const positions = e.marketPnL?.positions || [];
    for (const p of positions) {
      const px = p.position?.avgPrice;
      const sz = p.position?.size;
      if (typeof px !== 'number' || typeof sz !== 'number' || sz <= 0) continue;
      if (p.position.outcome?.toLowerCase() === 'up') {
        upPriceSums[f] += px * sz; s.upBuysCount += sz;
      } else if (p.position.outcome?.toLowerCase() === 'down') {
        downPriceSums[f] += px * sz; s.downBuysCount += sz;
      }
    }
  }

  for (const f of frames) {
    const s = summaries[f];
    if (s.wins + s.losses > 0) s.winRate = (s.wins / (s.wins + s.losses)) * 100;
    if (s.count > 0) s.avgPnl = s.totalPnl / s.count;
    if (s.upBuysCount > 0) s.upBuysAvgPrice = upPriceSums[f] / s.upBuysCount;
    if (s.downBuysCount > 0) s.downBuysAvgPrice = downPriceSums[f] / s.downBuysCount;
  }
  return summaries;
}

// ---------- biggest losers analysis ----------
function topLosers(entries: PnLEntry[], n: number = 15) {
  return [...entries]
    .filter((e) => e.totalPnl < 0)
    .sort((a, b) => a.totalPnl - b.totalPnl)
    .slice(0, n)
    .map((e) => {
      // determine winning side & loser-side avg price
      const winSide = e.priceUp >= 0.99 ? 'UP' : e.priceDown >= 0.99 ? 'DOWN' : '?';
      const loserSide = winSide === 'UP' ? 'down' : winSide === 'DOWN' ? 'up' : '?';
      const positions = e.marketPnL?.positions || [];
      const loserPos = positions.find((p) => p.position?.outcome?.toLowerCase() === loserSide);
      const winnerPos = positions.find((p) => p.position?.outcome?.toLowerCase() === (winSide.toLowerCase()));
      return {
        frame: classify(e.marketName),
        marketName: e.marketName,
        totalPnl: Math.round(e.totalPnl * 100) / 100,
        winSide,
        loserAvgPrice: loserPos?.position?.avgPrice ?? null,
        loserSize: loserPos?.position?.size ?? null,
        winnerAvgPrice: winnerPos?.position?.avgPrice ?? null,
        winnerSize: winnerPos?.position?.size ?? null,
      };
    });
}

// ---------- entry-price bucket analysis ----------
function entryPriceBuckets(entries: PnLEntry[]) {
  // Bucket the loser-side avg entry price across markets to see where the bot
  // bleeds. (loser side = side that ended at 0)
  const buckets = ['<0.40', '0.40-0.50', '0.50-0.60', '0.60-0.70', '0.70-0.85', '>=0.85'];
  const counts: Record<string, { n: number; loss: number }> = {};
  for (const b of buckets) counts[b] = { n: 0, loss: 0 };

  for (const e of entries) {
    const winSide = e.priceUp >= 0.99 ? 'up' : e.priceDown >= 0.99 ? 'down' : null;
    if (!winSide) continue;
    const loserSide = winSide === 'up' ? 'down' : 'up';
    const positions = e.marketPnL?.positions || [];
    const loserPos = positions.find((p) => p.position?.outcome?.toLowerCase() === loserSide);
    if (!loserPos) continue;
    const px = loserPos.position?.avgPrice;
    const sz = loserPos.position?.size || 0;
    if (typeof px !== 'number') continue;
    const b =
      px < 0.40 ? '<0.40'
      : px < 0.50 ? '0.40-0.50'
      : px < 0.60 ? '0.50-0.60'
      : px < 0.70 ? '0.60-0.70'
      : px < 0.85 ? '0.70-0.85'
      : '>=0.85';
    counts[b].n++;
    counts[b].loss += sz * px; // dollars wasted on losing side
  }
  return counts;
}

// ---------- output ----------
function fmt(n: number, d = 2) {
  if (!isFinite(n)) return '0';
  return n.toFixed(d);
}

function main() {
  const entries = loadAllPnLEntries();
  console.log(`\n[ANALYZER] Loaded ${entries.length} unique market PnL records from ${PAPER_DIR}\n`);

  const sums = summarizeByFrame(entries);
  console.log('============ FRAME-LEVEL SUMMARY ============');
  console.log('frame  count  total$       avg$    win%   wins   losses  worst$       big<-50  big<-200  upBuyAvg  downBuyAvg');
  for (const f of ['5m', '15m', '1h', 'unknown'] as Frame[]) {
    const s = sums[f];
    if (s.count === 0) continue;
    console.log(
      `${f.padEnd(6)} ${String(s.count).padStart(5)}  ${fmt(s.totalPnl).padStart(10)}  ${fmt(s.avgPnl).padStart(8)}  ${fmt(s.winRate, 1).padStart(5)}  ${String(s.wins).padStart(5)}  ${String(s.losses).padStart(6)}  ${fmt(s.worstMarket).padStart(10)}  ${String(s.bigLossesGT50).padStart(7)}  ${String(s.bigLossesGT200).padStart(8)}  ${fmt(s.upBuysAvgPrice, 3).padStart(8)}  ${fmt(s.downBuysAvgPrice, 3).padStart(10)}`,
    );
  }

  console.log('\n============ UP-WIN vs DOWN-WIN by frame ============');
  for (const f of ['5m', '15m', '1h'] as Frame[]) {
    const s = sums[f];
    if (s.count === 0) continue;
    console.log(`${f.padEnd(4)}  upWinPnL=${fmt(s.upWinTotal).padStart(10)}   downWinPnL=${fmt(s.downWinTotal).padStart(10)}`);
  }

  console.log('\n============ TOP 15 LOSING MARKETS ============');
  const losers = topLosers(entries, 15);
  console.log('frame  pnl$       winSide  loserSide_avgPx   loserSize   winnerAvgPx   winnerSize   marketName');
  for (const L of losers) {
    console.log(
      `${L.frame.padEnd(5)}  ${fmt(L.totalPnl).padStart(8)}  ${String(L.winSide).padEnd(6)}  ${fmt(L.loserAvgPrice ?? 0, 3).padStart(13)}  ${fmt(L.loserSize ?? 0, 1).padStart(9)}  ${fmt(L.winnerAvgPrice ?? 0, 3).padStart(11)}  ${fmt(L.winnerSize ?? 0, 1).padStart(10)}   ${L.marketName}`,
    );
  }

  console.log('\n============ LOSER-SIDE AVG ENTRY PRICE BUCKETS (across ALL frames) ============');
  console.log('Where did we BUY the side that lost?  (counts + total $ wasted on that side)');
  const buckets = entryPriceBuckets(entries);
  for (const b of Object.keys(buckets)) {
    console.log(`  loserAvgPx ${b.padEnd(10)}  count=${String(buckets[b].n).padStart(4)}   $on_loser=${fmt(buckets[b].loss).padStart(10)}`);
  }

  // Per-frame: % of markets with loser avg price >= 0.65 (regime "TREND" zone)
  console.log('\n============ ENTRY VS REGIME THRESHOLDS ============');
  for (const f of ['5m', '15m', '1h'] as Frame[]) {
    const fEntries = entries.filter((e) => classify(e.marketName) === f);
    if (fEntries.length === 0) continue;
    let entered65 = 0, entered58 = 0, entered85 = 0, total = 0, lossWhenEntered65 = 0;
    for (const e of fEntries) {
      const winSide = e.priceUp >= 0.99 ? 'up' : e.priceDown >= 0.99 ? 'down' : null;
      if (!winSide) continue;
      const loserSide = winSide === 'up' ? 'down' : 'up';
      const lp = e.marketPnL?.positions?.find((p) => p.position?.outcome?.toLowerCase() === loserSide);
      if (!lp) continue;
      total++;
      const px = lp.position?.avgPrice ?? 0;
      if (px >= 0.58) entered58++;
      if (px >= 0.65) { entered65++; lossWhenEntered65 += e.totalPnl; }
      if (px >= 0.85) entered85++;
    }
    console.log(`  ${f.padEnd(4)}  total=${total}   loserBuysAt>=0.58: ${entered58}   >=0.65: ${entered65} (sumPnL=${fmt(lossWhenEntered65)})   >=0.85: ${entered85}`);
  }

  console.log('\n============ EVIDENCE FOR LATE ENTRY / OVERSIZING ============');
  // Big losses are the symptoms; check the ratio of big-loss markets per frame
  for (const f of ['5m', '15m', '1h'] as Frame[]) {
    const s = sums[f];
    if (s.count === 0) continue;
    const ratio50 = (s.bigLossesGT50 / s.count) * 100;
    const ratio200 = (s.bigLossesGT200 / s.count) * 100;
    console.log(`  ${f.padEnd(4)}  >$50 loss markets: ${ratio50.toFixed(1)}%   >$200 loss markets: ${ratio200.toFixed(1)}%`);
  }

  console.log('\n[ANALYZER] done.\n');
}

main();
