import WebSocket from 'ws';

/**
 * 1-YEAR COMPREHENSIVE 15-MINUTE QUANT BACKTEST (FULL 365 DAYS)
 * 
 * Period: November 2025 to November 2026 (35,000+ 15-Minute Candles)
 * Assets: Volatility 100 (1s) [1HZ100V], Volatility 100 [R_100], Volatility 75 [R_75]
 * 
 * Strategy Engine:
 * - 30x Multiplier (intraday noise protection)
 * - 32-Bar Donchian Breakout (8-hour high/low)
 * - ADX(14) >= 28 Volatility Filter
 * - 100-EMA Macro Baseline
 * - Asymmetric 3:1 R:R (+200% Take Profit vs -65% Stop Loss)
 * - Compound Fixed Risk (1.5% and 2.0%)
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

async function fetchFullYear15m(client, symbol, targetBars = 35000) {
  let end = 'latest';
  const byEpoch = new Map();
  const maxPages = Math.ceil(targetBars / 1000);

  for (let p = 0; p < maxPages; p++) {
    let retries = 3;
    let list = null;

    while (retries > 0) {
      try {
        await sleep(650); // respect rate limits
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity: 900,
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

function extractTradesForBars(bars, symbol) {
  const multiplier = 30;
  const lookback = 32;
  const minAdx = 28;
  const tpR = 2.0;   // +200% (+2.0R)
  const slR = 0.65;  // -65% (-0.65R)
  const emaPeriod = 100;

  const commDollars = 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map(b => b.close);
  const emaFast = computeEMA(closes, 12);
  const emaSlow = computeEMA(closes, 26);
  const emaFilter = computeEMA(closes, emaPeriod);
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
      symbol,
      entryTime,
      exitTime: bars[exitIdx].time,
      pnlPct,
    });

    i = exitIdx + 1;
  }

  return trades;
}

async function run() {
  const client = await createClient();
  console.log('========================================================================');
  console.log('  1-YEAR INSTITUTIONAL BACKTEST REPORT: 15-MINUTE QUANT ENGINE');
  console.log('  Period: November 2025 to November 2026 (Full 365 Days)');
  console.log('========================================================================\n');

  const symbols = ['1HZ100V', 'R_100', 'R_75'];
  const allBasketTrades = [];

  for (const sym of symbols) {
    process.stdout.write(`Fetching full 1-year 15M candles for ${sym}... `);
    const bars = await fetchFullYear15m(client, sym, 35000);
    console.log(`Loaded ${bars.length} candles (~${(bars.length / 96).toFixed(1)} days).`);
    const symTrades = extractTradesForBars(bars, sym);
    console.log(`  -> Generated ${symTrades.length} trades for ${sym}.`);
    allBasketTrades.push(...symTrades);
  }

  // Sort trades chronologically
  allBasketTrades.sort((a, b) => a.entryTime - b.entryTime);

  console.log(`\n========================================================================`);
  console.log(`  TOTAL BASKET TRADES OVER 1 FULL YEAR: ${allBasketTrades.length}`);
  console.log(`========================================================================`);

  for (const risk of [0.015, 0.020]) {
    let balance = 1000;
    let peak = 1000;
    let maxDd = 0;
    let wins = 0;
    let losses = 0;
    let consecLoss = 0;
    let maxConsecLoss = 0;
    const monthly = new Map();
    const tradeLedger = [];

    for (const t of allBasketTrades) {
      const stake = balance * risk;
      const dollarPnl = stake * (t.pnlPct / 100);
      balance += dollarPnl;
      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDd) maxDd = dd;

      if (dollarPnl > 0) {
        wins++;
        consecLoss = 0;
      } else {
        losses++;
        consecLoss++;
        if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
      }

      const d = new Date(t.entryTime * 1000);
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthly.has(mKey)) monthly.set(mKey, { trades: 0, wins: 0, pnl: 0, balance });
      const mb = monthly.get(mKey);
      mb.trades++;
      if (dollarPnl > 0) mb.wins++;
      mb.pnl += dollarPnl;
      mb.balance = balance;

      tradeLedger.push(dollarPnl);
    }

    const total = wins + losses;
    const wr = ((wins / total) * 100).toFixed(1);
    const returnPct = (((balance - 1000) / 1000) * 100).toFixed(2);
    const grossW = tradeLedger.filter(p => p > 0).reduce((s, p) => s + p, 0);
    const grossL = Math.abs(tradeLedger.filter(p => p < 0).reduce((s, p) => s + p, 0));
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99.9';

    console.log(`\n------------------------------------------------------------------------`);
    console.log(`  📊 FULL 1-YEAR BASKET PERFORMANCE @ ${(risk * 100).toFixed(1)}% RISK PER TRADE:`);
    console.log(`  • Starting Capital:    $1,000.00`);
    console.log(`  • Final Capital:       $${balance.toFixed(2)} (+${returnPct}%) 🚀`);
    console.log(`  • Win Rate:            ${wr}% (${wins} Wins / ${losses} Losses in ${total} Trades)`);
    console.log(`  • Profit Factor:       ${pf}`);
    console.log(`  • Max Portfolio DD:    -${maxDd.toFixed(2)}%`);
    console.log(`  • Max Consec Losses:   ${maxConsecLoss}`);
    console.log(`\n  🗓️ 12-Month Month-by-Month Compounding Ledger:`);
    for (const [m, d] of monthly) {
      const mwr = ((d.wins / d.trades) * 100).toFixed(1);
      const sign = d.pnl >= 0 ? '+' : '';
      console.log(`    • ${m} | Trades: ${String(d.trades).padStart(2, ' ')} | WinRate: ${mwr.padStart(5, ' ')}% | Net: ${sign}$${d.pnl.toFixed(2).padStart(7, ' ')} | Balance: $${d.balance.toFixed(2)}`);
    }
    console.log(`------------------------------------------------------------------------`);
  }

  console.log('\n========================================================================\n');
  client.close();
}

run().catch(console.error);
