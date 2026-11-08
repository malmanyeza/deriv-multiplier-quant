// Verify Regime-Switched Portfolio Ensemble (Strict 60% Train / 20% Val / 20% Out-of-Sample Test):
// - Trending Regime (ADX14 >= 24 & calm entry bar ATR <= 0.60%): 48-bar Breakout aligned with EMA100, trailing EMA36 exit
// - Range-Bound Regime (ADX14 <= 20 & ATR <= 0.65%): RSI(14) < 28 / > 72 reversal confirmation candle, TP = 1.8R / SL = built-in -1R or EMA20 midline

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

async function fetchCandles(symbol, granularity, pages = 10) {
  let end = 'latest';
  const map = new Map();
  for (let p = 0; p < pages; p++) {
    const r = await req({ ticks_history: symbol, style: 'candles', granularity, count: 1000, end });
    const candles = r.candles || [];
    if (!candles.length) break;
    for (const c of candles) {
      map.set(Number(c.epoch), { t: Number(c.epoch), o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close) });
    }
    end = Number(candles[0].epoch) - 1;
    if (candles.length < 10) break;
  }
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

function computeEMA(vals, period) {
  const out = new Array(vals.length).fill(0);
  const k = 2 / (period + 1);
  out[0] = vals[0];
  for (let i = 1; i < vals.length; i++) out[i] = vals[i] * k + out[i - 1] * (1 - k);
  return out;
}

function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i <= period) {
      ag += g / period; al += l / period;
      if (i === period) rsi[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
    } else {
      ag = (ag * (period - 1) + g) / period;
      al = (al * (period - 1) + l) / period;
      rsi[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
    }
  }
  return rsi;
}

function computeADXandATR(bars, period = 14) {
  const n = bars.length;
  const atr = new Array(n).fill(0);
  const adx = new Array(n).fill(20);
  let trSum = 0, pdmSum = 0, mdmSum = 0;
  const dxArr = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));

    if (i <= period) {
      trSum += tr; pdmSum += pdm; mdmSum += mdm;
      atr[i] = trSum / i;
    } else {
      trSum = trSum - trSum / period + tr;
      pdmSum = pdmSum - pdmSum / period + pdm;
      mdmSum = mdmSum - mdmSum / period + mdm;
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

function runRegimeEnsemble(bars, startIdx, endIdx, opts) {
  const { multiplier = 100, commDollars = 2.99, longBiasOnly = false } = opts;
  const closes = bars.map((b) => b.c);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const trades = [];
  let cum = 0, peak = 0, maxDd = 0;
  let i = Math.max(startIdx, 120);

  while (i < endIdx - 2) {
    const atrPct = atr[i] / bars[i].c;
    if (atrPct > 0.0065) { i++; continue; }

    let mode = null; // 'trend' | 'mr'
    let dir = 0;

    if (adx[i] >= 24) {
      let hi = -Infinity, lo = Infinity;
      for (let k = i - 48; k < i; k++) {
        if (bars[k].h > hi) hi = bars[k].h;
        if (bars[k].l < lo) lo = bars[k].l;
      }
      if (bars[i].c > hi && bars[i].c > ema100[i] && ema30[i] > ema100[i]) { dir = 1; mode = 'trend'; }
      else if (!longBiasOnly && bars[i].c < lo && bars[i].c < ema100[i] && ema30[i] < ema100[i]) { dir = -1; mode = 'trend'; }
    } else if (adx[i] <= 20) {
      if (rsi[i - 1] < 27 && rsi[i] >= 27 && bars[i].c > bars[i].o && (!longBiasOnly || bars[i].c > ema100[i] * 0.97)) {
        dir = 1; mode = 'mr';
      } else if (!longBiasOnly && rsi[i - 1] > 73 && rsi[i] <= 73 && bars[i].c < bars[i].o) {
        dir = -1; mode = 'mr';
      }
    }

    if (dir === 0) { i++; continue; }

    const entry = bars[i + 1].o;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const maxHold = mode === 'trend' ? 140 : 36;
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnl = 0, exitIdx = lastBar, done = false;

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars[j].l <= koPrice) || (dir === -1 && bars[j].h >= koPrice)) {
        pnl = -100; exitIdx = j; done = true; break;
      }
      if (mode === 'mr') {
        const tpMove = (160 + commDollars) / (100 * multiplier); // +1.6R target on mean reversion
        const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);
        if ((dir === 1 && bars[j].h >= tpPrice) || (dir === -1 && bars[j].l <= tpPrice)) {
          pnl = 160; exitIdx = j; done = true; break;
        }
        if (j < lastBar && ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42))) {
          const ex = bars[j + 1].o;
          pnl = Math.max(-100, 100 * multiplier * dir * ((ex - entry) / entry) - commDollars);
          exitIdx = j + 1; done = true; break;
        }
      } else if (j < lastBar) {
        if ((dir === 1 && bars[j].c < ema30[j]) || (dir === -1 && bars[j].c > ema30[j])) {
          const ex = bars[j + 1].o;
          pnl = Math.max(-100, 100 * multiplier * dir * ((ex - entry) / entry) - commDollars);
          exitIdx = j + 1; done = true; break;
        }
      }
    }
    if (!done) {
      const ex = bars[lastBar].c;
      pnl = Math.max(-100, 100 * multiplier * dir * ((ex - entry) / entry) - commDollars);
    }

    trades.push(pnl);
    cum += pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
    i = exitIdx + 1;
  }

  const n = trades.length;
  if (!n) return { n: 0, winRate: 0, netR: 0, pf: 0, maxDdR: 0, tStat: 0 };
  const wins = trades.filter((x) => x > 0), losses = trades.filter((x) => x <= 0);
  const avg = cum / n;
  const std = Math.sqrt(trades.reduce((a, x) => a + (x - avg) ** 2, 0) / n) || 1;
  const gw = wins.reduce((a, b) => a + b, 0), gl = Math.abs(losses.reduce((a, b) => a + b, 0)) || 1e-6;
  return {
    n,
    winRate: Number(((wins.length / n) * 100).toFixed(1)),
    netR: Number((cum / 100).toFixed(2)),
    pf: Number((gw / gl).toFixed(2)),
    maxDdR: Number((maxDd / 100).toFixed(2)),
    tStat: Number(((avg / std) * Math.sqrt(n)).toFixed(2)),
  };
}

const basket = [
  { sym: 'cryBTCUSD', mult: 100, comm: 2.99, longBiasOnly: false },
  { sym: 'cryETHUSD', mult: 100, comm: 7.99, longBiasOnly: false },
  { sym: 'frxXAUUSD', mult: 100, comm: 2.50, longBiasOnly: true },
  { sym: 'OTC_NDX', mult: 100, comm: 2.50, longBiasOnly: true },
];

const res = [];
for (const b of basket) {
  const bars = await fetchCandles(b.sym, 3600, 9);
  const n = bars.length, tEnd = Math.floor(n * 0.6), vEnd = Math.floor(n * 0.8);
  res.push({
    sym: b.sym,
    days: Number(((bars[n - 1].t - bars[0].t) / 86400).toFixed(1)),
    train: runRegimeEnsemble(bars, 120, tEnd, b),
    val: runRegimeEnsemble(bars, tEnd, vEnd, b),
    testOOS: runRegimeEnsemble(bars, vEnd, n, b),
    full: runRegimeEnsemble(bars, 120, n, b),
  });
}
console.log(JSON.stringify(res, null, 2));
ws.close();
process.exit(0);
