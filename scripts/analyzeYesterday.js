/**
 * Analyse yesterday's paper trading run to find patterns that map to
 * existing config parameters in inventory-rebalance-config.yaml.
 *
 * Reads the PnL report directly (no API calls).
 */

const fs = require('fs');
const path = require('path');

const REPORT = process.env.REPORT || 'logs/paper/PnL Report_20260428-155939.txt';

function parseReport(text) {
  const normalised = text.replace(/\r\n/g, '\n');
  // Split on the market title line — every market begins with "  15-Min Market: ..." or "  1-Hour Market: ..."
  const recordRegex = /\s+(15-Min|1-Hour) Market:\s*(.+?)\n/g;
  const positions = [];
  let m;
  while ((m = recordRegex.exec(normalised)) !== null) {
    positions.push({ type: m[1], title: m[2].trim(), start: m.index, headerEnd: recordRegex.lastIndex });
  }

  const markets = [];
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    const nextStart = i + 1 < positions.length ? positions[i + 1].start : normalised.length;
    const block = normalised.slice(cur.headerEnd, nextStart);
    const type = cur.type === '15-Min' ? '15m' : '1h';
    const title = cur.title;

    const outcomeMatch = block.match(/OUTCOME:\s*(UP|DOWN) Won/);
    const pnlMatch = block.match(/PnL:\s*([+-])\$([\d.]+)\s*\(([+-][\d.]+)%\)/);
    const upSharesMatch = block.match(/UP:\s+([\d.]+)\s*\n\s*DOWN:\s+([\d.]+)/);
    const upCostMatch = block.match(/AVERAGE COST:\s*\n\s*UP:\s+\$([\d.]+)\s*\n\s*DOWN:\s+\$([\d.]+)/);
    const investedMatch = block.match(/TOTAL INVESTED:\s*\$([\d.]+)/);

    if (!pnlMatch || !investedMatch) continue;

    const pnlSign = pnlMatch[1];
    const pnl = (pnlSign === '+' ? 1 : -1) * parseFloat(pnlMatch[2]);
    const pnlPct = parseFloat(pnlMatch[3]);
    const invested = parseFloat(investedMatch[1]);

    // Detect if this is a 5-min slot vs 15-min slot from the title
    let detailedType = type;
    if (type === '15m') {
      const hhmmMatch = title.match(/(\d{1,2}):(\d{2})(AM|PM)-(\d{1,2}):(\d{2})(AM|PM)/);
      if (hhmmMatch) {
        const startMin = parseInt(hhmmMatch[2], 10);
        const endMin = parseInt(hhmmMatch[5], 10);
        const startH = parseInt(hhmmMatch[1], 10);
        const endH = parseInt(hhmmMatch[4], 10);
        const durMin = (endH * 60 + endMin) - (startH * 60 + startMin);
        const durMod = ((durMin % (24 * 60)) + (24 * 60)) % (24 * 60);
        if (durMod === 5) detailedType = '5m';
        else if (durMod === 15) detailedType = '15m';
      }
    }

    // Hour window from title (for grouping)
    let hourWindow = null;
    if (detailedType === '1h') {
      const hMatch = title.match(/(\d{1,2})(AM|PM) ET/);
      if (hMatch) hourWindow = `${hMatch[1]}${hMatch[2]}`;
    } else {
      const tMatch = title.match(/(\d{1,2}):(\d{2})(AM|PM)/);
      if (tMatch) {
        const h = parseInt(tMatch[1], 10);
        hourWindow = `${h}${tMatch[3]}`;
      }
    }

    const upWon = outcomeMatch && outcomeMatch[1] === 'UP';
    const upShares = upSharesMatch ? parseFloat(upSharesMatch[1]) : 0;
    const downShares = upSharesMatch ? parseFloat(upSharesMatch[2]) : 0;
    const upAvgCost = upCostMatch ? parseFloat(upCostMatch[1]) : 0;
    const downAvgCost = upCostMatch ? parseFloat(upCostMatch[2]) : 0;
    const asset = title.includes('Bitcoin') ? 'BTC' : title.includes('Ethereum') ? 'ETH' : 'OTHER';

    markets.push({
      title, type: detailedType, asset, hourWindow,
      pnl, pnlPct, invested, upWon, upShares, downShares, upAvgCost, downAvgCost,
      // Loser-side metrics: how much was sunk into the side that ultimately lost?
      loserShares: upWon ? downShares : upShares,
      loserAvgCost: upWon ? downAvgCost : upAvgCost,
      loserCostBasis: upWon ? downShares * downAvgCost : upShares * upAvgCost,
      winnerShares: upWon ? upShares : downShares,
      winnerAvgCost: upWon ? upAvgCost : downAvgCost,
      winnerCostBasis: upWon ? upShares * upAvgCost : downShares * downAvgCost,
    });
  }

  return markets;
}

function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function dol(n) { return (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0); }

function summary(markets, label) {
  const n = markets.length;
  if (!n) { console.log(`  ${label.padEnd(20)} (0 markets)`); return; }
  const inv = markets.reduce((s, m) => s + m.invested, 0);
  const pnl = markets.reduce((s, m) => s + m.pnl, 0);
  const wins = markets.filter(m => m.pnl > 0).length;
  const winRate = (wins / n) * 100;
  const pnlPct = inv > 0 ? (pnl / inv) * 100 : 0;
  const avgInv = inv / n;
  const avgPnl = pnl / n;
  const winnerCostMean = markets.reduce((s, m) => s + m.winnerCostBasis, 0) / n;
  const loserCostMean = markets.reduce((s, m) => s + m.loserCostBasis, 0) / n;
  const tilt = winnerCostMean / Math.max(1, winnerCostMean + loserCostMean) * 100;
  console.log(
    `  ${label.padEnd(20)} ${String(n).padStart(4)} mkts | inv $${avgInv.toFixed(0).padStart(5)} avg, $${(inv / 1000).toFixed(1).padStart(4)}k tot | ` +
    `pnl ${pct(pnlPct).padStart(7)} (${dol(pnl).padStart(7)}) | win ${winRate.toFixed(0).padStart(2)}% | ` +
    `tilt-to-winner: ${tilt.toFixed(0)}%`
  );
}

function main() {
  if (!fs.existsSync(REPORT)) {
    console.error(`PnL report not found: ${REPORT}`);
    process.exit(1);
  }
  const text = fs.readFileSync(REPORT, 'utf8');
  const markets = parseReport(text);
  console.log(`Parsed ${markets.length} markets from report\n`);

  // ===========================================================================
  // 1. By market type
  // ===========================================================================
  console.log('=== BY MARKET TYPE ===');
  for (const t of ['5m', '15m', '1h']) summary(markets.filter(m => m.type === t), t);
  console.log();

  // ===========================================================================
  // 2. By asset
  // ===========================================================================
  console.log('=== BY ASSET ===');
  for (const a of ['BTC', 'ETH', 'OTHER']) summary(markets.filter(m => m.asset === a), a);
  console.log();

  // ===========================================================================
  // 3. By type × asset (most useful matrix)
  // ===========================================================================
  console.log('=== BY TYPE × ASSET ===');
  for (const t of ['5m', '15m', '1h']) {
    for (const a of ['BTC', 'ETH']) summary(markets.filter(m => m.type === t && m.asset === a), `${t} ${a}`);
  }
  console.log();

  // ===========================================================================
  // 4. Loser-side cost basis pattern (where the bleed is)
  // ===========================================================================
  console.log('=== LOSER-SIDE BLEED ANALYSIS ===');
  const losing = markets.filter(m => m.pnl < 0).sort((a, b) => a.pnl - b.pnl);
  const totalLoss = losing.reduce((s, m) => s + m.pnl, 0);
  const totalLoserSunk = losing.reduce((s, m) => s + m.loserCostBasis, 0);
  console.log(`  ${losing.length} losing markets, total loss ${dol(totalLoss)}`);
  console.log(`  $${totalLoserSunk.toFixed(0)} total sunk into losing side across these markets`);
  console.log(`  → average loser-side cost in losing markets: $${(totalLoserSunk / losing.length).toFixed(2)}`);

  // For each losing market, what was the loser's avg buy price?
  // That tells us where regime gates failed to engage in time.
  const loserAvgBuckets = { '<0.20': 0, '0.20-0.30': 0, '0.30-0.40': 0, '0.40-0.50': 0, '0.50+': 0 };
  let countNonZero = 0;
  for (const m of losing) {
    if (m.loserAvgCost <= 0) continue;
    countNonZero++;
    const c = m.loserAvgCost;
    if (c < 0.20) loserAvgBuckets['<0.20']++;
    else if (c < 0.30) loserAvgBuckets['0.20-0.30']++;
    else if (c < 0.40) loserAvgBuckets['0.30-0.40']++;
    else if (c < 0.50) loserAvgBuckets['0.40-0.50']++;
    else loserAvgBuckets['0.50+']++;
  }
  console.log(`  Loser-side avg-cost distribution (${countNonZero} losing markets with loser inventory):`);
  for (const [bucket, count] of Object.entries(loserAvgBuckets)) {
    const p = countNonZero > 0 ? (count / countNonZero) * 100 : 0;
    console.log(`    ${bucket.padEnd(10)} ${String(count).padStart(3)} markets (${p.toFixed(0)}%)`);
  }
  console.log();

  // ===========================================================================
  // 5. Winning markets - how big was the winner-side lean?
  // ===========================================================================
  console.log('=== WINNING MARKETS — TILT QUALITY ===');
  const winning = markets.filter(m => m.pnl > 0);
  const winnerInWin = winning.reduce((s, m) => s + m.winnerCostBasis, 0);
  const loserInWin = winning.reduce((s, m) => s + m.loserCostBasis, 0);
  const tiltInWin = winnerInWin / Math.max(1, winnerInWin + loserInWin) * 100;
  console.log(`  ${winning.length} winning markets, ${pct((winning.reduce((s, m) => s + m.pnl, 0) / winning.reduce((s, m) => s + m.invested, 0)) * 100)}`);
  console.log(`  $${winnerInWin.toFixed(0)} on winner-side, $${loserInWin.toFixed(0)} on loser-side → ${tiltInWin.toFixed(1)}% tilt to winner`);

  const losingPlusInfo = losing;
  const winnerInLose = losingPlusInfo.reduce((s, m) => s + m.winnerCostBasis, 0);
  const loserInLose = losingPlusInfo.reduce((s, m) => s + m.loserCostBasis, 0);
  const tiltInLose = winnerInLose / Math.max(1, winnerInLose + loserInLose) * 100;
  console.log(`  ${losing.length} losing  markets`);
  console.log(`  $${winnerInLose.toFixed(0)} on winner-side, $${loserInLose.toFixed(0)} on loser-side → ${tiltInLose.toFixed(1)}% tilt to winner`);
  console.log(`  Δ: winning markets had ${(tiltInWin - tiltInLose).toFixed(1)}pp more lean to winner than losing markets`);
  console.log();

  // ===========================================================================
  // 6. Top 10 worst markets
  // ===========================================================================
  console.log('=== TOP 10 WORST MARKETS ===');
  for (const m of losing.slice(0, 10)) {
    console.log(`  ${m.type.padEnd(3)} ${m.asset} ${m.title.slice(0, 60).padEnd(60)} pnl ${dol(m.pnl).padStart(7)} (${pct(m.pnlPct).padStart(7)}) on $${m.invested.toFixed(0)} | loser avg $${m.loserAvgCost.toFixed(3)}`);
  }
  console.log();

  // ===========================================================================
  // 7. Top 10 best markets
  // ===========================================================================
  console.log('=== TOP 10 BEST MARKETS ===');
  for (const m of [...winning].sort((a, b) => b.pnl - a.pnl).slice(0, 10)) {
    console.log(`  ${m.type.padEnd(3)} ${m.asset} ${m.title.slice(0, 60).padEnd(60)} pnl ${dol(m.pnl).padStart(7)} (${pct(m.pnlPct).padStart(7)}) on $${m.invested.toFixed(0)} | winner avg $${m.winnerAvgCost.toFixed(3)}`);
  }
}

main();
