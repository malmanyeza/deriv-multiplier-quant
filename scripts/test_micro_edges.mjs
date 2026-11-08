import WebSocket from 'ws';

/**
 * Advanced Micro-Scalping Research Script
 * 
 * Testing 3 alternative quantitative edges on small timeframes:
 * 
 * Strategy A: Multi-Timeframe Trend-Pullback Scalper (MTF)
 *   - 15m Trend: EMA 20 > EMA 50
 *   - 1m/5m Entry: Wait for pullback to 1m EMA 20 + RSI(7) < 35, enter on recovery candle
 *   - Asymmetric exit: +100% TP, trailing stop, avoiding breakout top chasing.
 * 
 * Strategy B: High-Probability Mean Reversion (Bollinger Bands + RSI 2)
 *   - Pure counter-trend scalp when price stretches 2.5 standard deviations outside BB
 *   - RSI(2) < 5 or > 95
 *   - Fast 1-to-3 bar exit back to midline
 * 
 * Strategy C: Accumulator Tick Simulation
 *   - Using raw tick stream history (10,000 consecutive ticks)
 *   - Micro-volatility filter (Tick standard deviation)
 *   - 2-4 tick duration auto-take-profit
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

async function fetchTicks(client, symbol, count = 10000) {
  const res = await client.request({
    ticks_history: symbol,
    style: 'ticks',
    count,
    end: 'latest',
  });
  const history = res.history;
  if (!history || !history.prices) return [];
  return history.prices.map((p, idx) => ({
    time: history.times[idx],
    price: Number(p),
  }));
}

async function fetchCandles(client, symbol, granularity, count = 3000) {
  let end = 'latest';
  const map = new Map();
  const pages = Math.ceil(count / 1000);

  for (let p = 0; p < pages; p++) {
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
      map.set(Number(c.epoch), {
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
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
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

function computeRSI(closes, period = 7) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length <= 1) return rsi;
  let ag = 0;
  let al = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      ag += gain / period;
      al += loss / period;
      if (i === period) {
        rsi[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
      }
    } else {
      ag = (ag * (period - 1) + gain) / period;
      al = (al * (period - 1) + loss) / period;
      rsi[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
    }
  }
  return rsi;
}

function computeBollingerBands(closes, period = 20, numStd = 2.0) {
  const upper = new Array(closes.length).fill(0);
  const lower = new Array(closes.length).fill(0);
  const mid = new Array(closes.length).fill(0);

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let k = 0; k < period; k++) sum += closes[i - k];
    const mean = sum / period;
    let variance = 0;
    for (let k = 0; k < period; k++) {
      variance += Math.pow(closes[i - k] - mean, 2);
    }
    const std = Math.sqrt(variance / period);
    mid[i] = mean;
    upper[i] = mean + numStd * std;
    lower[i] = mean - numStd * std;
  }
  return { mid, upper, lower };
}

// Strategy A: MTF Pullback Scalp
function testMtfPullback(candles1m, candles15m, symbol) {
  const closes1m = candles1m.map((c) => c.close);
  const ema20_1m = computeEMA(closes1m, 20);
  const ema50_1m = computeEMA(closes1m, 50);
  const rsi7_1m = computeRSI(closes1m, 7);

  // Map 15m trend by epoch
  const closes15m = candles15m.map((c) => c.close);
  const ema20_15m = computeEMA(closes15m, 20);
  const ema50_15m = computeEMA(closes15m, 50);

  const get15mTrend = (epoch) => {
    // find latest 15m candle before epoch
    for (let i = candles15m.length - 1; i >= 0; i--) {
      if (candles15m[i].time <= epoch) {
        return ema20_15m[i] > ema50_15m[i] ? 'BULL' : 'BEAR';
      }
    }
    return 'NEUTRAL';
  };

  let balance = 1000;
  let wins = 0;
  let losses = 0;
  let maxDd = 0;
  let peak = 1000;
  let inTrade = null;
  const mult = 100;
  const commPct = 0.04;

  for (let i = 50; i < candles1m.length; i++) {
    const bar = candles1m[i];
    const prevBar = candles1m[i - 1];

    if (inTrade) {
      const { dir, entryPrice, entryBar, stake } = inTrade;
      let exitPrice = null;

      if (dir === 'MULTUP') {
        const dropPct = (entryPrice - bar.low) / entryPrice;
        const gainPct = (bar.high - entryPrice) / entryPrice;
        if (dropPct * mult >= 0.8) { // -80% cut loss
          exitPrice = entryPrice * (1 - 0.8 / mult);
        } else if (gainPct * mult >= 1.2) { // +120% target
          exitPrice = entryPrice * (1 + 1.2 / mult);
        } else if (bar.close < ema20_1m[i] && i - entryBar >= 4) {
          exitPrice = bar.close;
        }
      } else {
        const dropPct = (bar.high - entryPrice) / entryPrice;
        const gainPct = (entryPrice - bar.low) / entryPrice;
        if (dropPct * mult >= 0.8) {
          exitPrice = entryPrice * (1 + 0.8 / mult);
        } else if (gainPct * mult >= 1.2) {
          exitPrice = entryPrice * (1 - 1.2 / mult);
        } else if (bar.close > ema20_1m[i] && i - entryBar >= 4) {
          exitPrice = bar.close;
        }
      }

      if (exitPrice !== null) {
        const rawReturn = dir === 'MULTUP'
          ? ((exitPrice - entryPrice) / entryPrice) * mult
          : ((entryPrice - exitPrice) / entryPrice) * mult;
        const pnl = stake * Math.max(-1.0, rawReturn) - (stake * mult * (commPct / 100));
        balance += pnl;
        if (balance > peak) peak = balance;
        const dd = ((peak - balance) / peak) * 100;
        if (dd > maxDd) maxDd = dd;

        if (pnl > 0) wins++;
        else losses++;
        inTrade = null;
      }
    }

    if (!inTrade && i < candles1m.length - 1) {
      const trend15m = get15mTrend(bar.time);
      const stake = balance * 0.015;

      // Bullish pullback in uptrend
      if (
        trend15m === 'BULL' &&
        ema20_1m[i] > ema50_1m[i] &&
        bar.low <= ema20_1m[i] &&
        bar.close > ema20_1m[i] &&
        rsi7_1m[i] <= 45 &&
        rsi7_1m[i] > rsi7_1m[i - 1]
      ) {
        inTrade = { dir: 'MULTUP', entryPrice: bar.close, entryBar: i, stake };
      } else if (
        trend15m === 'BEAR' &&
        ema20_1m[i] < ema50_1m[i] &&
        bar.high >= ema20_1m[i] &&
        bar.close < ema20_1m[i] &&
        rsi7_1m[i] >= 55 &&
        rsi7_1m[i] < rsi7_1m[i - 1]
      ) {
        inTrade = { dir: 'MULTDOWN', entryPrice: bar.close, entryBar: i, stake };
      }
    }
  }

  const total = wins + losses;
  return {
    strategy: 'MTF Trend-Pullback Scalper',
    totalTrades: total,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    gainPct: ((balance - 1000) / 1000) * 100,
    maxDd,
    finalBalance: balance,
  };
}

// Strategy C: Accumulator Tick Simulation
function testAccumulatorTicks(ticks, growthRate = 0.03, targetTicks = 3) {
  // Deriv Accumulators: each tick grows stake by (1 + growthRate).
  // If tick moves outside statistical barrier, contract is lost (-100%).
  // We estimate barrier hit probability based on tick-to-tick volatility.
  let balance = 1000;
  let wins = 0;
  let losses = 0;
  let maxDd = 0;
  let peak = 1000;

  // Compute rolling tick volatility (10-tick standard deviation)
  const window = 20;
  for (let i = window; i < ticks.length - targetTicks; i += 5) {
    let sum = 0;
    for (let k = 0; k < window; k++) {
      sum += Math.abs(ticks[i - k].price - ticks[i - k - 1].price);
    }
    const avgMove = sum / window;
    const recentMove = Math.abs(ticks[i].price - ticks[i - 1].price);

    // Only enter when market is calm (not in a giant tick spike)
    if (recentMove > avgMove * 1.5) continue;

    const stake = balance * 0.02; // 2% stake

    // Check if barrier is breached within next targetTicks
    // In Deriv Accumulators (e.g. 3% growth), barrier is typically ~1.5 * average tick range
    const barrier = avgMove * 1.6;
    let breached = false;
    for (let t = 1; t <= targetTicks; t++) {
      const stepDiff = Math.abs(ticks[i + t].price - ticks[i + t - 1].price);
      if (stepDiff >= barrier) {
        breached = true;
        break;
      }
    }

    if (!breached) {
      // Won! Payout is (1 + growthRate)^targetTicks - 1
      const winPayoutPct = Math.pow(1 + growthRate, targetTicks) - 1; // e.g. (1.03)^3 - 1 = +9.27%
      const profit = stake * winPayoutPct;
      balance += profit;
      wins++;
    } else {
      // Lost stake
      balance -= stake;
      losses++;
    }

    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  const total = wins + losses;
  return {
    strategy: `Accumulator (${(growthRate * 100).toFixed(0)}% Growth, ${targetTicks}-Tick Scalp)`,
    totalTrades: total,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    gainPct: ((balance - 1000) / 1000) * 100,
    maxDd,
    finalBalance: balance,
  };
}

async function run() {
  const client = await createClient();
  console.log('Fetching live market datasets from Deriv...');

  const symbol = 'R_100';
  const candles1m = await fetchCandles(client, symbol, 60, 3000);
  const candles15m = await fetchCandles(client, symbol, 900, 1000);
  console.log(`Fetched ${candles1m.length} 1m candles and ${candles15m.length} 15m candles.`);

  const resMtf = testMtfPullback(candles1m, candles15m, symbol);
  console.log('\n--- Strategy A: Multi-Timeframe Trend-Pullback Scalper (1M + 15M) ---');
  console.log(`Trades: ${resMtf.totalTrades} | Win Rate: ${resMtf.winRate.toFixed(1)}% | Return: +${resMtf.gainPct.toFixed(2)}% | Max DD: -${resMtf.maxDd.toFixed(2)}%`);

  console.log('\nFetching 10,000 raw ticks for Accumulator simulation...');
  const ticks = await fetchTicks(client, symbol, 10000);
  console.log(`Fetched ${ticks.length} ticks.`);

  const resAccu3 = testAccumulatorTicks(ticks, 0.03, 3);
  console.log('\n--- Strategy B: Accumulator Scalp (3% Growth, 3 Ticks) ---');
  console.log(`Trades: ${resAccu3.totalTrades} | Win Rate: ${resAccu3.winRate.toFixed(1)}% | Return: +${resAccu3.gainPct.toFixed(2)}% | Max DD: -${resAccu3.maxDd.toFixed(2)}%`);

  const resAccu2 = testAccumulatorTicks(ticks, 0.02, 4);
  console.log('\n--- Strategy C: Accumulator Scalp (2% Growth, 4 Ticks) ---');
  console.log(`Trades: ${resAccu2.totalTrades} | Win Rate: ${resAccu2.winRate.toFixed(1)}% | Return: +${resAccu2.gainPct.toFixed(2)}% | Max DD: -${resAccu2.maxDd.toFixed(2)}%`);

  client.close();
}

run().catch(console.error);
