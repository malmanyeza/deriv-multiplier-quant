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

function isGoldFxTradingHour(epochSec: number): boolean {
  const d = new Date(epochSec * 1000);
  const day = d.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = d.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 23) return false;
  if (day === 5 && hour >= 21) return false;
  if (hour === 22) return false;
  return true;
}

function loadBinance5Y(binanceSymbol: string, fxHoursOnly = false): CandlePoint[] {
  const file = path.join(
    CACHE_DIR,
    `binance_${binanceSymbol}_1h_1635768131_1794434531.json`,
  );
  if (!fs.existsSync(file)) {
    throw new Error(`Missing 5Y cache file: ${file}`);
  }
  const raw: CandlePoint[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  return fxHoursOnly ? raw.filter((b) => isGoldFxTradingHour(Number(b.time))) : raw;
}

function loadDeriv1Y(sym: string, gran: number): CandlePoint[] {
  const file = path.join(CACHE_DIR, `deriv_1y_${sym}_${gran}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function simulateSymbol(params: {
  symbol: string;
  bars: CandlePoint[];
  timeframe: '1h' | '15m';
  M: number;
  commFrac: number;
  evalStartEpoch: number;
  evalEndEpoch?: number;
  upgraded: boolean;
}): SimTrade[] {
  const {
    symbol,
    bars,
    timeframe,
    M,
    commFrac,
    evalStartEpoch,
    evalEndEpoch = Infinity,
    upgraded,
  } = params;
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
    const tSec = Number(bars[i].time);
    if (tSec < evalStartEpoch) {
      i++;
      continue;
    }
    if (tSec > evalEndEpoch) break;

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

function summarizeSymbolTrades(trades: SimTrade[], years = 5) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0);
  const losses = trades.filter((t) => t.pnlR <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const netR = grossWin - grossLoss;
  const pf = grossLoss > 0 ? grossWin / grossLoss : 0;
  const ratchets = trades.filter((t) => t.exitReason === 'RATCHET').length;
  const trails = trades.filter((t) => t.exitReason === 'TRAIL').length;
  const kos = trades.filter((t) => t.exitReason === 'KO').length;
  const tps = trades.filter((t) => t.exitReason === 'TP').length;

  return {
    n,
    perMo: Number((n / (years * 12)).toFixed(1)),
    winRate: n > 0 ? Number(((wins.length / n) * 100).toFixed(1)) : 0,
    pf: Number(pf.toFixed(2)),
    netR: Number(netR.toFixed(2)),
    avgWinR: wins.length > 0 ? Number((grossWin / wins.length).toFixed(2)) : 0,
    avgLossR: losses.length > 0 ? Number((grossLoss / losses.length).toFixed(2)) : 0,
    ratchets,
    trails,
    kos,
    tps,
  };
}

function simulatePortfolio(
  trades: SimTrade[],
  opts: {
    initialEquity?: number;
    baseRisk?: number;
    convictionSizing?: boolean;
    maxOpen?: number;
    useThrottle?: boolean;
    yearsSpan?: number;
  } = {},
) {
  const {
    initialEquity = 1000,
    baseRisk = 0.03,
    convictionSizing = false,
    maxOpen = 4,
    useThrottle = false,
    yearsSpan = 5,
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

  const settled: Array<SimTrade & { stake: number; pnlUsd: number; equityAfter: number }> = [];
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

    settled.push({ ...c, pnlUsd, equityAfter: equity });
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
        risk = baseRisk * (3.8 / 3.0);
      } else {
        risk = baseRisk * (2.8 / 3.0);
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
  const posMonths = monthRows.filter((m) => m.retPct > 0).length;
  const posNetRMonths = monthRows.filter((m) => m.netR > 0).length;
  const cagrPct =
    yearsSpan > 0 && equity > 0
      ? (Math.pow(equity / initialEquity, 1 / yearsSpan) - 1) * 100
      : 0;

  return {
    initialEquity,
    finalEquity: Number(equity.toFixed(2)),
    totalRetPct: Number((((equity - initialEquity) / initialEquity) * 100).toFixed(2)),
    cagrPct: Number(cagrPct.toFixed(2)),
    maxDdPct: Number(maxDdPct.toFixed(2)),
    taken,
    winRate: taken > 0 ? Number(((wins / taken) * 100).toFixed(1)) : 0,
    pf: grossLossR > 0 ? Number((grossWinR / grossLossR).toFixed(2)) : 0,
    netR: Number((grossWinR - grossLossR).toFixed(2)),
    avgMoPct: Number(avgMoPct.toFixed(2)),
    posMonths,
    posNetRMonths,
    totalMonths: monthRows.length,
    settled,
    monthRows,
  };
}

function buildRollingYearBreakdown(
  settled: Array<SimTrade & { stake: number; pnlUsd: number; equityAfter: number }>,
  evalStartEpoch: number,
  evalEndEpoch: number,
  initialEquity = 1000,
) {
  const yearSec = 365.25 * 86400;
  let prevEq = initialEquity;
  const rows = [];
  for (let y = 0; y < 5; y++) {
    const a = evalStartEpoch + y * yearSec;
    const b = y === 4 ? evalEndEpoch + 86400 * 5 : evalStartEpoch + (y + 1) * yearSec;
    const slice = settled.filter((t) => t.exitTime >= a && t.exitTime < b);
    const startLabel = new Date(a * 1000).toISOString().slice(0, 10);
    const endLabel = new Date((b - 1) * 1000).toISOString().slice(0, 10);
    const startEq = prevEq;
    let peak = startEq;
    let maxDd = 0;
    for (const t of slice) {
      if (t.equityAfter > peak) peak = t.equityAfter;
      const dd = peak > 0 ? ((peak - t.equityAfter) / peak) * 100 : 0;
      if (dd > maxDd) maxDd = dd;
    }
    const endEq = slice.length > 0 ? slice[slice.length - 1].equityAfter : startEq;
    prevEq = endEq;
    const wins = slice.filter((t) => t.pnlR > 0);
    const losses = slice.filter((t) => t.pnlR <= 0);
    const gw = wins.reduce((s, t) => s + t.pnlR, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
    const netR = gw - gl;
    const pf = gl > 0 ? gw / gl : 0;
    rows.push({
      yearNum: y + 1,
      label: `Year ${y + 1} (${startLabel} -> ${endLabel})`,
      trades: slice.length,
      winRate: slice.length > 0 ? Number(((wins.length / slice.length) * 100).toFixed(1)) : 0,
      pf: Number(pf.toFixed(2)),
      netR: Number(netR.toFixed(2)),
      startEq: Number(startEq.toFixed(2)),
      endEq: Number(endEq.toFixed(2)),
      retPct: Number((((endEq - startEq) / startEq) * 100).toFixed(1)),
      maxDdPct: Number(maxDd.toFixed(2)),
    });
  }
  return rows;
}

function main() {
  // Load 5-Year 1H datasets (2021-11-01 -> 2026-11-11)
  const btc5y = loadBinance5Y('BTCUSDT', false);
  const eth5y = loadBinance5Y('ETHUSDT', false);
  const xau5y = loadBinance5Y('PAXGUSDT', true);

  // Load 1-Year Deriv native datasets (2025-11-14 -> 2026-11-14, the max retention of Deriv ticks_history)
  const xag1y = loadDeriv1Y('frxXAGUSD', 3600);
  const v100_1y = loadDeriv1Y('1HZ100V', 900);
  const r75_1y = loadDeriv1Y('R_75', 900);

  const end5ySec = Number(btc5y.at(-1)!.time);
  const eval5yStart = end5ySec - 1826 * 86400; // 5 full years (1,826 days)
  const eval1yStart = Number(v100_1y.at(-1)!.time) - 365 * 86400;

  console.log('====================================================================================');
  console.log('         5-YEAR QUANT ENGINE BACKTEST (2021-11-11 -> 2026-11-14 | 1,826 DAYS)       ');
  console.log('====================================================================================');

  // 1. 5-Year 1H Macro Core (BTC, ETH, Gold across all 5 years: 2021-11 -> 2026-11)
  const baseMacro5y = [
    ...simulateSymbol({ symbol: 'cryBTCUSD', bars: btc5y, timeframe: '1h', M: 100, commFrac: 0.0387, evalStartEpoch: eval5yStart, upgraded: false }),
    ...simulateSymbol({ symbol: 'cryETHUSD', bars: eth5y, timeframe: '1h', M: 100, commFrac: 0.0883, evalStartEpoch: eval5yStart, upgraded: false }),
    ...simulateSymbol({ symbol: 'frxXAUUSD', bars: xau5y, timeframe: '1h', M: 100, commFrac: 0.0480, evalStartEpoch: eval5yStart, upgraded: false }),
  ];

  const tier3Btc5y = simulateSymbol({ symbol: 'cryBTCUSD', bars: btc5y, timeframe: '1h', M: 100, commFrac: 0.0387, evalStartEpoch: eval5yStart, upgraded: true });
  const tier3Eth5y = simulateSymbol({ symbol: 'cryETHUSD', bars: eth5y, timeframe: '1h', M: 100, commFrac: 0.0883, evalStartEpoch: eval5yStart, upgraded: true });
  const tier3Xau5y = simulateSymbol({ symbol: 'frxXAUUSD', bars: xau5y, timeframe: '1h', M: 100, commFrac: 0.0480, evalStartEpoch: eval5yStart, upgraded: true });
  const tier3Macro5y = [...tier3Btc5y, ...tier3Eth5y, ...tier3Xau5y];

  // 2. Deriv 1Y datasets for Silver (frxXAGUSD 1H) and Synthetics (1HZ100V 15M, R_75 15M)
  const tier3Xag1y = simulateSymbol({ symbol: 'frxXAGUSD', bars: xag1y, timeframe: '1h', M: 100, commFrac: 0.0480, evalStartEpoch: eval1yStart, upgraded: true });
  const tier3V100_1y = simulateSymbol({ symbol: '1HZ100V', bars: v100_1y, timeframe: '15m', M: 40, commFrac: 0.0205, evalStartEpoch: eval1yStart, upgraded: true });
  const tier3R75_1y = simulateSymbol({ symbol: 'R_75', bars: r75_1y, timeframe: '15m', M: 50, commFrac: 0.0227, evalStartEpoch: eval1yStart, upgraded: true });

  const baseV100_1y = simulateSymbol({ symbol: '1HZ100V', bars: v100_1y, timeframe: '15m', M: 40, commFrac: 0.0205, evalStartEpoch: eval1yStart, upgraded: false });
  const baseR75_1y = simulateSymbol({ symbol: 'R_75', bars: r75_1y, timeframe: '15m', M: 50, commFrac: 0.0227, evalStartEpoch: eval1yStart, upgraded: false });

  console.log('\n--- SECTION 1: 5-YEAR PER-SYMBOL PERFORMANCE (2021-11 -> 2026-11, TIER 3 ENGINE) ---');
  for (const [label, tr, yrs] of [
    ['cryBTCUSD (1H, 5 Years)', tier3Btc5y, 5],
    ['cryETHUSD (1H, 5 Years)', tier3Eth5y, 5],
    ['frxXAUUSD (1H, 5 Years)', tier3Xau5y, 5],
    ['frxXAGUSD (1H, 1Y Deriv Archive)', tier3Xag1y, 1],
    ['1HZ100V   (15M, 1Y Deriv Archive)', tier3V100_1y, 1],
    ['R_75      (15M, 1Y Deriv Archive)', tier3R75_1y, 1],
  ] as const) {
    const s = summarizeSymbolTrades(tr, yrs);
    console.log(
      `  • ${label.padEnd(33)} | Trades: ${String(s.n).padStart(4)} (${String(s.perMo).padStart(4)}/mo) | WR: ${String(s.winRate).padStart(5)}% | PF: ${s.pf.toFixed(2)} | Net R: +${s.netR.toFixed(2).padStart(6)}R | Exits: Ratchet=${s.ratchets}, Trail=${s.trails}, TP=${s.tps}, KO=${s.kos}`,
    );
  }

  // Compare 5-Year 1H Macro Only: Old Baseline vs Tier 3
  const pfBaseMacro5y = simulatePortfolio(baseMacro5y, {
    initialEquity: 1000,
    baseRisk: 0.03,
    convictionSizing: false,
    maxOpen: 3,
    useThrottle: true,
    yearsSpan: 5,
  });
  const pfTier3Macro5y = simulatePortfolio(tier3Macro5y, {
    initialEquity: 1000,
    baseRisk: 0.03,
    convictionSizing: true,
    maxOpen: 4,
    useThrottle: false,
    yearsSpan: 5,
  });

  // Combined 5-Year Un-Extrapolated Portfolio (5Y 1H Macro + 1Y Deriv Synthetics & Silver where available)
  const baseCombined5yTrades = [...baseMacro5y, ...baseV100_1y, ...baseR75_1y];
  const tier3Combined5yTrades = [
    ...tier3Macro5y,
    ...tier3Xag1y,
    ...tier3V100_1y,
    ...tier3R75_1y,
  ];

  const pfBaseCombined5y = simulatePortfolio(baseCombined5yTrades, {
    initialEquity: 1000,
    baseRisk: 0.03,
    convictionSizing: false,
    maxOpen: 3,
    useThrottle: true,
    yearsSpan: 5,
  });
  const pfTier3Combined5y = simulatePortfolio(tier3Combined5yTrades, {
    initialEquity: 1000,
    baseRisk: 0.03,
    convictionSizing: true,
    maxOpen: 4,
    useThrottle: false,
    yearsSpan: 5,
  });

  console.log('\n--- SECTION 2: 5-YEAR 1H MACRO CORE COMPARISON (2021-11 -> 2026-11, BTC + ETH + GOLD ONLY) ---');
  console.log(
    `  0. Old Baseline (1H Macro 5Y): Trades=${pfBaseMacro5y.taken} | WR=${pfBaseMacro5y.winRate}% | PF=${pfBaseMacro5y.pf} | NetR=+${pfBaseMacro5y.netR}R | $1,000 -> $${pfBaseMacro5y.finalEquity.toLocaleString()} (+${pfBaseMacro5y.totalRetPct}% | CAGR +${pfBaseMacro5y.cagrPct}%/yr) | MaxDD=-${pfBaseMacro5y.maxDdPct}% | PosMos=${pfBaseMacro5y.posMonths}/${pfBaseMacro5y.totalMonths}`,
  );
  console.log(
    `  3. Tier 3 Engine (1H Macro 5Y): Trades=${pfTier3Macro5y.taken} | WR=${pfTier3Macro5y.winRate}% | PF=${pfTier3Macro5y.pf} | NetR=+${pfTier3Macro5y.netR}R | $1,000 -> $${pfTier3Macro5y.finalEquity.toLocaleString()} (+${pfTier3Macro5y.totalRetPct}% | CAGR +${pfTier3Macro5y.cagrPct}%/yr) | MaxDD=-${pfTier3Macro5y.maxDdPct}% | PosMos=${pfTier3Macro5y.posMonths}/${pfTier3Macro5y.totalMonths}`,
  );

  console.log('\n--- SECTION 3: 5-YEAR YEAR-BY-YEAR BREAKDOWN — 1H MACRO CORE ($1,000 START) ---');
  const yrsBaseMacro = buildRollingYearBreakdown(pfBaseMacro5y.settled, eval5yStart, end5ySec, 1000);
  const yrsTier3Macro = buildRollingYearBreakdown(pfTier3Macro5y.settled, eval5yStart, end5ySec, 1000);
  for (let i = 0; i < 5; i++) {
    const b = yrsBaseMacro[i];
    const u = yrsTier3Macro[i];
    console.log(
      `  ${u.label}: [Old: ${b.trades}t, WR ${b.winRate}%, Net ${b.netR >= 0 ? '+' : ''}${b.netR}R, ${b.retPct >= 0 ? '+' : ''}${b.retPct}% -> $${b.endEq.toLocaleString()}]  ==>  [Tier 3: ${u.trades}t, WR ${u.winRate}%, PF ${u.pf}, Net ${u.netR >= 0 ? '+' : ''}${u.netR}R, ${u.retPct >= 0 ? '+' : ''}${u.retPct}% ($${u.startEq.toLocaleString()} -> $${u.endEq.toLocaleString()}), MaxDD -${u.maxDdPct}%]`,
    );
  }

  console.log('\n--- SECTION 4: 5-YEAR COMBINED PORTFOLIO (5Y 1H MACRO + 1Y DERIV ARCHIVE FOR 15M SYNTHETICS & SILVER) ---');
  console.log(
    `  0. Old Baseline Combined: Trades=${pfBaseCombined5y.taken} | WR=${pfBaseCombined5y.winRate}% | PF=${pfBaseCombined5y.pf} | NetR=+${pfBaseCombined5y.netR}R | $1,000 -> $${pfBaseCombined5y.finalEquity.toLocaleString()} (+${pfBaseCombined5y.totalRetPct}% | CAGR +${pfBaseCombined5y.cagrPct}%/yr) | MaxDD=-${pfBaseCombined5y.maxDdPct}%`,
  );
  console.log(
    `  3. Tier 3 Combined:       Trades=${pfTier3Combined5y.taken} | WR=${pfTier3Combined5y.winRate}% | PF=${pfTier3Combined5y.pf} | NetR=+${pfTier3Combined5y.netR}R | $1,000 -> $${pfTier3Combined5y.finalEquity.toLocaleString()} (+${pfTier3Combined5y.totalRetPct}% | CAGR +${pfTier3Combined5y.cagrPct}%/yr) | MaxDD=-${pfTier3Combined5y.maxDdPct}%`,
  );

  const yrsTier3Comb = buildRollingYearBreakdown(
    pfTier3Combined5y.settled,
    eval5yStart,
    Number(v100_1y.at(-1)!.time),
    1000,
  );
  console.log('\n  Year-by-Year (Tier 3 Combined — Y1..Y4: 1H Macro Only; Y5: Full 6-Symbol Dual Basket):');
  for (const u of yrsTier3Comb) {
    console.log(
      `    • ${u.label}: Trades=${u.trades} | WR=${u.winRate}% | PF=${u.pf} | NetR=${u.netR >= 0 ? '+' : ''}${u.netR}R | $${u.startEq.toLocaleString()} -> $${u.endEq.toLocaleString()} (${u.retPct >= 0 ? '+' : ''}${u.retPct}%) | MaxDD=-${u.maxDdPct}%`,
    );
  }
}

main();
