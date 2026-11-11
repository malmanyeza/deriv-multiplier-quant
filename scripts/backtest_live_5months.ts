import 'dotenv/config';
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
}

const BASKET_1H: MarketSpec[] = [
  { code: 'cryBTCUSD', name: 'BTC/USD', market: 'cryptocurrency' },
  { code: 'cryETHUSD', name: 'ETH/USD', market: 'cryptocurrency' },
  { code: 'frxXAUUSD', name: 'Gold XAU/USD', market: 'commodities' },
  { code: 'OTC_NDX', name: 'US Tech 100', market: 'indices' },
];

const BASKET_15M: MarketSpec[] = [
  { code: '1HZ100V', name: 'Vol 100 (1s)', market: 'synthetic_index' },
  { code: 'R_75', name: 'Volatility 75', market: 'synthetic_index' },
];

interface LiveContractSpec {
  symbol: string;
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
  exitReason: 'TP' | 'KO' | 'TRAIL' | 'END';
  barsHeld: number;
}

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

  close(): void {
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
  const multEntries = (cf.contracts_for?.available ?? []).filter(
    (c: any) => c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN',
  );
  const multSet = new Set<number>();
  for (const e of multEntries) {
    if (Array.isArray(e.multiplier_range)) {
      for (const m of e.multiplier_range) {
        const n = Number(m);
        if (Number.isFinite(n) && n > 0) multSet.add(n);
      }
    }
  }
  const range = Array.from(multSet).sort((a, b) => a - b);
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
    // Keep fallback when market closed or proposal rejected
  }

  return { symbol, multiplier, multiplierRange: range, commissionPer100, commissionSource };
}

async function fetchCandlesMonths(
  client: DerivBacktestClient,
  symbol: string,
  granularity: number,
  days = 150,
): Promise<CandlePoint[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const startCutoff = nowSec - days * 86400;
  const byEpoch = new Map<number, CandlePoint>();
  let endCursor: number | 'latest' = 'latest';

  for (let page = 0; page < 12; page++) {
    const res = await client.request({
      ticks_history: symbol,
      style: 'candles',
      granularity,
      count: 4000,
      end: endCursor,
    });
    const batch = normalizeCandleHistory(res.candles);
    if (batch.length === 0) break;

    let oldest = Infinity;
    for (const c of batch) {
      const t = Number(c.time);
      byEpoch.set(t, c);
      if (t < oldest) oldest = t;
    }

    if (oldest <= startCutoff || batch.length < 10) break;
    const nextEnd = oldest - 1;
    if (typeof endCursor === 'number' && nextEnd >= endCursor) break;
    endCursor = nextEnd;
  }

  return Array.from(byEpoch.values())
    .filter((c) => Number(c.time) >= startCutoff - 250 * granularity) // keep warmup bars prior to 5m window
    .sort((a, b) => Number(a.time) - Number(b.time));
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
    const windowStart = Math.max(0, i - 248);
    const closedBarTime = Number(bars[i].time);
    if (closedBarTime < evalStartEpoch) {
      i++;
      continue;
    }

    // Pass trailing <= 250 bars ending with forming bar `bars[i+1]` so `evaluateQuantSignal` inspects `bars[i]`
    const slice = bars.slice(windowStart, i + 2);
    const ev = evaluateQuantSignal({
      symbol: spec.code,
      market: spec.market,
      bars: slice,
      accountBalance: 10000,
      positions: [],
      riskPctOfBalance: 0.0075,
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
    const tpR: number | null =
      ev.riskPlan.recommendedTakeProfit !== null && ev.riskPlan.recommendedStake > 0
        ? ev.riskPlan.recommendedTakeProfit / ev.riskPlan.recommendedStake
        : null;

    const koMovePct = (1 - commFrac) / M;
    const tpMovePct = tpR !== null ? (tpR + commFrac) / M : null;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
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
      // 1. Pessimistic -1R KO check
      if ((dir === 1 && b.low <= koPrice) || (dir === -1 && b.high >= koPrice)) {
        exitIdx = j;
        exitPrice = koPrice;
        exitReason = 'KO';
        pnlR = -1;
        break;
      }

      // 2. TP check (only when contract specifies fixed TP, e.g., MR trades)
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

      // 3. Exact live trailing EMA(30) / RSI exit on closed candle `j`
      const exitWindow = bars.slice(Math.max(0, j - 248), j + 2);
      const exitEv = evaluateQuantSignal({
        symbol: spec.code,
        market: spec.market,
        bars: exitWindow,
        accountBalance: 10000,
        positions: [dummyPos],
        riskPctOfBalance: 0.0075,
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

  const tpCount = trades.filter((t) => t.exitReason === 'TP').length;
  const trailCount = trades.filter((t) => t.exitReason === 'TRAIL').length;
  const koCount = trades.filter((t) => t.exitReason === 'KO').length;
  const trendCount = trades.filter((t) => t.mode === 'trend').length;
  const mrCount = trades.filter((t) => t.mode === 'mr').length;

  return {
    n,
    tradesPerMo: Number(((n / days) * 30).toFixed(1)),
    winRate: n > 0 ? Number(((wins.length / n) * 100).toFixed(1)) : 0,
    netR: Number(netR.toFixed(2)),
    avgR: n > 0 ? Number((netR / n).toFixed(3)) : 0,
    pf: Number(pf.toFixed(2)),
    maxDdR: Number(maxDdR.toFixed(2)),
    maxStreak,
    tpCount,
    trailCount,
    koCount,
    trendCount,
    mrCount,
  };
}

function simulatePortfolio(trades: SimTrade[], initialEquity = 1000, riskFrac = 0.0075) {
  // Chronological event replay with max 3 concurrent trades & 50% streak throttle after 2 consecutive losses on symbol
  type Event = { time: number; type: 'open' | 'close'; trade: SimTrade; stake?: number };
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const openQueue: SimTrade[] = [];
  const symbolStreaks = new Map<string, number>();
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDdPct = 0;
  let taken = 0;
  let skippedMaxOpen = 0;

  // Step through all entries chronologically, settling any open trades that closed before current entryTime
  const closeTrade = (t: SimTrade & { stake: number }) => {
    const pnlUsd = t.stake * t.pnlR;
    equity += pnlUsd;
    if (equity > peak) peak = equity;
    const ddPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    const prev = symbolStreaks.get(t.symbol) ?? 0;
    if (t.pnlR < 0) symbolStreaks.set(t.symbol, prev + 1);
    else if (t.pnlR > 0) symbolStreaks.set(t.symbol, 0);
  };

  const active: Array<SimTrade & { stake: number }> = [];
  for (const t of sorted) {
    // Close any active trades whose exitTime <= t.entryTime in exitTime order
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
  return {
    initialEquity,
    finalEquity: Number(equity.toFixed(2)),
    retPct: Number(retPct.toFixed(2)),
    maxDdPct: Number(maxDdPct.toFixed(2)),
    taken,
    skippedMaxOpen,
  };
}

async function main() {
  const client = new DerivBacktestClient();
  await client.connect();

  const days = 150; // ~5 months
  const nowSec = Math.floor(Date.now() / 1000);
  const evalStartEpoch = nowSec - days * 86400;

  console.log(`\n=== LIVE ALGORITHM 5-MONTH BACKTEST (${days} days, NO 0.65R SL, KO=-1R floor) ===`);
  console.log(`Window: ${new Date(evalStartEpoch * 1000).toISOString().slice(0, 10)} -> ${new Date(nowSec * 1000).toISOString().slice(0, 10)}\n`);

  const runBasket = async (
    title: string,
    basket: MarketSpec[],
    timeframe: '1h' | '15m',
    granularity: number,
    preferredMult: number,
  ) => {
    console.log(`\n--- ${title} ---`);
    const allTrades: SimTrade[] = [];

    for (const spec of basket) {
      const fallbackComm = spec.code === 'cryETHUSD' ? 7.99 : spec.code.startsWith('frx') || spec.code.startsWith('OTC_') ? 2.5 : 2.99;
      const live = await fetchLiveSpec(client, spec.code, preferredMult, fallbackComm);
      const bars = await fetchCandlesMonths(client, spec.code, granularity, days);
      const evalBars = bars.filter((b) => Number(b.time) >= evalStartEpoch);
      const firstDate = evalBars[0] ? new Date(Number(evalBars[0].time) * 1000).toISOString().slice(0, 10) : 'n/a';
      const lastDate = evalBars[evalBars.length - 1] ? new Date(Number(evalBars[evalBars.length - 1].time) * 1000).toISOString().slice(0, 10) : 'n/a';
      const spanDays = evalBars.length >= 2 ? Math.max(1, (Number(evalBars[evalBars.length - 1].time) - Number(evalBars[0].time)) / 86400) : days;

      const trades = simulateSymbol({ spec, live, bars, timeframe, evalStartEpoch });
      allTrades.push(...trades);
      const st = summarizeTrades(trades, spanDays);

      console.log(
        `${spec.code.padEnd(10)} | ${live.multiplier}x (comm $${live.commissionPer100.toFixed(2)}/100 [${live.commissionSource}]) | ${evalBars.length} bars (${firstDate}..${lastDate}, ${spanDays.toFixed(0)}d) | N=${st.n} (${st.tradesPerMo}/mo) | WR=${st.winRate}% | Net=${st.netR >= 0 ? '+' : ''}${st.netR}R | PF=${st.pf} | MaxDD=${st.maxDdR}R | MaxLossStrk=${st.maxStreak} | Exits: TP=${st.tpCount} Trail=${st.trailCount} KO=${st.koCount} | Modes: T=${st.trendCount} MR=${st.mrCount}`,
      );
    }

    const total = summarizeTrades(allTrades, days);
    const port1000 = simulatePortfolio(allTrades, 1000, 0.03);
    const port100 = simulatePortfolio(allTrades, 100, 0.03);
    console.log(
      `\nCOMBINED ${title}: N=${total.n} (${total.tradesPerMo}/mo) | WR=${total.winRate}% | Net=${total.netR >= 0 ? '+' : ''}${total.netR}R | Avg=${total.avgR >= 0 ? '+' : ''}${total.avgR}R/trade | PF=${total.pf} | MaxDD=${total.maxDdR}R | MaxLossStrk=${total.maxStreak}`,
    );
    console.log(
      `Portfolio ($1,000 @ 3.0% Stake, max 3 open, 2-loss throttle): $${port1000.initialEquity} -> $${port1000.finalEquity} (${port1000.retPct >= 0 ? '+' : ''}${port1000.retPct}%) | MaxDD=${port1000.maxDdPct}% | Trades=${port1000.taken}`,
    );
    console.log(
      `Portfolio ($100 @ 3.0% Stake / $1.00 min floor, max 3 open, 2-loss throttle): $${port100.initialEquity} -> $${port100.finalEquity} (${port100.retPct >= 0 ? '+' : ''}${port100.retPct}%) | MaxDD=${port100.maxDdPct}% | Trades=${port100.taken}`,
    );
    return allTrades;
  };

  const t1h = await runBasket('1H MACRO BASKET (BASKET_1H on 1h candles)', BASKET_1H, '1h', 3600, 100);
  const t15m = await runBasket('15M TURBO SYNTHETIC BASKET (BASKET_15M on 15m candles)', BASKET_15M, '15m', 900, 30);
  const dualTrades = [...t1h, ...t15m];
  const dualSummary = summarizeTrades(dualTrades, days);
  const dual1000 = simulatePortfolio(dualTrades, 1000, 0.03);
  const dual100 = simulatePortfolio(dualTrades, 100, 0.03);
  console.log(`\n--- COMBINED DUAL-ENGINE (1H + 15M @ 3.0% Stake) ---`);
  console.log(
    `COMBINED DUAL: N=${dualSummary.n} | WR=${dualSummary.winRate}% | Net=${dualSummary.netR >= 0 ? '+' : ''}${dualSummary.netR}R | PF=${dualSummary.pf} | MaxDD=${dualSummary.maxDdR}R`,
  );
  console.log(
    `Dual Portfolio ($1,000 @ 3.0% Stake): $${dual1000.initialEquity} -> $${dual1000.finalEquity} (${dual1000.retPct >= 0 ? '+' : ''}${dual1000.retPct}%) | MaxDD=${dual1000.maxDdPct}% | Trades=${dual1000.taken}`,
  );
  console.log(
    `Dual Portfolio ($100 @ 3.0% Stake / $1.00 min floor): $${dual100.initialEquity} -> $${dual100.finalEquity} (${dual100.retPct >= 0 ? '+' : ''}${dual100.retPct}%) | MaxDD=${dual100.maxDdPct}% | Trades=${dual100.taken}`,
  );
  await runBasket('15M NON-SYNTHETIC COMPARISON (BASKET_1H on 15m candles)', BASKET_1H, '15m', 900, 30);

  client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
