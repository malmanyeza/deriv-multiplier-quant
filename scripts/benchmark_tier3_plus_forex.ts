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

function loadCached(sym: string, gran: number): CandlePoint[] {
  const file = path.join(CACHE_DIR, `deriv_1y_${sym}_${gran}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

interface SimTrade {
  symbol: string;
  engine: '1h' | '15m';
  mode: 'trend' | 'mr';
  direction: 'rise' | 'fall';
  entryTime: number;
  exitTime: number;
  pnlR: number;
  exitReason: string;
}

interface SymbolConfig {
  symbol: string;
  timeframe: '1h' | '15m';
  M: number;
  commFrac: number;
  lookback: number;
  trendAdxMin: number;
  atrCutoff: number;
  trailEmaPeriod: number;
  useMacro200: boolean;
  pureTrend: boolean;
  longOnly: boolean;
  tpR: number | null;
  ratchet: Array<[number, number]>;
  sessionFilter: boolean;
  convictionRisk: number;
}

function simulateWithConfig(
  bars: CandlePoint[],
  cfg: SymbolConfig,
  evalStartEpoch: number,
): SimTrade[] {
  if (bars.length < 225) return [];
  const is15m = cfg.timeframe === '15m';

  const closes = bars.map((b) => b.close);
  const ema12 = computeEMA(closes, 12);
  const ema20 = computeEMA(closes, 20);
  const ema26 = computeEMA(closes, 26);
  const ema30 = computeEMA(closes, 30);
  const ema50 = computeEMA(closes, 50);
  const ema100 = computeEMA(closes, 100);
  const ema200 = computeEMA(closes, 200);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const emaTrail =
    cfg.trailEmaPeriod === 20 ? ema20 : cfg.trailEmaPeriod === 30 ? ema30 : ema50;

  const trades: SimTrade[] = [];
  let i = 220;
  while (i < bars.length - 2) {
    const tSec = Number(bars[i].time);
    if (tSec < evalStartEpoch) {
      i++;
      continue;
    }

    if (cfg.sessionFilter) {
      const hr = new Date(tSec * 1000).getUTCHours();
      if (hr < 6 || hr > 18) {
        i++;
        continue;
      }
    }

    const b = bars[i];
    const atrPct = b.close > 0 ? atr[i] / b.close : 0;
    if (atrPct > cfg.atrCutoff) {
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
    for (let k = i - cfg.lookback; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }

    let dir: 1 | -1 | 0 = 0;
    let mode: 'trend' | 'mr' = 'trend';
    let curTpR: number | null = cfg.tpR;

    const macroLongOk =
      !cfg.useMacro200 || (b.close > ema200[i] && (!is15m ? ema100[i] > ema200[i] : true));
    const macroShortOk =
      !cfg.useMacro200 || (b.close < ema200[i] && (!is15m ? ema100[i] < ema200[i] : true));

    if (adx[i] >= cfg.trendAdxMin) {
      const longOk = is15m
        ? b.close > hi && ema12[i] > ema26[i] && ema26[i] > ema100[i] && macroLongOk
        : b.close > hi && b.close > ema100[i] && ema30[i] > ema100[i] && macroLongOk;
      const shortOk =
        !cfg.longOnly &&
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
    } else if (!cfg.pureTrend && adx[i] <= 20) {
      const prevRsi = rsi[i - 1] ?? rsi[i];
      if (prevRsi < 27 && rsi[i] >= 27 && b.close > b.open) {
        dir = 1;
        mode = 'mr';
        curTpR = 1.2;
      } else if (!cfg.longOnly && prevRsi > 73 && rsi[i] <= 73 && b.close < b.open) {
        dir = -1;
        mode = 'mr';
        curTpR = 1.2;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = Number(bars[i + 1].time);
    const M = cfg.M;
    const commFrac = cfg.commFrac;
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

      if (cfg.ratchet.length > 0) {
        const favMove = dir === 1 ? (bj.high - entry) / entry : (entry - bj.low) / entry;
        const favR = M * favMove - commFrac;
        for (const [trig, lock] of cfg.ratchet) {
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
      symbol: cfg.symbol,
      engine: cfg.timeframe,
      mode,
      direction: dir === 1 ? 'rise' : 'fall',
      entryTime,
      exitTime: Number(bars[exitIdx].time),
      pnlR,
      exitReason,
    });
    i = exitIdx + 1;
  }
  return trades;
}

function simulatePortfolio(
  trades: SimTrade[],
  riskBySymbol: Map<string, number>,
  opts: {
    initialEquity?: number;
    maxOpen?: number;
    flatRiskOverride?: number | null;
  } = {},
) {
  const { initialEquity = 1000, maxOpen = 5, flatRiskOverride = null } = opts;
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);

  let equity = initialEquity;
  let peak = initialEquity;
  let maxDdPct = 0;
  let taken = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;

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
      gw += c.pnlR;
    } else {
      gl += Math.abs(c.pnlR);
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

    const risk = flatRiskOverride ?? riskBySymbol.get(t.symbol) ?? 0.03;
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
  const posFullMonths = fullMonths.filter((m) => m.retPct > 0).length;
  const months20Plus = fullMonths.filter((m) => m.retPct >= 20).length;

  return {
    finalEquity: Number(equity.toFixed(2)),
    totalRetPct: Number((((equity - initialEquity) / initialEquity) * 100).toFixed(2)),
    maxDdPct: Number(maxDdPct.toFixed(2)),
    taken,
    winRate: taken > 0 ? Number(((wins / taken) * 100).toFixed(1)) : 0,
    pf: gl > 0 ? Number((gw / gl).toFixed(2)) : 0,
    netR: Number((gw - gl).toFixed(2)),
    avgMoPct: Number(avgMoPct.toFixed(2)),
    medianMoPct: Number(medianMoPct.toFixed(2)),
    posFullMonths,
    months20Plus,
    fullMonthsCount: fullMonths.length,
    monthRows,
  };
}

function main() {
  const nowSec = Number(loadCached('cryBTCUSD', 3600).at(-1)?.time ?? Math.floor(Date.now() / 1000));
  const evalStart = nowSec - 365 * 86400;

  // 1. Existing Tier 3 Core 6-Symbol Configs
  const tier3Configs: SymbolConfig[] = [
    { symbol: 'cryBTCUSD', timeframe: '1h', M: 100, commFrac: 0.0387, lookback: 36, trendAdxMin: 24, atrCutoff: 0.0065, trailEmaPeriod: 50, useMacro200: true, pureTrend: true, longOnly: false, tpR: null, ratchet: [[0.8, 0.2]], sessionFilter: false, convictionRisk: 0.038 },
    { symbol: 'cryETHUSD', timeframe: '1h', M: 100, commFrac: 0.0883, lookback: 48, trendAdxMin: 24, atrCutoff: 0.0075, trailEmaPeriod: 50, useMacro200: false, pureTrend: true, longOnly: false, tpR: null, ratchet: [[0.8, 0.2]], sessionFilter: false, convictionRisk: 0.028 },
    { symbol: 'frxXAUUSD', timeframe: '1h', M: 100, commFrac: 0.0480, lookback: 72, trendAdxMin: 20, atrCutoff: 0.0065, trailEmaPeriod: 50, useMacro200: false, pureTrend: true, longOnly: true, tpR: null, ratchet: [], sessionFilter: false, convictionRisk: 0.028 },
    { symbol: 'frxXAGUSD', timeframe: '1h', M: 100, commFrac: 0.0480, lookback: 48, trendAdxMin: 24, atrCutoff: 0.0065, trailEmaPeriod: 20, useMacro200: false, pureTrend: true, longOnly: false, tpR: null, ratchet: [[0.8, 0.2]], sessionFilter: false, convictionRisk: 0.028 },
    { symbol: '1HZ100V', timeframe: '15m', M: 40, commFrac: 0.0205, lookback: 32, trendAdxMin: 28, atrCutoff: 0.015, trailEmaPeriod: 30, useMacro200: true, pureTrend: false, longOnly: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]], sessionFilter: false, convictionRisk: 0.038 },
    { symbol: 'R_75', timeframe: '15m', M: 50, commFrac: 0.0227, lookback: 32, trendAdxMin: 28, atrCutoff: 0.015, trailEmaPeriod: 50, useMacro200: false, pureTrend: false, longOnly: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]], sessionFilter: false, convictionRisk: 0.038 },
  ];

  // 2. Top Calibrated Forex Currency Pairs (from optimize_forex_only_1year.ts)
  const fxConfigs: SymbolConfig[] = [
    { symbol: 'frxUSDJPY', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 72, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: false, pureTrend: true, longOnly: false, tpR: null, ratchet: [], sessionFilter: false, convictionRisk: 0.035 },
    { symbol: 'frxAUDJPY', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 72, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: false, pureTrend: true, longOnly: false, tpR: null, ratchet: [[0.8, 0.2]], sessionFilter: true, convictionRisk: 0.035 },
    { symbol: 'frxEURUSD', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 72, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: true, pureTrend: true, longOnly: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]], sessionFilter: true, convictionRisk: 0.032 },
    { symbol: 'frxUSDCAD', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 24, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: false, pureTrend: true, longOnly: false, tpR: null, ratchet: [[0.8, 0.2]], sessionFilter: false, convictionRisk: 0.030 },
    { symbol: 'frxGBPJPY', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 72, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: false, pureTrend: true, longOnly: false, tpR: null, ratchet: [[0.8, 0.2]], sessionFilter: true, convictionRisk: 0.032 },
    { symbol: 'frxUSDCHF', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 48, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: true, pureTrend: true, longOnly: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]], sessionFilter: false, convictionRisk: 0.032 },
    { symbol: 'frxAUDUSD', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 72, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 30, useMacro200: true, pureTrend: true, longOnly: false, tpR: null, ratchet: [], sessionFilter: true, convictionRisk: 0.028 },
    { symbol: 'frxGBPUSD', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 72, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 20, useMacro200: true, pureTrend: false, longOnly: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]], sessionFilter: false, convictionRisk: 0.028 },
    { symbol: 'frxGBPAUD', timeframe: '1h', M: 300, commFrac: 0.025, lookback: 24, trendAdxMin: 22, atrCutoff: 0.0045, trailEmaPeriod: 50, useMacro200: true, pureTrend: true, longOnly: false, tpR: null, ratchet: [], sessionFilter: true, convictionRisk: 0.028 },
  ];

  const riskMap = new Map<string, number>();
  for (const c of [...tier3Configs, ...fxConfigs]) {
    riskMap.set(c.symbol, c.convictionRisk);
  }

  const simAll = (cfgs: SymbolConfig[]) =>
    cfgs.flatMap((c) => {
      const gran = c.timeframe === '15m' ? 900 : 3600;
      const bars = loadCached(c.symbol, gran);
      return simulateWithConfig(bars, c, evalStart);
    });

  const tTier3 = simAll(tier3Configs);
  const tFxTop4 = simAll(fxConfigs.slice(0, 4)); // USDJPY, AUDJPY, EURUSD, USDCAD
  const tFxTop6 = simAll(fxConfigs.slice(0, 6)); // + GBPJPY, USDCHF
  const tFxAll9 = simAll(fxConfigs);

  // Also test upgrading XAUUSD (200x, M200=Y) & XAGUSD (300x, LB=24, EMA50) inside the Super-Portfolio
  const tier3UpgradedMetals: SymbolConfig[] = tier3Configs.map((c) => {
    if (c.symbol === 'frxXAUUSD') return { ...c, M: 200, useMacro200: true, convictionRisk: 0.038 };
    if (c.symbol === 'frxXAGUSD') return { ...c, M: 300, lookback: 24, trailEmaPeriod: 50, ratchet: [], convictionRisk: 0.035 };
    return c;
  });
  for (const c of tier3UpgradedMetals) riskMap.set(c.symbol, c.convictionRisk);
  const tTier3UpgMetals = simAll(tier3UpgradedMetals);

  const pTier3Only = simulatePortfolio(tTier3, riskMap, { maxOpen: 4 });
  const pCombo10 = simulatePortfolio([...tTier3, ...tFxTop4], riskMap, { maxOpen: 5 });
  const pCombo12 = simulatePortfolio([...tTier3, ...tFxTop6], riskMap, { maxOpen: 6 });
  const pCombo15 = simulatePortfolio([...tTier3, ...tFxAll9], riskMap, { maxOpen: 6 });
  const pSuper15 = simulatePortfolio([...tTier3UpgMetals, ...tFxAll9], riskMap, { maxOpen: 6 });
  const pSuper15Safe = simulatePortfolio([...tTier3UpgMetals, ...tFxAll9], riskMap, {
    maxOpen: 6,
    flatRiskOverride: 0.025,
  });

  console.log('\n================ TIER 3 + FOREX SUPER-PORTFOLIO 1-YEAR BENCHMARK ($1,000 START) ================');
  for (const [label, res] of [
    ['A. Current Tier 3 Alone (6 Symbols: BTC, ETH, XAU, XAG, V100, R75 | 4 Slots)', pTier3Only],
    ['B. Tier 3 + Top 4 Forex Pairs (10 Symbols: + USDJPY, AUDJPY, EURUSD, USDCAD | 5 Slots)', pCombo10],
    ['C. Tier 3 + Top 6 Forex Pairs (12 Symbols: + GBPJPY, USDCHF | 6 Slots)', pCombo12],
    ['D. Tier 3 + All 9 Winning Forex Pairs (15 Symbols Total | 6 Slots, Conviction Risk)', pCombo15],
    ['E. Tier 4 "Super-Portfolio" (15 Symbols + 200x Gold / 300x Silver | 6 Slots, Conviction Risk)', pSuper15],
    ['F. Tier 4 "Low-DD Edition" (Same 15 Symbols @ Conservative 2.5% Flat Risk | 6 Slots)', pSuper15Safe],
  ] as const) {
    console.log(
      `\n${label}\n` +
        `  • Trades: ${res.taken} | Win Rate: ${res.winRate}% | PF: ${res.pf} | Net R: +${res.netR}R\n` +
        `  • $1,000 -> $${res.finalEquity.toLocaleString()} (+${res.totalRetPct}%) | MaxDD: -${res.maxDdPct}%\n` +
        `  • Avg Full-Month: +${res.avgMoPct}%/mo | Median Month: +${res.medianMoPct}%/mo | Months >= +20%: ${res.months20Plus}/${res.fullMonthsCount} | Profitable Full Months: ${res.posFullMonths}/${res.fullMonthsCount}`,
    );
  }

  console.log('\n================ MONTH-BY-MONTH COMPARISON ($1,000 START) ================');
  console.log('Month   | A. Tier 3 Alone (6 Sym)               | D. Tier 3 + 9 FX Pairs (15 Sym)        | E. Tier 4 Super-Portfolio (15 Sym)');
  const mapA = new Map(pTier3Only.monthRows.map((r) => [r.month, r]));
  const mapD = new Map(pCombo15.monthRows.map((r) => [r.month, r]));
  for (const rE of pSuper15.monthRows) {
    const rA = mapA.get(rE.month);
    const rD = mapD.get(rE.month);
    const sA = rA
      ? `${String(rA.trades).padStart(3)}t | ${(rA.retPct >= 0 ? '+' : '') + rA.retPct.toFixed(1).padStart(5)}% | $${rA.endEq.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(8)}`
      : '—';
    const sD = rD
      ? `${String(rD.trades).padStart(3)}t | ${(rD.retPct >= 0 ? '+' : '') + rD.retPct.toFixed(1).padStart(5)}% | $${rD.endEq.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(9)}`
      : '—';
    const sE = `${String(rE.trades).padStart(3)}t | ${rE.winRate.toFixed(0).padStart(2)}% | ${(rE.netR >= 0 ? '+' : '') + rE.netR.toFixed(1).padStart(5)}R | ${(rE.retPct >= 0 ? '+' : '') + rE.retPct.toFixed(1).padStart(6)}% | $${rE.endEq.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(9)}`;
    console.log(`${rE.month} | ${sA.padEnd(37)} | ${sD.padEnd(38)} | ${sE}`);
  }
}

main();
