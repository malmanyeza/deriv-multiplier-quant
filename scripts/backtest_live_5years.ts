import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  fetchOptionsAccounts,
  issueAccountOtpSocketUrl,
} from '../server/derivClient.ts';
import { pickClosestMultiplier } from '../server/quantRunner.ts';
import {
  evaluateQuantSignal,
  type QuantTimeframe,
} from '../src/services/quantStrategyEngine.ts';
import { normalizeCandleHistory, type CandlePoint } from '../src/services/chartFeed.ts';
import type { NormalizedPosition } from '../src/types/deriv.ts';

interface MarketSpec {
  code: string;
  name: string;
  market: string;
  binanceSymbol?: string;
  fxHoursOnly?: boolean;
}

const BASKET_1H: MarketSpec[] = [
  { code: 'cryBTCUSD', name: 'BTC/USD', market: 'cryptocurrency', binanceSymbol: 'BTCUSDT' },
  { code: 'cryETHUSD', name: 'ETH/USD', market: 'cryptocurrency', binanceSymbol: 'ETHUSDT' },
  { code: 'frxXAUUSD', name: 'Gold XAU/USD', market: 'commodities', binanceSymbol: 'PAXGUSDT', fxHoursOnly: true },
  { code: 'OTC_NDX', name: 'US Tech 100', market: 'indices' },
];

const BASKET_15M: MarketSpec[] = [
  { code: '1HZ100V', name: 'Vol 100 (1s)', market: 'synthetic_index' },
  { code: 'R_75', name: 'Volatility 75', market: 'synthetic_index' },
];

const CACHE_DIR =
  '/Users/admin/.gemini/antigravity/brain/501f9276-302b-4acf-baa0-10bff49b8dbe/scratch/data_cache';

interface LiveContractSpec {
  symbol: string;
  supportsMult: boolean;
  multiplier: number;
  multiplierRange: number[];
  commissionPer100: number;
  commissionSource: 'live_proposal' | 'fallback';
}

interface SimTrade {
  symbol: string;
  engine: '1h' | '15m';
  direction: 'rise' | 'fall';
  mode: 'trend' | 'mr';
  multiplier: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  tpR: number | null;
  pnlR: number;
  exitReason: 'TP' | 'SL' | 'KO' | 'TRAIL' | 'END';
  barsHeld: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DerivBacktestClient {
  private ws!: WebSocket;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  async connect(): Promise<void> {
    const pat = process.env.DERIV_PAT!;
    const appId = process.env.DERIV_APP_ID!;
    const accounts = await fetchOptionsAccounts(pat, appId);
    const demo = accounts.find((a) => a.account_type === 'demo') || accounts[0];
    if (!demo) throw new Error('No Deriv account available.');
    const otpUrl = await issueAccountOtpSocketUrl(pat, demo.account_id, appId);

    this.ws = new WebSocket(otpUrl);
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

  async reconnectIfClosed(): Promise<void> {
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

async function fetchLiveSpec(
  client: DerivBacktestClient,
  symbol: string,
  preferredMult: number,
  fallbackCommPer100: number,
): Promise<LiveContractSpec> {
  const cf = await client.request({ contracts_for: symbol });
  const multContracts = (cf.contracts_for?.available || []).filter(
    (c: any) => c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN',
  );
  if (multContracts.length === 0) {
    return {
      symbol,
      supportsMult: false,
      multiplier: preferredMult,
      multiplierRange: [],
      commissionPer100: fallbackCommPer100,
      commissionSource: 'fallback',
    };
  }

  const rangeSet = new Set<number>();
  for (const c of multContracts) {
    if (Array.isArray(c.multiplier_range)) {
      for (const m of c.multiplier_range) rangeSet.add(Number(m));
    }
  }
  const range = Array.from(rangeSet).sort((a, b) => a - b);
  const multiplier = pickClosestMultiplier(range, preferredMult, range[0] ?? preferredMult);

  let commissionPer100 = fallbackCommPer100;
  let commissionSource: 'live_proposal' | 'fallback' = 'fallback';
  try {
    const prop = await client.request({
      proposal: 1,
      amount: 100,
      basis: 'stake',
      contract_type: 'MULTUP',
      currency: 'USD',
      multiplier,
      underlying_symbol: symbol,
    });
    if (prop.proposal && typeof prop.proposal.commission === 'number') {
      commissionPer100 = prop.proposal.commission;
      commissionSource = 'live_proposal';
    } else if (prop.proposal && prop.proposal.commission === null) {
      commissionPer100 = 0;
      commissionSource = 'live_proposal';
    }
  } catch {
    // Keep fallback when market is temporarily closed
  }

  return {
    symbol,
    supportsMult: true,
    multiplier,
    multiplierRange: range,
    commissionPer100,
    commissionSource,
  };
}

function isGoldFxTradingHour(epochSec: number): boolean {
  const d = new Date(epochSec * 1000);
  const day = d.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  const hour = d.getUTCHours();
  if (day === 6) return false; // Saturday closed
  if (day === 0 && hour < 23) return false; // Sunday closed until 23:00 UTC
  if (day === 5 && hour >= 21) return false; // Friday closes ~21:00 UTC
  if (hour === 22) return false; // Daily 22:00 UTC rollover break (observed on frxXAUUSD)
  return true;
}

async function fetchBinance1h(
  binanceSymbol: string,
  startEpochSec: number,
  endEpochSec: number,
  fxHoursOnly = false,
): Promise<CandlePoint[]> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(
    CACHE_DIR,
    `binance_${binanceSymbol}_1h_${startEpochSec}_${endEpochSec}.json`,
  );

  let rawBars: CandlePoint[] = [];
  if (fs.existsSync(cacheFile)) {
    rawBars = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } else {
    const byEpoch = new Map<number, CandlePoint>();
    let cursorMs = startEpochSec * 1000;
    const endMs = endEpochSec * 1000;

    while (cursorMs < endMs) {
      const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1h&limit=1000&startTime=${cursorMs}`;
      let ok = false;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as any[];
          if (!Array.isArray(data) || data.length === 0) {
            cursorMs = endMs;
            ok = true;
            break;
          }
          for (const d of data) {
            const t = Math.floor(Number(d[0]) / 1000);
            if (t <= endEpochSec) {
              byEpoch.set(t, {
                time: t as any,
                open: Number(d[1]),
                high: Number(d[2]),
                low: Number(d[3]),
                close: Number(d[4]),
              });
            }
          }
          const lastMs = Number(data[data.length - 1][0]);
          const nextCursor = lastMs + 3600 * 1000;
          if (nextCursor <= cursorMs) {
            cursorMs = endMs;
          } else {
            cursorMs = nextCursor;
          }
          ok = true;
          await sleep(100);
          break;
        } catch (err) {
          if (attempt === 4) throw err;
          await sleep(1000 * attempt);
        }
      }
      if (!ok) break;
    }

    rawBars = Array.from(byEpoch.values()).sort(
      (a, b) => Number(a.time) - Number(b.time),
    );
    fs.writeFileSync(cacheFile, JSON.stringify(rawBars));
  }

  return fxHoursOnly
    ? rawBars.filter((b) => isGoldFxTradingHour(Number(b.time)))
    : rawBars;
}

async function fetchDerivCandles(
  client: DerivBacktestClient,
  symbol: string,
  granularity: number,
  targetDays = 365,
  maxPages = 42,
): Promise<{ bars: CandlePoint[]; stopReason: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startCutoff = nowSec - targetDays * 86400;
  const byEpoch = new Map<number, CandlePoint>();
  let endCursor: number | 'latest' = 'latest';
  let minSeen = Infinity;
  let stopReason = 'max_pages';

  for (let page = 0; page < maxPages; page++) {
    await sleep(450);
    let batch: CandlePoint[] = [];
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity,
          count: 1000,
          end: endCursor,
        });
        batch = normalizeCandleHistory(res.candles);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        await sleep(2200 * attempt);
      }
    }
    if (lastErr) {
      stopReason = `err:${lastErr.message}`;
      break;
    }
    if (batch.length === 0) {
      stopReason = 'empty';
      break;
    }

    const batchOldest = Number(batch[0].time);
    // Deriv wraps silently back to latest when history retention limit is exceeded
    if (minSeen < Infinity && batchOldest >= minSeen) {
      stopReason = 'retention_wrap';
      break;
    }

    for (const c of batch) {
      const t = Number(c.time);
      byEpoch.set(t, c);
      if (t < minSeen) minSeen = t;
    }

    if (minSeen <= startCutoff - 250 * granularity) {
      stopReason = 'reached_cutoff';
      break;
    }
    if (batch.length < 20) {
      stopReason = 'short_page';
      break;
    }
    endCursor = batchOldest - 1;
  }

  return {
    bars: Array.from(byEpoch.values()).sort((a, b) => Number(a.time) - Number(b.time)),
    stopReason,
  };
}

function makeDummyOpenPos(
  symbol: string,
  direction: 'rise' | 'fall',
  multiplier: number,
  entryTime: number,
  entrySpot: number,
  stake: number,
  tpPrice: number | null,
): NormalizedPosition {
  return {
    contractId: 999999,
    underlyingSymbol: symbol,
    contractType: direction === 'rise' ? 'MULTUP' : 'MULTDOWN',
    isSold: false,
    isExpired: false,
    isValidToSell: true,
    status: 'open',
    buyPrice: stake,
    bidPrice: stake,
    sellPrice: null,
    profit: 0,
    profitPercentage: 0,
    payout: 0,
    currency: 'USD',
    entrySpot,
    entrySpotTime: entryTime,
    currentSpot: entrySpot,
    exitSpot: null,
    exitSpotTime: null,
    purchaseTime: entryTime,
    dateStart: entryTime,
    dateExpiry: null,
    sellTime: null,
    tickCount: null,
    ticksObserved: 0,
    multiplier,
    stopOutPrice: null,
    takeProfitPrice: tpPrice,
    stopLossPrice: null,
  };
}

function simulateSymbol(params: {
  spec: MarketSpec;
  live: LiveContractSpec;
  bars: CandlePoint[];
  timeframe: '1h' | '15m';
  evalStartEpoch: number;
}): SimTrade[] {
  const { spec, live, bars, timeframe, evalStartEpoch } = params;
  const trades: SimTrade[] = [];
  const M = live.multiplier;
  const commFrac = live.commissionPer100 / 100;
  const stake = 100;

  let i = 115;
  while (i < bars.length - 2) {
    const closedBarTime = Number(bars[i].time);
    if (closedBarTime < evalStartEpoch) {
      i++;
      continue;
    }

    const windowStart = Math.max(0, i - 248);
    const slice = bars.slice(windowStart, i + 2);
    const ev = evaluateQuantSignal({
      symbol: spec.code,
      market: spec.market,
      bars: slice,
      accountBalance: 10000,
      positions: [],
      riskPctOfBalance: 0.03,
      timeframe: timeframe as QuantTimeframe,
    });

    if (!ev.signalDirection || !ev.signalMode || ev.riskPlan.circuitBreakerTripped) {
      i++;
      continue;
    }

    const dir = ev.signalDirection === 'rise' ? 1 : -1;
    const mode = ev.signalMode;
    const entryBar = bars[i + 1];
    const entry = entryBar.open;
    const entryTime = Number(entryBar.time);
    const recStake = ev.riskPlan.recommendedStake;

    const tpR: number | null =
      ev.riskPlan.recommendedTakeProfit !== null && recStake > 0
        ? ev.riskPlan.recommendedTakeProfit / recStake
        : null;
    const slR: number | null =
      ev.riskPlan.recommendedStopLoss !== null &&
      recStake > 0 &&
      ev.riskPlan.recommendedStopLoss < recStake
        ? -(ev.riskPlan.recommendedStopLoss / recStake)
        : null;

    const koMovePct = (1 - commFrac) / M;
    const tpMovePct = tpR !== null ? (tpR + commFrac) / M : null;
    const slMovePct = slR !== null ? (Math.abs(slR) - commFrac) / M : null;

    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const slPrice =
      slMovePct !== null && slMovePct > 0
        ? dir === 1
          ? entry * (1 - slMovePct)
          : entry * (1 + slMovePct)
        : null;
    const tpPrice =
      tpMovePct !== null
        ? dir === 1
          ? entry * (1 + tpMovePct)
          : entry * (1 - tpMovePct)
        : null;

    const dummyPos = makeDummyOpenPos(
      spec.code,
      ev.signalDirection,
      M,
      entryTime,
      entry,
      stake,
      tpPrice,
    );

    let exitIdx = bars.length - 1;
    let exitPrice = bars[exitIdx].close;
    let exitReason: SimTrade['exitReason'] = 'END';
    let pnlR = Math.max(-1, M * dir * ((exitPrice - entry) / entry) - commFrac);

    for (let j = i + 1; j < bars.length - 1; j++) {
      const b = bars[j];

      // 1. Pessimistic -1R KO check first
      if ((dir === 1 && b.low <= koPrice) || (dir === -1 && b.high >= koPrice)) {
        exitIdx = j;
        exitPrice = koPrice;
        exitReason = 'KO';
        pnlR = -1;
        break;
      }

      // 2. Optional stop-loss check (if configured tighter than stake)
      if (
        slPrice !== null &&
        slR !== null &&
        ((dir === 1 && b.low <= slPrice) || (dir === -1 && b.high >= slPrice))
      ) {
        exitIdx = j;
        exitPrice = slPrice;
        exitReason = 'SL';
        pnlR = slR;
        break;
      }

      // 3. TP check (for MR trades with fixed take profit)
      if (
        tpPrice !== null &&
        tpR !== null &&
        ((dir === 1 && b.high >= tpPrice) || (dir === -1 && b.low <= tpPrice))
      ) {
        exitIdx = j;
        exitPrice = tpPrice;
        exitReason = 'TP';
        pnlR = tpR;
        break;
      }

      // 4. Exact live trailing EMA(30) / RSI exit on closed candle j
      const exitWindow = bars.slice(Math.max(0, j - 248), j + 2);
      const exitEv = evaluateQuantSignal({
        symbol: spec.code,
        market: spec.market,
        bars: exitWindow,
        accountBalance: 10000,
        positions: [dummyPos],
        riskPctOfBalance: 0.03,
        timeframe: timeframe as QuantTimeframe,
      });

      if (exitEv.exitSignalForOpenPosition.shouldExit) {
        exitIdx = j + 1;
        exitPrice = bars[j + 1].open;
        exitReason = 'TRAIL';
        pnlR = Math.max(-1, M * dir * ((exitPrice - entry) / entry) - commFrac);
        break;
      }
    }

    trades.push({
      symbol: spec.code,
      engine: timeframe,
      direction: ev.signalDirection,
      mode,
      multiplier: M,
      entryTime,
      exitTime: Number(bars[exitIdx].time),
      entryPrice: entry,
      exitPrice,
      tpR,
      pnlR,
      exitReason,
      barsHeld: Math.max(1, exitIdx - (i + 1)),
    });

    i = exitIdx + 1;
  }

  return trades;
}

function summarizeTrades(trades: SimTrade[], days: number) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0);
  const losses = trades.filter((t) => t.pnlR <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlR, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const netR = grossWin - grossLoss;
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  let eq = 0;
  let peak = 0;
  let maxDdR = 0;
  let curStreak = 0;
  let maxStreak = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    eq += t.pnlR;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDdR) maxDdR = dd;
    if (t.pnlR < 0) {
      curStreak++;
      if (curStreak > maxStreak) maxStreak = curStreak;
    } else if (t.pnlR > 0) {
      curStreak = 0;
    }
  }

  return {
    n,
    tradesPerMo: Number(((n / days) * 30.4375).toFixed(1)),
    winRate: n > 0 ? Number(((wins.length / n) * 100).toFixed(1)) : 0,
    netR: Number(netR.toFixed(2)),
    avgR: n > 0 ? Number((netR / n).toFixed(3)) : 0,
    pf: Number(pf.toFixed(2)),
    maxDdR: Number(maxDdR.toFixed(2)),
    maxStreak,
    tpCount: trades.filter((t) => t.exitReason === 'TP').length,
    trailCount: trades.filter((t) => t.exitReason === 'TRAIL').length,
    koCount: trades.filter((t) => t.exitReason === 'KO').length,
    trendCount: trades.filter((t) => t.mode === 'trend').length,
    mrCount: trades.filter((t) => t.mode === 'mr').length,
  };
}

function simulatePortfolio(
  trades: SimTrade[],
  initialEquity = 1000,
  riskFrac = 0.03,
  yearsSpan = 5,
) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const symbolStreaks = new Map<string, number>();
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDdPct = 0;
  let taken = 0;
  let skippedMaxOpen = 0;
  let curGlobalStreak = 0;
  let maxGlobalStreak = 0;

  const monthlyMap = new Map<
    string,
    { startEq: number; endEq: number; trades: number; wins: number; netR: number }
  >();

  const settledTrades: Array<SimTrade & { stake: number; pnlUsd: number; equityAfter: number }> = [];

  const closeTrade = (c: SimTrade & { stake: number }) => {
    const pnlUsd = c.stake * c.pnlR;
    const eqBefore = equity;
    equity += pnlUsd;
    if (equity > peak) peak = equity;
    const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;

    const prev = symbolStreaks.get(c.symbol) ?? 0;
    if (c.pnlR < 0) {
      symbolStreaks.set(c.symbol, prev + 1);
      curGlobalStreak++;
      if (curGlobalStreak > maxGlobalStreak) maxGlobalStreak = curGlobalStreak;
    } else if (c.pnlR > 0) {
      symbolStreaks.set(c.symbol, 0);
      curGlobalStreak = 0;
    }

    const mk = new Date(c.exitTime * 1000).toISOString().slice(0, 7);
    const m = monthlyMap.get(mk) ?? {
      startEq: eqBefore,
      endEq: eqBefore,
      trades: 0,
      wins: 0,
      netR: 0,
    };
    m.endEq = equity;
    m.trades += 1;
    if (c.pnlR > 0) m.wins += 1;
    m.netR += c.pnlR;
    monthlyMap.set(mk, m);

    settledTrades.push({ ...c, pnlUsd, equityAfter: equity });
  };

  const active: Array<SimTrade & { stake: number }> = [];
  for (const t of sorted) {
    const toClose = active
      .filter((a) => a.exitTime <= t.entryTime)
      .sort((a, b) => a.exitTime - b.exitTime);
    for (const c of toClose) {
      const idx = active.indexOf(c);
      if (idx >= 0) active.splice(idx, 1);
      closeTrade(c);
    }

    if (active.some((a) => a.symbol === t.symbol) || active.length >= 3) {
      skippedMaxOpen++;
      continue;
    }

    const streak = symbolStreaks.get(t.symbol) ?? 0;
    const effRisk = streak >= 2 ? riskFrac * 0.5 : riskFrac;
    const stake = Math.max(1, Number((equity * effRisk).toFixed(2)));
    active.push({ ...t, stake });
    taken++;
  }

  for (const c of active.sort((a, b) => a.exitTime - b.exitTime)) {
    closeTrade(c);
  }

  const retPct = ((equity - initialEquity) / initialEquity) * 100;
  const cagrPct =
    yearsSpan > 0 && equity > 0
      ? (Math.pow(equity / initialEquity, 1 / yearsSpan) - 1) * 100
      : 0;
  const monthEntries = Array.from(monthlyMap.values());
  const posMonths = monthEntries.filter((m) => m.endEq > m.startEq).length;

  return {
    initialEquity,
    finalEquity: Number(equity.toFixed(2)),
    retPct: Number(retPct.toFixed(2)),
    cagrPct: Number(cagrPct.toFixed(2)),
    maxDdPct: Number(maxDdPct.toFixed(2)),
    maxGlobalStreak,
    taken,
    skippedMaxOpen,
    posMonths,
    totalActiveMonths: monthEntries.length,
    settledTrades,
  };
}

function buildRollingYearBreakdown(
  settled: Array<SimTrade & { stake: number; pnlUsd: number; equityAfter: number }>,
  evalStartEpoch: number,
  evalEndEpoch: number,
  initialEquity = 1000,
) {
  const yearSec = 365.25 * 86400;
  const rows: Array<{
    label: string;
    trades: number;
    wins: number;
    winRate: number;
    netR: number;
    startEq: number;
    endEq: number;
    retPct: number;
    maxDdPct: number;
  }> = [];

  let prevEq = initialEquity;
  for (let y = 0; y < 5; y++) {
    const a = evalStartEpoch + y * yearSec;
    const b = y === 4 ? evalEndEpoch + 1 : evalStartEpoch + (y + 1) * yearSec;
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
    const wins = slice.filter((t) => t.pnlR > 0).length;
    const netR = slice.reduce((s, t) => s + t.pnlR, 0);
    rows.push({
      label: `Y${y + 1} (${startLabel}..${endLabel})`,
      trades: slice.length,
      wins,
      winRate: slice.length > 0 ? Number(((wins / slice.length) * 100).toFixed(1)) : 0,
      netR: Number(netR.toFixed(2)),
      startEq: Number(startEq.toFixed(2)),
      endEq: Number(endEq.toFixed(2)),
      retPct: Number((((endEq - startEq) / startEq) * 100).toFixed(1)),
      maxDdPct: Number(maxDd.toFixed(2)),
    });
  }
  return rows;
}

async function main() {
  const client = new DerivBacktestClient();
  await client.connect();

  const nowSec = Math.floor(Date.now() / 1000);
  const fiveYearsDays = 1826; // 5 full years including 2024 leap year
  const oneYearDays = 365;
  const eval5yStart = nowSec - fiveYearsDays * 86400;
  const fetch5yStart = eval5yStart - 250 * 3600; // warmup
  const eval1yStart = nowSec - oneYearDays * 86400;

  console.log(`\n=== EXACT LIVE ALGORITHM — 5-YEAR BACKTEST (${fiveYearsDays} days @ 3.0% stake) ===`);
  console.log(
    `5Y Window: ${new Date(eval5yStart * 1000).toISOString().slice(0, 10)} -> ${new Date(nowSec * 1000).toISOString().slice(0, 10)}`,
  );
  console.log(
    `1Y Deriv Overlap Window: ${new Date(eval1yStart * 1000).toISOString().slice(0, 10)} -> ${new Date(nowSec * 1000).toISOString().slice(0, 10)}\n`,
  );

  // 1. Live Deriv multiplier leverage & proposal fee model
  const specs1h = new Map<string, LiveContractSpec>();
  for (const m of BASKET_1H) {
    const s = await fetchLiveSpec(
      client,
      m.code,
      40,
      m.code === 'cryETHUSD' ? 7.99 : m.code === 'frxXAUUSD' ? 2.5 : 2.99,
    );
    specs1h.set(m.code, s);
    console.log(
      `[Live Spec 1H] ${m.code}: supportsMult=${s.supportsMult}, mult=${s.multiplier}x, comm=${s.commissionPer100.toFixed(2)}%/100 (${s.commissionSource})`,
    );
  }
  const specs15m = new Map<string, LiveContractSpec>();
  for (const m of BASKET_15M) {
    const s = await fetchLiveSpec(client, m.code, 40, 2.99);
    specs15m.set(m.code, s);
    console.log(
      `[Live Spec 15M] ${m.code}: supportsMult=${s.supportsMult}, mult=${s.multiplier}x, comm=${s.commissionPer100.toFixed(2)}%/100 (${s.commissionSource})`,
    );
  }

  // 2. Fetch 5Y 1H datasets from Binance for active 1H Multiplier markets (excl. unsupported OTC_NDX)
  console.log('\n--- SECTION A: 5-YEAR 1H MACRO ENGINE (2021-11-11 -> 2026-11-11, Binance Spot + Live Deriv Fees) ---');
  const trades1h5y: SimTrade[] = [];
  const active1hMarkets = BASKET_1H.filter((m) => specs1h.get(m.code)?.supportsMult && m.binanceSymbol);

  for (const m of active1hMarkets) {
    const live = specs1h.get(m.code)!;
    const bars = await fetchBinance1h(
      m.binanceSymbol!,
      fetch5yStart,
      nowSec,
      Boolean(m.fxHoursOnly),
    );
    const firstD = new Date(Number(bars[0].time) * 1000).toISOString().slice(0, 10);
    const lastD = new Date(Number(bars[bars.length - 1].time) * 1000).toISOString().slice(0, 10);
    const symTrades = simulateSymbol({
      spec: m,
      live,
      bars,
      timeframe: '1h',
      evalStartEpoch: eval5yStart,
    });
    trades1h5y.push(...symTrades);
    const sum = summarizeTrades(symTrades, fiveYearsDays);
    console.log(
      `[5Y 1H] ${m.code.padEnd(10)} (${m.binanceSymbol}${m.fxHoursOnly ? ' FX24/5' : ''}): ${bars.length} bars (${firstD}..${lastD}) -> trades=${sum.n} (${sum.tradesPerMo}/mo), WR=${sum.winRate}%, Net=${sum.netR >= 0 ? '+' : ''}${sum.netR}R, PF=${sum.pf}, MaxDD=${sum.maxDdR}R, MaxStreak=${sum.maxStreak}L (Trend=${sum.trendCount}, MR=${sum.mrCount}, TP=${sum.tpCount}, TRAIL=${sum.trailCount}, KO=${sum.koCount})`,
    );
  }

  // 5-Year compounding @ 3.0% stake
  const p5y1000 = simulatePortfolio(trades1h5y, 1000, 0.03, 5);
  console.log('\n--- 5-YEAR 1H MACRO PORTFOLIO @ 3.0% STAKE (Max 3 Open, 2-Loss 50% Throttle) ---');
  for (const startCap of [100, 1000, 10000]) {
    const pf = simulatePortfolio(trades1h5y, startCap, 0.03, 5);
    console.log(
      `  Start $${startCap}: Final=$${pf.finalEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pf.retPct >= 0 ? '+' : ''}${pf.retPct}% | CAGR ${pf.cagrPct >= 0 ? '+' : ''}${pf.cagrPct}%/yr) | MaxDD=-${pf.maxDdPct}% | MaxStreak=${pf.maxGlobalStreak}L | ProfitableMos=${pf.posMonths}/${pf.totalActiveMonths} | Taken=${pf.taken}, SkippedCap=${pf.skippedMaxOpen}`,
    );
  }

  console.log('\n--- 5-YEAR YEAR-BY-YEAR BREAKDOWN ($1,000 START @ 3.0% STAKE) ---');
  for (const yr of buildRollingYearBreakdown(
    p5y1000.settledTrades,
    eval5yStart,
    nowSec,
    1000,
  )) {
    console.log(
      `  ${yr.label}: trades=${yr.trades}, WR=${yr.winRate}%, NetR=${yr.netR >= 0 ? '+' : ''}${yr.netR}R, $${yr.startEq} -> $${yr.endEq} (${yr.retPct >= 0 ? '+' : ''}${yr.retPct}%), MaxDD=-${yr.maxDdPct}%`,
    );
  }

  // 3. Validate Deriv Native 1Y vs Binance Proxy 1Y (2025-11-11 -> 2026-11-11) & Full 365-Day Deriv 15M Synthetics
  console.log('\n--- SECTION B: 1-YEAR OVERLAP VALIDATION (DERIV NATIVE VS BINANCE) & FULL 365D SYNTHETICS ---');
  client.close();
  const derivHistClient = new DerivBacktestClient();
  await derivHistClient.connect();
  const tradesDeriv1h1y: SimTrade[] = [];
  const tradesBinance1h1y = trades1h5y.filter((t) => t.entryTime >= eval1yStart);

  for (const m of active1hMarkets) {
    const live = specs1h.get(m.code)!;
    await derivHistClient.reconnectIfClosed();
    const { bars, stopReason } = await fetchDerivCandles(derivHistClient, m.code, 3600, 365, 16);
    const firstD = bars[0] ? new Date(Number(bars[0].time) * 1000).toISOString().slice(0, 10) : 'none';
    const lastD = bars.at(-1) ? new Date(Number(bars.at(-1)!.time) * 1000).toISOString().slice(0, 10) : 'none';
    const symTrades = simulateSymbol({
      spec: m,
      live,
      bars,
      timeframe: '1h',
      evalStartEpoch: eval1yStart,
    });
    tradesDeriv1h1y.push(...symTrades);
    const sumD = summarizeTrades(symTrades, oneYearDays);
    const sumB = summarizeTrades(
      tradesBinance1h1y.filter((t) => t.symbol === m.code),
      oneYearDays,
    );
    console.log(
      `[1Y Overlap] ${m.code}: Deriv=${bars.length}b (${firstD}..${lastD}, stop=${stopReason}) -> trades=${sumD.n}, WR=${sumD.winRate}%, Net=${sumD.netR >= 0 ? '+' : ''}${sumD.netR}R | BinanceProxy -> trades=${sumB.n}, WR=${sumB.winRate}%, Net=${sumB.netR >= 0 ? '+' : ''}${sumB.netR}R`,
    );
  }

  const tradesDeriv15m1y: SimTrade[] = [];
  for (const m of BASKET_15M) {
    const live = specs15m.get(m.code)!;
    await derivHistClient.reconnectIfClosed();
    const { bars, stopReason } = await fetchDerivCandles(derivHistClient, m.code, 900, 365, 42);
    const firstEp = Number(bars[0]?.time ?? nowSec);
    const lastEp = Number(bars.at(-1)?.time ?? nowSec);
    const actualDays = Math.max(1, Math.round((lastEp - firstEp) / 86400));
    const symTrades = simulateSymbol({
      spec: m,
      live,
      bars,
      timeframe: '15m',
      evalStartEpoch: eval1yStart,
    });
    tradesDeriv15m1y.push(...symTrades);
    const sum = summarizeTrades(symTrades, actualDays);
    console.log(
      `[Max Deriv 15M] ${m.code}: ${bars.length} bars (~${actualDays}d, ${new Date(firstEp * 1000).toISOString().slice(0, 10)}..${new Date(lastEp * 1000).toISOString().slice(0, 10)}, stop=${stopReason}) -> trades=${sum.n}, WR=${sum.winRate}%, Net=${sum.netR >= 0 ? '+' : ''}${sum.netR}R, PF=${sum.pf}, MaxDD=${sum.maxDdR}R, MaxStreak=${sum.maxStreak}L`,
    );
  }

  const pfDeriv1h1y = simulatePortfolio(tradesDeriv1h1y, 1000, 0.03, 1);
  const pfBinance1h1y = simulatePortfolio(tradesBinance1h1y, 1000, 0.03, 1);
  const pfDeriv15m1y = simulatePortfolio(tradesDeriv15m1y, 1000, 0.03, 1);
  const pfDerivDual1y = simulatePortfolio(
    [...tradesDeriv1h1y, ...tradesDeriv15m1y],
    1000,
    0.03,
    1,
  );

  console.log('\n--- 1-YEAR PORTFOLIO VALIDATION ($1,000 START @ 3.0% STAKE) ---');
  console.log(
    `  1H Macro (Deriv Exact 365d): $${pfDeriv1h1y.finalEquity} (${pfDeriv1h1y.retPct >= 0 ? '+' : ''}${pfDeriv1h1y.retPct}%, MaxDD -${pfDeriv1h1y.maxDdPct}%, taken=${pfDeriv1h1y.taken})`,
  );
  console.log(
    `  1H Macro (Binance Proxy 365d): $${pfBinance1h1y.finalEquity} (${pfBinance1h1y.retPct >= 0 ? '+' : ''}${pfBinance1h1y.retPct}%, MaxDD -${pfBinance1h1y.maxDdPct}%, taken=${pfBinance1h1y.taken})`,
  );
  console.log(
    `  15M Turbo Synthetics (Deriv Full 365d): $${pfDeriv15m1y.finalEquity} (${pfDeriv15m1y.retPct >= 0 ? '+' : ''}${pfDeriv15m1y.retPct}%, MaxDD -${pfDeriv15m1y.maxDdPct}%, taken=${pfDeriv15m1y.taken})`,
  );
  console.log(
    `  Dual (15M+1H Combined Deriv 365d): $${pfDerivDual1y.finalEquity} (${pfDerivDual1y.retPct >= 0 ? '+' : ''}${pfDerivDual1y.retPct}%, MaxDD -${pfDerivDual1y.maxDdPct}%, taken=${pfDerivDual1y.taken}, skippedCap=${pfDerivDual1y.skippedMaxOpen})`,
  );

  derivHistClient.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
