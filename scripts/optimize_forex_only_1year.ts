import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  computeADXandATR,
  computeEMA,
  computeRSI,
} from '../src/services/quantStrategyEngine.ts';
import { normalizeCandleHistory, type CandlePoint } from '../src/services/chartFeed.ts';

const CACHE_DIR =
  '/Users/admin/.gemini/antigravity/brain/501f9276-302b-4acf-baa0-10bff49b8dbe/scratch/data_cache';

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PublicDerivClient {
  private ws!: WebSocket;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const id = msg.req_id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.error) p.reject(new Error(msg.error.message || 'API error'));
        else p.resolve(msg);
      }
    });
  }

  async ensureOpen(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
  }

  request<T = any>(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout on ${Object.keys(payload).join(',')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function fetchOrLoad1Y(
  client: PublicDerivClient,
  symbol: string,
  granularity = 3600,
  maxPages = 7,
): Promise<CandlePoint[]> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `deriv_1y_${symbol}_${granularity}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.length > 4000) return cached;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const startCutoff = nowSec - 365 * 86400 - 250 * granularity;
  const byEpoch = new Map<number, CandlePoint>();
  let endCursor: number | 'latest' = 'latest';
  let minSeen = Infinity;

  for (let p = 0; p < maxPages; p++) {
    await sleep(220);
    await client.ensureOpen();
    let batch: CandlePoint[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity,
          count: 1000,
          end: endCursor,
        });
        batch = normalizeCandleHistory(res.candles);
        break;
      } catch {
        await sleep(1200 * attempt);
        await client.ensureOpen();
      }
    }
    if (batch.length === 0) break;
    const oldest = Number(batch[0].time);
    if (minSeen < Infinity && oldest >= minSeen) break;
    for (const c of batch) {
      const t = Number(c.time);
      byEpoch.set(t, c);
      if (t < minSeen) minSeen = t;
    }
    if (minSeen <= startCutoff || batch.length < 20) break;
    endCursor = oldest - 1;
  }

  const sorted = Array.from(byEpoch.values()).sort(
    (a, b) => Number(a.time) - Number(b.time),
  );
  fs.writeFileSync(cacheFile, JSON.stringify(sorted));
  return sorted;
}

interface SimTrade {
  symbol: string;
  mode: 'trend' | 'mr';
  direction: 'rise' | 'fall';
  entryTime: number;
  exitTime: number;
  pnlR: number;
  exitReason: string;
}

interface FxProfileConfig {
  M: number;
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
}

interface PrecomputedIndicators {
  bars: CandlePoint[];
  closes: number[];
  ema20: number[];
  ema30: number[];
  ema50: number[];
  ema100: number[];
  ema200: number[];
  rsi: number[];
  atr: number[];
  adx: number[];
}

function precompute(bars: CandlePoint[]): PrecomputedIndicators {
  const closes = bars.map((b) => b.close);
  const { atr, adx } = computeADXandATR(bars, 14);
  return {
    bars,
    closes,
    ema20: computeEMA(closes, 20),
    ema30: computeEMA(closes, 30),
    ema50: computeEMA(closes, 50),
    ema100: computeEMA(closes, 100),
    ema200: computeEMA(closes, 200),
    rsi: computeRSI(closes, 14),
    atr,
    adx,
  };
}

function simulateFastFx(
  symbol: string,
  ind: PrecomputedIndicators,
  cfg: FxProfileConfig,
  evalStartEpoch: number,
  commFrac = 0.025,
): SimTrade[] {
  const { bars, ema20, ema30, ema50, ema100, ema200, rsi, atr, adx } = ind;
  if (bars.length < 225) return [];

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

    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - cfg.lookback; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }

    let dir: 1 | -1 | 0 = 0;
    let mode: 'trend' | 'mr' = 'trend';
    let curTpR: number | null = cfg.tpR;

    const macroLongOk = !cfg.useMacro200 || (b.close > ema200[i] && ema100[i] > ema200[i]);
    const macroShortOk = !cfg.useMacro200 || (b.close < ema200[i] && ema100[i] < ema200[i]);

    if (adx[i] >= cfg.trendAdxMin) {
      if (b.close > hi && b.close > ema100[i] && ema30[i] > ema100[i] && macroLongOk) {
        dir = 1;
        mode = 'trend';
      } else if (
        !cfg.longOnly &&
        b.close < lo &&
        b.close < ema100[i] &&
        ema30[i] < ema100[i] &&
        macroShortOk
      ) {
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
      symbol,
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

function summarize(trades: SimTrade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0);
  const losses = trades.filter((t) => t.pnlR <= 0);
  const gw = wins.reduce((s, t) => s + t.pnlR, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const netR = gw - gl;
  const pf = gl > 0 ? gw / gl : 0;
  return {
    n,
    winRate: n > 0 ? Number(((wins.length / n) * 100).toFixed(1)) : 0,
    pf: Number(pf.toFixed(2)),
    netR: Number(netR.toFixed(2)),
  };
}

function simulatePortfolioMonthly(
  trades: SimTrade[],
  opts: {
    initialEquity?: number;
    baseRisk?: number;
    maxOpen?: number;
    highConvictionSymbols?: Set<string>;
  } = {},
) {
  const {
    initialEquity = 1000,
    baseRisk = 0.03,
    maxOpen = 5,
    highConvictionSymbols = new Set(),
  } = opts;

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
    const risk = highConvictionSymbols.has(t.symbol) ? 0.038 : baseRisk;
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

  return {
    finalEquity: Number(equity.toFixed(2)),
    totalRetPct: Number((((equity - initialEquity) / initialEquity) * 100).toFixed(2)),
    maxDdPct: Number(maxDdPct.toFixed(2)),
    taken,
    winRate: taken > 0 ? Number(((wins / taken) * 100).toFixed(1)) : 0,
    pf: gl > 0 ? Number((gw / gl).toFixed(2)) : 0,
    netR: Number((gw - gl).toFixed(2)),
    avgMoPct: Number(avgMoPct.toFixed(2)),
    posMonths,
    totalMonths: monthRows.length,
    monthRows,
  };
}

async function main() {
  const client = new PublicDerivClient();
  await client.connect();

  const allFxSymbols = [
    'frxEURUSD',
    'frxGBPUSD',
    'frxUSDJPY',
    'frxAUDUSD',
    'frxUSDCAD',
    'frxUSDCHF',
    'frxEURGBP',
    'frxEURJPY',
    'frxGBPJPY',
    'frxAUDJPY',
    'frxEURAUD',
    'frxEURCAD',
    'frxGBPAUD',
    'frxXAUUSD',
    'frxXAGUSD',
  ];

  const precomputedMap = new Map<string, PrecomputedIndicators>();
  console.log('Fetching/Loading 1-Year 1H datasets for all 15 Deriv Multiplier Forex & Metal pairs...');
  for (const sym of allFxSymbols) {
    const bars = await fetchOrLoad1Y(client, sym, 3600, 7);
    precomputedMap.set(sym, precompute(bars));
    const first = bars[0] ? new Date(Number(bars[0].time) * 1000).toISOString().slice(0, 10) : 'none';
    const last = bars.at(-1) ? new Date(Number(bars.at(-1)!.time) * 1000).toISOString().slice(0, 10) : 'none';
    console.log(`  • ${sym.padEnd(10)}: ${bars.length} bars (${first} -> ${last})`);
  }
  client.close();

  const evalStart = Math.floor(Date.now() / 1000) - 365 * 86400;

  // Parameter grid for FX pairs
  const candidateConfigs: Array<{ label: string; cfg: FxProfileConfig }> = [];
  for (const M of [100, 200, 300]) {
    for (const lookback of [24, 36, 48, 72]) {
      for (const trailEmaPeriod of [20, 30, 50]) {
        for (const useMacro200 of [false, true]) {
          for (const pureTrend of [true, false]) {
            for (const sessionFilter of [false, true]) {
              for (const [rLabel, ratchet, tpR] of [
                ['R2+TP2', [[0.75, 0.2], [1.2, 0.6]] as Array<[number, number]>, 2.0],
                ['R1+Uncap', [[0.8, 0.2]] as Array<[number, number]>, null],
                ['NoRatchet+Uncap', [] as Array<[number, number]>, null],
              ] as const) {
                candidateConfigs.push({
                  label: `${M}x | LB=${lookback} | EMA=${trailEmaPeriod} | M200=${useMacro200 ? 'Y' : 'N'} | ${pureTrend ? 'TrendOnly' : 'Trend+MR'} | ${sessionFilter ? 'LonNY' : '24/5'} | ${rLabel}`,
                  cfg: {
                    M,
                    lookback,
                    trendAdxMin: symIsMetalPlaceholder => 22,
                    atrCutoff: 0.0065,
                    trailEmaPeriod,
                    useMacro200,
                    pureTrend,
                    longOnly: false,
                    tpR,
                    ratchet,
                    sessionFilter,
                  } as any,
                });
              }
            }
          }
        }
      }
    }
  }

  console.log(`\nOptimizing across ${candidateConfigs.length} strategy profiles per symbol...`);
  const bestBySymbol = new Map<
    string,
    { label: string; cfg: FxProfileConfig; trades: SimTrade[]; stats: ReturnType<typeof summarize> }
  >();

  for (const sym of allFxSymbols) {
    const ind = precomputedMap.get(sym)!;
    const isMetal = sym === 'frxXAUUSD' || sym === 'frxXAGUSD';
    let bestScore = -Infinity;
    let bestEntry: any = null;

    for (const item of candidateConfigs) {
      const cfg: FxProfileConfig = {
        ...item.cfg,
        trendAdxMin: isMetal ? 20 : 22,
        atrCutoff: isMetal ? 0.0065 : 0.0045,
        longOnly: sym === 'frxXAUUSD',
      };
      const tr = simulateFastFx(sym, ind, cfg, evalStart, isMetal ? 0.048 : 0.025);
      const st = summarize(tr);
      if (st.n < 12) continue;
      // Score balances Net R and Profit Factor quality
      const score = st.netR * Math.min(2.2, Math.max(0.5, st.pf));
      if (score > bestScore) {
        bestScore = score;
        bestEntry = { label: item.label, cfg, trades: tr, stats: st };
      }
    }
    if (bestEntry) {
      bestBySymbol.set(sym, bestEntry);
    }
  }

  console.log('\n================ RANKED 1-YEAR FOREX & METALS LEADERBOARD (BEST PROFILE PER PAIR) ================');
  const ranked = Array.from(bestBySymbol.entries()).sort(
    (a, b) => b[1].stats.netR - a[1].stats.netR,
  );
  for (const [sym, data] of ranked) {
    console.log(
      `  • ${sym.padEnd(10)} | Trades=${String(data.stats.n).padStart(3)} | WR=${String(data.stats.winRate).padStart(5)}% | PF=${data.stats.pf.toFixed(2).padStart(4)} | NetR=+${data.stats.netR.toFixed(2).padStart(6)}R | Profile: ${data.label}`,
    );
  }

  // Build Portfolios:
  // A. Top Pure Currency Pairs Only (excluding XAU/XAG, PF >= 1.35 & NetR >= +6R)
  const topCurrenciesOnly = ranked.filter(
    ([sym, d]) =>
      sym !== 'frxXAUUSD' &&
      sym !== 'frxXAGUSD' &&
      d.stats.pf >= 1.35 &&
      d.stats.netR >= 6,
  );

  // B. Top All Forex (Currencies + Gold & Silver, PF >= 1.35 & NetR >= +6R)
  const topAllFx = ranked.filter(([, d]) => d.stats.pf >= 1.35 && d.stats.netR >= 6);

  const tradesCurrOnly = topCurrenciesOnly.flatMap(([, d]) => d.trades);
  const tradesAllFx = topAllFx.flatMap(([, d]) => d.trades);

  const highConvSet = new Set(ranked.slice(0, 6).map(([sym]) => sym));

  const pfCurr3 = simulatePortfolioMonthly(tradesCurrOnly, {
    initialEquity: 1000,
    baseRisk: 0.03,
    maxOpen: 5,
  });
  const pfCurrConv = simulatePortfolioMonthly(tradesCurrOnly, {
    initialEquity: 1000,
    baseRisk: 0.03,
    maxOpen: 5,
    highConvictionSymbols: highConvSet,
  });
  const pfAllFx3 = simulatePortfolioMonthly(tradesAllFx, {
    initialEquity: 1000,
    baseRisk: 0.03,
    maxOpen: 5,
  });
  const pfAllFxConv = simulatePortfolioMonthly(tradesAllFx, {
    initialEquity: 1000,
    baseRisk: 0.03,
    maxOpen: 5,
    highConvictionSymbols: highConvSet,
  });

  console.log('\n================ 1-YEAR FOREX-ONLY PORTFOLIO RESULTS ($1,000 START) ================');
  console.log(
    `1. Pure Forex Currencies (${topCurrenciesOnly.map(([s]) => s).join(', ')}) @ 3.0% Flat Risk:\n` +
      `   • Trades: ${pfCurr3.taken} | WR: ${pfCurr3.winRate}% | PF: ${pfCurr3.pf} | Net R: +${pfCurr3.netR}R\n` +
      `   • $1,000 -> $${pfCurr3.finalEquity.toLocaleString()} (+${pfCurr3.totalRetPct}%) | Avg Mo: +${pfCurr3.avgMoPct}%/mo | MaxDD: -${pfCurr3.maxDdPct}% | Pos Months: ${pfCurr3.posMonths}/${pfCurr3.totalMonths}`,
  );
  console.log(
    `\n2. Pure Forex Currencies (${topCurrenciesOnly.length} Pairs) @ 3.0%–3.8% Conviction Risk:\n` +
      `   • Trades: ${pfCurrConv.taken} | WR: ${pfCurrConv.winRate}% | PF: ${pfCurrConv.pf} | Net R: +${pfCurrConv.netR}R\n` +
      `   • $1,000 -> $${pfCurrConv.finalEquity.toLocaleString()} (+${pfCurrConv.totalRetPct}%) | Avg Mo: +${pfCurrConv.avgMoPct}%/mo | MaxDD: -${pfCurrConv.maxDdPct}% | Pos Months: ${pfCurrConv.posMonths}/${pfCurrConv.totalMonths}`,
  );
  console.log(
    `\n3. Full Forex + Spot Metals (${topAllFx.map(([s]) => s).join(', ')}) @ 3.0% Flat Risk:\n` +
      `   • Trades: ${pfAllFx3.taken} | WR: ${pfAllFx3.winRate}% | PF: ${pfAllFx3.pf} | Net R: +${pfAllFx3.netR}R\n` +
      `   • $1,000 -> $${pfAllFx3.finalEquity.toLocaleString()} (+${pfAllFx3.totalRetPct}%) | Avg Mo: +${pfAllFx3.avgMoPct}%/mo | MaxDD: -${pfAllFx3.maxDdPct}% | Pos Months: ${pfAllFx3.posMonths}/${pfAllFx3.totalMonths}`,
  );
  console.log(
    `\n4. Full Forex + Spot Metals (${topAllFx.length} Pairs) @ 3.0%–3.8% Conviction Risk:\n` +
      `   • Trades: ${pfAllFxConv.taken} | WR: ${pfAllFxConv.winRate}% | PF: ${pfAllFxConv.pf} | Net R: +${pfAllFxConv.netR}R\n` +
      `   • $1,000 -> $${pfAllFxConv.finalEquity.toLocaleString()} (+${pfAllFxConv.totalRetPct}%) | Avg Mo: +${pfAllFxConv.avgMoPct}%/mo | MaxDD: -${pfAllFxConv.maxDdPct}% | Pos Months: ${pfAllFxConv.posMonths}/${pfAllFxConv.totalMonths}`,
  );

  console.log('\n================ MONTH-BY-MONTH BREAKDOWN ($1,000 START — FULL FOREX #4 VS PURE CURRENCIES #2) ================');
  console.log('Month   | Pure Currencies #2 (Trades / WR / NetR / % / Bal)  | Full Forex + Metals #4 (Trades / WR / NetR / % / Bal)');
  const cMap = new Map(pfCurrConv.monthRows.map((r) => [r.month, r]));
  for (const r4 of pfAllFxConv.monthRows) {
    const r2 = cMap.get(r4.month);
    const cStr = r2
      ? `${String(r2.trades).padStart(2)}t | ${r2.winRate.toFixed(0).padStart(2)}% | ${(r2.netR >= 0 ? '+' : '') + r2.netR.toFixed(2).padStart(6)}R | ${((r2.retPct >= 0 ? '+' : '') + r2.retPct.toFixed(1) + '%').padStart(7)} | $${r2.endEq.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(7)}`
      : '—';
    const fStr = `${String(r4.trades).padStart(2)}t | ${r4.winRate.toFixed(0).padStart(2)}% | ${(r4.netR >= 0 ? '+' : '') + r4.netR.toFixed(2).padStart(6)}R | ${((r4.retPct >= 0 ? '+' : '') + r4.retPct.toFixed(1) + '%').padStart(7)} | $${r4.endEq.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(7)}`;
    console.log(`${r4.month} | ${cStr.padEnd(50)} | ${fStr}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
