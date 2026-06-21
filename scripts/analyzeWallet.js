/**
 * Deep-dive analysis of a single Polymarket wallet's trading behavior.
 *
 * Pulls every trade for the target wallet over a time window, groups by market,
 * and extracts observable strategy parameters:
 *   - Inventory target ratio (UP vs DOWN value)
 *   - Tilt / trend / stop thresholds (price at which they stop buying loser)
 *   - Trade size distribution
 *   - Entry timing (early vs late in market window)
 *   - Quartile-weighted sizing
 *
 * Usage:
 *   WALLET=0xe1d6b515... HOURS_BACK=48 node scripts/analyzeWallet.js
 */

const WALLET = (process.env.WALLET || '0xe1d6b51521bd436576d97ff2bf94e3df5c08907c').toLowerCase();
const HOURS_BACK = parseInt(process.env.HOURS_BACK || '48', 10);
const REQUEST_DELAY_MS = 80;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} for ${url} :: ${body.substring(0, 200)}`);
      }
      return await r.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

async function fetchUserTrades(wallet, sinceTs) {
  const all = [];
  let offset = 0;
  const PAGE = 500;
  while (true) {
    const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=${PAGE}&offset=${offset}`;
    const trades = await fetchJson(url);
    if (!trades.length) break;
    let oldest = Infinity;
    for (const t of trades) {
      oldest = Math.min(oldest, t.timestamp);
      if (t.timestamp >= sinceTs) all.push(t);
    }
    if (trades.length < PAGE) break;
    if (oldest < sinceTs) break;
    offset += PAGE;
    // Polymarket data-api hard caps offset at 3000
    if (offset >= 3000) { console.log(`  hit Polymarket 3000-trade cap; truncating`); break; }
    await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

async function fetchMarketDetails(conditionId) {
  try {
    const arr = await fetchJson(`https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`);
    return arr && arr[0] ? arr[0] : null;
  } catch {
    return null;
  }
}

async function fetchMarketBySlug(slug) {
  try {
    const arr = await fetchJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`);
    if (arr && arr[0]) return arr[0];
  } catch {}
  try {
    const arr = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
    if (arr && arr[0] && arr[0].markets && arr[0].markets[0]) return arr[0].markets[0];
  } catch {}
  return null;
}

function classifyMarketType(slug) {
  const s = (slug || '').toLowerCase();
  if (/-5m-/.test(s)) return '5m';
  if (/-15m-/.test(s)) return '15m';
  if (/-15min-/.test(s)) return '15m';
  if (/-1h-|-4h-/.test(s)) return 'hourly';
  if (/up-or-down-/.test(s)) return 'hourly';
  return 'hourly';
}

function isBtcEthMarket(slugOrTitle) {
  const s = (slugOrTitle || '').toLowerCase();
  return /(bitcoin|ethereum|^btc|^eth|-btc-|-eth-)/.test(s);
}

// Derive (startMs, endMs) for short-interval markets where slug encodes the start timestamp.
function deriveWindowFromSlug(slug) {
  // Patterns: btc-updown-5m-1777420800 / eth-updown-15m-1777420800
  let m = slug.match(/-(5m|15m)-(\d{10})$/);
  if (m) {
    const minutes = m[1] === '5m' ? 5 : 15;
    const startSec = parseInt(m[2], 10);
    return { startMs: startSec * 1000, endMs: (startSec + minutes * 60) * 1000 };
  }
  // Patterns: bitcoin-up-or-down-april-28-2026-9pm-et
  m = slug.match(/(?:bitcoin|ethereum)-up-or-down-([a-z]+)-(\d+)-(\d{4})-(\d+)(am|pm)-et/);
  if (m) {
    const monthName = m[1];
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    let hour = parseInt(m[4], 10);
    const ampm = m[5];
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const monthIdx = months.indexOf(monthName);
    if (monthIdx < 0) return null;
    // Build ET (UTC-5 standard, UTC-4 DST). Treat as UTC-4 for April-October roughly.
    const isDst = monthIdx >= 2 && monthIdx <= 10; // March–November DST window
    const utcHour = hour + (isDst ? 4 : 5);
    const startMs = Date.UTC(year, monthIdx, day, utcHour, 0, 0);
    return { startMs, endMs: startMs + 3600_000 };
  }
  return null;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  console.log(`Analyzing wallet ${WALLET} over last ${HOURS_BACK}h\n`);
  const sinceTs = Math.floor((Date.now() - HOURS_BACK * 3600_000) / 1000);

  console.log('Pulling trade history...');
  const trades = await fetchUserTrades(WALLET, sinceTs);
  console.log(`  ${trades.length} trades fetched\n`);
  if (!trades.length) { console.log('No trades, exiting.'); return; }

  // Group by market, filter to BTC/ETH only (user's universe)
  const byMarket = new Map();
  let droppedNonBtcEth = 0;
  for (const t of trades) {
    if (!isBtcEthMarket(t.slug || t.title || '')) { droppedNonBtcEth++; continue; }
    const cid = t.conditionId;
    if (!byMarket.has(cid)) byMarket.set(cid, []);
    byMarket.get(cid).push(t);
  }
  console.log(`  ${byMarket.size} unique BTC/ETH markets (${droppedNonBtcEth} non-BTC/ETH trades skipped)\n`);

  // Build market metadata: try to derive window from slug first (fast & reliable),
  // fall back to gamma API if needed.
  console.log('Building market metadata (slug-derived where possible)...');
  const marketMeta = new Map();
  let metaFromSlug = 0, metaFromApi = 0, metaMissing = 0, i = 0;
  for (const [cid, mtrades] of byMarket.entries()) {
    const slug = mtrades[0].slug;
    const window = deriveWindowFromSlug(slug);
    if (window) {
      marketMeta.set(cid, {
        slug,
        startMs: window.startMs,
        endMs: window.endMs,
        upTokenId: mtrades[0].outcomeIndex === 0 ? mtrades[0].asset : null,
        // We need both token IDs and the winner; fetch from API
      });
    }
    i++;
    if (i % 50 === 0) console.log(`  ${i}/${byMarket.size}`);
  }

  // For each market, also pull gamma details for clobTokenIds + outcome resolution
  console.log('  fetching outcome data per market...');
  i = 0;
  for (const [cid, mtrades] of byMarket.entries()) {
    const slug = mtrades[0].slug;
    const apiMarket = await fetchMarketBySlug(slug);
    if (apiMarket) {
      let outcomePrices = [], clobTokenIds = [];
      try { outcomePrices = JSON.parse(apiMarket.outcomePrices || '[]'); } catch {}
      try { clobTokenIds = JSON.parse(apiMarket.clobTokenIds || '[]'); } catch {}

      const existing = marketMeta.get(cid) || {};
      marketMeta.set(cid, {
        ...existing,
        slug,
        startMs: existing.startMs || new Date(apiMarket.startDate || 0).getTime(),
        endMs: existing.endMs || new Date(apiMarket.endDate || 0).getTime(),
        outcomePrices, clobTokenIds,
      });
      metaFromApi++;
    } else if (marketMeta.has(cid)) {
      metaFromSlug++;
    } else {
      metaMissing++;
    }
    i++;
    if (i % 25 === 0) console.log(`    ${i}/${byMarket.size}`);
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  metadata: ${metaFromApi} from API, ${metaFromSlug} slug-only, ${metaMissing} missing\n`);

  // Analyze each market
  const allBuyPrices = [];           // every BUY price across all markets
  const winnerSideBuyPrices = [];    // BUYs on whichever side ultimately won
  const loserSideBuyPrices = [];     // BUYs on whichever side lost
  const allTradeSizes = [];          // dollar size per trade
  const tradesByQuartile = [0, 0, 0, 0];
  const sizeByQuartile = [0, 0, 0, 0];
  const lastLoserBuyPrices = [];     // For each market, the highest winner-side price at which they still bought the loser
  const inventoryRatios = [];        // For each market, % of investment on UP side
  const entryLatencyByType = { '5m': [], '15m': [], 'hourly': [] };
  const totalsByType = { '5m': { mkts: 0, pnl: 0, inv: 0 }, '15m': { mkts: 0, pnl: 0, inv: 0 }, 'hourly': { mkts: 0, pnl: 0, inv: 0 } };
  const perMarket = [];

  for (const [cid, mtrades] of byMarket.entries()) {
    const meta = marketMeta.get(cid);
    if (!meta) continue;
    const outcomePrices = meta.outcomePrices || [];
    const clobTokenIds = meta.clobTokenIds || [];
    if (clobTokenIds.length !== 2 || outcomePrices.length !== 2) continue;
    const upRes = parseFloat(outcomePrices[0]);
    const dnRes = parseFloat(outcomePrices[1]);
    if (!(upRes >= 0.99 || dnRes >= 0.99)) continue; // unresolved
    const upWon = upRes > 0.5;
    const upTokenId = clobTokenIds[0];

    const startTs = meta.startMs || 0;
    const endTs = meta.endMs || 0;
    const duration = Math.max(1, endTs - startTs);
    const marketType = classifyMarketType(meta.slug || '');

    const sorted = [...mtrades].sort((a, b) => a.timestamp - b.timestamp);

    let upBuyShares = 0, upBuyCost = 0, upSellShares = 0, upSellProceeds = 0;
    let downBuyShares = 0, downBuyCost = 0, downSellShares = 0, downSellProceeds = 0;
    let firstTradeTs = sorted[0].timestamp * 1000;

    for (const t of sorted) {
      const isUp = t.asset === upTokenId;
      const size = parseFloat(t.size);
      const price = parseFloat(t.price);
      const value = size * price;
      const tsMs = t.timestamp * 1000;

      if (t.side === 'BUY') {
        if (isUp) { upBuyShares += size; upBuyCost += value; }
        else { downBuyShares += size; downBuyCost += value; }
        allBuyPrices.push(price);
        if ((isUp && upWon) || (!isUp && !upWon)) winnerSideBuyPrices.push(price);
        else loserSideBuyPrices.push(price);
        allTradeSizes.push(value);

        // Track quartile of trade
        const progress = duration > 0 ? Math.max(0, Math.min(0.999, (tsMs - startTs) / duration)) : 0;
        const q = Math.min(3, Math.floor(progress * 4));
        tradesByQuartile[q]++;
        sizeByQuartile[q] += value;
      } else {
        if (isUp) { upSellShares += size; upSellProceeds += value; }
        else { downSellShares += size; downSellProceeds += value; }
      }
    }

    // Per-market summary
    const upHeld = Math.max(0, upBuyShares - upSellShares);
    const downHeld = Math.max(0, downBuyShares - downSellShares);
    const upAvg = upBuyShares > 0 ? upBuyCost / upBuyShares : 0;
    const downAvg = downBuyShares > 0 ? downBuyCost / downBuyShares : 0;
    const upHeldCost = upHeld * upAvg;
    const downHeldCost = downHeld * downAvg;
    const upSettlement = upHeld * (upWon ? 1 : 0);
    const downSettlement = downHeld * (upWon ? 0 : 1);
    const realizedSells = (upSellProceeds - upSellShares * upAvg) + (downSellProceeds - downSellShares * downAvg);
    const settlementPnl = (upSettlement - upHeldCost) + (downSettlement - downHeldCost);
    const pnl = realizedSells + settlementPnl;
    const invested = upBuyCost + downBuyCost;

    if (totalsByType[marketType]) {
      totalsByType[marketType].mkts++;
      totalsByType[marketType].pnl += pnl;
      totalsByType[marketType].inv += invested;
    }

    // Inventory ratio: % invested on UP side
    if (invested > 0) inventoryRatios.push(upBuyCost / invested);

    // Find the highest winner-side price at which they were still buying the loser
    let highestLoserBuyContext = 0;
    for (const t of sorted) {
      if (t.side !== 'BUY') continue;
      const isUp = t.asset === upTokenId;
      const isLoser = (isUp && !upWon) || (!isUp && upWon);
      if (!isLoser) continue;
      // Find the contemporaneous winner-side price by scanning trades within 60s
      const tsMs = t.timestamp * 1000;
      const windowTrades = sorted.filter(x => Math.abs(x.timestamp * 1000 - tsMs) < 60_000);
      const winnerPrice = windowTrades
        .filter(x => (x.asset === upTokenId) === upWon) // winner side trades
        .map(x => parseFloat(x.price));
      if (winnerPrice.length) {
        const maxWinPrice = Math.max(...winnerPrice);
        if (maxWinPrice > highestLoserBuyContext) highestLoserBuyContext = maxWinPrice;
      }
    }
    if (highestLoserBuyContext > 0) lastLoserBuyPrices.push(highestLoserBuyContext);

    // Entry latency: how late in the window did they first trade
    if (duration > 0 && firstTradeTs > 0) {
      const latencyPct = Math.max(0, Math.min(1, (firstTradeTs - startTs) / duration));
      if (entryLatencyByType[marketType]) entryLatencyByType[marketType].push(latencyPct);
    }

    perMarket.push({
      slug: meta.slug,
      type: marketType,
      pnl,
      invested,
      upBuyCost,
      downBuyCost,
      upWon,
      tradeCount: sorted.length,
    });
  }

  perMarket.sort((a, b) => b.pnl - a.pnl);

  console.log('\n========================================');
  console.log(`STRATEGY FINGERPRINT: ${WALLET}`);
  console.log('========================================\n');

  // Aggregate PnL by market type
  console.log('PnL by market type:');
  for (const [type, t] of Object.entries(totalsByType)) {
    if (!t.mkts) continue;
    const pct = t.inv > 0 ? (t.pnl / t.inv) * 100 : 0;
    console.log(`  ${type.padEnd(7)} ${String(t.mkts).padStart(4)} markets | $${t.inv.toFixed(0).padStart(8)} invested | ${(t.pnl >= 0 ? '+' : '')}$${t.pnl.toFixed(0).padStart(7)} | ${pct.toFixed(2)}%`);
  }

  // Inventory target ratio
  const ratioMedian = median(inventoryRatios);
  console.log(`\nInventory target ratio (UP / total):`);
  console.log(`  median ${(ratioMedian * 100).toFixed(1)}%, p25 ${(percentile(inventoryRatios, 0.25) * 100).toFixed(1)}%, p75 ${(percentile(inventoryRatios, 0.75) * 100).toFixed(1)}%`);
  console.log(`  → suggests target_yes_ratio ≈ ${ratioMedian.toFixed(2)}`);

  // Stop threshold for the loser side
  const stopThresholdMedian = median(lastLoserBuyPrices);
  console.log(`\nLast price they bought the LOSING side (= effective STOP threshold):`);
  console.log(`  median ${stopThresholdMedian.toFixed(3)}, p75 ${percentile(lastLoserBuyPrices, 0.75).toFixed(3)}, p90 ${percentile(lastLoserBuyPrices, 0.90).toFixed(3)}`);
  console.log(`  → suggests price_stop_threshold ≈ ${percentile(lastLoserBuyPrices, 0.90).toFixed(2)}`);

  // Trade size
  const sizeMedian = median(allTradeSizes);
  console.log(`\nDollar size per trade:`);
  console.log(`  median $${sizeMedian.toFixed(2)}, p75 $${percentile(allTradeSizes, 0.75).toFixed(2)}, p95 $${percentile(allTradeSizes, 0.95).toFixed(2)}`);

  // Quartile distribution
  const totalTrades = tradesByQuartile.reduce((a, b) => a + b, 0);
  const totalSize = sizeByQuartile.reduce((a, b) => a + b, 0);
  console.log(`\nQuartile-weighted activity:`);
  for (let q = 0; q < 4; q++) {
    const tradePct = totalTrades > 0 ? (tradesByQuartile[q] / totalTrades) * 100 : 0;
    const sizePct = totalSize > 0 ? (sizeByQuartile[q] / totalSize) * 100 : 0;
    const avgSize = tradesByQuartile[q] > 0 ? sizeByQuartile[q] / tradesByQuartile[q] : 0;
    console.log(`  Q${q + 1}  ${tradePct.toFixed(1).padStart(5)}% of trades, ${sizePct.toFixed(1).padStart(5)}% of $$, avg $${avgSize.toFixed(0)} / trade`);
  }

  // Winner vs loser side buy price distributions
  const winnerBuyMed = median(winnerSideBuyPrices);
  const loserBuyMed = median(loserSideBuyPrices);
  console.log(`\nBuy price distribution (winner side vs loser side):`);
  console.log(`  Winner side buys: median ${winnerBuyMed.toFixed(3)}, p25 ${percentile(winnerSideBuyPrices, 0.25).toFixed(3)}, p75 ${percentile(winnerSideBuyPrices, 0.75).toFixed(3)}`);
  console.log(`  Loser side buys:  median ${loserBuyMed.toFixed(3)}, p25 ${percentile(loserSideBuyPrices, 0.25).toFixed(3)}, p75 ${percentile(loserSideBuyPrices, 0.75).toFixed(3)}`);

  // Entry timing
  console.log(`\nEntry timing (% of window elapsed at first trade):`);
  for (const [type, arr] of Object.entries(entryLatencyByType)) {
    if (!arr.length) continue;
    console.log(`  ${type.padEnd(7)} median ${(median(arr) * 100).toFixed(1)}%, p25 ${(percentile(arr, 0.25) * 100).toFixed(1)}%, p75 ${(percentile(arr, 0.75) * 100).toFixed(1)}%`);
  }

  // Top winners and losers
  console.log(`\nTop 5 best markets:`);
  for (const m of perMarket.slice(0, 5)) {
    console.log(`  ${m.slug.padEnd(60)} (${m.type.padEnd(6)}) pnl ${m.pnl >= 0 ? '+' : ''}$${m.pnl.toFixed(0)} on $${m.invested.toFixed(0)} (${m.tradeCount} trades)`);
  }
  console.log(`\nTop 5 worst markets:`);
  for (const m of perMarket.slice(-5).reverse()) {
    console.log(`  ${m.slug.padEnd(60)} (${m.type.padEnd(6)}) pnl ${m.pnl >= 0 ? '+' : ''}$${m.pnl.toFixed(0)} on $${m.invested.toFixed(0)} (${m.tradeCount} trades)`);
  }

  const fs = require('fs');
  fs.writeFileSync('wallet-analysis.json', JSON.stringify({
    wallet: WALLET, hoursBack: HOURS_BACK, generatedAt: new Date().toISOString(),
    totalsByType,
    inventoryRatio: { median: ratioMedian, p25: percentile(inventoryRatios, 0.25), p75: percentile(inventoryRatios, 0.75) },
    stopThreshold: { median: stopThresholdMedian, p75: percentile(lastLoserBuyPrices, 0.75), p90: percentile(lastLoserBuyPrices, 0.90) },
    tradeSize: { median: sizeMedian, p75: percentile(allTradeSizes, 0.75), p95: percentile(allTradeSizes, 0.95) },
    quartileTrades: tradesByQuartile, quartileSize: sizeByQuartile,
    winnerBuyDist: { median: winnerBuyMed, p25: percentile(winnerSideBuyPrices, 0.25), p75: percentile(winnerSideBuyPrices, 0.75) },
    loserBuyDist: { median: loserBuyMed, p25: percentile(loserSideBuyPrices, 0.25), p75: percentile(loserSideBuyPrices, 0.75) },
    entryLatencyByType: Object.fromEntries(Object.entries(entryLatencyByType).map(([k, v]) => [k, { median: median(v), p25: percentile(v, 0.25), p75: percentile(v, 0.75), n: v.length }])),
    perMarket,
  }, null, 2));
  console.log('\nFull analysis saved to wallet-analysis.json');
}

main().catch(e => { console.error(e); process.exit(1); });
