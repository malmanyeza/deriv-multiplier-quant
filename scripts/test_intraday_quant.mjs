import WebSocket from 'ws';

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

async function fetchCandles(client, symbol, granularity, totalBars = 5000) {
  let end = 'latest';
  const byTime = new Map();
  const pages = Math.ceil(totalBars / 1000);

  for (let p = 0; p < pages; p++) {
    await sleep(350);
    const res = await client.request({
      ticks_history: symbol,
      style: 'candles',
      granularity,
      count: 1000,
      end,
    });
    const candles = res.candles || [];
    if (candles.length === 0) break;
    for (const c of candles) {
      byTime.set(Number(c.epoch), {
        time: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      });
    }
    end = Number(candles[0].epoch) - 1;
    if (candles.length < 20) break;
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
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
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
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
      Math.abs(bars[i].low - bars[i - 1].close),
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

function runIntradayBacktest(bars, symbol, granName, config = {}) {
  const multiplier = 100;
  const commDollars = symbol.includes('BTC') ? 2.99 : symbol.includes('ETH') ? 7.99 : 2.5;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  // Scaled lookback for small timeframes
  const lookback = config.lookback || 36;
  const trendAdxMin = config.adxMin || 24;
  const atrCutoff = config.atrCutoff || 0.008;

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let consecLoss = 0;
  let maxConsecLoss = 0;

  let i = 120;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > atrCutoff) {
      i++;
      continue;
    }

    let dir = 0;
    let mode = null;

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
      } else if (bars[i].close < lo && bars[i].close < ema100[i] && ema30[i] < ema100[i]) {
        dir = -1;
        mode = 'trend';
      }
    } else if (adx[i] <= 20) {
      if (rsi[i - 1] < 28 && rsi[i] >= 28 && bars[i].close > bars[i].open) {
        dir = 1;
        mode = 'mr';
      } else if (rsi[i - 1] > 72 && rsi[i] <= 72 && bars[i].close < bars[i].open) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0 || !mode) {
      i++;
      continue;
    }

    const stake = balance * 0.02; // 2% risk
    const entry = bars[i + 1].open;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const maxHold = mode === 'trend' ? 60 : 24;
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      // Check KO stop-out
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      if (mode === 'trend') {
        // Trailing EMA30 exit
        if ((dir === 1 && bars[j].close < ema30[j]) || (dir === -1 && bars[j].close > ema30[j])) {
          const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
          pnlPct = move * multiplier * 100 - commDollars;
          exitIdx = j;
          break;
        }
      } else if (mode === 'mr') {
        // Mean reversion target +120%
        const move = dir === 1 ? (bars[j].high - entry) / entry : (entry - bars[j].low) / entry;
        if (move * multiplier * 100 >= 120) {
          pnlPct = 120 - commDollars;
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

    i = exitIdx + 1;
  }

  const total = wins + losses;
  const days = ((bars[bars.length - 1].time - bars[0].time) / 86400).toFixed(1);
  return {
    symbol,
    granName,
    days,
    totalTrades: total,
    tradesPerDay: (total / parseFloat(days)).toFixed(1),
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0',
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(1),
    finalBalance: balance.toFixed(2),
    maxDd: maxDd.toFixed(2),
    maxConsecLoss,
  };
}

async function run() {
  const client = await createClient();
  console.log('Testing Intraday Small-Timeframe Quant on Deriv API...\n');

  const configs = [
    { symbol: 'cryBTCUSD', gran: 900, name: '15-Minute (15M)', lookback: 28, atrCutoff: 0.009 },
    { symbol: 'cryBTCUSD', gran: 300, name: '5-Minute (5M)', lookback: 24, atrCutoff: 0.007 },
    { symbol: 'cryETHUSD', gran: 900, name: '15-Minute (15M)', lookback: 28, atrCutoff: 0.012 },
    { symbol: 'cryETHUSD', gran: 300, name: '5-Minute (5M)', lookback: 24, atrCutoff: 0.009 },
    { symbol: '1HZ100V', gran: 900, name: '15-Minute (15M)', lookback: 24, atrCutoff: 0.015 },
  ];

  for (const c of configs) {
    process.stdout.write(`Fetching 4000 bars for ${c.symbol} (${c.name})... `);
    const bars = await fetchCandles(client, c.symbol, c.gran, 4000);
    console.log(`Loaded ${bars.length} bars.`);

    const res = runIntradayBacktest(bars, c.symbol, c.name, c);
    console.log(`  📊 Results for ${res.symbol} [${res.granName}] (${res.days} days):`);
    console.log(`  • Trades:           ${res.totalTrades} (~${res.tradesPerDay} trades/day)`);
    console.log(`  • Win Rate:         ${res.winRate}%`);
    console.log(`  • Net Return:       +${res.returnPct}% ($1,000 -> $${res.finalBalance})`);
    console.log(`  • Max Drawdown:     -${res.maxDd}%`);
    console.log(`  • Max Consec Losses: ${res.maxConsecLoss}\n`);
  }

  client.close();
}

run().catch(console.error);
