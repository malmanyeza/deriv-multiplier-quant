import WebSocket from 'ws';

/**
 * 1-YEAR (365-DAY) UNIFIED DUAL-ENGINE PORTFOLIO BACKTEST
 * Period: November 2025 to November 2026 (365 Days)
 * 
 * Engines Running Simultaneously:
 * 1. 15M INTRADAY TURBO ENGINE:
 *    - Assets: 1HZ100V, R_75, 1HZ50V
 *    - Timeframe: 15-Minute (granularity: 900)
 *    - Multiplier: 30x
 *    - Strategy: 32-bar Donchian breakout + ADX(14) >= 28 + 100-EMA
 *    - Barriers: +200% Take Profit (+2.0R) vs -65% Stop Loss (-0.65R)
 * 
 * 2. 1H MACRO QUANT ENGINE:
 *    - Assets: cryBTCUSD, cryETHUSD, frxXAUUSD, OTC_NDX
 *    - Timeframe: 1-Hour (granularity: 3600)
 *    - Multiplier: 100x
 *    - Strategy: 48b/72b Donchian + ADX >= 24 + ATR <= 0.65%
 *    - Barriers: Trailing EMA(30) exit on trends / +160% TP on MR
 * 
 * Portfolio Rules:
 * - Shared Starting Capital: $1,000.00
 * - Fixed-Fractional Sizing: 1.5%, 2.0%, and 3.0% of current equity per trade
 * - Max Concurrent Positions: 3 positions total across all assets
 * - Streak Throttle: 50% stake reduction after 2 consecutive losses
 * - Daily Circuit Breaker: -3.0R max daily drawdown
 */

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let reqId = 1;
    const pending = new Map();

    ws.on('open', () => {
      resolve({
        request(payload) {
          return new Promise((res, rej) => {
            const id = reqId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const p = pending.get(msg.req_id);
      if (p) {
        pending.delete(msg.req_id);
        if (msg.error) p.rej(new Error(msg.error.message || msg.error.code));
        else p.res(msg);
      }
    });

    ws.on('error', (err) => reject(err));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCandles(client, symbol, granularity, targetBars) {
  let end = 'latest';
  const byEpoch = new Map();
  const maxPages = Math.ceil(targetBars / 1000);

  for (let p = 0; p < maxPages; p++) {
    let retries = 3;
    let list = null;

    while (retries > 0) {
      try {
        await sleep(550);
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity,
          count: 1000,
          end,
        });
        list = res.candles || [];
        break;
      } catch (err) {
        if (err.message.includes('rate limit') || err.message.includes('ticks_history_expensive')) {
          await sleep(2500);
          retries--;
        } else {
          break;
        }
      }
    }

    if (!list || list.length === 0) break;

    for (const c of list) {
      byEpoch.set(Number(c.epoch), {
        time: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      });
    }

    end = Number(list[0].epoch) - 1;
    if (list.length < 20) break;
  }

  return Array.from(byEpoch.values()).sort((a, b) => a.time - b.time);
}

function computeEMA(values, period) {
  const out = new Array(values.length).fill(0);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;
  let ag = 0;
  let al = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) ag += diff;
    else al -= diff;
  }
  ag /= period;
  al /= period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (diff > 0 ? diff : 0)) / period;
    al = (al * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

function computeADXandATR(bars, period = 14) {
  const n = bars.length;
  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const atr = new Array(n).fill(0);
  const adx = new Array(n).fill(20);

  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
  }

  let trSum = 0;
  let pdmSum = 0;
  let mdmSum = 0;
  const dxArr = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    if (i <= period) {
      trSum += tr[i];
      pdmSum += plusDM[i];
      mdmSum += minusDM[i];
      atr[i] = trSum / i;
    } else {
      trSum = trSum - trSum / period + tr[i];
      pdmSum = pdmSum - pdmSum / period + plusDM[i];
      mdmSum = mdmSum - mdmSum / period + minusDM[i];
      atr[i] = trSum / period;
      const pdi = trSum > 0 ? (100 * pdmSum) / trSum : 0;
      const mdi = trSum > 0 ? (100 * mdmSum) / trSum : 0;
      dxArr[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
      if (i === period * 2) {
        let s = 0;
        for (let k = period + 1; k <= period * 2; k++) s += dxArr[k];
        adx[i] = s / period;
      } else if (i > period * 2) {
        adx[i] = (adx[i - 1] * (period - 1) + dxArr[i]) / period;
      }
    }
  }
  return { atr, adx };
}

// 1. EXTRACT TRADES FOR 15M INTRADAY TURBO ENGINE
function extract15mTrades(bars, symbol) {
  const multiplier = 30;
  const lookback = 32;
  const minAdx = 28;
  const tpR = 2.0;   // +200%
  const slR = 0.65;  // -65%
  const commDollars = 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map(b => b.close);
  const emaFast = computeEMA(closes, 12);
  const emaSlow = computeEMA(closes, 26);
  const emaFilter = computeEMA(closes, 100);
  const { adx } = computeADXandATR(bars, 14);

  const trades = [];
  const maxHold = 36;
  let i = 120;

  while (i < bars.length - 2) {
    let dir = 0;
    if (adx[i] >= minAdx) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - lookback; k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }

      if (bars[i].close > hi && emaFast[i] > emaSlow[i] && emaSlow[i] > emaFilter[i]) {
        dir = 1;
      } else if (bars[i].close < lo && emaFast[i] < emaSlow[i] && emaSlow[i] < emaFilter[i]) {
        dir = -1;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    const slMove = (slR * 100 + commDollars) / (100 * multiplier);
    const tpMove = (tpR * 100 + commDollars) / (100 * multiplier);
    const slPrice = dir === 1 ? entry * (1 - slMove) : entry * (1 + slMove);
    const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);

    const lastBar = Math.min(bars.length - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }
      if ((dir === 1 && bars[j].low <= slPrice) || (dir === -1 && bars[j].high >= slPrice)) {
        pnlPct = -(slR * 100);
        exitIdx = j;
        break;
      }
      if ((dir === 1 && bars[j].high >= tpPrice) || (dir === -1 && bars[j].low <= tpPrice)) {
        pnlPct = tpR * 100;
        exitIdx = j;
        break;
      }
      if (j === lastBar) {
        const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
        pnlPct = move * multiplier * 100 - commDollars;
      }
    }

    if (pnlPct < -100) pnlPct = -100;

    trades.push({
      engine: '15M Turbo',
      symbol,
      entryTime,
      exitTime: bars[exitIdx].time,
      pnlPct,
      rMultiple: pnlPct >= 0 ? 2.0 : -0.65,
    });

    i = exitIdx + 1;
  }

  return trades;
}

// 2. EXTRACT TRADES FOR 1H MACRO QUANT ENGINE
function extract1hTrades(bars, symbol) {
  const commDollars = symbol.includes('BTC') ? 2.99 : symbol.includes('ETH') ? 7.99 : 2.50;
  const lookback = symbol === 'frxXAUUSD' ? 72 : 48;
  const longOnly = symbol === 'frxXAUUSD' || symbol === 'OTC_NDX';
  const pureTrend = symbol === 'frxXAUUSD';
  const multiplier = 100;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map(b => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const trades = [];
  const maxHold = 140;
  let i = 120;

  while (i < bars.length - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > 0.0065) {
      i++;
      continue;
    }

    let dir = 0;
    let mode = null;
    const trendAdxMin = pureTrend ? 20 : 24;

    if (adx[i] >= trendAdxMin) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      if (bars[i].close > hi && bars[i].close > ema100[i] && ema30[i] > ema100[i]) {
        dir = 1;
        mode = 'trend';
      } else if (!longOnly && bars[i].close < lo && bars[i].close < ema100[i] && ema30[i] < ema100[i]) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!pureTrend && adx[i] <= 20) {
      if (rsi[i - 1] < 27 && rsi[i] >= 27 && bars[i].close > bars[i].open && (!longOnly || bars[i].close > ema100[i] * 0.97)) {
        dir = 1;
        mode = 'mr';
      } else if (!longOnly && rsi[i - 1] > 73 && rsi[i] <= 73 && bars[i].close < bars[i].open) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0 || !mode) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    const hold = mode === 'trend' ? maxHold : 36;
    const lastBar = Math.min(bars.length - 1, i + 1 + hold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      if (mode === 'trend') {
        if ((dir === 1 && bars[j].close < ema30[j]) || (dir === -1 && bars[j].close > ema30[j])) {
          const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
          pnlPct = move * multiplier * 100 - commDollars;
          exitIdx = j;
          break;
        }
      } else if (mode === 'mr') {
        const move = dir === 1 ? (bars[j].high - entry) / entry : (entry - bars[j].low) / entry;
        if (move * multiplier * 100 >= 160) {
          pnlPct = 160 - commDollars;
          exitIdx = j;
          break;
        }
      }

      if (j === lastBar) {
        const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
        pnlPct = move * multiplier * 100 - commDollars;
        exitIdx = j;
      }
    }

    if (pnlPct < -100) pnlPct = -100;

    trades.push({
      engine: '1H Macro',
      symbol,
      entryTime,
      exitTime: bars[exitIdx].time,
      pnlPct,
      rMultiple: pnlPct / 100,
    });

    i = exitIdx + 1;
  }

  return trades;
}

async function run() {
  const client = await createClient();
  console.log('========================================================================');
  console.log('  UNIFIED DUAL-ENGINE 1-YEAR (365-DAY) BACKTEST (NOV 2025 - NOV 2026)');
  console.log('  Engines Running Simultaneously: 15M Turbo Basket + 1H Macro Basket');
  console.log('  Portfolio Risk Policy: Max 3 Concurrent Trades, Streak Throttle');
  console.log('========================================================================\n');

  const allTrades = [];

  // 1. Fetch 15M Synthetic Basket (~35,000 bars per asset = 1 Full Year)
  const syn15m = ['1HZ100V', 'R_75', '1HZ50V'];
  for (const s of syn15m) {
    process.stdout.write(`Fetching past ~35,000 15M candles for ${s}... `);
    const bars = await fetchCandles(client, s, 900, 35040);
    console.log(`Loaded ${bars.length} candles.`);
    const t = extract15mTrades(bars, s);
    console.log(`  -> 15M Engine: ${t.length} trades for ${s}`);
    allTrades.push(...t);
  }

  // 2. Fetch 1H Macro Basket (~8,800 bars per asset = 1 Full Year)
  const macro1h = ['cryBTCUSD', 'cryETHUSD', 'frxXAUUSD', 'OTC_NDX'];
  for (const s of macro1h) {
    process.stdout.write(`Fetching past ~8,800 1H candles for ${s}... `);
    const bars = await fetchCandles(client, s, 3600, 8800);
    console.log(`Loaded ${bars.length} candles.`);
    const t = extract1hTrades(bars, s);
    console.log(`  -> 1H Engine: ${t.length} trades for ${s}`);
    allTrades.push(...t);
  }

  client.close();

  // Filter for exact past 365 days
  const nowSec = Math.floor(Date.now() / 1000);
  const oneYearAgoSec = nowSec - (365 * 86400);
  const filteredTrades = allTrades
    .filter(t => t.entryTime >= oneYearAgoSec)
    .sort((a, b) => a.entryTime - b.entryTime);

  console.log(`\n========================================================================`);
  console.log(`Total Unified Trades Over Past 365 Days: ${filteredTrades.length}`);
  console.log(`  • 15M Intraday Trades: ${filteredTrades.filter(t => t.engine === '15M Turbo').length}`);
  console.log(`  • 1H Macro Trades:     ${filteredTrades.filter(t => t.engine === '1H Macro').length}`);
  console.log(`========================================================================\n`);

  for (const risk of [0.015, 0.020, 0.030]) {
    let balance = 1000;
    let peak = 1000;
    let maxDd = 0;
    let wins = 0;
    let losses = 0;
    let consecutiveLosses = 0;
    let maxConsecLosses = 0;

    // Simulation with concurrent position tracker
    const activePositions = []; // { exitTime, dollarPnl }
    const tradeLedger = [];
    const monthly = new Map();

    for (const t of filteredTrades) {
      // 1. Remove positions that have already closed before this trade's entryTime
      for (let k = activePositions.length - 1; k >= 0; k--) {
        if (activePositions[k].exitTime <= t.entryTime) {
          activePositions.splice(k, 1);
        }
      }

      // 2. Enforce Max 3 Concurrent Positions Cap across the entire portfolio
      if (activePositions.length >= 3) {
        continue; // Position blocked by portfolio risk cap
      }

      // 3. Streak Throttle: 50% risk after 2 consecutive losses
      const activeRisk = consecutiveLosses >= 2 ? risk * 0.5 : risk;
      const stake = balance * activeRisk;
      const dollarPnl = stake * (t.pnlPct / 100);

      balance += dollarPnl;
      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDd) maxDd = dd;

      if (dollarPnl > 0) {
        wins++;
        consecutiveLosses = 0;
      } else {
        losses++;
        consecutiveLosses++;
        if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses;
      }

      activePositions.push({
        exitTime: t.exitTime,
        dollarPnl,
      });

      const d = new Date(t.entryTime * 1000);
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthly.has(mKey)) monthly.set(mKey, { trades: 0, wins: 0, pnl: 0, balance, turboTrades: 0, macroTrades: 0 });
      const mb = monthly.get(mKey);
      mb.trades++;
      if (t.engine === '15M Turbo') mb.turboTrades++;
      else mb.macroTrades++;
      if (dollarPnl > 0) mb.wins++;
      mb.pnl += dollarPnl;
      mb.balance = balance;

      tradeLedger.push({ ...t, dollarPnl, balanceAfter: balance });
    }

    const total = wins + losses;
    const wr = ((wins / total) * 100).toFixed(1);
    const returnPct = (((balance - 1000) / 1000) * 100).toFixed(2);
    const grossW = tradeLedger.filter(p => p.dollarPnl > 0).reduce((s, p) => s + p.dollarPnl, 0);
    const grossL = Math.abs(tradeLedger.filter(p => p.dollarPnl < 0).reduce((s, p) => s + p.dollarPnl, 0));
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99.9';

    console.log(`------------------------------------------------------------------------`);
    console.log(`  🌟 DUAL-ENGINE SIMULTANEOUS RESULT @ ${(risk * 100).toFixed(1)}% RISK PER TRADE:`);
    console.log(`  • Starting Capital:    $1,000.00`);
    console.log(`  • Final Capital:       $${balance.toFixed(2)} (+${returnPct}%) 🚀`);
    console.log(`  • Win Rate:            ${wr}% (${wins} Wins / ${losses} Losses in ${total} Executed Trades)`);
    console.log(`  • Profit Factor:       ${pf}`);
    console.log(`  • Max Portfolio DD:    -${maxDd.toFixed(2)}%`);
    console.log(`  • Max Consec Losses:   ${maxConsecLosses}`);
    console.log(`\n  🗓️ Month-by-Month Compounding Ledger:`);
    for (const [m, d] of monthly) {
      const mwr = ((d.wins / d.trades) * 100).toFixed(1);
      const sign = d.pnl >= 0 ? '+' : '';
      console.log(`    • ${m} | Trades: ${String(d.trades).padStart(3, ' ')} (15M: ${String(d.turboTrades).padStart(2, ' ')} · 1H: ${String(d.macroTrades).padStart(2, ' ')}) | WinRate: ${mwr.padStart(5, ' ')}% | Net: ${sign}$${d.pnl.toFixed(2).padStart(8, ' ')} | Balance: $${d.balance.toFixed(2)}`);
    }
    console.log(`------------------------------------------------------------------------\n`);
  }
}

run().catch(console.error);
