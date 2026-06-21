/**
 * Find Polymarket wallets running a similar dual-side inventory rebalancing
 * strategy on BTC/ETH up-or-down markets, and rank them by realized PnL.
 *
 * Usage:
 *   node scripts/findSimilarTraders.js
 *
 * Tunables via env vars:
 *   HOURS_BACK              How far back to look at resolved markets (default 36)
 *   MIN_DUAL_SIDE_MARKETS   Wallet must hold both UP and DOWN in at least N markets
 *   MIN_TOTAL_VOLUME        USDC volume floor to filter dust traders
 *   MARKET_TYPES            Comma-separated list of any of: hourly,15m,5m (default hourly,15m)
 */

const HOURS_BACK = parseInt(process.env.HOURS_BACK || '36', 10);
const MIN_DUAL_SIDE_MARKETS = parseInt(process.env.MIN_DUAL_SIDE_MARKETS || '5', 10);
const MIN_TOTAL_VOLUME = parseFloat(process.env.MIN_TOTAL_VOLUME || '500');
const MARKET_TYPES = (process.env.MARKET_TYPES || 'hourly,15m').split(',').map(s => s.trim());
const REQUEST_DELAY_MS = 80;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

function isBtcEthUpDown(title, slug) {
  const t = (title || '').toLowerCase();
  const s = (slug || '').toLowerCase();
  const isCrypto = /(bitcoin|ethereum|btc|eth)/.test(t) || /(btc|eth|bitcoin|ethereum)/.test(s);
  const isUpDown = /(up or down|updown|up-or-down)/.test(t) || /(up-or-down|updown)/.test(s);
  return isCrypto && isUpDown;
}

function classifyMarketType(slug, title) {
  const s = (slug || '').toLowerCase();
  if (/-5m-/.test(s) || /5\s*min/.test((title || '').toLowerCase())) return '5m';
  if (/-15m-/.test(s) || /15\s*min/.test((title || '').toLowerCase())) return '15m';
  return 'hourly';
}

function processGammaMarketsArray(markets, since, collected) {
  // markets array can come from either /markets (flat) or /events[].markets (nested)
  for (const m of markets) {
    if (!m || m.closed === false) continue;
    if (!isBtcEthUpDown(m.question || m.slug, m.slug)) continue;

    const closedTimeRaw = m.closedTime || m.endDate || m.umaEndDate || 0;
    const closedTime = new Date(closedTimeRaw).getTime();
    if (!Number.isFinite(closedTime) || closedTime < since) continue;
    if (closedTime > Date.now()) continue;

    let outcomePrices = [], clobTokenIds = [];
    try { outcomePrices = JSON.parse(m.outcomePrices || '[]'); } catch {}
    try { clobTokenIds = JSON.parse(m.clobTokenIds || '[]'); } catch {}
    if (clobTokenIds.length !== 2 || outcomePrices.length !== 2) continue;
    const upPrice = parseFloat(outcomePrices[0]);
    const downPrice = parseFloat(outcomePrices[1]);
    const winnerKnown = upPrice >= 0.99 || downPrice >= 0.99;
    if (!winnerKnown) continue;

    const marketType = classifyMarketType(m.slug, m.question);
    if (!MARKET_TYPES.includes(marketType)) continue;

    collected.set(m.conditionId, {
      conditionId: m.conditionId,
      slug: m.slug,
      title: m.question,
      marketType,
      upWon: upPrice > 0.5,
      upTokenId: clobTokenIds[0],
      downTokenId: clobTokenIds[1],
      closedTime,
    });
  }
}

async function fetchResolvedMarkets() {
  const since = Date.now() - HOURS_BACK * 3600_000;
  const collected = new Map();

  // Source 1: tag_slug=up-or-down events (catches hourly markets reliably)
  console.log(`  source 1: gamma events tag=up-or-down (paginated)`);
  for (let offset = 0; offset < 600; offset += 100) {
    const url = `https://gamma-api.polymarket.com/events?tag_slug=up-or-down&closed=true&limit=100&offset=${offset}&order=endDate&ascending=false`;
    let events;
    try { events = await fetchJson(url); } catch (e) { console.warn(`    failed offset=${offset}: ${e.message}`); break; }
    if (!events.length) break;
    let oldestSeen = Infinity;
    for (const ev of events) {
      const closedTime = new Date(ev.closedTime || ev.endDate || 0).getTime();
      oldestSeen = Math.min(oldestSeen, closedTime);
      processGammaMarketsArray(ev.markets || [], since, collected);
    }
    if (oldestSeen < since - 6 * 3600_000) break;
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`    after source 1: ${collected.size} markets`);

  // Source 2: gamma /markets paginated by slug_contains for each prefix
  // This is the only way to get the full set of timestamp-slugged 5m and 15m markets
  const slugPrefixes = [];
  if (MARKET_TYPES.includes('5m')) slugPrefixes.push('btc-updown-5m', 'eth-updown-5m');
  if (MARKET_TYPES.includes('15m')) slugPrefixes.push('btc-updown-15m', 'eth-updown-15m');
  if (MARKET_TYPES.includes('hourly')) slugPrefixes.push('bitcoin-up-or-down', 'ethereum-up-or-down');

  for (const prefix of slugPrefixes) {
    console.log(`  source 2: gamma /markets slug_contains=${prefix}`);
    let prefixCount = 0;
    for (let offset = 0; offset < 5000; offset += 500) {
      const url = `https://gamma-api.polymarket.com/markets?slug_contains=${prefix}&closed=true&limit=500&offset=${offset}&order=endDate&ascending=false`;
      let markets;
      try { markets = await fetchJson(url); } catch (e) { console.warn(`    failed offset=${offset}: ${e.message}`); break; }
      if (!markets.length) break;
      const before = collected.size;
      processGammaMarketsArray(markets, since, collected);
      prefixCount += collected.size - before;

      // Stop paginating when newest markets in batch are already older than window
      const oldestEnd = markets.reduce((m, x) => Math.min(m, new Date(x.endDate || x.closedTime || 0).getTime()), Infinity);
      if (oldestEnd < since - 6 * 3600_000) break;
      if (markets.length < 500) break;
      await sleep(REQUEST_DELAY_MS);
    }
    console.log(`    +${prefixCount} new markets (total ${collected.size})`);
  }

  return [...collected.values()];
}

async function fetchAllTrades(conditionId) {
  const all = [];
  let offset = 0;
  const PAGE = 500;
  while (true) {
    const url = `https://data-api.polymarket.com/trades?market=${conditionId}&limit=${PAGE}&offset=${offset}`;
    const trades = await fetchJson(url);
    if (!trades.length) break;
    all.push(...trades);
    if (trades.length < PAGE) break;
    offset += PAGE;
    if (all.length > 20000) break; // safety
    await sleep(REQUEST_DELAY_MS);
  }
  return all;
}

function computeMarketPnL(trades, market) {
  const wallets = new Map();
  for (const t of trades) {
    const wallet = (t.proxyWallet || '').toLowerCase();
    if (!wallet) continue;
    if (!wallets.has(wallet)) {
      wallets.set(wallet, {
        wallet, name: t.name || t.pseudonym || '',
        upBuyShares: 0, upBuyCost: 0,
        upSellShares: 0, upSellProceeds: 0,
        downBuyShares: 0, downBuyCost: 0,
        downSellShares: 0, downSellProceeds: 0,
        firstTrade: t.timestamp, lastTrade: t.timestamp,
        tradeCount: 0,
        buyPrices: [], // (price, side, ts) for fingerprint analysis
      });
    }
    const w = wallets.get(wallet);
    w.tradeCount++;
    w.firstTrade = Math.min(w.firstTrade, t.timestamp);
    w.lastTrade = Math.max(w.lastTrade, t.timestamp);

    const size = parseFloat(t.size || 0);
    const price = parseFloat(t.price || 0);
    const value = size * price;
    const isUp = t.asset === market.upTokenId;

    if (t.side === 'BUY') {
      if (isUp) { w.upBuyShares += size; w.upBuyCost += value; }
      else { w.downBuyShares += size; w.downBuyCost += value; }
      w.buyPrices.push({ price, isUp, ts: t.timestamp });
    } else {
      if (isUp) { w.upSellShares += size; w.upSellProceeds += value; }
      else { w.downSellShares += size; w.downSellProceeds += value; }
    }
  }

  const out = [];
  for (const w of wallets.values()) {
    const upHeldShares = w.upBuyShares - w.upSellShares;
    const downHeldShares = w.downBuyShares - w.downSellShares;

    // Approximate cost basis on shares actually held to settlement using average buy price
    const upAvgBuy = w.upBuyShares > 0 ? w.upBuyCost / w.upBuyShares : 0;
    const downAvgBuy = w.downBuyShares > 0 ? w.downBuyCost / w.downBuyShares : 0;
    const upHeldCost = Math.max(0, upHeldShares) * upAvgBuy;
    const downHeldCost = Math.max(0, downHeldShares) * downAvgBuy;

    // Realized cost basis on shares sold before settlement (FIFO simplified to avg)
    const upSoldCost = w.upSellShares * upAvgBuy;
    const downSoldCost = w.downSellShares * downAvgBuy;

    // Settlement payout for held shares
    const upSettlement = Math.max(0, upHeldShares) * (market.upWon ? 1 : 0);
    const downSettlement = Math.max(0, downHeldShares) * (market.upWon ? 0 : 1);

    // Realized PnL on pre-settlement sells
    const realizedSells = (w.upSellProceeds - upSoldCost) + (w.downSellProceeds - downSoldCost);
    // Settlement PnL on held shares
    const settlementPnl = (upSettlement - upHeldCost) + (downSettlement - downHeldCost);

    const totalPnl = realizedSells + settlementPnl;
    const totalInvested = w.upBuyCost + w.downBuyCost;
    const heldBoth = w.upBuyShares > 0 && w.downBuyShares > 0;

    out.push({
      ...w,
      heldBoth,
      upHeldShares,
      downHeldShares,
      upAvgBuy, downAvgBuy,
      totalInvested,
      pnl: totalPnl,
      pnlPercent: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
      market: market.slug,
      marketType: market.marketType,
      upWon: market.upWon,
    });
  }
  return out;
}

async function main() {
  console.log(`Scanning Polymarket for dual-side traders on BTC/ETH ${MARKET_TYPES.join('/')} markets`);
  console.log(`Window: last ${HOURS_BACK}h | min markets: ${MIN_DUAL_SIDE_MARKETS} | min volume: $${MIN_TOTAL_VOLUME}`);

  const markets = await fetchResolvedMarkets();
  console.log(`Found ${markets.length} resolved markets matching filters`);
  if (!markets.length) { console.log('No markets to analyse, exiting.'); return; }

  const breakdown = markets.reduce((m, x) => { m[x.marketType] = (m[x.marketType] || 0) + 1; return m; }, {});
  console.log(`  Breakdown: ${Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // Aggregate per wallet
  const stats = new Map();
  let processed = 0, totalTrades = 0;

  for (const market of markets) {
    let trades = [];
    try { trades = await fetchAllTrades(market.conditionId); }
    catch (e) { console.warn(`  trades fetch failed for ${market.slug}: ${e.message}`); continue; }
    totalTrades += trades.length;

    const wallets = computeMarketPnL(trades, market);
    for (const w of wallets) {
      if (!w.heldBoth) continue;
      const key = w.wallet;
      if (!stats.has(key)) {
        stats.set(key, {
          wallet: w.wallet, name: w.name,
          markets: 0, wins: 0, losses: 0,
          totalPnl: 0, totalInvested: 0, totalTrades: 0,
          totalUpInvested: 0, totalDownInvested: 0,
          marketTypeBreakdown: { '5m': 0, '15m': 0, hourly: 0 },
          buyPrices: [], // for fingerprint
          marketsList: [],
        });
      }
      const s = stats.get(key);
      s.markets++;
      s.totalPnl += w.pnl;
      s.totalInvested += w.totalInvested;
      s.totalTrades += w.tradeCount;
      s.totalUpInvested += w.upBuyCost;
      s.totalDownInvested += w.downBuyCost;
      s.marketTypeBreakdown[w.marketType] = (s.marketTypeBreakdown[w.marketType] || 0) + 1;
      if (w.pnl > 0) s.wins++; else s.losses++;
      s.buyPrices.push(...w.buyPrices.map(b => b.price));
      s.marketsList.push({ slug: w.market, pnl: w.pnl, pnlPct: w.pnlPercent, invested: w.totalInvested });
    }

    processed++;
    if (processed % 10 === 0) {
      console.log(`  processed ${processed}/${markets.length} markets, ${totalTrades} trades, ${stats.size} wallets seen`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nDone. Total trades scanned: ${totalTrades.toLocaleString()}, unique dual-side wallets: ${stats.size}\n`);

  const ranked = [...stats.values()]
    .filter(s => s.markets >= MIN_DUAL_SIDE_MARKETS)
    .filter(s => s.totalInvested >= MIN_TOTAL_VOLUME)
    .map(s => {
      const winRate = s.markets > 0 ? (s.wins / s.markets) * 100 : 0;
      const avgTradesPerMarket = s.markets > 0 ? s.totalTrades / s.markets : 0;
      const upDownBalance = s.totalUpInvested + s.totalDownInvested > 0
        ? Math.min(s.totalUpInvested, s.totalDownInvested) / Math.max(s.totalUpInvested, s.totalDownInvested)
        : 0;
      const pnlPercent = s.totalInvested > 0 ? (s.totalPnl / s.totalInvested) * 100 : 0;
      return { ...s, winRate, avgTradesPerMarket, upDownBalance, pnlPercent };
    })
    .sort((a, b) => b.totalPnl - a.totalPnl);

  console.log('=== TOP DUAL-SIDE WALLETS BY ABSOLUTE PnL ===\n');
  printTable(ranked.slice(0, 25));

  console.log('\n=== TOP DUAL-SIDE WALLETS BY PnL% (min 10 markets) ===\n');
  const byPercent = ranked.filter(s => s.markets >= 10).sort((a, b) => b.pnlPercent - a.pnlPercent);
  printTable(byPercent.slice(0, 15));

  // Persist full results for later reference
  const fs = require('fs');
  const out = {
    generatedAt: new Date().toISOString(),
    config: { HOURS_BACK, MIN_DUAL_SIDE_MARKETS, MIN_TOTAL_VOLUME, MARKET_TYPES },
    marketsScanned: markets.length,
    tradesScanned: totalTrades,
    walletsRanked: ranked.length,
    top: ranked.slice(0, 50),
  };
  fs.writeFileSync('similar-traders-report.json', JSON.stringify(out, null, 2));
  console.log('\nFull rankings saved to similar-traders-report.json');
}

function printTable(rows) {
  const head = ['Wallet', 'Mkts', 'Win%', 'PnL ($)', 'PnL %', 'Invested', 'Trd/Mkt', 'Bal', 'Type mix', 'Name'];
  console.log(head.map(h => h.padEnd(11)).join(' '));
  for (const s of rows) {
    const cells = [
      s.wallet.slice(0, 10) + '…' + s.wallet.slice(-4),
      String(s.markets),
      `${s.winRate.toFixed(0)}%`,
      `${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(0)}`,
      `${s.pnlPercent >= 0 ? '+' : ''}${s.pnlPercent.toFixed(1)}`,
      `${(s.totalInvested / 1000).toFixed(1)}k`,
      `${s.avgTradesPerMarket.toFixed(0)}`,
      `${(s.upDownBalance * 100).toFixed(0)}%`,
      Object.entries(s.marketTypeBreakdown).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(','),
      (s.name || '').slice(0, 20),
    ];
    console.log(cells.map(c => String(c).padEnd(11)).join(' '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
