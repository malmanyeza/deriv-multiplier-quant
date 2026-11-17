import fs from 'node:fs';
import path from 'node:path';
import {
  computeADXandATR,
  computeEMA,
  computeRSI,
} from '../src/services/quantStrategyEngine.ts';
import type { CandlePoint } from '../src/services/chartFeed.ts';

const CACHE_DIR =
  '/Users/admin/.gemini/antigravity/brain/501f9276-302b-4acf-baa0-10bff49b8dbe/scratch/data_cache';

interface SimTrade {
  symbol: string;
  engine: '1h' | '15m';
  mode: 'trend' | 'mr';
  direction: 'rise' | 'fall';
  entryTime: number;
  exitTime: number;
  pnlR: number;
  adxAtEntry: number;
  exitReason: string;
}

function loadCached(sym: string, gran: number): CandlePoint[] {
  const file = path.join(CACHE_DIR, `deriv_1y_${sym}_${gran}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Unified 1-Year Simulator:
 * - When `upgraded = false`: reproduces exact current live `evaluateQuantSignal` behavior
 *   (no profit-ratchet, no 15M trend TP, EMA(30) exit on all symbols, 0.65% ATR gate on all 1H symbols, 1H MR enabled on BTC/ETH).
 * - When `upgraded = true`:
 *   1. Two-Stage Profit-Ratchet:
 *      - 15M (`1HZ100V`, `R_75`): +0.75R peak locks +0.20R floor; +1.20R peak locks +0.60R floor; +2.0R Asymmetric Take-Profit target.
 *      - 1H (`cryBTCUSD`, `cryETHUSD`, `frxXAGUSD`): +0.80R peak locks +0.20R floor.
 *   2. Calibrated Trend Runner EMAs & Macro Filters:
 *      - `R_75 15M`: wider `EMA(50)` trend trail so normal synthetic volatility pullbacks don't close winning trends early.
 *      - `1HZ100V 15M` & `cryBTCUSD 1H`: `EMA(200)` macro trend alignment filter.
 *      - `1H` symbols (`cryBTCUSD`, `cryETHUSD`, `frxXAUUSD`, `frxXAGUSD`): pure-trend mode (eliminates 0% WR 1H counter-trend MR trades),
 *        `36`-bar breakout on `cryBTCUSD 1H` (`EMA(50)` trail), `0.75%` ATR gate on `cryETHUSD 1H` (`EMA(50)` trail), `EMA(50)` trail on `frxXAUUSD 1H`, `EMA(20)` trail on `frxXAGUSD 1H`.
 */
function simulateSymbol(params: {
  symbol: string;
  bars: CandlePoint[];
  timeframe: '1h' | '15m';
  M: number;
  commFrac: number;
  evalStartEpoch: number;
  upgraded: boolean;
}): SimTrade[] {
  const { symbol, bars, timeframe, M, commFrac, evalStartEpoch, upgraded } = params;
  if (bars.length < 225) return [];

  const is15m = timeframe === '15m';

  const lookback = !upgraded
    ? is15m
      ? 32
      : symbol === 'frxXAUUSD'
        ? 72
        : 48
    : is15m
      ? 32
      : symbol === 'cryBTCUSD'
        ? 36
        : symbol === 'frxXAUUSD'
          ? 72
          : 48;

  const atrCutoff = !upgraded
    ? is15m
      ? 0.015
      : 0.0065
    : is15m
      ? 0.015
      : symbol === 'cryETHUSD'
        ? 0.0075
        : 0.0065;

  const pureTrend = !upgraded ? symbol === 'frxXAUUSD' : !is15m;
  const longOnly = symbol === 'frxXAUUSD';
  const trendAdxMin = is15m ? 28 : symbol === 'frxXAUUSD' ? 20 : 24;

  const macroEmaPeriod = !upgraded
    ? 0
    : symbol === 'cryBTCUSD' || symbol === '1HZ100V'
      ? 200
      : 0;

  const trailEmaPeriod = !upgraded
    ? 30
    : symbol === 'frxXAGUSD'
      ? 20
      : symbol === '1HZ100V'
        ? 30
        : 50;

  const tpR = !upgraded ? null : is15m ? 2.0 : null;

  const ratchet: Array<[number, number]> = !upgraded
    ? []
    : is15m
      ? [
          [0.75, 0.2],
          [1.2, 0.6],
        ]
      : symbol === 'cryBTCUSD' || symbol === 'cryETHUSD' || symbol === 'frxXAGUSD'
        ? [[0.8, 0.2]]
        : [];

  const closes = bars.map((b) => b.close);
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const ema30 = computeEMA(closes, 30);
  const emaTrail = computeEMA(closes, trailEmaPeriod);
  const ema100 = computeEMA(closes, 100);
  const emaMacro = macroEmaPeriod ? computeEMA(closes, macroEmaPeriod) : null;
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const trades: SimTrade[] = [];
  let i = 220;
  while (i < bars.length - 2) {
    if (Number(bars[i].time) < evalStartEpoch) {
      i++;
      continue;
    }
    const b = bars[i];
    const atrPct = b.close > 0 ? atr[i] / b.close : 0;
    if (atrPct > atrCutoff) {
      i++;
      continue;
    }

    let chopCount = 0;
    if (is15m) {
      for (let k = 0; k < 16 && i - k >= 0; k++) {
        if (adx[i - k] < 19) chopCount++;
      }
    }
    if (is15m && chopCount >= 12) {
      i++;
      continue;
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - lookback; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }

    let dir: 1 | -1 | 0 = 0;
    let mode: 'trend' | 'mr' = 'trend';
    let curTpR: number | null = tpR;

    const macroLongOk =
      !emaMacro || (b.close > emaMacro[i] && (!is15m ? ema100[i] > emaMacro[i] : true));
    const macroShortOk =
      !emaMacro || (b.close < emaMacro[i] && (!is15m ? ema100[i] < emaMacro[i] : true));

    if (adx[i] >= trendAdxMin) {
      const longOk = is15m
        ? b.close > hi && ema12[i] > ema26[i] && ema26[i] > ema100[i] && macroLongOk
        : b.close > hi && b.close > ema100[i] && ema30[i] > ema100[i] && macroLongOk;
      const shortOk =
        !longOnly &&
        (is15m
          ? b.close < lo && ema12[i] < ema26[i] && ema26[i] < ema100[i] && macroShortOk
          : b.close < lo && b.close < ema100[i] && ema30[i] < ema100[i] && macroShortOk);
      if (longOk) {
        dir = 1;
        mode = 'trend';
      } else if (shortOk) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!pureTrend && adx[i] <= 20) {
      const prevRsi = rsi[i - 1] ?? rsi[i];
      if (prevRsi < 27 && rsi[i] >= 27 && b.close > b.open) {
        dir = 1;
        mode = 'mr';
        curTpR = is15m ? 1.2 : 1.6;
      } else if (!longOnly && prevRsi > 73 && rsi[i] <= 73 && b.close < b.open) {
        dir = -1;
        mode = 'mr';
        curTpR = is15m ? 1.2 : 1.6;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = Number(bars[i + 1].time);
    const getPriceForR = (rTarget: number) => {
      const movePct = (rTarget + commFrac) / M;
      return dir === 1 ? entry * (1 + movePct) : entry * (1 - movePct);
    };
    const koPrice = getPriceForR(-1.0);
    let activeStopR = -1.0;
    let activeStopPrice = koPrice;
    const tpPrice = curTpR !== null ? getPriceForR(curTpR) : null;

    let exitIdx = bars.length - 1;
    let pnlR = Math.max(-1, M * dir * ((bars[exitIdx].close - entry) / entry) - commFrac);
    let exitReason = 'END';

    for (let j = i + 1; j < bars.length - 1; j++) {
      const bj = bars[j];
      if ((dir === 1 && bj.low <= koPrice) || (dir === -1 && bj.high >= koPrice)) {
        exitIdx = j;
        pnlR = -1.0;
        exitReason = 'KO';
        break;
      }
      if (
        (dir === 1 && bj.low <= activeStopPrice) ||
        (dir === -1 && bj.high >= activeStopPrice)
      ) {
        exitIdx = j;
        pnlR = activeStopR;
        exitReason = activeStopR > 0 ? 'RATCHET' : 'KO';
        break;
      }
      if (
        tpPrice !== null &&
        curTpR !== null &&
        ((dir === 1 && bj.high >= tpPrice) || (dir === -1 && bj.low <= tpPrice))
      ) {
        exitIdx = j;
        pnlR = curTpR;
        exitReason = 'TP';
        break;
      }

      if (ratchet.length > 0) {
        const favMove = dir === 1 ? (bj.high - entry) / entry : (entry - bj.low) / entry;
        const favR = M * favMove - commFrac;
        for (const [trig, lock] of ratchet) {
          if (favR >= trig && activeStopR < lock) {
            activeStopR = lock;
            activeStopPrice = getPriceForR(lock);
          }
        }
      }

      if (mode === 'mr') {
        if ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42)) {
          exitIdx = j + 1;
          pnlR = Math.max(-1, M * dir * ((bars[j + 1].open - entry) / entry) - commFrac);
          exitReason = 'MR_RSI';
          break;
        }
      } else {
        if ((dir === 1 && bj.close < emaTrail[j]) || (dir === -1 && bj.close > emaTrail[j])) {
          exitIdx = j + 1;
          pnlR = Math.max(-1, M * dir * ((bars[j + 1].open - entry) / entry) - commFrac);
          exitReason = 'TRAIL';
          break;
        }
      }
    }

    trades.push({
      symbol,
      engine: timeframe,
      mode,
      direction: dir === 1 ? 'rise' : 'fall',
      entryTime,
      exitTime: Number(bars[exitIdx].time),
      pnlR,
      adxAtEntry: adx[i],
      exitReason,
    });
    i = exitIdx + 1;
  }
  return trades;
}

function simulatePortfolioMonthly(
  trades: SimTrade[],
  opts: {
    initialEquity?: number;
    baseRisk?: number;
    convictionSizing?: boolean;
    maxOpen?: number;
    useThrottle?: boolean;
  } = {},
) {
  const {
    initialEquity = 1000,
    baseRisk = 0.03,
    convictionSizing = false,
    maxOpen = 3,
    useThrottle = true,
  } = opts;

  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const symbolStreaks = new Map<string, number>();
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDdPct = 0;
  let taken = 0;
  let wins = 0;
  let grossWinR = 0;
  let grossLossR = 0;

  const months = new Map<
    string,
    { startEq: number; endEq: number; trades: number; wins: number; netR: number }
  >();

  const active: Array<SimTrade & { stake: number }> = [];
  const closeTrade = (c: SimTrade & { stake: number }) => {
    const eqBefore = equity;
    const pnlUsd = c.stake * c.pnlR;
    equity += pnlUsd;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;

    if (c.pnlR > 0) {
      wins++;
      grossWinR += c.pnlR;
      symbolStreaks.set(c.symbol, 0);
    } else {
      grossLossR += Math.abs(c.pnlR);
      symbolStreaks.set(c.symbol, (symbolStreaks.get(c.symbol) ?? 0) + 1);
    }

    const mk = new Date(c.exitTime * 1000).toISOString().slice(0, 7);
    const m = months.get(mk) ?? {
      startEq: eqBefore,
      endEq: eqBefore,
      trades: 0,
      wins: 0,
      netR: 0,
    };
    m.endEq = equity;
    m.trades++;
    if (c.pnlR > 0) m.wins++;
    m.netR += c.pnlR;
    months.set(mk, m);
  };

  for (const t of sorted) {
    const toClose = active
      .filter((a) => a.exitTime <= t.entryTime)
      .sort((a, b) => a.exitTime - b.exitTime);
    for (const c of toClose) {
      const idx = active.indexOf(c);
      if (idx >= 0) active.splice(idx, 1);
      closeTrade(c);
    }

    if (active.some((a) => a.symbol === t.symbol) || active.length >= maxOpen) {
      continue;
    }

    let risk = baseRisk;
    if (convictionSizing) {
      if (t.symbol === 'cryBTCUSD' || t.symbol === 'R_75' || t.symbol === '1HZ100V') {
        risk = 0.038; // 3.8% on primary high-PF trend drivers
      } else {
        risk = 0.028; // 2.8% on secondary macro diversifiers
      }
    }

    const streak = symbolStreaks.get(t.symbol) ?? 0;
    if (useThrottle && streak >= 2) {
      risk *= 0.5;
    }

    const stake = Math.max(1, Number((equity * risk).toFixed(2)));
    active.push({ ...t, stake });
    taken++;
  }

  for (const c of active.sort((a, b) => a.exitTime - b.exitTime)) {
    closeTrade(c);
  }

  const monthRows = Array.from(months.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({
      month,
      trades: d.trades,
      winRate: d.trades > 0 ? Number(((d.wins / d.trades) * 100).toFixed(1)) : 0,
      netR: Number(d.netR.toFixed(2)),
      retPct: Number((((d.endEq - d.startEq) / d.startEq) * 100).toFixed(2)),
      endEq: Number(d.endEq.toFixed(2)),
    }));

  const fullMonths = monthRows.slice(1, -1);
  const avgMoPct =
    fullMonths.reduce((s, m) => s + m.retPct, 0) / Math.max(1, fullMonths.length);
  const sortedPcts = [...fullMonths.map((m) => m.retPct)].sort((a, b) => a - b);
  const medianMoPct = sortedPcts[Math.floor(sortedPcts.length / 2)] ?? 0;
  const months20Plus = fullMonths.filter((m) => m.retPct >= 20).length;
  const posFullMonths = fullMonths.filter((m) => m.retPct > 0).length;

  return {
    finalEquity: Number(equity.toFixed(2)),
    totalRetPct: Number((((equity - initialEquity) / initialEquity) * 100).toFixed(2)),
    maxDdPct: Number(maxDdPct.toFixed(2)),
    taken,
    winRate: taken > 0 ? Number(((wins / taken) * 100).toFixed(1)) : 0,
    pf: grossLossR > 0 ? Number((grossWinR / grossLossR).toFixed(2)) : 0,
    netR: Number((grossWinR - grossLossR).toFixed(2)),
    avgMoPct: Number(avgMoPct.toFixed(2)),
    medianMoPct: Number(medianMoPct.toFixed(2)),
    months20Plus,
    posFullMonths,
    fullMonthsCount: fullMonths.length,
    monthRows,
  };
}

function main() {
  const btc1h = loadCached('cryBTCUSD', 3600);
  const eth1h = loadCached('cryETHUSD', 3600);
  const xau1h = loadCached('frxXAUUSD', 3600);
  const xag1h = loadCached('frxXAGUSD', 3600);
  const v100_15m = loadCached('1HZ100V', 900);
  const r75_15m = loadCached('R_75', 900);

  const nowSec = Number(btc1h.at(-1)?.time ?? Math.floor(Date.now() / 1000));
  const evalStart = nowSec - 365 * 86400;

  const base5Trades = [
    ...simulateSymbol({ symbol: 'cryBTCUSD', bars: btc1h, timeframe: '1h', M: 100, commFrac: 0.0387, evalStartEpoch: evalStart, upgraded: false }),
    ...simulateSymbol({ symbol: 'cryETHUSD', bars: eth1h, timeframe: '1h', M: 100, commFrac: 0.0883, evalStartEpoch: evalStart, upgraded: false }),
    ...simulateSymbol({ symbol: 'frxXAUUSD', bars: xau1h, timeframe: '1h', M: 100, commFrac: 0.0480, evalStartEpoch: evalStart, upgraded: false }),
    ...simulateSymbol({ symbol: '1HZ100V', bars: v100_15m, timeframe: '15m', M: 40, commFrac: 0.0205, evalStartEpoch: evalStart, upgraded: false }),
    ...simulateSymbol({ symbol: 'R_75', bars: r75_15m, timeframe: '15m', M: 50, commFrac: 0.0227, evalStartEpoch: evalStart, upgraded: false }),
  ];

  const upg5Trades = [
    ...simulateSymbol({ symbol: 'cryBTCUSD', bars: btc1h, timeframe: '1h', M: 100, commFrac: 0.0387, evalStartEpoch: evalStart, upgraded: true }),
    ...simulateSymbol({ symbol: 'cryETHUSD', bars: eth1h, timeframe: '1h', M: 100, commFrac: 0.0883, evalStartEpoch: evalStart, upgraded: true }),
    ...simulateSymbol({ symbol: 'frxXAUUSD', bars: xau1h, timeframe: '1h', M: 100, commFrac: 0.0480, evalStartEpoch: evalStart, upgraded: true }),
    ...simulateSymbol({ symbol: '1HZ100V', bars: v100_15m, timeframe: '15m', M: 40, commFrac: 0.0205, evalStartEpoch: evalStart, upgraded: true }),
    ...simulateSymbol({ symbol: 'R_75', bars: r75_15m, timeframe: '15m', M: 50, commFrac: 0.0227, evalStartEpoch: evalStart, upgraded: true }),
  ];

  const upg6Trades = [
    ...upg5Trades,
    ...simulateSymbol({ symbol: 'frxXAGUSD', bars: xag1h, timeframe: '1h', M: 100, commFrac: 0.0480, evalStartEpoch: evalStart, upgraded: true }),
  ];

  const m0 = simulatePortfolioMonthly(base5Trades, { baseRisk: 0.03, maxOpen: 3, useThrottle: true });
  const m1 = simulatePortfolioMonthly(upg5Trades, { baseRisk: 0.03, maxOpen: 3, useThrottle: true });
  const m2 = simulatePortfolioMonthly(upg6Trades, { baseRisk: 0.03, maxOpen: 4, useThrottle: false });
  const m3 = simulatePortfolioMonthly(upg6Trades, {
    baseRisk: 0.03,
    convictionSizing: true,
    maxOpen: 4,
    useThrottle: false,
  });

  console.log('\n================ 1-YEAR BENCHMARK: CURRENT LIVE BOT VS UPGRADED 20%+/MO ENGINE ================');
  for (const [label, res] of [
    ['0. Current Live Bot (Baseline @ 3.0% Risk, 3 Slots)', m0],
    ['1. + Two-Stage Profit-Ratchet & Trail EMA Calibration (Same 5 Symbols @ 3.0%)', m1],
    ['2. + Silver (frxXAGUSD 1H) & 4-Slot Un-Throttled Portfolio (@ 3.0%)', m2],
    ['3. Full Combo (+ Conviction Sizing 2.8%–3.8% across 6 Symbols)', m3],
  ] as const) {
    console.log(
      `\n${label}\n  • Trades: ${res.taken} | Win Rate: ${res.winRate}% | PF: ${res.pf} | Net R: +${res.netR}R\n  • $1,000 -> $${res.finalEquity.toLocaleString()} (+${res.totalRetPct}%) | MaxDD: -${res.maxDdPct}%\n  • Avg Full-Month Return: +${res.avgMoPct}%/mo | Median: +${res.medianMoPct}%/mo | Months >= +20%: ${res.months20Plus}/${res.fullMonthsCount} | Profitable Months: ${res.posFullMonths}/${res.fullMonthsCount}`,
    );
  }

  console.log('\n================ MONTH-BY-MONTH COMPARISON ($1,000 START) ================');
  console.log('Month   | Baseline Live (Trades / % / Bal)       | Upgraded Combo #3 (Trades / WR / NetR / % / Bal)');
  const m0Map = new Map(m0.monthRows.map((r) => [r.month, r]));
  for (const r3 of m3.monthRows) {
    const r0 = m0Map.get(r3.month);
    const bStr = r0
      ? `${String(r0.trades).padStart(2)}t | ${(r0.retPct >= 0 ? '+' : '') + r0.retPct.toFixed(1) + '%'}`.padEnd(14) +
        ` | $${r0.endEq.toFixed(0).padStart(6)}`
      : '—';
    const uStr = `${String(r3.trades).padStart(2)}t | ${r3.winRate.toFixed(0).padStart(2)}% | ${(r3.netR >= 0 ? '+' : '') + r3.netR.toFixed(2).padStart(6)}R | ${((r3.retPct >= 0 ? '+' : '') + r3.retPct.toFixed(1) + '%').padStart(7)} | $${r3.endEq.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    console.log(`${r3.month} | ${bStr.padEnd(38)} | ${uStr}`);
  }
}

main();
