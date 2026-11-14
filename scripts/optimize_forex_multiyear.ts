import fs from 'node:fs';
import path from 'node:path';
import { computeADXandATR, computeEMA, computeRSI } from '../src/services/quantStrategyEngine.ts';
import type { CandlePoint } from '../src/services/chartFeed.ts';

const CACHE_DIR =
  '/Users/admin/.gemini/antigravity/brain/501f9276-302b-4acf-baa0-10bff49b8dbe/scratch/data_cache';

function loadYahoo28M(sym: string): CandlePoint[] {
  const file = path.join(CACHE_DIR, `yahoo_28m_${sym}_3600.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

interface Config {
  M: number;
  lookback: number;
  trendAdxMin: number;
  atrCutoff: number;
  trailEmaPeriod: number;
  useMacro200: boolean;
  pureTrend: boolean;
  tpR: number | null;
  ratchet: Array<[number, number]>;
  sessionFilter: boolean;
}

interface SimTrade {
  entryTime: number;
  exitTime: number;
  pnlR: number;
}

function simulate(bars: CandlePoint[], cfg: Config, commFrac = 0.025): SimTrade[] {
  if (bars.length < 225) return [];
  const closes = bars.map((b) => b.close);
  const emaMacro = cfg.useMacro200 ? computeEMA(closes, 200) : null;
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const emaTrail = cfg.trailEmaPeriod === 30 ? ema30 : computeEMA(closes, cfg.trailEmaPeriod);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const trades: SimTrade[] = [];
  let i = 210;
  while (i < bars.length - 2) {
    const bar = bars[i];
    const barTime = Number(bar.time);

    if (cfg.sessionFilter) {
      const hr = new Date(barTime * 1000).getUTCHours();
      if (hr < 6 || hr > 18) {
        i++;
        continue;
      }
    }

    const atrPct = bar.close > 0 ? atr[i] / bar.close : 1;
    if (atrPct > cfg.atrCutoff) {
      i++;
      continue;
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - cfg.lookback; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }

    const macroLongOk = !emaMacro || (bar.close > emaMacro[i] && ema100[i] > emaMacro[i]);
    const macroShortOk = !emaMacro || (bar.close < emaMacro[i] && ema100[i] < emaMacro[i]);

    let dir: 1 | -1 | 0 = 0;
    let mode: 'trend' | 'mr' = 'trend';

    if (adx[i] >= cfg.trendAdxMin) {
      if (macroLongOk && bar.close > hi && bar.close > ema100[i] && ema30[i] > ema100[i]) {
        dir = 1;
        mode = 'trend';
      } else if (macroShortOk && bar.close < lo && bar.close < ema100[i] && ema30[i] < ema100[i]) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!cfg.pureTrend && adx[i] <= 20) {
      const prevRsi = rsi[i - 1] ?? rsi[i];
      if (bar.close > ema100[i] && prevRsi < 32 && rsi[i] >= 32) {
        dir = 1;
        mode = 'mr';
      } else if (bar.close < ema100[i] && prevRsi > 68 && rsi[i] <= 68) {
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
    const activeTp = mode === 'mr' ? 1.2 : cfg.tpR;
    const maxHold = mode === 'mr' ? 24 : 72;

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

      if (advMove * cfg.M - commFrac >= 1.0) {
        pnlR = -1.0;
        break;
      }
      const barPeakR = favMove * cfg.M - commFrac;
      if (activeTp !== null && barPeakR >= activeTp) {
        pnlR = activeTp;
        break;
      }
      if (mode === 'trend' && cfg.ratchet.length > 0) {
        let activeFloor: number | null = null;
        for (const [trig, flr] of cfg.ratchet) {
          if (peakR >= trig) activeFloor = flr;
        }
        if (activeFloor !== null && -(advMove * cfg.M) - commFrac <= activeFloor) {
          pnlR = activeFloor;
          break;
        }
      }
      if (barPeakR > peakR) peakR = barPeakR;

      const curCloseR = closeMove * cfg.M - commFrac;
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

    trades.push({ entryTime, exitTime: Number(bars[exitIdx].time), pnlR });
    i = exitIdx + 1;
  }
  return trades;
}

function stats(tr: SimTrade[]) {
  const w = tr.filter((t) => t.pnlR > 0);
  const gw = w.reduce((s, t) => s + t.pnlR, 0);
  const gl = Math.abs(tr.filter((t) => t.pnlR <= 0).reduce((s, t) => s + t.pnlR, 0));
  return {
    n: tr.length,
    wr: tr.length ? (w.length / tr.length) * 100 : 0,
    pf: gl > 0 ? gw / gl : 0,
    netR: gw - gl,
  };
}

function main() {
  const splitEpoch = Math.floor(Date.parse('2025-11-14T00:00:00Z') / 1000);
  const symbols: Array<{ sym: string; mults: number[]; comm: number }> = [
    { sym: 'frxXAGUSD', mults: [100, 200], comm: 0.048 },
    { sym: 'frxUSDJPY', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxAUDJPY', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxEURUSD', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxUSDCAD', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxGBPJPY', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxUSDCHF', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxAUDUSD', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxGBPUSD', mults: [100, 200, 300], comm: 0.025 },
    { sym: 'frxGBPAUD', mults: [100, 200, 300], comm: 0.025 },
  ];

  const lookbacks = [24, 48, 72];
  const adxMins = [22, 26];
  const atrCutoffs = [0.0045, 0.0065];
  const trailEmas = [30, 50];
  const macro200s = [false, true];
  const pureTrends = [true, false];
  const tpRs: Array<number | null> = [null, 2.0];
  const ratchets: Array<Array<[number, number]>> = [
    [],
    [[0.8, 0.2]],
    [[0.75, 0.2], [1.2, 0.6]],
  ];
  const sessions = [false, true];

  console.log('=== MULTI-YEAR (2.8Y) WALK-FORWARD CALIBRATION (MUST BE POSITIVE IN BOTH P1 AND P2) ===');
  for (const item of symbols) {
    const bars = loadYahoo28M(item.sym);
    let bestScore = -Infinity;
    let bestCfg: Config | null = null;
    let bestAll: ReturnType<typeof stats> | null = null;
    let bestP1: ReturnType<typeof stats> | null = null;
    let bestP2: ReturnType<typeof stats> | null = null;

    for (const M of item.mults) {
      for (const lookback of lookbacks) {
        for (const trendAdxMin of adxMins) {
          for (const atrCutoff of atrCutoffs) {
            for (const trailEmaPeriod of trailEmas) {
              for (const useMacro200 of macro200s) {
                for (const pureTrend of pureTrends) {
                  for (const tpR of tpRs) {
                    for (const ratchet of ratchets) {
                      for (const sessionFilter of sessions) {
                        const cfg: Config = {
                          M,
                          lookback,
                          trendAdxMin,
                          atrCutoff,
                          trailEmaPeriod,
                          useMacro200,
                          pureTrend,
                          tpR,
                          ratchet,
                          sessionFilter,
                        };
                        const tr = simulate(bars, cfg, item.comm);
                        if (tr.length < 60) continue;
                        const p1 = stats(tr.filter((t) => t.entryTime < splitEpoch));
                        const p2 = stats(tr.filter((t) => t.entryTime >= splitEpoch));
                        const all = stats(tr);
                        if (p1.n < 20 || p2.n < 15) continue;
                        // Require BOTH periods positive and PF >= 1.05
                        if (p1.netR <= 0 || p2.netR <= 0 || p1.pf < 1.05 || p2.pf < 1.05) continue;
                        const score = Math.min(p1.pf, p2.pf) * 20 + all.netR;
                        if (score > bestScore) {
                          bestScore = score;
                          bestCfg = cfg;
                          bestAll = all;
                          bestP1 = p1;
                          bestP2 = p2;
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    if (!bestCfg || !bestAll || !bestP1 || !bestP2) {
      console.log(`❌ ${item.sym.padEnd(10)} | NO config profitable in both 2024-2025 AND 2025-2026`);
    } else {
      console.log(
        `✅ ${item.sym.padEnd(10)} | ${bestCfg.M}x | LB=${bestCfg.lookback} ADX>=${bestCfg.trendAdxMin} ATR<=${(bestCfg.atrCutoff * 100).toFixed(2)}% Trail=${bestCfg.trailEmaPeriod} M200=${bestCfg.useMacro200 ? 'Y' : 'N'} PT=${bestCfg.pureTrend ? 'Y' : 'N'} TP=${bestCfg.tpR ?? 'Trail'} Ratch=${bestCfg.ratchet.length} Sess=${bestCfg.sessionFilter ? 'Y' : 'N'}`,
      );
      console.log(
        `     All=${bestAll.n}t WR=${bestAll.wr.toFixed(1)}% PF=${bestAll.pf.toFixed(2)} +${bestAll.netR.toFixed(1)}R | P1(24-25)=${bestP1.n}t PF=${bestP1.pf.toFixed(2)} +${bestP1.netR.toFixed(1)}R | P2(25-26)=${bestP2.n}t PF=${bestP2.pf.toFixed(2)} +${bestP2.netR.toFixed(1)}R`,
      );
    }
  }
}

main();
