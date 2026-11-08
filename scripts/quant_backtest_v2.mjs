// Phase 2 Quantitative Research:
// 1. Check cryBTCUSD Multiplier contract lifetime (date_expiry - date_start)
// 2. Check weekday symbols available on account (Gold XAUUSD, EURUSD, etc.) via active_symbols + ticks_history
// 3. Test Uncapped Chandelier-Trailing-Stop Trend Breakout (letting winners run instead of capping TP!)
//    with strict 60% Train / 20% Validation / 20% Out-of-Sample Test split.

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

const btcP = await req({
  proposal: 1,
  amount: 100,
  basis: 'stake',
  contract_type: 'MULTUP',
  currency: 'USD',
  multiplier: 100,
  underlying_symbol: 'cryBTCUSD',
});
const btcLifetimeHours =
  ((btcP.proposal?.date_expiry ?? 0) - (btcP.proposal?.date_start ?? 0)) / 3600;

const allSymsRes = await req({ active_symbols: 'brief' });
const allSyms = allSymsRes.active_symbols || [];
const nonSynth = allSyms
  .filter((s) => s.market !== 'synthetic_index')
  .map((s) => ({ sym: s.underlying_symbol, name: s.underlying_symbol_name, market: s.market, openNow: s.exchange_is_open }));

async function fetchCandles(symbol, granularity, pages = 8) {
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

/**
 * Uncapped Trailing-Stop Multiplier Simulator ($100 stake, M leverage, exact entry commission).
 * - Initial stop: min(slAtr * ATR / entry, 0.95 / M)
 * - Chandelier trailing stop: trails highest high (or lowest low) minus trailAtr * ATR
 * - Max hold: maxHoldBars (respecting Deriv Multiplier date_expiry!)
 */
function simulateTrailingMultiplier(bars, startIdx, endIdx, signalFn, opts) {
  const { multiplier, commDollars, slAtr, trailAtr, maxHoldBars } = opts;
  const atr = computeATR(bars, 14);
  const trades = [];
  let cum = 0, peak = 0, maxDd = 0;

  let i = Math.max(startIdx, 120);
  while (i < endIdx - 2) {
    const dir = signalFn(bars, i, atr);
    if (dir === 0 || atr[i] <= 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].o;
    const hardKnockoutPct = 0.96 / multiplier; // Deriv -100% stake stop-out
    const initStopPct = Math.min((slAtr * atr[i]) / entry, hardKnockoutPct);
    let stopPrice = dir === 1 ? entry * (1 - initStopPct) : entry * (1 + initStopPct);
    let extreme = entry;

    const lastBar = Math.min(endIdx - 1, i + 1 + maxHoldBars);
    let exitPrice = bars[lastBar].c;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      // Check stop hit FIRST using previous bar's trailing stop (strictly zero intrabar lookahead!)
      if (dir === 1 && bars[j].l <= stopPrice) {
        exitPrice = stopPrice;
        exitIdx = j;
        break;
      }
      if (dir === -1 && bars[j].h >= stopPrice) {
        exitPrice = stopPrice;
        exitIdx = j;
        break;
      }

      // Update trailing stop at bar close for subsequent bars
      if (dir === 1) {
        if (bars[j].h > extreme) extreme = bars[j].h;
        const candidate = extreme - trailAtr * atr[j];
        if (candidate > stopPrice) stopPrice = candidate;
      } else {
        if (bars[j].l < extreme) extreme = bars[j].l;
        const candidate = extreme + trailAtr * atr[j];
        if (candidate < stopPrice) stopPrice = candidate;
      }
    }

    const movePct = dir * ((exitPrice - entry) / entry);
    const pnl = Math.max(-100, 100 * multiplier * movePct - commDollars);
    trades.push(pnl);
    cum += pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
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

// Squeeze Breakout Signal: Bollinger/Keltner Volatility Compression -> 48-bar Channel Breakout aligned with EMA100
function makeSqueezeBreakoutSignal(bars, lookback = 48) {
  const closes = bars.map((b) => b.c);
  const ema100 = computeEMA(closes, 100);
  const atr14 = computeATR(bars, 14);
  const atr80 = computeEMA(atr14, 80);

  return (b, i) => {
    if (i < Math.max(lookback + 2, 105)) return 0;
    // Volatility must be compressed enough that 2*ATR < 0.75% of price (so 100x stop-out isn't hit by noise!)
    const atrPct = atr14[i] / b[i].c;
    if (atrPct > 0.0045) return 0; // Skip chaotic ultra-wide bars where 100x leverage gets stopped out by noise
    // Prior quiet regime expanding into breakout bar
    let hi = -Infinity, lo = Infinity;
    for (let k = i - lookback; k < i; k++) {
      if (b[k].h > hi) hi = b[k].h;
      if (b[k].l < lo) lo = b[k].l;
    }
    const barRange = b[i].h - b[i].l;
    if (barRange < atr80[i] * 1.1) return 0; // Require strong expansion candle closing outside range
    if (b[i].c > hi && b[i].c > ema100[i] && ema100[i] > ema100[i - 5]) return 1;
    if (b[i].c < lo && b[i].c < ema100[i] && ema100[i] < ema100[i - 5]) return -1;
    return 0;
  };
}

const testCases = [
  { sym: 'cryBTCUSD', gran: 900, tf: '15m', mult: 100, comm: 2.99 },
  { sym: 'cryBTCUSD', gran: 300, tf: '5m', mult: 100, comm: 2.99 },
  { sym: 'frxXAUUSD', gran: 900, tf: '15m (Gold)', mult: 100, comm: 2.50 },
  { sym: '1HZ100V', gran: 900, tf: '15m (CSPRNG control)', mult: 40, comm: 1.99 },
];

const summary = [];
for (const tc of testCases) {
  const bars = await fetchCandles(tc.sym, tc.gran, 8);
  if (bars.length < 300) {
    summary.push({ sym: tc.sym, tf: tc.tf, bars: bars.length, note: 'Insufficient bars' });
    continue;
  }
  const n = bars.length;
  const tEnd = Math.floor(n * 0.6);
  const vEnd = Math.floor(n * 0.8);
  const sig = makeSqueezeBreakoutSignal(bars, 48);
  const maxHold = Math.max(12, Math.floor((btcLifetimeHours * 3600) / tc.gran) - 2);
  const opts = { multiplier: tc.mult, commDollars: tc.comm, slAtr: 1.8, trailAtr: 3.2, maxHoldBars: Math.min(96, maxHold) };

  summary.push({
    sym: tc.sym,
    tf: tc.tf,
    bars: n,
    days: Number(((bars[n - 1].t - bars[0].t) / 86400).toFixed(1)),
    train: simulateTrailingMultiplier(bars, 120, tEnd, sig, opts),
    val: simulateTrailingMultiplier(bars, tEnd, vEnd, sig, opts),
    testOOS: simulateTrailingMultiplier(bars, vEnd, n, sig, opts),
    full: simulateTrailingMultiplier(bars, 120, n, sig, opts),
  });
}

console.log(JSON.stringify({
  btcMultiplierMaxLifetimeHours: Number(btcLifetimeHours.toFixed(1)),
  nonSyntheticMarketsCount: nonSynth.length,
  sampleNonSynthMarkets: nonSynth.slice(0, 20),
  summary,
}, null, 2));

ws.close();
process.exit(0);
