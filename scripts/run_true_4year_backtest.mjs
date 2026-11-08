import fs from 'node:fs';
import path from 'node:path';

const CACHE_DIR = '/Users/admin/.gemini/antigravity/brain/cb1dc01c-d1d1-4bef-a70a-190da3914f85/scratch/data_cache';
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetch4YearsBinance(symbol) {
  const cachePath = path.join(CACHE_DIR, `${symbol}_4y_1h.json`);
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached.length > 30000) {
      console.log(`Using cached 4-year data for ${symbol} (${cached.length} bars)`);
      return cached;
    }
  }

  console.log(`Downloading 4-year 1h dataset for ${symbol} (~35,000 bars)...`);
  const bars = [];
  // 4 years ago from 2026-11-08 is 2022-11-08 (1667865600000 ms)
  let startTime = 1667865600000;
  const now = Date.now();

  while (startTime < now) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&startTime=${startTime}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;

      for (const d of data) {
        bars.push({
          time: Math.floor(d[0] / 1000),
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
        });
      }

      const lastBarTime = data[data.length - 1][0];
      startTime = lastBarTime + 3600 * 1000;
      await sleep(150); // Respect Binance rate limits
    } catch (err) {
      console.warn(`Error fetching ${symbol} at ${startTime}: ${err.message}. Retrying in 1s...`);
      await sleep(1000);
    }
  }

  // Deduplicate and sort
  const map = new Map();
  for (const b of bars) map.set(b.time, b);
  const sorted = Array.from(map.values()).sort((a, b) => a.time - b.time);
  fs.writeFileSync(cachePath, JSON.stringify(sorted));
  console.log(`Cached ${sorted.length} bars for ${symbol} (${new Date(sorted[0].time * 1000).toISOString().slice(0, 10)} to ${new Date(sorted[sorted.length - 1].time * 1000).toISOString().slice(0, 10)})`);
  return sorted;
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

function getProfile(symbol) {
  if (symbol.includes('BTC')) {
    return { comm: 2.99, longBiasOnly: false, pureTrendOnly: false, lookback: 48 };
  }
  if (symbol.includes('ETH')) {
    return { comm: 7.99, longBiasOnly: false, pureTrendOnly: false, lookback: 48 };
  }
  return { comm: 2.5, longBiasOnly: true, pureTrendOnly: false, lookback: 48 };
}

function extractTrades(bars, symbol) {
  const profile = getProfile(symbol);
  const multiplier = 100;
  const commDollars = profile.comm;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);
  const lookback = profile.lookback;

  const trades = [];
  let i = 120;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > 0.0065) {
      i++;
      continue;
    }

    let mode = null;
    let dir = 0;
    const trendAdxMin = profile.pureTrendOnly ? 20 : 24;

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
      } else if (
        !profile.longBiasOnly &&
        bars[i].close < lo &&
        bars[i].close < ema100[i] &&
        ema30[i] < ema100[i]
      ) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!profile.pureTrendOnly && adx[i] <= 20) {
      if (
        rsi[i - 1] < 27 &&
        rsi[i] >= 27 &&
        bars[i].close > bars[i].open &&
        (!profile.longBiasOnly || bars[i].close > ema100[i] * 0.97)
      ) {
        dir = 1;
        mode = 'mr';
      } else if (
        !profile.longBiasOnly &&
        rsi[i - 1] > 73 &&
        rsi[i] <= 73 &&
        bars[i].close < bars[i].open
      ) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0 || !mode) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const maxHold = mode === 'trend' ? 140 : 36;
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnl = 0;
    let exitIdx = lastBar;
    let done = false;

    for (let j = i + 1; j <= lastBar; j++) {
      if (
        (dir === 1 && bars[j].low <= koPrice) ||
        (dir === -1 && bars[j].high >= koPrice)
      ) {
        pnl = -100;
        exitIdx = j;
        done = true;
        break;
      }

      if (mode === 'mr') {
        const tpMove = (160 + commDollars) / (100 * multiplier);
        const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);
        if (
          (dir === 1 && bars[j].high >= tpPrice) ||
          (dir === -1 && bars[j].low <= tpPrice)
        ) {
          pnl = 160;
          exitIdx = j;
          done = true;
          break;
        }
        if (j < lastBar && ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42))) {
          const ex = bars[j + 1].open;
          pnl = Math.max(
            -100,
            100 * multiplier * dir * ((ex - entry) / entry) - commDollars,
          );
          exitIdx = j + 1;
          done = true;
          break;
        }
      } else if (j < lastBar) {
        if (
          (dir === 1 && bars[j].close < ema30[j]) ||
          (dir === -1 && bars[j].close > ema30[j])
        ) {
          const ex = bars[j + 1].open;
          pnl = Math.max(
            -100,
            100 * multiplier * dir * ((ex - entry) / entry) - commDollars,
          );
          exitIdx = j + 1;
          done = true;
          break;
        }
      }
    }

    if (!done) {
      const ex = bars[lastBar].close;
      pnl = Math.max(-100, 100 * multiplier * dir * ((ex - entry) / entry) - commDollars);
    }

    trades.push({
      symbol,
      mode,
      dir: dir === 1 ? 'BUY' : 'SELL',
      entryPrice: entry,
      exitPrice: bars[exitIdx].close,
      entryTime,
      exitTime: bars[exitIdx].time,
      r: pnl / 100,
    });
    i = exitIdx + 1;
  }

  return trades;
}

function runMonteCarlo(trades, trials = 2000, startBalance = 1000, riskPct = 0.02) {
  const n = trades.length;
  if (n === 0) return { probDd25Pct: 0, probDd50Pct: 0, probRuin80Pct: 0 };
  let dd25 = 0;
  let dd50 = 0;
  let ruin80 = 0;
  let worstStreak = 0;

  let seed = 42424242;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let s = 0; s < trials; s++) {
    let bal = startBalance;
    let peak = startBalance;
    let maxDd = 0;
    let curStreak = 0;

    for (let k = 0; k < n; k++) {
      const pick = trades[Math.floor(rand() * n)];
      const stake = Math.max(1, bal * riskPct);
      bal = Math.max(0, bal + stake * pick.r);

      if (pick.r <= 0) {
        curStreak++;
        if (curStreak > worstStreak) worstStreak = curStreak;
      } else {
        curStreak = 0;
      }

      if (bal > peak) peak = bal;
      const dd = peak > 0 ? ((peak - bal) / peak) * 100 : 100;
      if (dd > maxDd) maxDd = dd;
      if (bal <= startBalance * 0.2 || maxDd >= 80) {
        maxDd = Math.max(maxDd, 80);
        break;
      }
    }

    if (maxDd >= 25) dd25++;
    if (maxDd >= 50) dd50++;
    if (maxDd >= 80) ruin80++;
  }

  return {
    probDd25Pct: ((dd25 / trials) * 100).toFixed(1),
    probDd50Pct: ((dd50 / trials) * 100).toFixed(1),
    probRuin80Pct: ((ruin80 / trials) * 100).toFixed(1),
    worstStreak,
  };
}

async function main() {
  const btcBars = await fetch4YearsBinance('BTCUSDT');
  const ethBars = await fetch4YearsBinance('ETHUSDT');

  const btcTrades = extractTrades(btcBars, 'BTCUSD');
  const ethTrades = extractTrades(ethBars, 'ETHUSD');
  const allTrades = [...btcTrades, ...ethTrades];

  const firstBar = Math.min(btcBars[120].time, ethBars[120].time);
  const lastBar = Math.max(btcBars[btcBars.length - 1].time, ethBars[ethBars.length - 1].time);

  console.log(`\nExtracted Trades: BTC: ${btcTrades.length} | ETH: ${ethTrades.length} | Total: ${allTrades.length}`);
  console.log(`Date Horizon: ${new Date(firstBar * 1000).toISOString().slice(0, 10)} to ${new Date(lastBar * 1000).toISOString().slice(0, 10)} (4.0 Years)`);

  const events = [];
  allTrades.forEach((t, idx) => {
    events.push({ time: t.entryTime, kind: 'entry', idx });
    events.push({ time: t.exitTime, kind: 'exit', idx });
  });

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.idx === b.idx) return a.kind === 'entry' ? -1 : 1;
    return a.kind === 'exit' ? -1 : 1;
  });

  const monthKey = (sec) => {
    const d = new Date(sec * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const yearKey = (sec) => {
    const d = new Date(sec * 1000);
    return `${d.getUTCFullYear()}`;
  };

  function simulate(riskPct, startBal = 1000) {
    let bal = startBal;
    let peak = startBal;
    let maxDdPct = 0;
    let maxDdDollar = 0;
    let worstGlobalStreak = 0;
    let curGlobalStreak = 0;
    let worstStreakLossDollar = 0;
    let curStreakLossDollar = 0;

    const stakes = new Map();
    const months = new Map();
    const years = new Map();

    const getM = (k) => {
      if (!months.has(k)) {
        months.set(k, {
          opened: 0, closed: 0, wins: 0, losses: 0, netR: 0, pnl: 0,
          startBal: null, endBal: null, worstStreak: 0, curStreak: 0, mPeak: null, mDd: 0,
          bySym: {},
        });
      }
      return months.get(k);
    };

    const getY = (k) => {
      if (!years.has(k)) {
        years.set(k, {
          opened: 0, closed: 0, wins: 0, losses: 0, netR: 0, pnl: 0,
          startBal: null, endBal: null, worstStreak: 0, curStreak: 0, yPeak: null, yDd: 0,
        });
      }
      return years.get(k);
    };

    // Pre-populate calendar
    for (let t = firstBar; t <= lastBar; t += 86400 * 25) {
      getM(monthKey(t));
      getY(yearKey(t));
    }

    for (const ev of events) {
      const t = allTrades[ev.idx];
      const mk = monthKey(ev.time);
      const yk = yearKey(ev.time);
      const m = getM(mk);
      const y = getY(yk);

      if (m.startBal === null) m.startBal = bal;
      if (y.startBal === null) y.startBal = bal;

      if (ev.kind === 'entry') {
        const stake = Math.max(1, bal * riskPct);
        stakes.set(ev.idx, stake);
        m.opened += 1;
        y.opened += 1;
      } else {
        const stake = stakes.get(ev.idx) || Math.max(1, bal * riskPct);
        const pnl = stake * t.r;
        bal = Math.max(0, bal + pnl);

        m.closed += 1;
        m.netR += t.r;
        m.pnl += pnl;
        m.bySym[t.symbol] = (m.bySym[t.symbol] || 0) + 1;

        y.closed += 1;
        y.netR += t.r;
        y.pnl += pnl;

        if (t.r > 0) {
          m.wins += 1;
          y.wins += 1;
          curGlobalStreak = 0;
          curStreakLossDollar = 0;
          m.curStreak = 0;
          y.curStreak = 0;
        } else {
          m.losses += 1;
          y.losses += 1;
          curGlobalStreak += 1;
          curStreakLossDollar += Math.abs(pnl);
          m.curStreak += 1;
          y.curStreak += 1;
          if (curGlobalStreak > worstGlobalStreak) worstGlobalStreak = curGlobalStreak;
          if (curStreakLossDollar > worstStreakLossDollar) worstStreakLossDollar = curStreakLossDollar;
          if (m.curStreak > m.worstStreak) m.worstStreak = m.curStreak;
          if (y.curStreak > y.worstStreak) y.worstStreak = y.curStreak;
        }

        if (m.mPeak === null) m.mPeak = m.startBal;
        if (bal > m.mPeak) m.mPeak = bal;
        m.mDd = Math.max(m.mDd, ((m.mPeak - bal) / m.mPeak) * 100);

        if (y.yPeak === null) y.yPeak = y.startBal;
        if (bal > y.yPeak) y.yPeak = bal;
        y.yDd = Math.max(y.yDd, ((y.yPeak - bal) / y.yPeak) * 100);

        if (bal > peak) peak = bal;
        const curDd = peak > 0 ? ((peak - bal) / peak) * 100 : 0;
        if (curDd > maxDdPct) maxDdPct = curDd;
        if (peak - bal > maxDdDollar) maxDdDollar = peak - bal;
      }
      m.endBal = bal;
      y.endBal = bal;
    }

    return {
      bal,
      peak,
      maxDdPct,
      maxDdDollar,
      worstGlobalStreak,
      worstStreakLossDollar,
      months,
      years,
    };
  }

  const res2Pct = simulate(0.02, 1000);
  const res1Pct = simulate(0.01, 1000);
  const mc2Pct = runMonteCarlo(allTrades, 2000, 1000, 0.02);

  console.log('\n================ 4-YEAR YEAR-BY-YEAR PERFORMANCE @ 2% RISK ($1,000 START) ================');
  console.log('Year | Trades | W-L     | Win%  | Net R    | Start $    | End $      | Year P&L $   | Return %   | Max Intra-Yr DD | Worst Streak');
  const yKeys = Array.from(res2Pct.years.keys()).sort();
  let yCarry = 1000;
  for (const yk of yKeys) {
    const y = res2Pct.years.get(yk);
    const s = y.startBal ?? yCarry;
    const e = y.endBal ?? yCarry;
    yCarry = e;
    const pct = s > 0 ? ((e - s) / s) * 100 : 0;
    const wr = y.closed ? ((y.wins / y.closed) * 100).toFixed(1) + '%' : '—';
    console.log(
      `${yk} | ${String(y.closed).padStart(6)} | ${(y.wins + '-' + y.losses).padEnd(7)} | ${wr.padStart(5)} | ${(y.netR >= 0 ? '+' : '') + y.netR.toFixed(2).padStart(8)} | ${s.toFixed(2).padStart(10)} | ${e.toFixed(2).padStart(10)} | ${((e - s) >= 0 ? '+' : '') + (e - s).toFixed(2).padStart(12)} | ${((pct >= 0 ? '+' : '') + pct.toFixed(1) + '%').padStart(10)} | ${('-' + y.yDd.toFixed(2) + '%').padStart(15)} | ${String(y.worstStreak).padStart(12)}`,
    );
  }

  console.log('\n================ 4-YEAR MONTH-BY-MONTH PERFORMANCE (ALL 48 MONTHS @ 2% RISK) ================');
  console.log('Month   | Trades | W-L   | Win%  | Net R   | Start $   | End $     | Month P&L $ | Month %  | Intra-Mo DD | Streak | Breakdown');
  const mKeys = Array.from(res2Pct.months.keys()).sort();
  let mCarry = 1000;
  let posMonths = 0, negMonths = 0, flatMonths = 0;
  for (const mk of mKeys) {
    const m = res2Pct.months.get(mk);
    const s = m.startBal ?? mCarry;
    const e = m.endBal ?? mCarry;
    mCarry = e;
    const pct = s > 0 ? ((e - s) / s) * 100 : 0;
    if (m.closed === 0) flatMonths++; else if (pct > 0) posMonths++; else negMonths++;
    const wr = m.closed ? ((m.wins / m.closed) * 100).toFixed(0) + '%' : '—';
    const symSummary = Object.entries(m.bySym).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(
      `${mk} | ${String(m.closed).padStart(6)} | ${`${m.wins}-${m.losses}`.padEnd(5)} | ${wr.padStart(5)} | ${(m.netR >= 0 ? '+' : '') + m.netR.toFixed(2).padStart(6)}R | ${s.toFixed(2).padStart(9)} | ${e.toFixed(2).padStart(9)} | ${((e - s) >= 0 ? '+' : '') + (e - s).toFixed(2).padStart(11)} | ${((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%').padStart(8)} | ${('-' + m.mDd.toFixed(2) + '%').padStart(11)} | ${String(m.worstStreak).padStart(6)} | ${symSummary}`,
    );
  }

  console.log('\n================ 4-YEAR EXECUTIVE METRICS ================');
  console.log(`Duration: 4 Full Years (${new Date(firstBar * 1000).toISOString().slice(0, 10)} to ${new Date(lastBar * 1000).toISOString().slice(0, 10)})`);
  console.log(`Total Trades: ${allTrades.length} (~${(allTrades.length / 48).toFixed(1)} trades/month)`);
  console.log(`Win Rate: ${((allTrades.filter(t => t.r > 0).length / allTrades.length) * 100).toFixed(1)}%`);
  console.log(`Net R: +${allTrades.reduce((acc, t) => acc + t.r, 0).toFixed(2)}R`);
  console.log(`Profitable Months: ${posMonths} / ${posMonths + negMonths} (${((posMonths / (posMonths + negMonths)) * 100).toFixed(1)}%)`);
  console.log(`Losing Months: ${negMonths} (${((negMonths / (posMonths + negMonths)) * 100).toFixed(1)}%)`);

  console.log(`\n--- COMPOUNDING AT 2% RISK ($1,000 START) ---`);
  console.log(`Final Account Balance: $${res2Pct.bal.toFixed(2)}`);
  console.log(`Total 4-Year Return: +${(((res2Pct.bal - 1000) / 1000) * 100).toFixed(1)}% (CAGR ~${(Math.pow(res2Pct.bal / 1000, 1 / 4) * 100 - 100).toFixed(1)}%/yr)`);
  console.log(`Max Peak-to-Trough Drawdown: -${res2Pct.maxDdPct.toFixed(2)}% (-$${res2Pct.maxDdDollar.toFixed(2)})`);
  console.log(`Worst Losing Streak: ${res2Pct.worstGlobalStreak} consecutive losses`);
  console.log(`Worst Losing Streak Drawdown: -$${res2Pct.worstStreakLossDollar.toFixed(2)} (-${((1 - Math.pow(0.98, res2Pct.worstGlobalStreak)) * 100).toFixed(1)}% of balance)`);
  console.log(`Monte Carlo 2,000 Shuffles (2% Risk):`);
  console.log(`  Prob of >= 25% Drawdown: ${mc2Pct.probDd25Pct}%`);
  console.log(`  Prob of >= 50% Drawdown: ${mc2Pct.probDd50Pct}%`);
  console.log(`  Prob of Ruin (>= 80% loss): ${mc2Pct.probRuin80Pct}%`);

  console.log(`\n--- COMPARISON AT 1% RISK ($1,000 START) ---`);
  console.log(`Final Account Balance: $${res1Pct.bal.toFixed(2)} (+${(((res1Pct.bal - 1000) / 1000) * 100).toFixed(1)}%)`);
  console.log(`Max Peak-to-Trough Drawdown: -${res1Pct.maxDdPct.toFixed(2)}%`);
}

main().catch(console.error);
