// Phase 3: Testing Deriv Multipliers as Built-In Down-and-Out / Up-and-Out Convexity Options
// Key Mathematical Insight:
// A $10 stake at 100x Multiplier ($1,000 notional) has:
//   - Hard maximum loss strictly capped at -$10 (-1R) at ~0.97% adverse move (zero gap/liquidation slippage!)
//   - One-time $0.30 commission ($2.99 per $100 stake at 0% app markup)
//   - Up to 184 hours (7.6 days) holding window with uncapped upside (+3% move = +3R, +6% move = +6R!)
// Strict Chronological Walk-Forward: 60% Train -> 20% Validation -> 20% Out-of-Sample Test
// Plus CSPRNG 1HZ100V Control to prove zero look-ahead bias!

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

async function fetchCandles(symbol, granularity, pages = 12) {
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

function computeEMA(values, period) {
  const out = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
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
        s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
      }
      atr[i] = s / period;
    } else atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
  }
  return atr;
}

/**
 * Simulates $100 stake (1R = $100) Multiplier using Deriv's built-in -100% stake stop-out barrier
 * + EMA trend-flip / time-expiry exit (max 168h = 7 days < 184h contract lifetime).
 * Strictly zero lookahead: signal at bar[i] close -> enters at bar[i+1] open;
 * checks intrabar knock-out on bar[j].low (for MULTUP) or bar[j].high (for MULTDOWN) EVERY hour!
 */
function simConvexMultiplier(bars, startIdx, endIdx, signalFn, exitFn, opts) {
  const { multiplier = 100, commDollars = 2.99, maxHoldBars = 160 } = opts;
  // Deriv stop-out occurs when unrealized loss + commission reaches $100:
  // 100 * multiplier * adverseMovePct + commDollars = 100 => adverseMovePct = (100 - commDollars) / (100 * multiplier)
  const knockoutMovePct = (100 - commDollars) / (100 * multiplier);

  const trades = [];
  let cum = 0, peak = 0, maxDd = 0;

  let i = Math.max(startIdx, 210);
  while (i < endIdx - 2) {
    const dir = signalFn(bars, i);
    if (dir === 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].o;
    const koPrice = dir === 1 ? entry * (1 - knockoutMovePct) : entry * (1 + knockoutMovePct);
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHoldBars);
    let pnl = 0;
    let exitIdx = lastBar;
    let knockedOut = false;

    for (let j = i + 1; j <= lastBar; j++) {
      // 1. Intrabar hard knock-out check FIRST (worst-case conservative!)
      if (dir === 1 && bars[j].l <= koPrice) {
        pnl = -100;
        exitIdx = j;
        knockedOut = true;
        break;
      }
      if (dir === -1 && bars[j].h >= koPrice) {
        pnl = -100;
        exitIdx = j;
        knockedOut = true;
        break;
      }
      // 2. End-of-bar trend reversal exit check -> exits at next bar open (or lastBar close)
      if (j < lastBar && exitFn(bars, j, dir, entry)) {
        const ex = bars[j + 1].o;
        const movePct = dir * ((ex - entry) / entry);
        pnl = Math.max(-100, 100 * multiplier * movePct - commDollars);
        exitIdx = j + 1;
        break;
      }
    }

    if (!knockedOut && exitIdx === lastBar) {
      const ex = bars[lastBar].c;
      const movePct = dir * ((ex - entry) / entry);
      pnl = Math.max(-100, 100 * multiplier * movePct - commDollars);
    }

    trades.push(pnl);
    cum += pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
    i = exitIdx + 1;
  }

  const n = trades.length;
  if (n === 0) return { n: 0, winRate: 0, netR: 0, avgR: 0, pf: 0, maxDdR: 0, tStat: 0, kellyPct: 0 };
  const wins = trades.filter((x) => x > 0);
  const losses = trades.filter((x) => x <= 0);
  const avg = cum / n;
  const std = Math.sqrt(trades.reduce((a, x) => a + (x - avg) ** 2, 0) / n) || 1;
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0)) || 1e-6;
  const p = wins.length / n;
  const avgWin = wins.length ? gw / wins.length : 0;
  const avgLoss = losses.length ? gl / losses.length : 100;
  const bRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const kelly = bRatio > 0 ? p - (1 - p) / bRatio : 0;

  return {
    n,
    winRate: Number((p * 100).toFixed(1)),
    avgWinR: Number((avgWin / 100).toFixed(2)),
    avgLossR: Number((avgLoss / 100).toFixed(2)),
    netR: Number((cum / 100).toFixed(2)), // in multiples of 1R ($100 stake)
    avgR: Number((avg / 100).toFixed(3)),
    pf: Number((gw / gl).toFixed(2)),
    maxDdR: Number((maxDd / 100).toFixed(2)),
    tStat: Number(((avg / std) * Math.sqrt(n)).toFixed(2)),
    fullKellyPct: Number((Math.max(0, kelly) * 100).toFixed(2)),
  };
}

// Academic Time-Series Momentum Breakout (Donchian 72-hour breakout in direction of EMA200, entering when 1h ATR <= 0.65% so knock-out barrier is >= 1.5x hourly ATR)
function buildMomentumSystem(bars, lookback = 72, longOnly = false) {
  const closes = bars.map((b) => b.c);
  const ema200 = computeEMA(closes, 200);
  const ema36 = computeEMA(closes, 36);
  const atr = computeATR(bars, 14);

  const signalFn = (b, i) => {
    if (i < 205) return 0;
    // Volatility regime gate: 1-hour ATR must be calm enough (<0.65% of price) that the 0.97% barrier isn't random 1-bar noise
    if (atr[i] / b[i].c > 0.0065) return 0;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - lookback; k < i; k++) {
      if (b[k].h > hi) hi = b[k].h;
      if (b[k].l < lo) lo = b[k].l;
    }
    if (b[i].c > hi && b[i].c > ema200[i] && ema36[i] > ema200[i]) return 1;
    if (!longOnly && b[i].c < lo && b[i].c < ema200[i] && ema36[i] < ema200[i]) return -1;
    return 0;
  };

  // Trend-following exit: close only when price closes back across EMA36 (let trend winners run!)
  const exitFn = (b, j, dir) => {
    if (dir === 1 && b[j].c < ema36[j]) return true;
    if (dir === -1 && b[j].c > ema36[j]) return true;
    return false;
  };

  return { signalFn, exitFn };
}

const universe = [
  { sym: 'cryBTCUSD', name: 'Bitcoin (24/7)', mult: 100, comm: 2.99, longOnly: false },
  { sym: 'cryBTCUSD', name: 'Bitcoin Long-Only Macro Drift (24/7)', mult: 100, comm: 2.99, longOnly: true },
  { sym: 'frxXAUUSD', name: 'Gold XAU/USD (Mon-Fri)', mult: 100, comm: 2.50, longOnly: true },
  { sym: 'OTC_NDX', name: 'US Tech 100 Nasdaq (Mon-Fri)', mult: 100, comm: 2.50, longOnly: true },
  { sym: '1HZ100V', name: 'Volatility 100 1s (CSPRNG Control)', mult: 40, comm: 1.99, longOnly: false },
];

const out = [];
for (const u of universe) {
  const bars = await fetchCandles(u.sym, 3600, 12); // up to 12,000 1h bars = 500 days!
  if (bars.length < 500) {
    out.push({ name: u.name, bars: bars.length, note: 'too few bars' });
    continue;
  }
  const n = bars.length;
  const tEnd = Math.floor(n * 0.6);
  const vEnd = Math.floor(n * 0.8);
  const { signalFn, exitFn } = buildMomentumSystem(bars, 72, u.longOnly);
  const opts = { multiplier: u.mult, commDollars: u.comm, maxHoldBars: 160 };

  out.push({
    sym: u.sym,
    name: u.name,
    bars: n,
    days: Number(((bars[n - 1].t - bars[0].t) / 86400).toFixed(1)),
    train: simConvexMultiplier(bars, 210, tEnd, signalFn, exitFn, opts),
    val: simConvexMultiplier(bars, tEnd, vEnd, signalFn, exitFn, opts),
    testOOS: simConvexMultiplier(bars, vEnd, n, signalFn, exitFn, opts),
    full: simConvexMultiplier(bars, 210, n, signalFn, exitFn, opts),
  });
}

console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
