import WebSocket from 'ws';

/**
 * 15-MINUTE QUANT OPTIMIZATION & DISCOVERY ENGINE
 * 
 * Testing across:
 *   - Multipliers: 20x, 30x, 50x, 100x
 *   - Symbols: 1HZ100V, 1HZ50V, R_100, R_75, cryBTCUSD, frxXAUUSD
 *   - Stop-Loss / Take-Profit ratios
 *   - Trend vs Mean-Reversion rules
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

async function fetch15mCandles(client, symbol, targetBars = 20000) {
  let end = 'latest';
  const byEpoch = new Map();
  const maxPages = Math.ceil(targetBars / 1000);

  for (let p = 0; p < maxPages; p++) {
    try {
      await sleep(350);
      const res = await client.request({
        ticks_history: symbol,
        style: 'candles',
        granularity: 900,
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
 * Strategy: Adaptive 15M Trend & Volatility Filter
 */
function test15mStrategy(bars, symbol, options = {}) {
  const {
    multiplier = 50,
    lookback = 20,
    trendAdxMin = 22,
    takeProfitR = 1.5, // 150%
    stopLossR = 0.8,   // 80%
    trailingEma = 21,
    riskPct = 0.015,
  } = options;

  const commDollars = symbol.includes('BTC') ? 2.99 : 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const emaFast = computeEMA(closes, 9);
  const emaSlow = computeEMA(closes, trailingEma);
  const emaBaseline = computeEMA(closes, 50);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  const trades = [];

  let i = 60;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 0;
    if (atrPct > 0.02) {
      i++;
      continue;
    }

    let dir = 0;

    // Trend filter: Fast EMA > Slow EMA > Baseline
    if (adx[i] >= trendAdxMin) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }

      if (bars[i].close > hi && emaFast[i] > emaSlow[i] && emaSlow[i] > emaBaseline[i]) {
        dir = 1;
      } else if (bars[i].close < lo && emaFast[i] < emaSlow[i] && emaSlow[i] < emaBaseline[i]) {
        dir = -1;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const stake = Math.max(1, balance * riskPct);
    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    // Stop Loss and Take Profit barrier prices
    const slMove = (stopLossR * 100 + commDollars) / (100 * multiplier);
    const tpMove = (takeProfitR * 100 + commDollars) / (100 * multiplier);
    const slPrice = dir === 1 ? entry * (1 - slMove) : entry * (1 + slMove);
    const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);

    const maxHold = 32; // up to 8 hours
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      // Check KO stop-out floor first
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      // Check Stop Loss target
      if ((dir === 1 && bars[j].low <= slPrice) || (dir === -1 && bars[j].high >= slPrice)) {
        pnlPct = -(stopLossR * 100);
        exitIdx = j;
        break;
      }

      // Check Take Profit target
      if ((dir === 1 && bars[j].high >= tpPrice) || (dir === -1 && bars[j].low <= tpPrice)) {
        pnlPct = takeProfitR * 100;
        exitIdx = j;
        break;
      }

      // Trailing Slow EMA exit after 4 bars
      if (j - (i + 1) >= 4) {
        if ((dir === 1 && bars[j].close < emaSlow[j]) || (dir === -1 && bars[j].close > emaSlow[j])) {
          const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
          pnlPct = move * multiplier * 100 - commDollars;
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
    const dollarPnl = stake * (pnlPct / 100);
    balance += dollarPnl;
    if (balance > peak) peak = balance;
    const currentDd = ((peak - balance) / peak) * 100;
    if (currentDd > maxDd) maxDd = currentDd;

    if (dollarPnl > 0) wins++;
    else losses++;

    trades.push({
      entryTime,
      dollarPnl,
      balanceAfter: balance,
    });

    i = exitIdx + 1;
  }

  const total = wins + losses;
  return {
    multiplier,
    lookback,
    totalTrades: total,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0',
    finalBalance: balance.toFixed(2),
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(1),
    maxDd: maxDd.toFixed(2),
    trades,
  };
}

async function run() {
  console.log('========================================================================');
  console.log('   15-MINUTE QUANT BACKTEST ENGINE: TESTING MULTIPLE PARAMETERS & ASSETS');
  console.log('========================================================================\n');

  const client = await createClient();

  const symbols = ['cryBTCUSD', '1HZ100V', 'R_75'];

  for (const sym of symbols) {
    console.log(`\n------------------------------------------------------------------------`);
    console.log(`Testing Symbol on 15M: ${sym}`);
    console.log(`------------------------------------------------------------------------`);

    process.stdout.write(`Fetching 15M candles (~25,000 bars)... `);
    const bars = await fetch15mCandles(client, sym, 25000);
    console.log(`Loaded ${bars.length} bars (${(bars.length / 96).toFixed(1)} days).`);

    for (const mult of [30, 50, 100]) {
      for (const tp of [1.2, 1.6, 2.0]) {
        const res = test15mStrategy(bars, sym, {
          multiplier: mult,
          takeProfitR: tp,
          stopLossR: 0.75,
          lookback: 20,
          trendAdxMin: 22,
          riskPct: 0.015,
        });

        console.log(`  • Mult: ${String(mult).padStart(3, ' ')}x | TP: +${(tp*100).toFixed(0)}% | Trades: ${String(res.totalTrades).padStart(3, ' ')} | WinRate: ${res.winRate.padStart(5, ' ')}% | Return: +${res.returnPct.padStart(6, ' ')}% ($${res.finalBalance.padStart(8, ' ')}) | MaxDD: -${res.maxDd}%`);
      }
    }
  }

  client.close();
}

run().catch(console.error);
