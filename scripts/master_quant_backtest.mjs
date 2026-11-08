import WebSocket from 'ws';

/**
 * MASTER QUANT BACKTEST ENGINE: 1-YEAR COMPREHENSIVE SEARCH
 * 
 * Objective: Find the mathematically robust, winning strategy configuration 
 * across small timeframes (15m, 30m, 1h) that produces positive net compounding,
 * high profit factor, and safe drawdowns (<25%) over the full past year.
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
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg);
      }
    });

    ws.on('error', (err) => reject(err));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCandles(client, symbol, granularity, targetBars = 35000) {
  let end = 'latest';
  const byEpoch = new Map();
  const maxPages = Math.ceil(targetBars / 1000);

  for (let p = 0; p < maxPages; p++) {
    try {
      await sleep(350);
      const res = await client.request({
        ticks_history: symbol,
        style: 'candles',
        granularity,
        count: 1000,
        end,
      });

      const list = res.candles || [];
      if (list.length === 0) break;

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
    } catch (err) {
      break;
    }
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

/**
 * Multi-Timeframe Trend-Pullback Engine (MTF)
 * Uses 1H for macro trend direction, and 15M for low-risk pullback entries.
 */
function testMtfStrategy(bars15m, bars1h, symbol, config = {}) {
  const multiplier = 100;
  const commDollars = symbol.includes('BTC') ? 2.99 : symbol.includes('ETH') ? 7.99 : 2.5;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  // 1H Indicators
  const closes1h = bars1h.map((b) => b.close);
  const ema30_1h = computeEMA(closes1h, 30);
  const ema100_1h = computeEMA(closes1h, 100);
  const { adx: adx1h } = computeADXandATR(bars1h, 14);

  // Quick lookup for 1H trend at any given 15m timestamp
  const get1hMacro = (epoch) => {
    // Find the latest completed 1h candle before epoch
    let low = 0;
    let high = bars1h.length - 1;
    let matchIdx = -1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (bars1h[mid].time <= epoch) {
        matchIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (matchIdx < 100) return 'NEUTRAL';
    const isBull = ema30_1h[matchIdx] > ema100_1h[matchIdx] && bars1h[matchIdx].close > ema100_1h[matchIdx];
    const isBear = ema30_1h[matchIdx] < ema100_1h[matchIdx] && bars1h[matchIdx].close < ema100_1h[matchIdx];
    const trendStrong = adx1h[matchIdx] >= 20;
    if (trendStrong && isBull) return 'BULL';
    if (trendStrong && isBear) return 'BEAR';
    return 'NEUTRAL';
  };

  // 15M Indicators
  const closes15m = bars15m.map((b) => b.close);
  const ema20_15m = computeEMA(closes15m, 20);
  const ema50_15m = computeEMA(closes15m, 50);
  const rsi15m = computeRSI(closes15m, 14);
  const { atr: atr15m, adx: adx15m } = computeADXandATR(bars15m, 14);

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let consecLoss = 0;
  let maxConsecLoss = 0;
  const trades = [];

  const riskPct = config.riskPct || 0.015;
  let i = 120;
  const endIdx = bars15m.length;

  while (i < endIdx - 2) {
    const bar = bars15m[i];
    const prevBar = bars15m[i - 1];
    const atrPct = bar.close > 0 ? atr15m[i] / bar.close : 0;
    if (atrPct > 0.012) {
      i++;
      continue;
    }

    const macro1h = get1hMacro(bar.time);
    let dir = 0;

    // MTF Rule: Only buy pullbacks in direction of 1H Trend
    if (macro1h === 'BULL') {
      // 15m pullback: Price dipped near/below EMA20 and RSI pulled back (< 48), now hooking up
      if (
        prevBar.low <= ema20_15m[i - 1] &&
        bar.close > ema20_15m[i] &&
        bar.close > bar.open &&
        rsi15m[i - 1] < 48 &&
        rsi15m[i] >= 48
      ) {
        dir = 1;
      }
    } else if (macro1h === 'BEAR') {
      if (
        prevBar.high >= ema20_15m[i - 1] &&
        bar.close < ema20_15m[i] &&
        bar.close < bar.open &&
        rsi15m[i - 1] > 52 &&
        rsi15m[i] <= 52
      ) {
        dir = -1;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    // Dynamic Sizing with streak dampener
    let currentRisk = riskPct;
    if (consecLoss >= 2) currentRisk = riskPct * 0.5;

    const stake = Math.max(1, balance * currentRisk);
    const entry = bars15m[i + 1].open;
    const entryTime = bars15m[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const maxHold = 48; // up to 12 hours
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars15m[j].low <= koPrice) || (dir === -1 && bars15m[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      // Profit Target: +120% or Trailing EMA20 break
      const move = dir === 1 ? (bars15m[j].close - entry) / entry : (entry - bars15m[j].close) / entry;
      const currentGain = move * multiplier * 100 - commDollars;

      if (currentGain >= 120) {
        pnlPct = 120;
        exitIdx = j;
        break;
      }

      if (j - (i + 1) >= 4) {
        if ((dir === 1 && bars15m[j].close < ema20_15m[j]) || (dir === -1 && bars15m[j].close > ema20_15m[j])) {
          pnlPct = currentGain;
          exitIdx = j;
          break;
        }
      }

      if (j === lastBar) {
        pnlPct = currentGain;
        exitIdx = j;
      }
    }

    if (pnlPct < -100) pnlPct = -100;
    const dollarPnl = stake * (pnlPct / 100);
    balance += dollarPnl;
    if (balance > peak) peak = balance;
    const currentDd = ((peak - balance) / peak) * 100;
    if (currentDd > maxDd) maxDd = currentDd;

    if (dollarPnl > 0) {
      wins++;
      consecLoss = 0;
    } else {
      losses++;
      consecLoss++;
      if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
    }

    trades.push({
      entryTime,
      dollarPnl,
      balanceAfter: balance,
    });

    i = exitIdx + 1;
  }

  // Monthly breakdown
  const monthlyBuckets = new Map();
  for (const t of trades) {
    const d = new Date(t.entryTime * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyBuckets.has(key)) monthlyBuckets.set(key, { trades: 0, wins: 0, pnl: 0, balance: t.balanceAfter });
    const b = monthlyBuckets.get(key);
    b.trades++;
    if (t.dollarPnl > 0) b.wins++;
    b.pnl += t.dollarPnl;
    b.balance = t.balanceAfter;
  }

  const total = wins + losses;
  return {
    symbol,
    strategy: '1H/15M Multi-Timeframe Trend-Pullback',
    barsTested: bars15m.length,
    startDate: new Date(bars15m[0].time * 1000).toISOString().split('T')[0],
    endDate: new Date(bars15m[bars15m.length - 1].time * 1000).toISOString().split('T')[0],
    totalTrades: total,
    wins,
    losses,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0',
    finalBalance: balance.toFixed(2),
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(1),
    maxDd: maxDd.toFixed(2),
    maxConsecLoss,
    monthly: Array.from(monthlyBuckets.entries()),
  };
}

async function run() {
  console.log('========================================================================');
  console.log('   SEARCHING FOR THE OPTIMAL 1-YEAR HIGH-GROWTH QUANT CONFIGURATION     ');
  console.log('========================================================================\n');

  const client = await createClient();

  const testList = ['cryBTCUSD', '1HZ100V'];

  for (const sym of testList) {
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`Downloading 1 Full Year of Live Data for ${sym}...`);
    console.log(`------------------------------------------------------------------------`);

    process.stdout.write(`Fetching 1H candles (~8,760 bars)... `);
    const bars1h = await fetchCandles(client, sym, 3600, 8760);
    console.log(`Loaded ${bars1h.length} bars.`);

    process.stdout.write(`Fetching 15M candles (~35,000 bars)... `);
    const bars15m = await fetchCandles(client, sym, 900, 35000);
    console.log(`Loaded ${bars15m.length} bars.`);

    // Run MTF strategy
    const resMtf = testMtfStrategy(bars15m, bars1h, sym, { riskPct: 0.015 });
    console.log(`\n📊 RESULTS: [${sym} - MTF 1H Trend + 15M Pullback Scalp]`);
    console.log(`  • Period:            ${resMtf.startDate} to ${resMtf.endDate}`);
    console.log(`  • Total Trades:      ${resMtf.totalTrades} (~${(resMtf.totalTrades / 365).toFixed(1)} trades/day)`);
    console.log(`  • Win Rate:          ${resMtf.winRate}% (${resMtf.wins}W / ${resMtf.losses}L)`);
    console.log(`  • Net Return:        +${resMtf.returnPct}% ($1,000 -> $${resMtf.finalBalance})`);
    console.log(`  • Max Drawdown:      -${resMtf.maxDd}%`);
    console.log(`  • Max Consec Losses: ${resMtf.maxConsecLoss}`);

    console.log(`\n    🗓️ Month-by-Month Breakdown:`);
    for (const [m, d] of resMtf.monthly) {
      const s = d.pnl >= 0 ? '+' : '';
      console.log(`      • ${m} | Trades: ${String(d.trades).padStart(2, ' ')} | Net: ${s}$${d.pnl.toFixed(2).padStart(8, ' ')} | Balance: $${d.balance.toFixed(2)}`);
    }
  }

  client.close();
}

run().catch(console.error);
