import type { CandlePoint } from './chartFeed';
import { isCsprngSyntheticSymbol } from './marketData';
import type { NormalizedPosition, TradeDirection } from '../types/deriv';

export type QuantTimeframe = '1h' | '15m' | '5m';

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
  recommendedStopLoss: null; // Uses Deriv's zero-slippage -100% stake Stop-Out floor (-1R)
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

export function getSymbolStrategyProfile(symbol: string): {
  commissionPer100Stake: number;
  longBiasOnly: boolean;
  pureTrendOnly: boolean;
  donchianLookback: number;
} {
  if (symbol === 'cryBTCUSD') {
    return {
      commissionPer100Stake: 2.99,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 48,
    };
  }
  if (symbol === 'cryETHUSD') {
    return {
      commissionPer100Stake: 7.99,
      longBiasOnly: false,
      pureTrendOnly: false,
      donchianLookback: 48,
    };
  }
  if (symbol === 'frxXAUUSD') {
    // Selected strictly on Train split (+2.13R Pure Trend vs -5.43R mixed MR on Gold)
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: true,
      pureTrendOnly: true,
      donchianLookback: 72,
    };
  }
  if (symbol === 'OTC_NDX' || symbol === 'OTC_SPC' || symbol === 'OTC_DJI') {
    return {
      commissionPer100Stake: 2.5,
      longBiasOnly: true,
      pureTrendOnly: false,
      donchianLookback: 48,
    };
  }
  return {
    commissionPer100Stake: 2.99,
    longBiasOnly: false,
    pureTrendOnly: false,
    donchianLookback: 48,
  };
}

/**
 * Evaluates the live ADX Regime-Switched + ATR Chaos-Gated strategy on closed candles
 * (`bars[bars.length - 2]` when the last bar is still forming) and computes the Quarter-Kelly risk plan.
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

  // Consecutive loss counter on this symbol
  let consecutiveLosses = 0;
  for (const p of symbolRecentClosed) {
    if (p.profit < 0) consecutiveLosses++;
    else if (p.profit > 0) break;
  }

  // Drawdown throttle: 50% risk reduction if symbol down -5R or after 2 consecutive losses
  const throttledByDrawdown =
    (symbolRecentClosed.length >= 5 && rollingSymbolR <= -5.0) || consecutiveLosses >= 2;
  const basePct = throttledByDrawdown ? riskPctOfBalance * 0.5 : riskPctOfBalance;
  const rawStake = accountBalance > 0 ? accountBalance * basePct : 10;
  const minStake = stakeLimits?.min ?? 1;
  const maxStake = stakeLimits?.max ?? Math.max(10, accountBalance * 0.05);
  const recommendedStake = Number(
    Math.min(maxStake, Math.max(minStake, rawStake)).toFixed(2),
  );
  const stakePctOfBalance =
    accountBalance > 0
      ? Number(((recommendedStake / accountBalance) * 100).toFixed(2))
      : Number((riskPctOfBalance * 100).toFixed(2));

  const openForSymbol = openPositions.find((p) => p.underlyingSymbol === symbol);
  let circuitBreakerTripped = false;
  let circuitBreakerReason: string | null = null;

  if (isCsprng && timeframe === '1h') {
    circuitBreakerTripped = true;
    circuitBreakerReason =
      'CSPRNG Synthetic Index detected (ACF ≈ 0). Automated 1H macro execution is disabled to protect against negative-EV house edge.';
  } else if (consecutiveLosses >= 3) {
    circuitBreakerTripped = true;
    circuitBreakerReason = `3 consecutive losses on ${symbol}. Dynamic cooldown circuit breaker active to prevent chop drawdown.`;
  } else if (dailyRealizedR <= -3.0) {
    circuitBreakerTripped = true;
    circuitBreakerReason = `Daily -3.0R circuit breaker reached (${dailyRealizedR.toFixed(2)}R today). Pausing new entries.`;
  } else if (openPositions.length >= 3) {
    circuitBreakerTripped = true;
    circuitBreakerReason =
      'Max 3 concurrent portfolio positions active (2.25% total risk cap reached).';
  }

  const baseRiskPlan: QuantRiskPlan = {
    recommendedStake,
    stakePctOfBalance,
    recommendedMultiplier: 100,
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

  const is15m = timeframe === '15m';
  const is5m = timeframe === '5m';
  const lookback = is5m ? 20 : is15m ? 24 : profile.donchianLookback;
  const atrCutoff = is5m ? 0.018 : is15m ? 0.015 : 0.0065;
  const trendAdxMin = is5m ? 28 : is15m ? 26 : profile.pureTrendOnly ? 20 : 24;
  const trendTpMult = is5m ? 1.4 : is15m ? 1.8 : 3.2;
  const mrTpMult = is5m ? 1.0 : is15m ? 1.2 : 1.6;

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
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
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

  // Check exit condition if there is an open Multiplier contract on this symbol
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
    if (isLong && bar.close < ema30[idx] && rsi[idx] > 58) {
      exitSignalForOpenPosition = {
        shouldExit: true,
        contractId: openForSymbol.contractId,
        reason: 'Closed bar crossed below trailing EMA(30) / RSI target.',
      };
    } else if (!isLong && bar.close > ema30[idx] && rsi[idx] < 42) {
      exitSignalForOpenPosition = {
        shouldExit: true,
        contractId: openForSymbol.contractId,
        reason: 'Closed bar crossed above trailing EMA(30) / RSI target.',
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

  // Check prolonged chop gate on intraday timeframes (15m/5m)
  let chopCount = 0;
  for (let k = 0; k < 16 && idx - k >= 0; k++) {
    if (adx[idx - k] < 19) chopCount++;
  }
  const isProlongedChop = (is15m || is5m) && chopCount >= 12;

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

    if (bar.close > hi && bar.close > ema100[idx] && ema30[idx] > ema100[idx]) {
      return {
        symbol,
        isCsprng,
        regime: 'TREND_EXPANSION',
        chaosGatePassed: true,
        indicators,
        signalDirection: 'rise',
        signalMode: 'trend',
        signalHeadline: `MULTUP Trend Breakout (${lookback}b High + EMA30 > EMA100 [${timeframe.toUpperCase()}])`,
        signalRationale: `Calm compression (ATR ${indicators.atrPct.toFixed(2)}%) + ADX ${adx[idx].toFixed(1)} expansion above ${lookback}-bar high (${hi.toFixed(2)}). Trail exit on EMA(30).`,
        exitSignalForOpenPosition,
        riskPlan: {
          ...baseRiskPlan,
          recommendedTakeProfit: Number((recommendedStake * trendTpMult).toFixed(2)),
        },
      };
    }

    if (
      !profile.longBiasOnly &&
      bar.close < lo &&
      bar.close < ema100[idx] &&
      ema30[idx] < ema100[idx]
    ) {
      return {
        symbol,
        isCsprng,
        regime: 'TREND_EXPANSION',
        chaosGatePassed: true,
        indicators,
        signalDirection: 'fall',
        signalMode: 'trend',
        signalHeadline: `MULTDOWN Trend Breakdown (${lookback}b Low + EMA30 < EMA100 [${timeframe.toUpperCase()}])`,
        signalRationale: `Calm compression (ATR ${indicators.atrPct.toFixed(2)}%) + ADX ${adx[idx].toFixed(1)} breakdown below ${lookback}-bar low (${lo.toFixed(2)}). Trail exit on EMA(30).`,
        exitSignalForOpenPosition,
        riskPlan: {
          ...baseRiskPlan,
          recommendedTakeProfit: Number((recommendedStake * trendTpMult).toFixed(2)),
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

  // 2. Range Mean-Reversion Regime Check (when ADX <= 20 and not pureTrendOnly)
  if (!profile.pureTrendOnly && adx[idx] <= 20) {
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
