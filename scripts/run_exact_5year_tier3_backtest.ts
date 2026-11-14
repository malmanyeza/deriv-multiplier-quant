import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateQuantSignal,
  getRatchetFloorForPeakR,
  getSymbolStrategyProfile,
  type QuantTimeframe,
} from '../src/services/quantStrategyEngine.ts';
import type { CandlePoint } from '../src/services/chartFeed.ts';
import type { NormalizedPosition } from '../src/types/deriv.ts';

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
  exitReason: 'TP' | 'RATCHET' | 'TRAIL' | 'MR_RSI' | 'KO' | 'END';
  barsHeld: number;
}

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
  const file = path.join(
    CACHE_DIR,
    `binance_${binanceSymbol}_1h_1635768131_1794434531.json`,
  );
  const raw: CandlePoint[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  return fxHoursOnly ? raw.filter((b) => isGoldFxTradingHour(Number(b.time))) : raw;
}

function loadDeriv1Y(sym: string, gran: number): CandlePoint[] {
  const file = path.join(CACHE_DIR, `deriv_1y_${sym}_${gran}.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function simulateExactLiveEngine(params: {
  symbol: string;
  market: string;
  bars: CandlePoint[];
  timeframe: QuantTimeframe;
  M: number;
  commFrac: number;
  evalStartEpoch: number;
}): SimTrade[] {
  const { symbol, market, bars, timeframe, M, commFrac, evalStartEpoch } = params;
  const trades: SimTrade[] = [];
  const stake = 100;

  let i = 220;
  while (i < bars.length - 2) {
    const closedBarTime = Number(bars[i].time);
    if (closedBarTime < evalStartEpoch) {
      i++;
      continue;
    }

    const windowStart = Math.max(0, i - 300);
    const slice = bars.slice(windowStart, i + 2);
    const ev = evaluateQuantSignal({
      symbol,
      market,
      bars: slice,
      accountBalance: 10000,
      positions: [],
      riskPctOfBalance: 0.03,
      timeframe,
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

    const getPriceForR = (rTarget: number) => {
      const movePct = (rTarget + commFrac) / M;
      return dir === 1 ? entry * (1 + movePct) : entry * (1 - movePct);
    };

    const koPrice = getPriceForR(-1.0);
    const tpPrice = tpR !== null ? getPriceForR(tpR) : null;

    let activeStopR = -1.0;
    let activeStopPrice = koPrice;
    let peakR = 0;

    const dummyPos = makeDummyOpenPos(
      symbol,
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

      // 1. Hardware -1R KO check
      if ((dir === 1 && b.low <= koPrice) || (dir === -1 && b.high >= koPrice)) {
        exitIdx = j;
        exitReason = 'KO';
        pnlR = -1.0;
        break;
      }

      // 2. Armed Profit-Ratchet floor check
      if (
        activeStopR > 0 &&
        ((dir === 1 && b.low <= activeStopPrice) || (dir === -1 && b.high >= activeStopPrice))
      ) {
        exitIdx = j;
        exitReason = 'RATCHET';
        pnlR = activeStopR;
        break;
      }

      // 3. Hardware Take-Profit check (+2.0R on 15M Trend, +1.2R on 15M MR)
      if (
        tpPrice !== null &&
        tpR !== null &&
        ((dir === 1 && b.high >= tpPrice) || (dir === -1 && b.low <= tpPrice))
      ) {
        exitIdx = j;
        exitReason = 'TP';
        pnlR = tpR;
        break;
      }

      // 4. Update Peak R from candle High/Low and arm Two-Stage Profit-Ratchet
      const favMove = dir === 1 ? (b.high - entry) / entry : (entry - b.low) / entry;
      const favR = M * favMove - commFrac;
      if (favR > peakR) peakR = favR;
      const ratchetCheck = getRatchetFloorForPeakR(symbol, timeframe, peakR);
      if (ratchetCheck && ratchetCheck.floorR > activeStopR) {
        activeStopR = ratchetCheck.floorR;
        activeStopPrice = getPriceForR(activeStopR);
      }

      // 5. Exact live evaluateQuantSignal exit on closed candle j
      const closeMove = dir === 1 ? (b.close - entry) / entry : (entry - b.close) / entry;
      const closeR = M * closeMove - commFrac;
      dummyPos.profit = stake * closeR;
      dummyPos.profitPercentage = closeR * 100;
      dummyPos.currentSpot = b.close;

      const exitWindow = bars.slice(Math.max(0, j - 300), j + 2);
      const exitEv = evaluateQuantSignal({
        symbol,
        market,
        bars: exitWindow,
        accountBalance: 10000,
        positions: [dummyPos],
        riskPctOfBalance: 0.03,
        timeframe,
        peakRByContract: new Map([[dummyPos.contractId, peakR]]),
      });

      if (exitEv.exitSignalForOpenPosition.shouldExit) {
        exitIdx = j + 1;
        exitPrice = bars[j + 1].open;
        const isRatchetExit =
          exitEv.exitSignalForOpenPosition.reason.includes('Profit-Ratchet');
        exitReason = isRatchetExit ? 'RATCHET' : mode === 'mr' ? 'MR_RSI' : 'TRAIL';
        pnlR = isRatchetExit
          ? activeStopR > 0
            ? activeStopR
            : Math.max(-1, M * dir * ((exitPrice - entry) / entry) - commFrac)
          : Math.max(-1, M * dir * ((exitPrice - entry) / entry) - commFrac);
        break;
      }
    }

    trades.push({
      symbol,
      engine: timeframe,
      mode,
      direction: ev.signalDirection,
      entryTime,
      exitTime: Number(bars[exitIdx].time),
      pnlR,
      exitReason,
      barsHeld: Math.max(1, exitIdx - (i + 1)),
    });

    i = exitIdx + 1;
  }

  return trades;
}

function summarizeTrades(trades: SimTrade[], years: number) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0);
  const losses = trades.filter((t) => t.pnlR <= 0);
  const gw = wins.reduce((s, t) => s + t.pnlR, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const netR = gw - gl;
  const pf = gl > 0 ? gw / gl : 0;
  return {
    n,
    perMo: Number((n / (years * 12)).toFixed(1)),
    winRate: n > 0 ? Number(((wins.length / n) * 100).toFixed(1)) : 0,
    pf: Number(pf.toFixed(2)),
    netR: Number(netR.toFixed(2)),
    ratchets: trades.filter((t) => t.exitReason === 'RATCHET').length,
    trails: trades.filter((t) => t.exitReason === 'TRAIL').length,
    tps: trades.filter((t) => t.exitReason === 'TP').length,
    kos: trades.filter((t) => t.exitReason === 'KO').length,
  };
}

function simulatePortfolio(
  trades: SimTrade[],
  initialEquity = 1000,
  baseRisk = 0.03,
  yearsSpan = 5,
) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDdPct = 0;
  let taken = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;

  const settled: Array<SimTrade & { stake: number; pnlUsd: number; equityAfter: number }> = [];
  const active: Array<SimTrade & { stake: number }> = [];

  const closeTrade = (c: SimTrade & { stake: number }) => {
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
    if (active.some((a) => a.symbol === t.symbol) || active.length >= 4) {
      continue;
    }
    const profile = getSymbolStrategyProfile(t.symbol, t.engine);
    const effRisk = baseRisk * profile.convictionWeight;
    const stake = Math.max(1, Number((equity * effRisk).toFixed(2)));
    active.push({ ...t, stake });
    taken++;
  }
  for (const c of active.sort((a, b) => a.exitTime - b.exitTime)) {
    closeTrade(c);
  }

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
    pf: gl > 0 ? Number((gw / gl).toFixed(2)) : 0,
    netR: Number((gw - gl).toFixed(2)),
    settled,
  };
}

function main() {
  const btc5y = loadBinance5Y('BTCUSDT', false);
  const eth5y = loadBinance5Y('ETHUSDT', false);
  const xau5y = loadBinance5Y('PAXGUSDT', true);
  const xag1y = loadDeriv1Y('frxXAGUSD', 3600);
  const v100_1y = loadDeriv1Y('1HZ100V', 900);
  const r75_1y = loadDeriv1Y('R_75', 900);

  const end5ySec = Number(btc5y.at(-1)!.time);
  const eval5yStart = end5ySec - 1826 * 86400;
  const eval1yStart = Number(v100_1y.at(-1)!.time) - 365 * 86400;

  console.log('Running Exact Live evaluateQuantSignal() 5-Year Backtest...');
  const tBtc = simulateExactLiveEngine({ symbol: 'cryBTCUSD', market: 'cryptocurrency', bars: btc5y, timeframe: '1h', M: 50, commFrac: 0.0299, evalStartEpoch: eval5yStart });
  const tEth = simulateExactLiveEngine({ symbol: 'cryETHUSD', market: 'cryptocurrency', bars: eth5y, timeframe: '1h', M: 50, commFrac: 0.0799, evalStartEpoch: eval5yStart });
  const tXau = simulateExactLiveEngine({ symbol: 'frxXAUUSD', market: 'commodities', bars: xau5y, timeframe: '1h', M: 100, commFrac: 0.025, evalStartEpoch: eval5yStart });
  const tXag = simulateExactLiveEngine({ symbol: 'frxXAGUSD', market: 'commodities', bars: xag1y, timeframe: '1h', M: 100, commFrac: 0.048, evalStartEpoch: eval1yStart });
  const tV100 = simulateExactLiveEngine({ symbol: '1HZ100V', market: 'synthetic_index', bars: v100_1y, timeframe: '15m', M: 40, commFrac: 0.0205, evalStartEpoch: eval1yStart });
  const tR75 = simulateExactLiveEngine({ symbol: 'R_75', market: 'synthetic_index', bars: r75_1y, timeframe: '15m', M: 50, commFrac: 0.0227, evalStartEpoch: eval1yStart });

  for (const [label, tr, yrs] of [
    ['cryBTCUSD (1H, 5Y)', tBtc, 5],
    ['cryETHUSD (1H, 5Y)', tEth, 5],
    ['frxXAUUSD (1H, 5Y)', tXau, 5],
    ['frxXAGUSD (1H, 1Y)', tXag, 1],
    ['1HZ100V   (15M, 1Y)', tV100, 1],
    ['R_75      (15M, 1Y)', tR75, 1],
  ] as const) {
    const s = summarizeTrades(tr, yrs);
    console.log(
      `  • ${label.padEnd(22)} | Trades=${String(s.n).padStart(4)} (${String(s.perMo).padStart(4)}/mo) | WR=${String(s.winRate).padStart(5)}% | PF=${s.pf.toFixed(2)} | NetR=${(s.netR >= 0 ? '+' : '') + s.netR.toFixed(2)}R | Ratchet=${s.ratchets}, Trail=${s.trails}, TP=${s.tps}, KO=${s.kos}`,
    );
  }

  const macro5y = simulatePortfolio([...tBtc, ...tEth, ...tXau], 1000, 0.03, 5);
  const full5y = simulatePortfolio([...tBtc, ...tEth, ...tXau, ...tXag, ...tV100, ...tR75], 1000, 0.03, 5);
  console.log('\nExact evaluateQuantSignal 5Y Macro Only ($1,000):', {
    trades: macro5y.taken,
    winRate: macro5y.winRate,
    pf: macro5y.pf,
    netR: macro5y.netR,
    finalEquity: macro5y.finalEquity,
    cagrPct: macro5y.cagrPct,
    maxDdPct: macro5y.maxDdPct,
  });
  console.log('Exact evaluateQuantSignal 5Y Full Combined ($1,000):', {
    trades: full5y.taken,
    winRate: full5y.winRate,
    pf: full5y.pf,
    netR: full5y.netR,
    finalEquity: full5y.finalEquity,
    cagrPct: full5y.cagrPct,
    maxDdPct: full5y.maxDdPct,
  });

  const yearSec = 365.25 * 86400;
  for (const [title, pfObj, endEpoch] of [
    ['5-YEAR 1H MACRO CORE ONLY (BTC + ETH + GOLD, 2021-2026)', macro5y, end5ySec],
    ['5-YEAR FULL COMBINED PORTFOLIO (5Y MACRO + 1Y DERIV SYNTHETICS & SILVER)', full5y, Number(v100_1y.at(-1)!.time)],
  ] as const) {
    console.log(`\n=== ${title} ===`);
    let prevEq = 1000;
    for (let y = 0; y < 5; y++) {
      const a = eval5yStart + y * yearSec;
      const b = y === 4 ? endEpoch + 86400 * 5 : eval5yStart + (y + 1) * yearSec;
      const slice = pfObj.settled.filter((t) => t.exitTime >= a && t.exitTime < b);
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
      const wr = slice.length > 0 ? ((wins.length / slice.length) * 100).toFixed(1) : '0.0';
      const retPct = (((endEq - startEq) / startEq) * 100).toFixed(1);
      console.log(
        `  Year ${y + 1} (${startLabel}..${endLabel}): Trades=${String(slice.length).padStart(3)} | WR=${wr.padStart(5)}% | PF=${pf.toFixed(2)} | NetR=${(netR >= 0 ? '+' : '') + netR.toFixed(2).padStart(6)}R | $${startEq.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} -> $${endEq.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${Number(retPct) >= 0 ? '+' : ''}${retPct}%) | MaxDD=-${maxDd.toFixed(2)}%`,
      );
    }
  }
}

main();
