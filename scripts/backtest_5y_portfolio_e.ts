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

function isGoldFxTradingHour(epochSec: number): boolean {
  const d = new Date(epochSec * 1000);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return false;
  if (day === 0 && hour < 23) return false;
  if (day === 5 && hour >= 21) return false;
  if (hour === 22) return false;
  return true;
}

function loadBinance5Y(binanceSymbol: string, fxHoursOnly = false): CandlePoint[] {
  const file = path.join(CACHE_DIR, `binance_${binanceSymbol}_1h_1635768131_1794434531.json`);
  const raw: CandlePoint[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  return fxHoursOnly ? raw.filter((b) => isGoldFxTradingHour(Number(b.time))) : raw;
}

function loadYahoo28M(sym: string): CandlePoint[] {
  const file = path.join(CACHE_DIR, `yahoo_28m_${sym}_3600.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadDeriv1Y(sym: string, gran: number): CandlePoint[] {
  const file = path.join(CACHE_DIR, `deriv_1y_${sym}_${gran}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

interface SimTrade {
  symbol: string;
  timeframe: '1h' | '15m';
  mode: 'trend' | 'mr';
  direction: 'rise' | 'fall';
  entryTime: number;
  exitTime: number;
  pnlR: number;
  exitReason: string;
}

function simulateLivePortfolioESymbol(
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

    const atrPct = bar.close > 0 ? atr[i] / bar.close : 1;
    if (atrPct > atrCutoff) {
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

    let chopCount = 0;
    if (is15m) {
      for (let k = 0; k < 16 && i - k >= 0; k++) {
        if (adx[i - k] < 19) chopCount++;
      }
      if (chopCount >= 12 && adx[i] >= trendAdxMin) {
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
    let exitReason = 'TIME';
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
        exitReason = 'KO';
        break;
      }
      const barPeakR = favMove * M - commFrac;
      if (activeTp !== null && barPeakR >= activeTp) {
        pnlR = activeTp;
        exitReason = 'TP';
        break;
      }

      if (mode === 'trend' && ratchetStages.length > 0) {
        let activeFloor: number | null = null;
        for (const [trig, flr] of ratchetStages) {
          if (peakR >= trig) activeFloor = flr;
        }
        if (activeFloor !== null && -(advMove * M) - commFrac <= activeFloor) {
          pnlR = activeFloor;
          exitReason = 'RATCHET';
          break;
        }
      }
      if (barPeakR > peakR) peakR = barPeakR;

      const curCloseR = closeMove * M - commFrac;
      if (mode === 'mr') {
        if ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42)) {
          pnlR = Math.max(-1.0, curCloseR);
          exitReason = 'MR_RSI';
          break;
        }
      } else {
        if ((dir === 1 && b.close < emaTrail[j]) || (dir === -1 && b.close > emaTrail[j])) {
          pnlR = Math.max(-1.0, curCloseR);
          exitReason = 'TRAIL';
          break;
        }
      }
      if (j === Math.min(bars.length, i + 1 + maxHold) - 1) {
        pnlR = Math.max(-1.0, curCloseR);
        exitReason = 'TIME';
      }
    }

    trades.push({
      symbol,
      timeframe,
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

function runPortfolio(trades: SimTrade[], initialEq = 1000, maxOpen = 8, baseRisk = 0.03) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let equity = initialEq;
  let peak = initialEq;
  let maxDd = 0;
  let taken = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;
  const active: Array<SimTrade & { stake: number }> = [];
  const settled: Array<SimTrade & { stake: number; equityAfter: number }> = [];

  const closeTrade = (c: SimTrade & { stake: number }) => {
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
    settled.push({ ...c, equityAfter: equity });
  };

  for (const t of sorted) {
    const toClose = active
      .filter((a) => a.exitTime <= t.entryTime)
      .sort((a, b) => a.exitTime - b.exitTime);
    for (const c of toClose) {
      active.splice(active.indexOf(c), 1);
      closeTrade(c);
    }
    if (active.some((a) => a.symbol === t.symbol) || active.length >= maxOpen) continue;
    const prof = getSymbolStrategyProfile(t.symbol);
    const risk = Math.min(0.05, baseRisk * prof.convictionWeight);
    active.push({ ...t, stake: Math.max(1, Number((equity * risk).toFixed(2))) });
    taken++;
  }
  for (const c of active.sort((a, b) => a.exitTime - b.exitTime)) closeTrade(c);
  return {
    initialEq,
    finalEquity: equity,
    maxDd,
    taken,
    winRate: taken > 0 ? (wins / taken) * 100 : 0,
    pf: gl > 0 ? gw / gl : 0,
    netR: gw - gl,
    settled,
  };
}

function summarizeTrades(lbl: string, tr: SimTrade[]) {
  const w = tr.filter((t) => t.pnlR > 0);
  const gw = w.reduce((s, t) => s + t.pnlR, 0);
  const gl = Math.abs(tr.filter((t) => t.pnlR <= 0).reduce((s, t) => s + t.pnlR, 0));
  console.log(
    `  • ${lbl.padEnd(28)} | Trades=${String(tr.length).padStart(4)} | WR=${((w.length / Math.max(1, tr.length)) * 100).toFixed(1).padStart(5)}% | PF=${(gl > 0 ? gw / gl : 0).toFixed(2)} | NetR=${gw - gl >= 0 ? '+' : ''}${(gw - gl).toFixed(2)}R`,
  );
}

function main() {
  const btc5y = loadBinance5Y('BTCUSDT', false);
  const eth5y = loadBinance5Y('ETHUSDT', false);
  const xau5y = loadBinance5Y('PAXGUSDT', true);
  const end5ySec = Number(btc5y.at(-1)!.time);
  const eval5yStart = end5ySec - 1826 * 86400;

  const tBtc5y = simulateLivePortfolioESymbol('cryBTCUSD', '1h', btc5y, eval5yStart, 0.0387);
  const tEth5y = simulateLivePortfolioESymbol('cryETHUSD', '1h', eth5y, eval5yStart, 0.0883);
  const tXau5y = simulateLivePortfolioESymbol('frxXAUUSD', '1h', xau5y, eval5yStart, 0.048);

  const tXag28m = simulateLivePortfolioESymbol(
    'frxXAGUSD',
    '1h',
    loadYahoo28M('frxXAGUSD'),
    0,
    0.048,
  );
  const fxList = [
    'frxUSDJPY',
    'frxAUDJPY',
    'frxEURUSD',
    'frxUSDCAD',
    'frxGBPJPY',
    'frxUSDCHF',
    'frxAUDUSD',
    'frxGBPUSD',
    'frxGBPAUD',
  ];
  const tFx28m = fxList.map((s) =>
    simulateLivePortfolioESymbol(s, '1h', loadYahoo28M(s), 0, 0.025),
  );

  const eval1yStart = Number(loadDeriv1Y('1HZ100V', 900).at(-1)!.time) - 365 * 86400;
  const tV100_1y = simulateLivePortfolioESymbol(
    '1HZ100V',
    '15m',
    loadDeriv1Y('1HZ100V', 900),
    eval1yStart,
    0.0205,
  );
  const tR75_1y = simulateLivePortfolioESymbol(
    'R_75',
    '15m',
    loadDeriv1Y('R_75', 900),
    eval1yStart,
    0.0227,
  );

  console.log('=== PER-SYMBOL MULTI-YEAR PERFORMANCE (PORTFOLIO E ENGINE) ===');
  summarizeTrades('cryBTCUSD (5Y, 100x)', tBtc5y);
  summarizeTrades('cryETHUSD (5Y, 100x)', tEth5y);
  summarizeTrades('frxXAUUSD (5Y, 200x)', tXau5y);
  summarizeTrades('frxXAGUSD (2.4Y, 300x)', tXag28m);
  fxList.forEach((s, idx) => summarizeTrades(`${s} (2.8Y, 300x)`, tFx28m[idx]));
  summarizeTrades('1HZ100V   (1Y, 40x 15m)', tV100_1y);
  summarizeTrades('R_75      (1Y, 50x 15m)', tR75_1y);

  // 1) Pure 5-Year Macro Core (BTC + ETH + 200x Gold)
  const macro5y = runPortfolio([...tBtc5y, ...tEth5y, ...tXau5y], 1000, 8, 0.03);

  // 2) Full Multi-Year Stitched Portfolio E (5Y Macro + 2.8Y Forex & Silver + 1Y Synthetics)
  const allTrades = [...tBtc5y, ...tEth5y, ...tXau5y, ...tXag28m, ...tFx28m.flat(), ...tV100_1y, ...tR75_1y];
  const full5y = runPortfolio(allTrades, 1000, 8, 0.03);
  const full5yBal = runPortfolio(allTrades, 1000, 8, 0.015);

  // 3) Clean 2.5-Year Out-of-Sample Window where ALL 13 1H symbols (Crypto + Metals + 9 Forex) are active (2024-06-24 -> 2026-11-14)
  const start25y = Math.floor(Date.parse('2024-06-24T00:00:00Z') / 1000);
  const trades25y = allTrades.filter((t) => t.entryTime >= start25y);
  const port25y = runPortfolio(trades25y, 1000, 8, 0.03);
  const port25yBal = runPortfolio(trades25y, 1000, 8, 0.015);

  console.log('\n=== PORTFOLIO SUMMARIES ($1,000 START, 8 OPEN SLOTS) ===');
  for (const [name, pf] of [
    ['A. 5Y Macro Core Only (BTC+ETH+200x Gold, 2021-2026 @ 3%)', macro5y],
    ['B. 5Y Combined Portfolio E (5Y Macro + 2.8Y FX/XAG + 1Y Synth @ 3%)', full5y],
    ['C. 5Y Combined Portfolio E @ Balanced 1.5% Risk', full5yBal],
    ['D. 2.4Y Full 13-15 Symbol Window (2024-06 -> 2026-11 @ 3%)', port25y],
    ['E. 2.4Y Full 13-15 Symbol Window @ Balanced 1.5% Risk', port25yBal],
  ] as const) {
    console.log(
      `${name}\n  Trades=${pf.taken} | WR=${pf.winRate.toFixed(1)}% | PF=${pf.pf.toFixed(2)} | NetR=+${pf.netR.toFixed(2)}R | $1,000 -> $${pf.finalEquity.toLocaleString('en-US', { maximumFractionDigits: 2 })} | MaxDD=-${pf.maxDd.toFixed(2)}%`,
    );
  }

  const yearSec = 365.25 * 86400;
  console.log('\n=== YEAR-BY-YEAR BREAKDOWN: 5Y COMBINED PORTFOLIO E (8 SLOTS @ 3% BASE) ===');
  let prevEq = 1000;
  for (let y = 0; y < 5; y++) {
    const a = eval5yStart + y * yearSec;
    const b = y === 4 ? Infinity : eval5yStart + (y + 1) * yearSec;
    const slice = full5y.settled.filter((t) => t.exitTime >= a && t.exitTime < b);
    const startEq = prevEq;
    let pk = startEq;
    let mdd = 0;
    for (const t of slice) {
      if (t.equityAfter > pk) pk = t.equityAfter;
      const dd = ((pk - t.equityAfter) / pk) * 100;
      if (dd > mdd) mdd = dd;
    }
    const endEq = slice.length > 0 ? slice[slice.length - 1].equityAfter : startEq;
    prevEq = endEq;
    const w = slice.filter((t) => t.pnlR > 0);
    const gw = w.reduce((s, t) => s + t.pnlR, 0);
    const gl = Math.abs(slice.filter((t) => t.pnlR <= 0).reduce((s, t) => s + t.pnlR, 0));
    const retPct = ((endEq - startEq) / startEq) * 100;
    const d0 = new Date(a * 1000).toISOString().slice(0, 10);
    const d1 = new Date((y === 4 ? end5ySec + 3 * 86400 : b) * 1000).toISOString().slice(0, 10);
    console.log(
      `  Year ${y + 1} (${d0} -> ${d1}) | Trades=${String(slice.length).padStart(4)} | WR=${((w.length / slice.length) * 100).toFixed(1).padStart(5)}% | PF=${(gw / gl).toFixed(2)} | NetR=${gw - gl >= 0 ? '+' : ''}${(gw - gl).toFixed(2).padStart(6)}R | $${startEq.toLocaleString('en-US', { maximumFractionDigits: 0 })} -> $${endEq.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${retPct >= 0 ? '+' : ''}${retPct.toFixed(1)}%) | MaxDD=-${mdd.toFixed(2)}%`,
    );
  }
}

main();
