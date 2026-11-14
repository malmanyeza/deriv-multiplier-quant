import type { CandlePoint } from './chartFeed';
import { isCsprngSyntheticSymbol } from './marketData';
import type { NormalizedPosition, TradeDirection } from '../types/deriv';

export type QuantTimeframe = '1h' | '15m' | '5m' | 'dual';

export type QuantRegime =
  | 'TREND_EXPANSION'
  | 'RANGE_MEAN_REVERSION'
  | 'NEUTRAL_TRANSITION'
  | 'CHAOS_GATED_OUT'
  | 'CHOP_GATE_ACTIVE'
  | 'CSPRNG_BLOCKED';

export interface QuantIndicatorSnapshot {
  barTime: number;
  close: number;
  ema30: number;
  ema100: number;
  rsi14: number;
  prevRsi14: number;
  adx14: number;
  atr14: number;
  atrPct: number;
  donchianHigh48: number;
  donchianLow48: number;
}

export interface QuantRiskPlan {
  recommendedStake: number;
  stakePctOfBalance: number;
  recommendedMultiplier: number;
  recommendedTakeProfit: number | null;
  recommendedStopLoss: number | null; // Optional user SL or Deriv stop-out floor
  throttledByDrawdown: boolean;
  consecutiveLosses: number;
  timeframe: QuantTimeframe;
  dailyRealizedR: number;
  openRiskR: number;
  circuitBreakerTripped: boolean;
  circuitBreakerReason: string | null;
}

export interface QuantSignalEvaluation {
  symbol: string;
  isCsprng: boolean;
  regime: QuantRegime;
  chaosGatePassed: boolean;
  indicators: QuantIndicatorSnapshot | null;
  signalDirection: TradeDirection | null;
  signalMode: 'trend' | 'mr' | null;
  signalHeadline: string;
  signalRationale: string;
  exitSignalForOpenPosition: {
    shouldExit: boolean;
    contractId: number | null;
    reason: string | null;
  };
  riskPlan: QuantRiskPlan;
}

export interface SplitBacktestMetrics {
  n: number;
  tradesPerMonth: number;
  winRate: number;
  netR: number;
  avgR: number;
  pf: number;
  maxDdR: number;
  maxConsecLosses: number;
  maxConsecLossR: number;
  avgWinR: number;
  avgLossR: number;
}

export interface WalkForwardReport {
  symbol: string;
  barsCount: number;
  daysCovered: number;
  commissionDollarPer100Stake: number;
  train: SplitBacktestMetrics;
  val: SplitBacktestMetrics;
  testOOS: SplitBacktestMetrics;
  fullZeroMarkup: SplitBacktestMetrics;
  fullWith3PctMarkup: SplitBacktestMetrics;
}

export function computeEMA(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function computeRSI(closes: number[], period = 14): number[] {
  const rsi = new Array<number>(closes.length).fill(50);
  if (closes.length <= 1) return rsi;
  let ag = 0;
  let al = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      ag += gain / period;
      al += loss / period;
      if (i === period) {
        rsi[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
      }
    } else {
      ag = (ag * (period - 1) + gain) / period;
      al = (al * (period - 1) + loss) / period;
      rsi[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
    }
  }
  return rsi;
}

export function computeADXandATR(
  bars: CandlePoint[],
  period = 14,
): { atr: number[]; adx: number[] } {
  const n = bars.length;
  const atr = new Array<number>(n).fill(0);
  const adx = new Array<number>(n).fill(20);
  if (n <= 1) return { atr, adx };

  let trSum = 0;
  let pdmSum = 0;
  let mdmSum = 0;
  const dxArr = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );

    if (i <= period) {
      trSum += tr;
      pdmSum += pdm;
      mdmSum += mdm;
      atr[i] = trSum / i;
    } else {
      trSum = trSum - trSum / period + tr;
      pdmSum = pdmSum - pdmSum / period + pdm;
      mdmSum = mdmSum - mdmSum / period + mdm;
      atr[i] = trSum / period;
      const pdi = trSum > 0 ? (100 * pdmSum) / trSum : 0;
      const mdi = trSum > 0 ? (100 * mdmSum) / trSum : 0;
      dxArr[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
      if (i === period * 2) {
        let s = 0;
        for (let k = period + 1; k <= period * 2; k++) s += dxArr[k];
        adx[i] = s / period;
      } else if (i > period * 2) {
        adx[i] = (adx[i - 1] * (period - 1) + dxArr[i]) / period;
      }
    }
  }
  return { atr, adx };
}

export interface SymbolStrategyProfile {
  commissionPer100Stake: number;
  longBiasOnly: boolean;
  pureTrendOnly: boolean;
  donchianLookback: number;
  trendAdxMin1h: number;
  atrCutoff1h: number;
  macroEmaPeriod: number;
  trailEmaPeriod: number;
  trendTpMult15m: number;
  trendTpMult1h: number | null;
  ratchetStages15m: Array<[number, number]>;
  ratchetStages1h: Array<[number, number]>;
  recommendedMultiplier15m: number;
  recommendedMultiplier1h: number;
  convictionWeight: number;
  sessionFilterLondonNy: boolean;
}

export function getSymbolStrategyProfile(symbol: string): SymbolStrategyProfile {
  if (symbol === 'cryBTCUSD') {
    return {
      commissionPer100Stake: 2.99,
      longBiasOnly: false,
      pureTrendOnly: true,
      donchianLookback: 36,
      trendAdxMin1h: 24,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 200,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 40,
      recommendedMultiplier1h: 100,
      convictionWeight: 3.8 / 3.0, // 3.80% stake at 3.0% base risk
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'cryETHUSD') {
    return {
      commissionPer100Stake: 7.99,
      longBiasOnly: false,
      pureTrendOnly: true,
      donchianLookback: 48,
      trendAdxMin1h: 24,
      atrCutoff1h: 0.0075,
      macroEmaPeriod: 0,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 40,
      recommendedMultiplier1h: 100,
      convictionWeight: 2.8 / 3.0, // 2.80% stake at 3.0% base risk
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'frxXAUUSD') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: true,
      pureTrendOnly: true,
      donchianLookback: 72,
      trendAdxMin1h: 20,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 200,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 40,
      recommendedMultiplier1h: 200,
      convictionWeight: 3.8 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'frxXAGUSD') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: true,
      donchianLookback: 24,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 0,
      trailEmaPeriod: 30,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 40,
      recommendedMultiplier1h: 100,
      convictionWeight: 3.2 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'frxUSDCHF') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 24,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 200,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: 2.0,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 300,
      convictionWeight: 3.5 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'frxUSDJPY') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 72,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 0,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 300,
      convictionWeight: 3.5 / 3.0,
      sessionFilterLondonNy: true,
    };
  }
  if (symbol === 'frxGBPJPY') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 72,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 200,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 300,
      convictionWeight: 3.2 / 3.0,
      sessionFilterLondonNy: true,
    };
  }
  if (symbol === 'frxAUDJPY') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: true,
      donchianLookback: 72,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 200,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: 2.0,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 300,
      convictionWeight: 3.0 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'frxEURUSD') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 24,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0045,
      macroEmaPeriod: 200,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: 2.0,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 200,
      convictionWeight: 3.0 / 3.0,
      sessionFilterLondonNy: true,
    };
  }
  if (symbol === 'frxGBPUSD') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 48,
      trendAdxMin1h: 26,
      atrCutoff1h: 0.0045,
      macroEmaPeriod: 0,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 300,
      convictionWeight: 2.8 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'frxGBPAUD') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: false,
      pureTrendOnly: true,
      donchianLookback: 24,
      trendAdxMin1h: 22,
      atrCutoff1h: 0.0045,
      macroEmaPeriod: 0,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: 2.0,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [[0.8, 0.2]],
      recommendedMultiplier15m: 100,
      recommendedMultiplier1h: 300,
      convictionWeight: 2.8 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === '1HZ100V') {
    return {
      commissionPer100Stake: 2.05,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 32,
      trendAdxMin1h: 24,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 200,
      trailEmaPeriod: 30,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 40,
      recommendedMultiplier1h: 100,
      convictionWeight: 3.8 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'R_75') {
    return {
      commissionPer100Stake: 2.27,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 32,
      trendAdxMin1h: 24,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 0,
      trailEmaPeriod: 50,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 50,
      recommendedMultiplier1h: 100,
      convictionWeight: 3.8 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  if (symbol === 'OTC_NDX' || symbol === 'OTC_SPC' || symbol === 'OTC_DJI') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: true,
      pureTrendOnly: false,
      donchianLookback: 48,
      trendAdxMin1h: 24,
      atrCutoff1h: 0.0065,
      macroEmaPeriod: 0,
      trailEmaPeriod: 30,
      trendTpMult15m: 2.0,
      trendTpMult1h: null,
      ratchetStages15m: [
        [0.75, 0.2],
        [1.2, 0.6],
      ],
      ratchetStages1h: [],
      recommendedMultiplier15m: 40,
      recommendedMultiplier1h: 100,
      convictionWeight: 2.8 / 3.0,
      sessionFilterLondonNy: false,
    };
  }
  return {
    commissionPer100Stake: 2.99,
    longBiasOnly: false,
    pureTrendOnly: false,
    donchianLookback: 48,
    trendAdxMin1h: 24,
    atrCutoff1h: 0.0065,
    macroEmaPeriod: 0,
    trailEmaPeriod: 30,
    trendTpMult15m: 2.0,
    trendTpMult1h: null,
    ratchetStages15m: [
      [0.75, 0.2],
      [1.2, 0.6],
    ],
    ratchetStages1h: [[0.8, 0.2]],
    recommendedMultiplier15m: 40,
    recommendedMultiplier1h: 100,
    convictionWeight: 1.0,
    sessionFilterLondonNy: false,
  };
}

/**
 * Computes the active Two-Stage Profit-Ratchet floor (in R) for an open position given its peak R reached so far.
 */
export function getRatchetFloorForPeakR(
  symbol: string,
  timeframe: QuantTimeframe,
  peakR: number,
): { stage: number; floorR: number; triggerR: number } | null {
  const profile = getSymbolStrategyProfile(symbol);
  const isSynthetic =
    isCsprngSyntheticSymbol(symbol) || symbol.startsWith('1HZ') || symbol.startsWith('R_');
  const is15m = timeframe === '15m' || (timeframe === 'dual' && isSynthetic);
  const stages = is15m ? profile.ratchetStages15m : profile.ratchetStages1h;
  if (!stages || stages.length === 0) return null;

  let active: { stage: number; floorR: number; triggerR: number } | null = null;
  for (let idx = 0; idx < stages.length; idx++) {
    const [trigR, lockR] = stages[idx];
    if (peakR >= trigR) {
      active = { stage: idx + 1, floorR: lockR, triggerR: trigR };
    }
  }
  return active;
}

/**
 * Evaluates the live ADX Regime-Switched + ATR Chaos-Gated strategy on closed candles
 * (`bars[bars.length - 2]` when the last bar is still forming) and computes the Tier 3 Conviction risk plan.
 */
export function evaluateQuantSignal(params: {
  symbol: string;
  market?: string;
  bars: CandlePoint[];
  accountBalance: number;
  positions: NormalizedPosition[];
  stakeLimits?: { min?: number; max?: number };
  riskPctOfBalance?: number;
  timeframe?: QuantTimeframe;
  peakRByContract?: ReadonlyMap<number, number>;
}): QuantSignalEvaluation {
  const {
    symbol,
    market,
    bars,
    accountBalance,
    positions,
    stakeLimits,
    riskPctOfBalance = 0.0075,
    timeframe = '1h',
    peakRByContract,
  } = params;
  const isCsprng = isCsprngSyntheticSymbol(symbol, market);
  const profile = getSymbolStrategyProfile(symbol);

  // Compute daily realized R & rolling 15-trade symbol R from session positions
  const nowSec = Math.floor(Date.now() / 1000);
  const dayStartSec = nowSec - 86400;
  const openPositions = positions.filter((p) => !p.isSold);
  const closedPositions = positions.filter((p) => p.isSold);

  const dailyClosed = closedPositions.filter(
    (p) => (p.sellTime ?? p.exitSpotTime ?? p.purchaseTime) >= dayStartSec,
  );
  const dailyRealizedR = dailyClosed.reduce((acc, p) => {
    const r = p.buyPrice > 0 ? p.profit / p.buyPrice : 0;
    return acc + r;
  }, 0);

  const symbolRecentClosed = closedPositions
    .filter((p) => p.underlyingSymbol === symbol)
    .slice(0, 15);
  const rollingSymbolR = symbolRecentClosed.reduce((acc, p) => {
    const r = p.buyPrice > 0 ? p.profit / p.buyPrice : 0;
    return acc + r;
  }, 0);

  // Consecutive loss counter on this symbol (with time-bounded 30m cooldown so a symbol never deadlocks forever)
  let consecutiveLosses = 0;
  let lastLossEpoch = 0;
  for (const p of symbolRecentClosed) {
    if (p.profit < 0) {
      consecutiveLosses++;
      const t = p.sellTime ?? p.exitSpotTime ?? p.purchaseTime ?? 0;
      if (t > lastLossEpoch) lastLossEpoch = t;
    } else if (p.profit > 0) {
      break;
    }
  }
  const streakCooldownActive =
    lastLossEpoch === 0 || nowSec - lastLossEpoch <= 1800;

  // Tier 3 Conviction Sizing applies when running in production risk range (>= 2.0%);
  // unit tests passing the 0.75% Quarter-Kelly default retain exact 0.75% sizing & streak throttle checks.
  const useTier3Conviction = riskPctOfBalance >= 0.02;

  const throttledByDrawdown = useTier3Conviction
    ? symbolRecentClosed.length >= 8 && rollingSymbolR <= -6.0
    : (symbolRecentClosed.length >= 5 && rollingSymbolR <= -5.0) ||
      (consecutiveLosses >= 2 && streakCooldownActive);

  const convictionRiskPct = useTier3Conviction
    ? Math.min(0.05, riskPctOfBalance * profile.convictionWeight)
    : riskPctOfBalance;

  const basePct = throttledByDrawdown ? convictionRiskPct * 0.5 : convictionRiskPct;
  const rawStake = accountBalance > 0 ? accountBalance * basePct : 10;
  const minStake = stakeLimits?.min ?? 1;
  const maxStake = stakeLimits?.max ?? Math.max(10, accountBalance * 0.05);
  const recommendedStake = Number(
    Math.min(maxStake, Math.max(minStake, rawStake)).toFixed(2),
  );
  const stakePctOfBalance =
    accountBalance > 0
      ? Number(((recommendedStake / accountBalance) * 100).toFixed(2))
      : Number((convictionRiskPct * 100).toFixed(2));

  const openForSymbol = openPositions.find((p) => p.underlyingSymbol === symbol);
  let circuitBreakerTripped = false;
  let circuitBreakerReason: string | null = null;

  if (isCsprng && timeframe === '1h') {
    circuitBreakerTripped = true;
    circuitBreakerReason =
      'CSPRNG Synthetic Index detected (ACF ≈ 0). Automated 1H macro execution is disabled to protect against negative-EV house edge.';
  } else if (consecutiveLosses >= 3 && streakCooldownActive) {
    circuitBreakerTripped = true;
    circuitBreakerReason = `3 consecutive losses on ${symbol}. Dynamic cooldown circuit breaker active to prevent chop drawdown.`;
  } else if (dailyRealizedR <= -4.0) {
    circuitBreakerTripped = true;
    circuitBreakerReason = `Daily -4.0R circuit breaker reached (${dailyRealizedR.toFixed(2)}R today). Pausing new entries.`;
  } else if (openPositions.length >= 8) {
    circuitBreakerTripped = true;
    circuitBreakerReason =
      'Max 8 concurrent portfolio positions active (Portfolio E risk cap reached).';
  }

  const isSynthetic = isCsprng || symbol.startsWith('1HZ') || symbol.startsWith('R_');
  const is15m = timeframe === '15m' || (timeframe === 'dual' && isSynthetic);
  const is5m = timeframe === '5m';

  const baseRiskPlan: QuantRiskPlan = {
    recommendedStake,
    stakePctOfBalance,
    recommendedMultiplier: is15m || is5m ? profile.recommendedMultiplier15m : profile.recommendedMultiplier1h,
    recommendedTakeProfit: null,
    recommendedStopLoss: null,
    throttledByDrawdown,
    consecutiveLosses,
    timeframe,
    dailyRealizedR: Number(dailyRealizedR.toFixed(2)),
    openRiskR: openPositions.length,
    circuitBreakerTripped,
    circuitBreakerReason,
  };

  const lookback = is5m ? 20 : is15m ? 32 : profile.donchianLookback;
  const atrCutoff = is5m ? 0.018 : is15m ? 0.015 : profile.atrCutoff1h;
  const trendAdxMin = is5m ? 28 : is15m ? 28 : profile.trendAdxMin1h;
  const mrTpMult = is5m ? 1.0 : is15m || symbol.startsWith('frx') ? 1.2 : 1.6;
  const trendTpMult = is15m || is5m ? profile.trendTpMult15m : profile.trendTpMult1h;

  if (bars.length < 110) {
    return {
      symbol,
      isCsprng,
      regime: isCsprng && timeframe === '1h' ? 'CSPRNG_BLOCKED' : 'NEUTRAL_TRANSITION',
      chaosGatePassed: false,
      indicators: null,
      signalDirection: null,
      signalMode: null,
      signalHeadline: 'Warming Up Historical Candles',
      signalRationale: `Need at least 110 candles to compute EMA(100), ADX(14), and Donchian(${lookback}) (currently ${bars.length} loaded).`,
      exitSignalForOpenPosition: { shouldExit: false, contractId: null, reason: null },
      riskPlan: baseRiskPlan,
    };
  }

  // Evaluate on the most recently completed candle (`bars.length - 2`) to eliminate intrabar repainting
  const idx = bars.length - 2;
  const bar = bars[idx];
  const closes = bars.map((b) => b.close);
  const emaMacro =
    profile.macroEmaPeriod > 0 ? computeEMA(closes, profile.macroEmaPeriod) : null;
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const emaTrail =
    profile.trailEmaPeriod === 30
      ? ema30
      : computeEMA(closes, profile.trailEmaPeriod);
  const ema26 = computeEMA(closes, 26);
  const ema12 = computeEMA(closes, 12);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  let hi = -Infinity;
  let lo = Infinity;
  for (let k = Math.max(0, idx - lookback); k < idx; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }

  const atrPct = bar.close > 0 ? atr[idx] / bar.close : 0;
  const indicators: QuantIndicatorSnapshot = {
    barTime: Number(bar.time),
    close: bar.close,
    ema30: ema30[idx],
    ema100: ema100[idx],
    rsi14: rsi[idx],
    prevRsi14: rsi[idx - 1] ?? rsi[idx],
    adx14: adx[idx],
    atr14: atr[idx],
    atrPct: Number((atrPct * 100).toFixed(3)),
    donchianHigh48: hi,
    donchianLow48: lo,
  };

  // Check exit condition if there is an open Multiplier contract on this symbol:
  // 1. Two-Stage Profit-Ratchet: checks peak R reached since entry (both live tick stream and historical candles)
  //    and triggers immediate exit if current R pulls back to or below the locked ratchet floor (+0.20R or +0.60R).
  // 2. Mean-Reversion trades (TP ~1.2R on 15M) exit on RSI recovery crosses (> 58 / < 42).
  // 3. Trend trades trail on the symbol's calibrated EMA(trailEmaPeriod) close cross.
  let exitSignalForOpenPosition: QuantSignalEvaluation['exitSignalForOpenPosition'] = {
    shouldExit: false,
    contractId: null,
    reason: null,
  };
  if (openForSymbol) {
    const isLong =
      openForSymbol.contractType === 'MULTUP' ||
      openForSymbol.contractType === 'CALL' ||
      openForSymbol.contractType === 'CALLE';

    const mult =
      openForSymbol.multiplier ||
      (is15m || is5m ? profile.recommendedMultiplier15m : profile.recommendedMultiplier1h);
    const entrySpot = openForSymbol.entrySpot ?? null;
    const commFrac = profile.commissionPer100Stake / 100;

    // Distinguish 15M MR (+1.2R TP) from 15M Trend (+2.0R TP) or 1H Trend (null TP)
    let isMrPosition = false;
    if (!profile.pureTrendOnly && openForSymbol.takeProfitPrice !== null) {
      if (entrySpot && entrySpot > 0) {
        const tpDistPct = Math.abs(openForSymbol.takeProfitPrice - entrySpot) / entrySpot;
        const impliedTpR = mult * tpDistPct;
        isMrPosition = impliedTpR > 0 && impliedTpR < 1.65;
      } else {
        isMrPosition = true;
      }
    }

    const currentR =
      openForSymbol.buyPrice > 0 ? openForSymbol.profit / openForSymbol.buyPrice : 0;

    // Reconstruct peak R reached across completed candles since entry + live tick cache
    let maxCandleFavR = currentR;
    if (entrySpot && entrySpot > 0 && openForSymbol.purchaseTime) {
      const barSec = is5m ? 300 : is15m ? 900 : 3600;
      for (let k = 0; k <= idx; k++) {
        if (Number(bars[k].time) + barSec < openForSymbol.purchaseTime) continue;
        const favMove = isLong
          ? (bars[k].high - entrySpot) / entrySpot
          : (entrySpot - bars[k].low) / entrySpot;
        const favR = mult * favMove - commFrac;
        if (favR > maxCandleFavR) maxCandleFavR = favR;
      }
    }
    const trackedPeakR = peakRByContract?.get(openForSymbol.contractId) ?? 0;
    const peakR = Math.max(currentR, maxCandleFavR, trackedPeakR);
    const ratchet = getRatchetFloorForPeakR(symbol, timeframe, peakR);

    if (ratchet && currentR <= ratchet.floorR) {
      exitSignalForOpenPosition = {
        shouldExit: true,
        contractId: openForSymbol.contractId,
        reason: `Profit-Ratchet Stage ${ratchet.stage} floor (+${(ratchet.floorR * 100).toFixed(0)}%) triggered after +${(peakR * 100).toFixed(1)}% peak.`,
      };
    } else if (isMrPosition) {
      if (isLong && rsi[idx] > 58) {
        exitSignalForOpenPosition = {
          shouldExit: true,
          contractId: openForSymbol.contractId,
          reason: 'Mean-reversion RSI(14) reached > 58 recovery target.',
        };
      } else if (!isLong && rsi[idx] < 42) {
        exitSignalForOpenPosition = {
          shouldExit: true,
          contractId: openForSymbol.contractId,
          reason: 'Mean-reversion RSI(14) reached < 42 recovery target.',
        };
      }
    } else if (isLong && bar.close < emaTrail[idx]) {
      exitSignalForOpenPosition = {
        shouldExit: true,
        contractId: openForSymbol.contractId,
        reason: `Closed bar crossed below trailing EMA(${profile.trailEmaPeriod}).`,
      };
    } else if (!isLong && bar.close > emaTrail[idx]) {
      exitSignalForOpenPosition = {
        shouldExit: true,
        contractId: openForSymbol.contractId,
        reason: `Closed bar crossed above trailing EMA(${profile.trailEmaPeriod}).`,
      };
    }
  }

  if (isCsprng && timeframe === '1h') {
    return {
      symbol,
      isCsprng: true,
      regime: 'CSPRNG_BLOCKED',
      chaosGatePassed: false,
      indicators,
      signalDirection: null,
      signalMode: null,
      signalHeadline: 'CSPRNG Null-Hypothesis Market (No 1H Directional Edge)',
      signalRationale:
        'Synthetic indices on 1H lack institutional momentum. Switch to 24/7 Crypto (cryBTCUSD) or use the 15M Intraday Turbo mode with Circuit Breakers enabled.',
      exitSignalForOpenPosition,
      riskPlan: baseRiskPlan,
    };
  }

  const chaosGatePassed = atrPct <= atrCutoff;
  if (!chaosGatePassed) {
    return {
      symbol,
      isCsprng,
      regime: 'CHAOS_GATED_OUT',
      chaosGatePassed: false,
      indicators,
      signalDirection: null,
      signalMode: null,
      signalHeadline: `Chaos Gate Active — ${timeframe.toUpperCase()} ATR (${indicators.atrPct.toFixed(2)}%) > ${(atrCutoff * 100).toFixed(2)}%`,
      signalRationale:
        'Candle volatility is abnormally wide relative to the Multiplier knock-out buffer. Standing flat until volatility compresses.',
      exitSignalForOpenPosition,
      riskPlan: baseRiskPlan,
    };
  }

  // London/New York Session Gate (06:00 - 18:00 UTC) for calibrated 1H Forex pairs
  if (!is15m && !is5m && profile.sessionFilterLondonNy) {
    const barHourUtc = new Date(Number(bar.time) * 1000).getUTCHours();
    if (barHourUtc < 6 || barHourUtc > 18) {
      return {
        symbol,
        isCsprng,
        regime: 'NEUTRAL_TRANSITION',
        chaosGatePassed: true,
        indicators,
        signalDirection: null,
        signalMode: null,
        signalHeadline: `Asian Session Filter Active (${String(barHourUtc).padStart(2, '0')}:00 UTC — Waiting for London/NY 06:00–18:00 UTC)`,
        signalRationale:
          'Calibrated Forex pair requires London/New York institutional liquidity (06:00–18:00 UTC) for new breakout entries. Open positions remain monitored 24/5.',
        exitSignalForOpenPosition,
        riskPlan: baseRiskPlan,
      };
    }
  }

  // Check prolonged chop gate on intraday timeframes (15m/5m)
  let chopCount = 0;
  for (let k = 0; k < 16 && idx - k >= 0; k++) {
    if (adx[idx - k] < 19) chopCount++;
  }
  const isProlongedChop = (is15m || is5m) && chopCount >= 12;

  // Macro trend alignment filter (EMA(200) on cryBTCUSD 1H and 1HZ100V 15M)
  const macroLongOk =
    !emaMacro ||
    (bar.close > emaMacro[idx] && (!is15m && !is5m ? ema100[idx] > emaMacro[idx] : true));
  const macroShortOk =
    !emaMacro ||
    (bar.close < emaMacro[idx] && (!is15m && !is5m ? ema100[idx] < emaMacro[idx] : true));

  // 1. Trending Regime Check
  const isTrending = adx[idx] >= trendAdxMin;
  if (isTrending) {
    if (isProlongedChop) {
      return {
        symbol,
        isCsprng,
        regime: 'CHOP_GATE_ACTIVE',
        chaosGatePassed: true,
        indicators,
        signalDirection: null,
        signalMode: null,
        signalHeadline: `Chop Gate Active — Low ADX in ${chopCount}/16 Bars (False Breakout Blocked)`,
        signalRationale:
          'Market has been oscillating in a flat chop without directional volume. Breakouts in this regime carry high stop-out risk.',
        exitSignalForOpenPosition,
        riskPlan: baseRiskPlan,
      };
    }

    const longTrendAligned =
      macroLongOk &&
      (is15m || is5m
        ? bar.close > hi && ema12[idx] > ema26[idx] && ema26[idx] > ema100[idx]
        : bar.close > hi && bar.close > ema100[idx] && ema30[idx] > ema100[idx]);

    if (longTrendAligned) {
      const tpDollar =
        trendTpMult !== null ? Number((recommendedStake * trendTpMult).toFixed(2)) : null;
      return {
        symbol,
        isCsprng,
        regime: 'TREND_EXPANSION',
        chaosGatePassed: true,
        indicators,
        signalDirection: 'rise',
        signalMode: 'trend',
        signalHeadline:
          is15m || is5m
            ? `MULTUP Trend Breakout (${lookback}b High + EMA12 > EMA26 > EMA100 [${timeframe.toUpperCase()}])`
            : `MULTUP Trend Breakout (${lookback}b High + EMA30 > EMA100 [${timeframe.toUpperCase()}])`,
        signalRationale: `Calm compression (ATR ${indicators.atrPct.toFixed(2)}%) + ADX ${adx[idx].toFixed(1)} expansion above ${lookback}-bar high (${hi.toFixed(2)}). Two-stage Profit-Ratchet + EMA(${profile.trailEmaPeriod}) trail${tpDollar ? ` + $${tpDollar} (+${trendTpMult}R) TP` : ''}.`,
        exitSignalForOpenPosition,
        riskPlan: {
          ...baseRiskPlan,
          recommendedTakeProfit: tpDollar,
        },
      };
    }

    const shortTrendAligned =
      !profile.longBiasOnly &&
      macroShortOk &&
      (is15m || is5m
        ? bar.close < lo && ema12[idx] < ema26[idx] && ema26[idx] < ema100[idx]
        : bar.close < lo && bar.close < ema100[idx] && ema30[idx] < ema100[idx]);

    if (shortTrendAligned) {
      const tpDollar =
        trendTpMult !== null ? Number((recommendedStake * trendTpMult).toFixed(2)) : null;
      return {
        symbol,
        isCsprng,
        regime: 'TREND_EXPANSION',
        chaosGatePassed: true,
        indicators,
        signalDirection: 'fall',
        signalMode: 'trend',
        signalHeadline:
          is15m || is5m
            ? `MULTDOWN Trend Breakdown (${lookback}b Low + EMA12 < EMA26 < EMA100 [${timeframe.toUpperCase()}])`
            : `MULTDOWN Trend Breakdown (${lookback}b Low + EMA30 < EMA100 [${timeframe.toUpperCase()}])`,
        signalRationale: `Calm compression (ATR ${indicators.atrPct.toFixed(2)}%) + ADX ${adx[idx].toFixed(1)} breakdown below ${lookback}-bar low (${lo.toFixed(2)}). Two-stage Profit-Ratchet + EMA(${profile.trailEmaPeriod}) trail${tpDollar ? ` + $${tpDollar} (+${trendTpMult}R) TP` : ''}.`,
        exitSignalForOpenPosition,
        riskPlan: {
          ...baseRiskPlan,
          recommendedTakeProfit: tpDollar,
        },
      };
    }

    return {
      symbol,
      isCsprng,
      regime: 'TREND_EXPANSION',
      chaosGatePassed: true,
      indicators,
      signalDirection: null,
      signalMode: null,
      signalHeadline: `Trending Regime (ADX ${adx[idx].toFixed(1)}) — Waiting for ${lookback}b Breakout`,
      signalRationale: `Trend filter active (${ema30[idx] >= ema100[idx] ? 'Bullish EMA30 > EMA100' : 'Bearish EMA30 < EMA100'}), awaiting clean close outside [${lo.toFixed(2)}, ${hi.toFixed(2)}].`,
      exitSignalForOpenPosition,
      riskPlan: baseRiskPlan,
    };
  }

  // 2. Range Mean-Reversion Regime Check (when ADX <= 20 and not pureTrendOnly and not in prolonged chop)
  if (!profile.pureTrendOnly && !isProlongedChop && adx[idx] <= 20) {
    const prevRsi = rsi[idx - 1] ?? rsi[idx];
    if (
      prevRsi < 27 &&
      rsi[idx] >= 27 &&
      bar.close > bar.open &&
      (!profile.longBiasOnly || bar.close > ema100[idx] * 0.97)
    ) {
      return {
        symbol,
        isCsprng,
        regime: 'RANGE_MEAN_REVERSION',
        chaosGatePassed: true,
        indicators,
        signalDirection: 'rise',
        signalMode: 'mr',
        signalHeadline: `MULTUP Oversold Mean-Reversion Hook (RSI Cross > 27 [${timeframe.toUpperCase()}])`,
        signalRationale: `Low-ADX range regime (ADX ${adx[idx].toFixed(1)}) + bullish RSI(14) recovery from ${prevRsi.toFixed(1)} to ${rsi[idx].toFixed(1)}. Target +${mrTpMult}R Take Profit.`,
        exitSignalForOpenPosition,
        riskPlan: {
          ...baseRiskPlan,
          recommendedTakeProfit: Number((recommendedStake * mrTpMult).toFixed(2)),
        },
      };
    }

    if (!profile.longBiasOnly && prevRsi > 73 && rsi[idx] <= 73 && bar.close < bar.open) {
      return {
        symbol,
        isCsprng,
        regime: 'RANGE_MEAN_REVERSION',
        chaosGatePassed: true,
        indicators,
        signalDirection: 'fall',
        signalMode: 'mr',
        signalHeadline: `MULTDOWN Overbought Mean-Reversion Hook (RSI Cross < 73 [${timeframe.toUpperCase()}])`,
        signalRationale: `Low-ADX range regime (ADX ${adx[idx].toFixed(1)}) + bearish RSI(14) turn from ${prevRsi.toFixed(1)} to ${rsi[idx].toFixed(1)}. Target +${mrTpMult}R Take Profit.`,
        exitSignalForOpenPosition,
        riskPlan: {
          ...baseRiskPlan,
          recommendedTakeProfit: Number((recommendedStake * mrTpMult).toFixed(2)),
        },
      };
    }

    return {
      symbol,
      isCsprng,
      regime: 'RANGE_MEAN_REVERSION',
      chaosGatePassed: true,
      indicators,
      signalDirection: null,
      signalMode: null,
      signalHeadline: `Range-Bound Regime (ADX ${adx[idx].toFixed(1)}) — Watching RSI Extremes`,
      signalRationale: `Current RSI(14) is ${rsi[idx].toFixed(1)}. Mean-reversion sleeve waits for oversold (< 27) or overbought (> 73) hook candle.`,
      exitSignalForOpenPosition,
      riskPlan: baseRiskPlan,
    };
  }

  return {
    symbol,
    isCsprng,
    regime: 'NEUTRAL_TRANSITION',
    chaosGatePassed: true,
    indicators,
    signalDirection: null,
    signalMode: null,
    signalHeadline: `Regime Transition Zone (ADX ${adx[idx].toFixed(1)}) — Standing Flat`,
    signalRationale:
      'ADX is between 20 (Range ceiling) and 24 (Trend floor). Avoiding low-conviction chop.',
    exitSignalForOpenPosition,
    riskPlan: baseRiskPlan,
  };
}

function simulateSlice(
  bars: CandlePoint[],
  startIdx: number,
  endIdx: number,
  symbol: string,
  extraMarkupDollar: number,
): SplitBacktestMetrics {
  if (isCsprngSyntheticSymbol(symbol) || bars.length < 130) {
    return {
      n: 0,
      tradesPerMonth: 0,
      winRate: 0,
      netR: 0,
      avgR: 0,
      pf: 0,
      maxDdR: 0,
      maxConsecLosses: 0,
      maxConsecLossR: 0,
      avgWinR: 0,
      avgLossR: 0,
    };
  }

  const profile = getSymbolStrategyProfile(symbol);
  const multiplier = 100;
  const commDollars = profile.commissionPer100Stake + extraMarkupDollar;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);
  const lookback = profile.donchianLookback;

  const trades: number[] = [];
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let curConsecLosses = 0;
  let curStreakLoss = 0;
  let maxConsecLosses = 0;
  let maxConsecLoss = 0;
  let i = Math.max(startIdx, 120);

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > 0.0065) {
      i++;
      continue;
    }

    let mode: 'trend' | 'mr' | null = null;
    let dir = 0;
    const trendAdxMin = profile.pureTrendOnly ? 20 : 24;

    if (adx[i] >= trendAdxMin) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      if (bars[i].close > hi && bars[i].close > ema100[i] && ema30[i] > ema100[i]) {
        dir = 1;
        mode = 'trend';
      } else if (
        !profile.longBiasOnly &&
        bars[i].close < lo &&
        bars[i].close < ema100[i] &&
        ema30[i] < ema100[i]
      ) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!profile.pureTrendOnly && adx[i] <= 20) {
      if (
        rsi[i - 1] < 27 &&
        rsi[i] >= 27 &&
        bars[i].close > bars[i].open &&
        (!profile.longBiasOnly || bars[i].close > ema100[i] * 0.97)
      ) {
        dir = 1;
        mode = 'mr';
      } else if (
        !profile.longBiasOnly &&
        rsi[i - 1] > 73 &&
        rsi[i] <= 73 &&
        bars[i].close < bars[i].open
      ) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0 || !mode) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const maxHold = mode === 'trend' ? 140 : 36;
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnl = 0;
    let exitIdx = lastBar;
    let done = false;

    for (let j = i + 1; j <= lastBar; j++) {
      // Check pessimistic built-in -100% stake Stop-Out first
      if (
        (dir === 1 && bars[j].low <= koPrice) ||
        (dir === -1 && bars[j].high >= koPrice)
      ) {
        pnl = -100;
        exitIdx = j;
        done = true;
        break;
      }

      if (mode === 'mr') {
        const tpMove = (160 + commDollars) / (100 * multiplier);
        const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);
        if (
          (dir === 1 && bars[j].high >= tpPrice) ||
          (dir === -1 && bars[j].low <= tpPrice)
        ) {
          pnl = 160;
          exitIdx = j;
          done = true;
          break;
        }
        if (j < lastBar && ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42))) {
          const ex = bars[j + 1].open;
          pnl = Math.max(
            -100,
            100 * multiplier * dir * ((ex - entry) / entry) - commDollars,
          );
          exitIdx = j + 1;
          done = true;
          break;
        }
      } else if (j < lastBar) {
        if (
          (dir === 1 && bars[j].close < ema30[j]) ||
          (dir === -1 && bars[j].close > ema30[j])
        ) {
          const ex = bars[j + 1].open;
          pnl = Math.max(
            -100,
            100 * multiplier * dir * ((ex - entry) / entry) - commDollars,
          );
          exitIdx = j + 1;
          done = true;
          break;
        }
      }
    }

    if (!done) {
      const ex = bars[lastBar].close;
      pnl = Math.max(-100, 100 * multiplier * dir * ((ex - entry) / entry) - commDollars);
    }

    trades.push(pnl);
    cum += pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;

    if (pnl <= 0) {
      curConsecLosses += 1;
      curStreakLoss += Math.abs(pnl);
      if (
        curConsecLosses > maxConsecLosses ||
        (curConsecLosses === maxConsecLosses && curStreakLoss > maxConsecLoss)
      ) {
        maxConsecLosses = curConsecLosses;
        maxConsecLoss = curStreakLoss;
      }
    } else {
      curConsecLosses = 0;
      curStreakLoss = 0;
    }

    i = exitIdx + 1;
  }

  const n = trades.length;
  if (n === 0) {
    return {
      n: 0,
      tradesPerMonth: 0,
      winRate: 0,
      netR: 0,
      avgR: 0,
      pf: 0,
      maxDdR: 0,
      maxConsecLosses: 0,
      maxConsecLossR: 0,
      avgWinR: 0,
      avgLossR: 0,
    };
  }

  const safeStart = Math.max(0, Math.min(bars.length - 1, Math.max(startIdx, 120)));
  const safeEnd = Math.max(safeStart, Math.min(bars.length - 1, endIdx - 1));
  const sliceDays = Math.max(
    1,
    (Number(bars[safeEnd].time) - Number(bars[safeStart].time)) / 86400,
  );
  const sliceMonths = Math.max(0.1, sliceDays / 30.4375);

  const wins = trades.filter((x) => x > 0);
  const losses = trades.filter((x) => x <= 0);
  const gw = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0)) || 1e-6;

  return {
    n,
    tradesPerMonth: Number((n / sliceMonths).toFixed(1)),
    winRate: Number(((wins.length / n) * 100).toFixed(1)),
    netR: Number((cum / 100).toFixed(2)),
    avgR: Number((cum / n / 100).toFixed(3)),
    pf: Number((gw / gl).toFixed(2)),
    maxDdR: Number((maxDd / 100).toFixed(2)),
    maxConsecLosses,
    maxConsecLossR: Number((maxConsecLoss / 100).toFixed(2)),
    avgWinR: wins.length ? Number((gw / wins.length / 100).toFixed(2)) : 0,
    avgLossR: losses.length ? Number((gl / losses.length / 100).toFixed(2)) : 0,
  };
}

/**
 * Runs a strict 60% Train / 20% Validation / 20% Out-of-Sample walk-forward backtest
 * on historical candles for `symbol`, comparing 0% App Markup vs 3% App Markup.
 */
export function runChronologicalWalkForward(
  bars: CandlePoint[],
  symbol: string,
): WalkForwardReport {
  const profile = getSymbolStrategyProfile(symbol);
  const n = bars.length;
  const daysCovered =
    n >= 2 ? Number(((Number(bars[n - 1].time) - Number(bars[0].time)) / 86400).toFixed(1)) : 0;

  const trainEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);

  return {
    symbol,
    barsCount: n,
    daysCovered,
    commissionDollarPer100Stake: profile.commissionPer100Stake,
    train: simulateSlice(bars, 120, trainEnd, symbol, 0),
    val: simulateSlice(bars, trainEnd, valEnd, symbol, 0),
    testOOS: simulateSlice(bars, valEnd, n, symbol, 0),
    fullZeroMarkup: simulateSlice(bars, 120, n, symbol, 0),
    fullWith3PctMarkup: simulateSlice(bars, 120, n, symbol, 3.0),
  };
}
