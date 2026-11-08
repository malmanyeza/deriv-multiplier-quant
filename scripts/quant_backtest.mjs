// Rigorous Chronological Walk-Forward Research:
// Real 24/7 Markets (cryBTCUSD, cryETHUSD) vs CSPRNG Synthetics (1HZ100V, BOOM1000)
// Strict Chronological Split: 60% Train -> 20% Validation -> 20% Out-of-Sample Test (untouched)
// Exact live Deriv Multiplier costs from authenticated account audit:
//   - cryBTCUSD x100 ($100 stake = $10,000 notional): $2.99 commission (0% app markup) | $5.99 (with current 3% app markup)
//   - cryETHUSD x100 ($100 stake = $10,000 notional): $7.99 commission (0% app markup) | $10.99 (with current 3% app markup)
//   - 1HZ100V   x100 ($100 stake = $10,000 notional): ~$9.95 commission
//   - BOOM1000  x100 ($100 stake = $10,000 notional): ~$2.92 commission

const ws = new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');
await new Promise((r) => (ws.onopen = r));

let nextId = 1;
function req(payload) {
  return new Promise((resolve) => {
    const id = nextId++;
    const h = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.req_id === id) {
        ws.removeEventListener('message', h);
        resolve(m);
      }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ ...payload, req_id: id }));
  });
}

async function fetchCandlesMultiPage(symbol, granularity, pages = 6) {
  let end = 'latest';
  const map = new Map();
  for (let p = 0; p < pages; p++) {
    const r = await req({
      ticks_history: symbol,
      style: 'candles',
      granularity,
      count: 1000,
      end,
    });
    const candles = r.candles || [];
    if (candles.length === 0) break;
    for (const c of candles) {
      map.set(Number(c.epoch), {
        t: Number(c.epoch),
        o: Number(c.open),
        h: Number(c.high),
        l: Number(c.low),
        c: Number(c.close),
      });
    }
    const earliest = Number(candles[0].epoch);
    if (candles.length < 10) break;
    end = earliest - 1;
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

function computeATR(bars, period = 14) {
  const atr = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    if (i < period) atr[i] = tr;
    else if (i === period) {
      let s = 0;
      for (let k = 1; k <= period; k++) {
        s += Math.max(
          bars[k].h - bars[k].l,
          Math.abs(bars[k].h - bars[k - 1].c),
          Math.abs(bars[k].l - bars[k - 1].c),
        );
      }
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

function computeEMA(values, period) {
  const out = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) {
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi[i] = 100 - 100 / (1 + rs);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi[i] = 100 - 100 / (1 + rs);
    }
  }
  return rsi;
}

/**
 * Simulates Deriv Multiplier ($100 stake, 100x multiplier) with dollar stop_loss & take_profit
 * (or ATR-based stop/target capped at -$100 stop-out).
 * Conservative intrabar conflict rule: if BOTH SL and TP hit in same candle, counts as SL!
 */
function simulateMultiplier(bars, startIdx, endIdx, signalFn, opts) {
  const { multiplier = 100, commDollars = 2.99, slAtr = 1.2, tpAtr = 3.0, maxHoldBars = 24 } = opts;
  const atr = computeATR(bars, 14);
  const trades = [];
  let maxPeak = 0;
  let cum = 0;
  let maxDd = 0;

  let i = Math.max(startIdx, 65);
  while (i < endIdx - 2) {
    const dir = signalFn(bars, i, atr);
    if (dir === 0 || atr[i] <= 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].o; // Next bar open — zero lookahead!
    // Cap riskDist so dollar loss before commission never exceeds $95 (avoid full $100 stop-out!)
    const maxStopMovePct = 0.92 / multiplier; // e.g. 0.92% on 100x = -$92
    const rawStopPct = (slAtr * atr[i]) / entry;
    const effStopPct = Math.min(rawStopPct, maxStopMovePct);
    const effTpPct = effStopPct * (tpAtr / slAtr);

    const slPrice = dir === 1 ? entry * (1 - effStopPct) : entry * (1 + effStopPct);
    const tpPrice = dir === 1 ? entry * (1 + effTpPct) : entry * (1 - effTpPct);

    const lastBar = Math.min(endIdx - 1, i + 1 + maxHoldBars);
    let exitPrice = bars[lastBar].c;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      const hitSl = dir === 1 ? bars[j].l <= slPrice : bars[j].h >= slPrice;
      const hitTp = dir === 1 ? bars[j].h >= tpPrice : bars[j].l <= tpPrice;
      if (hitSl) {
        exitPrice = slPrice;
        exitIdx = j;
        break;
      }
      if (hitTp) {
        exitPrice = tpPrice;
        exitIdx = j;
        break;
      }
    }

    const movePct = dir * ((exitPrice - entry) / entry);
    let pnl = Math.max(-100, 100 * multiplier * movePct - commDollars);
    trades.push(pnl);
    cum += pnl;
    if (cum > maxPeak) maxPeak = cum;
    if (maxPeak - cum > maxDd) maxDd = maxPeak - cum;
    i = exitIdx + 1;
  }

  const n = trades.length;
  if (n === 0) return { n: 0, winRate: 0, netPnl: 0, avgPnl: 0, pf: 0, maxDd: 0, tStat: 0 };
  const wins = trades.filter((x) => x > 0);
  const losses = trades.filter((x) => x <= 0);
  const avgPnl = cum / n;
  const std = Math.sqrt(trades.reduce((a, x) => a + (x - avgPnl) ** 2, 0) / n) || 1;
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0)) || 1e-6;

  return {
    n,
    winRate: Number(((wins.length / n) * 100).toFixed(1)),
    netPnl: Number(cum.toFixed(2)),
    avgPnl: Number(avgPnl.toFixed(2)),
    pf: Number((gw / gl).toFixed(2)),
    maxDd: Number(maxDd.toFixed(2)),
    tStat: Number(((avgPnl / std) * Math.sqrt(n)).toFixed(2)),
  };
}

// Strategy 1: Time-Series Momentum / Donchian Breakout (20-bar breakout + EMA50 regime + Volatility squeeze expansion)
function stratDonchian(bars) {
  const closes = bars.map((b) => b.c);
  const ema50 = computeEMA(closes, 50);
  const atr14 = computeATR(bars, 14);
  const atr40 = computeEMA(atr14, 40);
  return (b, i) => {
    if (i < 55) return 0;
    if (atr14[i] < atr40[i]) return 0; // Require active volatility expansion
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - 20; k < i; k++) {
      if (b[k].h > hi) hi = b[k].h;
      if (b[k].l < lo) lo = b[k].l;
    }
    if (b[i].c > hi && b[i].c > ema50[i]) return 1;
    if (b[i].c < lo && b[i].c < ema50[i]) return -1;
    return 0;
  };
}

// Strategy 2: Dual-EMA Trend + RSI Impulse Continuation (EMA20 > EMA60, RSI crosses 55/45 with momentum)
function stratTrendImpulse(bars) {
  const closes = bars.map((b) => b.c);
  const ema20 = computeEMA(closes, 20);
  const ema60 = computeEMA(closes, 60);
  const rsi = computeRSI(closes, 14);
  return (b, i) => {
    if (i < 62) return 0;
    if (ema20[i] > ema60[i] && rsi[i - 1] <= 55 && rsi[i] > 55 && rsi[i] < 72) return 1;
    if (ema20[i] < ema60[i] && rsi[i - 1] >= 45 && rsi[i] < 45 && rsi[i] > 28) return -1;
    return 0;
  };
}

// Strategy 3: Bollinger / RSI Extreme Mean Reversion
function stratMeanRev(bars) {
  const closes = bars.map((b) => b.c);
  const rsi = computeRSI(closes, 14);
  return (b, i) => {
    if (i < 30) return 0;
    if (rsi[i - 1] < 26 && rsi[i] >= 26 && b[i].c > b[i].o) return 1;
    if (rsi[i - 1] > 74 && rsi[i] <= 74 && b[i].c < b[i].o) return -1;
    return 0;
  };
}

const assets = [
  { sym: 'cryBTCUSD', gran: 3600, tf: '1h', comm0: 2.99, comm3: 5.99 },
  { sym: 'cryBTCUSD', gran: 900, tf: '15m', comm0: 2.99, comm3: 5.99 },
  { sym: 'cryETHUSD', gran: 3600, tf: '1h', comm0: 7.99, comm3: 10.99 },
  { sym: '1HZ100V', gran: 3600, tf: '1h (CSPRNG control)', comm0: 7.3, comm3: 10.3 },
];

const results = [];
for (const a of assets) {
  const bars = await fetchCandlesMultiPage(a.sym, a.gran, 6);
  const n = bars.length;
  const tEnd = Math.floor(n * 0.6);
  const vEnd = Math.floor(n * 0.8);

  const strats = {
    donchianBreakout: stratDonchian(bars),
    trendImpulse: stratTrendImpulse(bars),
    meanReversion: stratMeanRev(bars),
  };

  const stratOut = {};
  for (const [sName, fn] of Object.entries(strats)) {
    const opts0 = { multiplier: 100, commDollars: a.comm0, slAtr: 1.2, tpAtr: 3.0, maxHoldBars: 24 };
    stratOut[sName] = {
      train_0markup: simulateMultiplier(bars, 65, tEnd, fn, opts0),
      val_0markup: simulateMultiplier(bars, tEnd, vEnd, fn, opts0),
      testOOS_0markup: simulateMultiplier(bars, vEnd, n, fn, opts0),
      full_0markup: simulateMultiplier(bars, 65, n, fn, opts0),
      full_with3pctAppMarkup: simulateMultiplier(bars, 65, n, fn, { ...opts0, commDollars: a.comm3 }),
    };
  }

  results.push({
    sym: a.sym,
    tf: a.tf,
    bars: n,
    days: Number(((bars[n - 1].t - bars[0].t) / 86400).toFixed(1)),
    stratOut,
  });
}

console.log(JSON.stringify(results, null, 2));
ws.close();
process.exit(0);
