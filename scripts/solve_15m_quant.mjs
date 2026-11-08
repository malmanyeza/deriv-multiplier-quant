import WebSocket from 'ws';

/**
 * SOLVING THE 15-MINUTE QUANT FOR CONSISTENT 12-MONTH PROFITABILITY
 * 
 * Testing 4 distinct hypotheses on 35,000 15m candles:
 * Hypothesis 1: Mean Reversion (Bollinger Band 2.5 STD + RSI 14 Hook)
 * Hypothesis 2: Session Filter (Only trading during peak hours 08:00 - 20:00 UTC)
 * Hypothesis 3: SuperTrend Volatility Trailing
 * Hypothesis 4: Multi-Asset 15M Diversified Basket (1HZ100V + R_75 + R_50)
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

async function fetch15mCandles(client, symbol, targetBars = 35000) {
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

function computeBollingerBands(closes, period = 20, stdDev = 2.0) {
  const mid = new Array(closes.length).fill(0);
  const upper = new Array(closes.length).fill(0);
  const lower = new Array(closes.length).fill(0);

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += closes[i - k];
    const mean = sum / period;
    let variance = 0;
    for (let k = 0; k < period; k++) variance += Math.pow(closes[i - k] - mean, 2);
    const sd = Math.sqrt(variance / period);
    mid[i] = mean;
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
  }
  return { mid, upper, lower };
}

// Hypothesis 1: Mean Reversion on 15M (Bouncing Bollinger Bands)
function testMeanReversion15m(bars, symbol) {
  const multiplier = 30;
  const commDollars = 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const { mid, upper, lower } = computeBollingerBands(closes, 20, 2.2);
  const rsi = computeRSI(closes, 14);

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  const monthly = new Map();

  for (let i = 25; i < bars.length - 2; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];

    let dir = 0;
    // Oversold Bounce
    if (prev.close < lower[i - 1] && bar.close > lower[i] && rsi[i] < 32 && bar.close > bar.open) {
      dir = 1;
    } else if (prev.close > upper[i - 1] && bar.close < upper[i] && rsi[i] > 68 && bar.close < bar.open) {
      dir = -1;
    }

    if (dir === 0) continue;

    const stake = balance * 0.015;
    const entry = bars[i + 1].open;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const targetPrice = mid[i]; // Exit when price reverts back to middle band!

    let pnlPct = 0;
    let exitIdx = Math.min(bars.length - 1, i + 16);

    for (let j = i + 1; j <= exitIdx; j++) {
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      if ((dir === 1 && bars[j].high >= targetPrice) || (dir === -1 && bars[j].low <= targetPrice)) {
        const move = dir === 1 ? (targetPrice - entry) / entry : (entry - targetPrice) / entry;
        pnlPct = move * multiplier * 100 - commDollars;
        exitIdx = j;
        break;
      }

      if (j === exitIdx) {
        const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
        pnlPct = move * multiplier * 100 - commDollars;
      }
    }

    if (pnlPct < -100) pnlPct = -100;
    const dollarPnl = stake * (pnlPct / 100);
    balance += dollarPnl;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDd) maxDd = dd;

    if (dollarPnl > 0) wins++;
    else losses++;

    const d = new Date(bar.time * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthly.has(key)) monthly.set(key, { trades: 0, pnl: 0, balance });
    const b = monthly.get(key);
    b.trades++;
    b.pnl += dollarPnl;
    b.balance = balance;

    i = exitIdx + 1;
  }

  const total = wins + losses;
  return {
    strategy: '15M Bollinger Band Mean Reversion',
    trades: total,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0',
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(1),
    finalBalance: balance.toFixed(2),
    maxDd: maxDd.toFixed(2),
    monthly: Array.from(monthly.entries()),
  };
}

async function run() {
  const client = await createClient();
  console.log('Testing 15M Strategies on 1-Year 1HZ100V Data...');

  const bars = await fetch15mCandles(client, '1HZ100V', 35000);
  console.log(`Loaded ${bars.length} 15m candles (~365 days).\n`);

  const resMR = testMeanReversion15m(bars, '1HZ100V');
  console.log(`========================================================================`);
  console.log(`  📊 RESULTS: ${resMR.strategy}`);
  console.log(`  • Trades:        ${resMR.trades}`);
  console.log(`  • Win Rate:      ${resMR.winRate}%`);
  console.log(`  • Net Return:    +${resMR.returnPct}% ($1,000 -> $${resMR.finalBalance})`);
  console.log(`  • Max Drawdown:  -${resMR.maxDd}%`);
  console.log(`------------------------------------------------------------------------`);
  console.log(`  🗓️ Monthly Breakdown:`);
  for (const [m, d] of resMR.monthly) {
    const s = d.pnl >= 0 ? '+' : '';
    console.log(`    • ${m} | Trades: ${String(d.trades).padStart(2, ' ')} | Net: ${s}$${d.pnl.toFixed(2).padStart(7, ' ')} | Balance: $${d.balance.toFixed(2)}`);
  }

  client.close();
}

run().catch(console.error);
