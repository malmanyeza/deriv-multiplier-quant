import fs from 'node:fs';
import path from 'node:path';
import {
  computeADXandATR,
  computeEMA,
  computeRSI,
  getSymbolStrategyProfile,
} from '../src/services/quantStrategyEngine.ts';
import type { CandlePoint } from '../src/services/chartFeed.ts';

const CACHE_DIR =
  '/Users/admin/.gemini/antigravity/brain/501f9276-302b-4acf-baa0-10bff49b8dbe/scratch/data_cache';

function loadDeriv1Y(sym: string, gran: number): CandlePoint[] {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `deriv_1y_${sym}_${gran}.json`), 'utf8'));
}

interface SimTrade {
  symbol: string;
  timeframe: '1h' | '15m';
  entryTime: number;
  exitTime: number;
  pnlR: number;
}

function simulateLiveSymbol(
  symbol: string,
  timeframe: '1h' | '15m',
  bars: CandlePoint[],
  evalStart: number,
  commFracOverride?: number,
): SimTrade[] {
  if (bars.length < 225) return [];
  const profile = getSymbolStrategyProfile(symbol);
  const is15m = timeframe === '15m';
  const M = is15m ? profile.recommendedMultiplier15m : profile.recommendedMultiplier1h;
  const commFrac = commFracOverride ?? profile.commissionPer100Stake / 100;
  const lookback = is15m ? 32 : profile.donchianLookback;
  const atrCutoff = is15m ? 0.015 : profile.atrCutoff1h;
  const trendAdxMin = is15m ? 28 : profile.trendAdxMin1h;
  const mrTpMult = is15m || symbol.startsWith('frx') ? 1.2 : 1.6;
  const trendTpMult = is15m ? profile.trendTpMult15m : profile.trendTpMult1h;
  const ratchetStages = is15m ? profile.ratchetStages15m : profile.ratchetStages1h;

  const closes = bars.map((b) => b.close);
  const emaMacro = profile.macroEmaPeriod > 0 ? computeEMA(closes, profile.macroEmaPeriod) : null;
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const emaTrail =
    profile.trailEmaPeriod === 30 ? ema30 : computeEMA(closes, profile.trailEmaPeriod);
  const ema26 = computeEMA(closes, 26);
  const ema12 = computeEMA(closes, 12);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const trades: SimTrade[] = [];
  let i = 210;
  while (i < bars.length - 2) {
    const bar = bars[i];
    const barTime = Number(bar.time);
    if (barTime < evalStart) {
      i++;
      continue;
    }

    if ((bar.close > 0 ? atr[i] / bar.close : 1) > atrCutoff) {
      i++;
      continue;
    }

    if (!is15m && profile.sessionFilterLondonNy) {
      const hr = new Date(barTime * 1000).getUTCHours();
      if (hr < 6 || hr > 18) {
        i++;
        continue;
      }
    }

    if (is15m && adx[i] >= trendAdxMin) {
      let chopCount = 0;
      for (let k = 0; k < 16 && i - k >= 0; k++) {
        if (adx[i - k] < 19) chopCount++;
      }
      if (chopCount >= 12) {
        i++;
        continue;
      }
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - lookback; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }

    const macroLongOk =
      !emaMacro || (bar.close > emaMacro[i] && (!is15m ? ema100[i] > emaMacro[i] : true));
    const macroShortOk =
      !emaMacro || (bar.close < emaMacro[i] && (!is15m ? ema100[i] < emaMacro[i] : true));

    let dir: 1 | -1 | 0 = 0;
    let mode: 'trend' | 'mr' = 'trend';

    if (adx[i] >= trendAdxMin) {
      const lOk =
        macroLongOk &&
        (is15m
          ? bar.close > hi && ema12[i] > ema26[i] && ema26[i] > ema100[i]
          : bar.close > hi && bar.close > ema100[i] && ema30[i] > ema100[i]);
      const sOk =
        !profile.longBiasOnly &&
        macroShortOk &&
        (is15m
          ? bar.close < lo && ema12[i] < ema26[i] && ema26[i] < ema100[i]
          : bar.close < lo && bar.close < ema100[i] && ema30[i] < ema100[i]);
      if (lOk) {
        dir = 1;
        mode = 'trend';
      } else if (sOk) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!profile.pureTrendOnly && adx[i] <= 20) {
      const prevRsi = rsi[i - 1] ?? rsi[i];
      if (bar.close > ema100[i] && prevRsi < 32 && rsi[i] >= 32) {
        dir = 1;
        mode = 'mr';
      } else if (!profile.longBiasOnly && bar.close < ema100[i] && prevRsi > 68 && rsi[i] <= 68) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const entryPrice = bars[i + 1].open;
    const entryTime = Number(bars[i + 1].time);
    const activeTp = mode === 'mr' ? mrTpMult : trendTpMult;
    const maxHold = mode === 'mr' ? (is15m ? 32 : 24) : is15m ? 96 : 72;

    let exitIdx = i + 1;
    let pnlR = 0;
    let peakR = 0;

    for (let j = i + 1; j < Math.min(bars.length, i + 1 + maxHold); j++) {
      exitIdx = j;
      const b = bars[j];
      const favMove =
        dir === 1 ? (b.high - entryPrice) / entryPrice : (entryPrice - b.low) / entryPrice;
      const advMove =
        dir === 1 ? (entryPrice - b.low) / entryPrice : (b.high - entryPrice) / entryPrice;
      const closeMove =
        dir === 1 ? (b.close - entryPrice) / entryPrice : (entryPrice - b.close) / entryPrice;

      if (advMove * M - commFrac >= 1.0) {
        pnlR = -1.0;
        break;
      }
      const barPeakR = favMove * M - commFrac;
      if (activeTp !== null && barPeakR >= activeTp) {
        pnlR = activeTp;
        break;
      }
      if (mode === 'trend' && ratchetStages.length > 0) {
        let activeFloor: number | null = null;
        for (const [trig, flr] of ratchetStages) {
          if (peakR >= trig) activeFloor = flr;
        }
        if (activeFloor !== null && -(advMove * M) - commFrac <= activeFloor) {
          pnlR = activeFloor;
          break;
        }
      }
      if (barPeakR > peakR) peakR = barPeakR;

      const curCloseR = closeMove * M - commFrac;
      if (mode === 'mr') {
        if ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42)) {
          pnlR = Math.max(-1.0, curCloseR);
          break;
        }
      } else {
        if ((dir === 1 && b.close < emaTrail[j]) || (dir === -1 && b.close > emaTrail[j])) {
          pnlR = Math.max(-1.0, curCloseR);
          break;
        }
      }
      if (j === Math.min(bars.length, i + 1 + maxHold) - 1) {
        pnlR = Math.max(-1.0, curCloseR);
      }
    }

    trades.push({ symbol, timeframe, entryTime, exitTime: Number(bars[exitIdx].time), pnlR });
    i = exitIdx + 1;
  }
  return trades;
}

function runPortfolio(trades: SimTrade[], initialEq = 1000, maxOpen = 8, baseRisk = 0.03) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let equity = initialEq;
  let peak = initialEq;
  let maxDd = 0;
  let taken = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;
  const months = new Map<
    string,
    { startEq: number; endEq: number; trades: number; wins: number; netR: number }
  >();
  const active: Array<SimTrade & { stake: number }> = [];

  const close = (c: SimTrade & { stake: number }) => {
    const eqBefore = equity;
    equity += c.stake * c.pnlR;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
    if (c.pnlR > 0) {
      wins++;
      gw += c.pnlR;
    } else {
      gl += Math.abs(c.pnlR);
    }
    const mk = new Date(c.exitTime * 1000).toISOString().slice(0, 7);
    const m = months.get(mk) ?? { startEq: eqBefore, endEq: eqBefore, trades: 0, wins: 0, netR: 0 };
    m.endEq = equity;
    m.trades++;
    if (c.pnlR > 0) m.wins++;
    m.netR += c.pnlR;
    months.set(mk, m);
  };

  for (const t of sorted) {
    const toC = active
      .filter((a) => a.exitTime <= t.entryTime)
      .sort((a, b) => a.exitTime - b.exitTime);
    for (const c of toC) {
      active.splice(active.indexOf(c), 1);
      close(c);
    }
    if (active.some((a) => a.symbol === t.symbol) || active.length >= maxOpen) continue;
    const prof = getSymbolStrategyProfile(t.symbol);
    const risk = Math.min(0.05, baseRisk * prof.convictionWeight);
    active.push({ ...t, stake: Math.max(1, Number((equity * risk).toFixed(2))) });
    taken++;
  }
  for (const c of active.sort((a, b) => a.exitTime - b.exitTime)) close(c);

  const monthRows = Array.from(months.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, d]) => ({
      month,
      trades: d.trades,
      wr: d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) : '0',
      netR: d.netR,
      retPct: ((d.endEq - d.startEq) / d.startEq) * 100,
      endEq: d.endEq,
    }));
  const fullMonths = monthRows.slice(1, -1);
  const avgMo = fullMonths.reduce((s, m) => s + m.retPct, 0) / Math.max(1, fullMonths.length);
  const sortedPcts = [...fullMonths.map((m) => m.retPct)].sort((a, b) => a - b);
  const medMo = sortedPcts[Math.floor(sortedPcts.length / 2)] ?? 0;

  return {
    taken,
    wr: taken > 0 ? (wins / taken) * 100 : 0,
    pf: gl > 0 ? gw / gl : 0,
    netR: gw - gl,
    finalEq: equity,
    maxDd,
    avgMo,
    medMo,
    posFullMonths: fullMonths.filter((m) => m.retPct > 0).length,
    fullMonthsCount: fullMonths.length,
    monthRows,
  };
}

function main() {
  const basket: Array<{ sym: string; tf: '1h' | '15m'; gran: number; comm: number }> = [
    { sym: '1HZ100V', tf: '15m', gran: 900, comm: 0.0205 },
    { sym: 'R_75', tf: '15m', gran: 900, comm: 0.0227 },
    { sym: 'cryBTCUSD', tf: '1h', gran: 3600, comm: 0.0387 },
    { sym: 'cryETHUSD', tf: '1h', gran: 3600, comm: 0.0883 },
    { sym: 'frxXAUUSD', tf: '1h', gran: 3600, comm: 0.048 },
    { sym: 'frxXAGUSD', tf: '1h', gran: 3600, comm: 0.048 },
    { sym: 'frxUSDCHF', tf: '1h', gran: 3600, comm: 0.025 },
    { sym: 'frxUSDJPY', tf: '1h', gran: 3600, comm: 0.025 },
    { sym: 'frxGBPJPY', tf: '1h', gran: 3600, comm: 0.025 },
    { sym: 'frxAUDJPY', tf: '1h', gran: 3600, comm: 0.025 },
    { sym: 'frxEURUSD', tf: '1h', gran: 3600, comm: 0.025 },
    { sym: 'frxGBPUSD', tf: '1h', gran: 3600, comm: 0.025 },
    { sym: 'frxGBPAUD', tf: '1h', gran: 3600, comm: 0.025 },
  ];

  const evalStart = Number(loadDeriv1Y('1HZ100V', 900).at(-1)!.time) - 365 * 86400;
  const allTrades: SimTrade[] = [];

  console.log('=== 1-YEAR PER-SYMBOL PERFORMANCE: LIVE WF-13 QUANT (DERIV CANDLES) ===');
  for (const b of basket) {
    const tr = simulateLiveSymbol(b.sym, b.tf, loadDeriv1Y(b.sym, b.gran), evalStart, b.comm);
    allTrades.push(...tr);
    const w = tr.filter((t) => t.pnlR > 0);
    const gw = w.reduce((s, t) => s + t.pnlR, 0);
    const gl = Math.abs(tr.filter((t) => t.pnlR <= 0).reduce((s, t) => s + t.pnlR, 0));
    const prof = getSymbolStrategyProfile(b.sym);
    const m = b.tf === '15m' ? prof.recommendedMultiplier15m : prof.recommendedMultiplier1h;
    console.log(
      `  • ${b.sym.padEnd(10)} (${b.tf.toUpperCase()} ${String(m).padStart(3)}x) | Trades=${String(tr.length).padStart(3)} | WR=${((w.length / Math.max(1, tr.length)) * 100).toFixed(1).padStart(5)}% | PF=${(gl > 0 ? gw / gl : 0).toFixed(2)} | NetR=${gw - gl >= 0 ? '+' : ''}${(gw - gl).toFixed(2)}R`,
    );
  }

  console.log('\n=== 1-YEAR PORTFOLIO SUMMARY: LIVE WF-13 (13 SYMBOLS, 8 OPEN SLOTS, $1,000 START) ===');
  for (const [lbl, r] of [
    ['Live 3.0% Base Risk', 0.03],
    ['Balanced 2.0% Base Risk', 0.02],
    ['Conservative 1.5% Base Risk', 0.015],
  ] as const) {
    const pf = runPortfolio(allTrades, 1000, 8, r);
    console.log(
      `  ${lbl.padEnd(28)} -> Trades=${pf.taken} | WR=${pf.wr.toFixed(1)}% | PF=${pf.pf.toFixed(2)} | NetR=+${pf.netR.toFixed(2)}R | AvgMo=+${pf.avgMo.toFixed(2)}% | MedMo=+${pf.medMo.toFixed(2)}% | ProfMonths=${pf.posFullMonths}/${pf.fullMonthsCount} | $1,000 -> $${pf.finalEq.toLocaleString('en-US', { maximumFractionDigits: 2 })} | MaxDD=-${pf.maxDd.toFixed(2)}%`,
    );
  }

  const pf3 = runPortfolio(allTrades, 1000, 8, 0.03);
  console.log('\n=== MONTH-BY-MONTH ($1,000 START @ LIVE 3.0% BASE RISK) ===');
  for (const m of pf3.monthRows) {
    console.log(
      `  ${m.month} | ${String(m.trades).padStart(3)}t | WR=${m.wr.padStart(3)}% | NetR=${m.netR >= 0 ? '+' : ''}${m.netR.toFixed(2).padStart(6)}R | ${m.retPct >= 0 ? '+' : ''}${m.retPct.toFixed(2).padStart(7)}% | End=$${m.endEq.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
  }
}

main();
