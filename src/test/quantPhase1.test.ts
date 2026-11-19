import { describe, expect, it } from 'vitest';
import {
  computeCppiRiskMultiplier,
  evaluateQuantSignal,
  getSymbolRiskCluster,
} from '../services/quantStrategyEngine';
import { pickClosestMultiplier } from '../../server/quantRunner';
import type { CandlePoint } from '../services/chartFeed';
import type { NormalizedPosition } from '../types/deriv';

function makeDummyBars(count = 130): CandlePoint[] {
  const bars: CandlePoint[] = [];
  const start = 1700000000;
  let price = 100;
  for (let i = 0; i < count; i++) {
    price += 0.1;
    bars.push({
      time: (start + i * 3600) as CandlePoint['time'],
      open: price - 0.05,
      high: price + 0.2,
      low: price - 0.2,
      close: price,
    });
  }
  return bars;
}

function makeOpenPosition(contractId: number, symbol: string): NormalizedPosition {
  const now = Math.floor(Date.now() / 1000);
  return {
    contractId,
    underlyingSymbol: symbol,
    contractType: 'MULTUP',
    currency: 'USD',
    longcode: `${symbol} MULTUP`,
    shortcode: `MULTUP_${symbol}`,
    buyPrice: 30,
    bidPrice: 30,
    payout: 0,
    profit: 0,
    profitPercentage: 0,
    multiplier: 100,
    stopOutPrice: 99,
    takeProfitPrice: null,
    stopLossPrice: null,
    purchaseTime: now - 600,
    dateStart: now - 600,
    dateExpiry: null,
    entrySpot: 100,
    entrySpotTime: now - 600,
    currentSpot: 100,
    currentSpotTime: now,
    exitSpot: null,
    exitSpotTime: null,
    sellPrice: null,
    sellTime: null,
    tickCount: null,
    ticksObserved: 10,
    isSold: false,
    isExpired: false,
    isValidToSell: true,
    status: 'open',
    buyTransactionId: contractId,
    sellTransactionId: null,
  };
}

describe('Phase 1 Portfolio Risk Math (CPPI + Correlation Clusters)', () => {
  it('keeps CPPI multiplier at 1.0 when drawdown is <= 10%', () => {
    expect(computeCppiRiskMultiplier(1000, 1000)).toEqual({
      multiplier: 1,
      drawdownPct: 0,
      active: false,
    });
    expect(computeCppiRiskMultiplier(900, 1000)).toEqual({
      multiplier: 1,
      drawdownPct: 10,
      active: false,
    });
  });

  it('smoothly scales down stake between 10% and 45% drawdown and clamps at 0.35 floor', () => {
    const mid = computeCppiRiskMultiplier(725, 1000); // 27.5% DD -> 1 - 17.5/35 = 0.5
    expect(mid.active).toBe(true);
    expect(mid.drawdownPct).toBe(27.5);
    expect(mid.multiplier).toBeCloseTo(0.5, 4);

    const deep = computeCppiRiskMultiplier(450, 1000); // 55% DD -> clamped to 0.35
    expect(deep.active).toBe(true);
    expect(deep.multiplier).toBe(0.35);
  });

  it('maps symbols to correlated risk clusters accurately', () => {
    expect(getSymbolRiskCluster('cryBTCUSD')).toBe('CRYPTO');
    expect(getSymbolRiskCluster('cryETHUSD')).toBe('CRYPTO');
    expect(getSymbolRiskCluster('1HZ100V')).toBe('SYNTH');
    expect(getSymbolRiskCluster('R_75')).toBe('SYNTH');
    expect(getSymbolRiskCluster('frxXAUUSD')).toBe('METALS');
    expect(getSymbolRiskCluster('frxUSDJPY')).toBe('JPY');
    expect(getSymbolRiskCluster('frxGBPJPY')).toBe('JPY');
    expect(getSymbolRiskCluster('frxAUDJPY')).toBe('JPY');
    expect(getSymbolRiskCluster('frxEURUSD')).toBe('FX_USD');
  });

  it('trips correlation-cluster circuit breaker on 3rd JPY position while allowing uncorrelated Crypto', () => {
    const bars = makeDummyBars(130);
    const twoJpyOpen = [
      makeOpenPosition(1, 'frxUSDJPY'),
      makeOpenPosition(2, 'frxGBPJPY'),
    ];

    const jpyBlocked = evaluateQuantSignal({
      symbol: 'frxAUDJPY',
      market: 'forex',
      bars,
      accountBalance: 1000,
      peakAccountBalance: 1000,
      positions: twoJpyOpen,
      riskPctOfBalance: 0.03,
      timeframe: '1h',
    });
    expect(jpyBlocked.riskPlan.riskCluster).toBe('JPY');
    expect(jpyBlocked.riskPlan.clusterOpenCount).toBe(2);
    expect(jpyBlocked.riskPlan.circuitBreakerTripped).toBe(true);
    expect(jpyBlocked.riskPlan.circuitBreakerReason).toContain('Correlation-cluster cap reached');

    const btcAllowed = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      market: 'cryptocurrency',
      bars,
      accountBalance: 1000,
      peakAccountBalance: 1000,
      positions: twoJpyOpen,
      riskPctOfBalance: 0.03,
      timeframe: '1h',
    });
    expect(btcAllowed.riskPlan.riskCluster).toBe('CRYPTO');
    expect(btcAllowed.riskPlan.clusterOpenCount).toBe(0);
    expect(btcAllowed.riskPlan.circuitBreakerTripped).toBe(false);
  });

  it('applies CPPI stake reduction when accountBalance is in >10% drawdown from peakAccountBalance', () => {
    const bars = makeDummyBars(130);
    const fullRisk = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      market: 'cryptocurrency',
      bars,
      accountBalance: 1000,
      peakAccountBalance: 1000,
      positions: [],
      riskPctOfBalance: 0.03,
      timeframe: '1h',
    });

    const ddRisk = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      market: 'cryptocurrency',
      bars,
      accountBalance: 725, // 27.5% drawdown -> 0.50x CPPI multiplier
      peakAccountBalance: 1000,
      positions: [],
      riskPctOfBalance: 0.03,
      timeframe: '1h',
    });

    expect(ddRisk.riskPlan.cppiMultiplier).toBeCloseTo(0.5, 4);
    expect(ddRisk.riskPlan.throttledByDrawdown).toBe(true);
    // 725 * 0.038 * 0.5 = 13.78 vs 1000 * 0.038 = 38.00
    expect(ddRisk.riskPlan.recommendedStake).toBeLessThan(fullRisk.riskPlan.recommendedStake * 0.4);
  });

  it('snaps 300x conservatively to 250x on live Deriv FX range [50,100,150,250,500], never dangerously up to 500x', () => {
    expect(pickClosestMultiplier([50, 100, 150, 250, 500], 300, 100)).toBe(250);
    expect(pickClosestMultiplier([50, 100, 150, 250, 500], 200, 100)).toBe(150);
    expect(pickClosestMultiplier([50, 100, 150, 250, 500], 250, 100)).toBe(250);
  });
});
