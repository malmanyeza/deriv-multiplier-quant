import { describe, expect, it } from 'vitest';
import {
  PUBLIC_OPTIONS_WS_URL,
  assertNewApiPayload,
  assertNewApiSocketUrl,
} from '../services/derivSocket';
import {
  extractRiseFallRules,
  fluctuationToDecimals,
  parseDurationBound,
} from '../services/marketData';
import {
  buildRiseFallProposal,
  reconcileRiseFallControls,
} from '../adapters/riseFallAdapter';
import {
  buildMultipliersProposal,
  computeMultiplierHoverPreview,
  extractMultiplierQuoteTelemetry,
} from '../adapters/multipliersAdapter';
import {
  evaluateQuantSignal,
  runChronologicalWalkForward,
} from '../services/quantStrategyEngine';
import { pickClosestMultiplier } from '../../server/quantRunner';
import type { AvailableContractEntry } from '../types/deriv';
import type { UTCTimestamp } from 'lightweight-charts';

describe('New Deriv API protocol guardrails', () => {
  it('accepts New API public and OTP WebSocket URLs and rejects Legacy endpoints', () => {
    expect(() => assertNewApiSocketUrl(PUBLIC_OPTIONS_WS_URL)).not.toThrow();
    expect(() =>
      assertNewApiSocketUrl('wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc123'),
    ).not.toThrow();

    expect(() =>
      assertNewApiSocketUrl('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
    ).toThrow(/ForbiddenEndpoint|non-New-API/i);

    expect(() =>
      assertNewApiSocketUrl('http://api.derivws.com/trading/v1/options/ws/public'),
    ).toThrow();
  });

  it('rejects forbidden Legacy WebSocket payload fields', () => {
    expect(() => assertNewApiPayload({ authorize: 'tok_123' })).toThrow(/authorize/);
    expect(() => assertNewApiPayload({ balance: 1, loginid: 'VRTC123' })).toThrow(
      /loginid/,
    );
    expect(() =>
      assertNewApiPayload({
        proposal: 1,
        symbol: '1HZ100V',
        contract_type: 'CALL',
      }),
    ).toThrow(/underlying_symbol/);

    expect(() =>
      assertNewApiPayload({
        proposal: 1,
        underlying_symbol: '1HZ100V',
        contract_type: 'CALL',
      }),
    ).not.toThrow();
  });
});

describe('Market metadata & Rise/Fall contract discovery', () => {
  const sampleContractsFor: AvailableContractEntry[] = [
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'CALL',
      default_stake: 10,
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      payout_limit: 50000,
      sentiment: 'up',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'PUT',
      default_stake: 10,
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '5', // Bare numeric tick string fallback
      max_contract_duration: '10t',
      payout_limit: 50000,
      sentiment: 'down',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'CALL',
      expiry_type: 'intraday',
      market: 'synthetic_index',
      min_contract_duration: '15s',
      max_contract_duration: '1d',
      sentiment: 'up',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'PUT',
      expiry_type: 'daily',
      market: 'synthetic_index',
      min_contract_duration: '1d',
      max_contract_duration: '365d',
      sentiment: 'down',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    {
      barriers: 1,
      contract_category: 'callputequal',
      contract_type: 'CALLE',
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      sentiment: 'up',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    {
      barriers: 1,
      contract_category: 'callputequal',
      contract_type: 'PUTE',
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      sentiment: 'down',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    // Non-Rise/Fall sibling entry that must be ignored
    {
      barriers: 1,
      contract_category: 'touchnotouch',
      contract_type: 'ONETOUCH',
      expiry_type: 'intraday',
      market: 'synthetic_index',
      min_contract_duration: '15m',
      max_contract_duration: '1d',
      sentiment: 'up',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
  ];

  it('keeps barriers=1 callput & callputequal entries and normalizes tick vs time axes', () => {
    const rules = extractRiseFallRules('1HZ100V', sampleContractsFor);
    expect(rules.supportsPlainRiseFall).toBe(true);
    expect(rules.supportsEquals).toBe(true);
    expect(rules.payoutLimit).toBe(50000);

    const tickRule = rules.unitsByVariant.plain.find((u) => u.unit === 't');
    expect(tickRule).toEqual({
      unit: 't',
      label: 'Ticks',
      min: 1,
      max: 10,
      defaultValue: 5,
    });

    const secRule = rules.unitsByVariant.plain.find((u) => u.unit === 's');
    expect(secRule?.min).toBe(15);

    const dayRule = rules.unitsByVariant.plain.find((u) => u.unit === 'd');
    expect(dayRule?.max).toBe(365);
  });

  it('parses bare numeric duration strings using expiry_type natural unit', () => {
    expect(parseDurationBound('5', 'tick')).toEqual({ kind: 'tick', ticks: 5 });
    expect(parseDurationBound('2', 'daily')).toEqual({ kind: 'time', seconds: 172800 });
    expect(parseDurationBound('15s', 'intraday')).toEqual({ kind: 'time', seconds: 15 });
  });

  it('converts active_symbols pip_size fluctuation to decimal places', () => {
    expect(fluctuationToDecimals(0.01)).toBe(2);
    expect(fluctuationToDecimals(0.0001)).toBe(4);
    expect(fluctuationToDecimals(0.1)).toBe(1);
    expect(fluctuationToDecimals(1)).toBe(0);
  });
});

describe('Rise/Fall proposal adapter & control reconciliation', () => {
  const rules = extractRiseFallRules('R_100', [
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'CALL',
      default_stake: 10,
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      sentiment: 'up',
      submarket: 'random_index',
      underlying_symbol: 'R_100',
    },
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'PUT',
      default_stake: 10,
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      sentiment: 'down',
      submarket: 'random_index',
      underlying_symbol: 'R_100',
    },
  ]);

  it('builds clean New API proposal payloads with underlying_symbol and NO barrier or symbol', () => {
    const built = buildRiseFallProposal(
      {
        underlyingSymbol: 'R_100',
        direction: 'rise',
        allowEquals: false,
        basis: 'stake',
        amount: 12.5,
        currency: 'USD',
        duration: 5,
        durationUnit: 't',
      },
      rules,
    );

    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload).toEqual({
        proposal: 1,
        amount: 12.5,
        basis: 'stake',
        contract_type: 'CALL',
        currency: 'USD',
        duration: 5,
        duration_unit: 't',
        underlying_symbol: 'R_100',
      });
      expect('barrier' in built.payload).toBe(false);
      expect('symbol' in built.payload).toBe(false);
    }
  });

  it('resets allowEquals and clamps duration when switching to a symbol without callputequal', () => {
    const reconciled = reconcileRiseFallControls(
      { allowEquals: true, duration: 99, durationUnit: 'm', amount: 15 },
      'R_100',
      rules,
    );

    expect(reconciled.allowEquals).toBe(false);
    expect(reconciled.durationUnit).toBe('t');
    expect(reconciled.duration).toBe(10);
    expect(reconciled.amount).toBe(15);
  });
});

describe('Multipliers (MULTUP / MULTDOWN) adapter & live fee telemetry', () => {
  const btcRules = extractRiseFallRules('cryBTCUSD', [
    {
      barriers: 0,
      cancellation_range: ['15m', '30m', '60m'],
      contract_category: 'multipliers',
      contract_type: 'MULTUP',
      default_stake: 10,
      expiry_type: 'no_expiry',
      market: 'cryptocurrency',
      min_contract_duration: '1s',
      max_contract_duration: '7d',
      multiplier_range: [100, 200, 300, 500, 800],
      sentiment: 'up',
      submarket: 'non_stable_coin',
      underlying_symbol: 'cryBTCUSD',
    },
    {
      barriers: 0,
      cancellation_range: ['15m', '30m', '60m'],
      contract_category: 'multipliers',
      contract_type: 'MULTDOWN',
      default_stake: 10,
      expiry_type: 'no_expiry',
      market: 'cryptocurrency',
      min_contract_duration: '1s',
      max_contract_duration: '7d',
      multiplier_range: [100, 200, 300, 500, 800],
      sentiment: 'down',
      submarket: 'non_stable_coin',
      underlying_symbol: 'cryBTCUSD',
    },
  ]);

  it('extracts multiplier_range and builds valid MULTUP / MULTDOWN payloads with limit_order', () => {
    expect(btcRules.supportsMultipliers).toBe(true);
    expect(btcRules.supportsPlainRiseFall).toBe(false);
    expect(btcRules.multiplierRange).toEqual([100, 200, 300, 500, 800]);
    expect(btcRules.defaultMultiplier).toBe(100);

    const built = buildMultipliersProposal(
      {
        underlyingSymbol: 'cryBTCUSD',
        direction: 'rise',
        amount: 10,
        currency: 'USD',
        multiplier: 100,
        takeProfit: 16,
        stopLoss: null,
      },
      btcRules,
    );

    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload).toEqual({
        proposal: 1,
        amount: 10,
        basis: 'stake',
        contract_type: 'MULTUP',
        currency: 'USD',
        multiplier: 100,
        underlying_symbol: 'cryBTCUSD',
        limit_order: {
          take_profit: 16,
        },
      });
      expect('duration' in built.payload).toBe(false);
      expect('barrier' in built.payload).toBe(false);
    }
  });

  it('separates base commission (2.99 bps) from developer app_markup_amount in quote telemetry', () => {
    const telemetry = extractMultiplierQuoteTelemetry(
      {
        id: 'prop-btc-1',
        ask_price: 100,
        payout: 0,
        spot: 70000,
        spot_time: 1700000000,
        date_start: 1700000000,
        longcode: 'MULTUP 100x on BTC/USD',
        commission: 5.99,
        contract_details: {
          app_markup_amount: '3.00',
        },
        limit_order: {
          stop_out: {
            value: '69320.93',
          },
        },
      },
      100,
      100,
    );

    expect(telemetry).not.toBeNull();
    expect(telemetry?.commissionDollar).toBeCloseTo(2.99, 2);
    expect(telemetry?.commissionBpsOfNotional).toBeCloseTo(2.99, 2);
    expect(telemetry?.appMarkupDollar).toBeCloseTo(3.0, 2);
    expect(telemetry?.appMarkupPctOfStake).toBeCloseTo(3.0, 2);
    expect(telemetry?.effectiveNotional).toBe(10000);
    expect(telemetry?.stopOutPrice).toBeCloseTo(69320.93, 2);
  });
});

describe('Quant Strategy Engine (Chaos Gate, CSPRNG Block & Quarter-Kelly Risk)', () => {
  it('blocks CSPRNG Synthetic Indices from directional auto-execution and computes Quarter-Kelly 0.75% stake', () => {
    const syntheticCandles = Array.from({ length: 150 }, (_, i) => ({
      time: (1700000000 + i * 3600) as UTCTimestamp,
      open: 1000 + i * 0.5,
      high: 1005 + i * 0.5,
      low: 995 + i * 0.5,
      close: 1001 + i * 0.5,
    }));

    const evalResult = evaluateQuantSignal({
      symbol: '1HZ100V',
      market: 'synthetic_index',
      bars: syntheticCandles,
      accountBalance: 2000,
      positions: [],
    });

    expect(evalResult.isCsprng).toBe(true);
    expect(evalResult.regime).toBe('CSPRNG_BLOCKED');
    expect(evalResult.signalDirection).toBeNull();
    expect(evalResult.riskPlan.recommendedStake).toBe(15); // 0.75% of $2,000
    expect(evalResult.riskPlan.circuitBreakerTripped).toBe(true);

    const wf = runChronologicalWalkForward(syntheticCandles, '1HZ100V');
    expect(wf.fullZeroMarkup.n).toBe(0);
  });

  it('trips Chaos Gate when 1h ATR exceeds 0.65% of spot on real-world Crypto', () => {
    const volatileCandles = Array.from({ length: 150 }, (_, i) => ({
      time: (1700000000 + i * 3600) as UTCTimestamp,
      open: 70000,
      high: 70900, // ~1.57% hourly range (> 0.65% Chaos Gate)
      low: 69800,
      close: 70100,
    }));

    const evalResult = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      market: 'cryptocurrency',
      bars: volatileCandles,
      accountBalance: 1000,
      positions: [],
    });

    expect(evalResult.isCsprng).toBe(false);
    expect(evalResult.chaosGatePassed).toBe(false);
    expect(evalResult.regime).toBe('CHAOS_GATED_OUT');
    expect(evalResult.signalDirection).toBeNull();
    expect(evalResult.riskPlan.recommendedStake).toBe(7.5); // 0.75% of $1,000
  });

  it('computes exact Loss Point and Take Profit Point on chart for MULTUP and MULTDOWN hover preview', () => {
    const quote = {
      id: 'prop-btc-hover',
      ask_price: 10,
      payout: 0,
      spot: 70000,
      spot_time: 1700000000,
      date_start: 1700000000,
      longcode: 'MULTUP 100x on BTC/USD',
      commission: 0.3,
      limit_order: {
        stop_out: {
          value: '69320.93',
        },
      },
    };

    const upPreview = computeMultiplierHoverPreview({
      direction: 'rise',
      proposal: quote,
      amount: 10,
      multiplier: 100,
      takeProfit: null, // blank -> defaults to +1.6R ($16) Quant Target preview
      stopLoss: null, // blank -> uses Deriv Stop-Out floor (69320.93)
      currency: 'USD',
    });

    expect(upPreview).not.toBeNull();
    expect(upPreview?.contractType).toBe('MULTUP');
    expect(upPreview?.entryPrice).toBe(70000);
    expect(upPreview?.lossPrice).toBeCloseTo(69320.93, 2);
    expect(upPreview?.lossAmount).toBe(10);
    expect(upPreview?.isDefaultTakeProfit).toBe(true);
    expect(upPreview?.takeProfitAmount).toBe(16);
    // +$16 net TP + $0.30 commission = $16.30 gross on $1,000 notional (+1.63% above 70,000 = 71,141)
    expect(upPreview?.takeProfitPrice).toBeCloseTo(71141, 2);

    const downPreview = computeMultiplierHoverPreview({
      direction: 'fall',
      proposal: {
        ...quote,
        limit_order: {
          stop_out: {
            value: '70679.07',
          },
        },
      },
      amount: 10,
      multiplier: 100,
      takeProfit: 20, // custom $20 net TP + $0.30 comm = -2.03% below 70,000 = 68,579
      stopLoss: 5, // custom $5 net SL - $0.30 comm = +0.47% above 70,000 = 70,329
      currency: 'USD',
    });

    expect(downPreview).not.toBeNull();
    expect(downPreview?.contractType).toBe('MULTDOWN');
    expect(downPreview?.isDefaultTakeProfit).toBe(false);
    expect(downPreview?.takeProfitPrice).toBeCloseTo(68579, 2);
    expect(downPreview?.lossPrice).toBeCloseTo(70329, 2);
  });

  it('supports multi-timeframe signal evaluation and streak loss circuit breakers', () => {
    // Generate 120 synthetic bars
    const dummyBars = Array.from({ length: 120 }, (_, i) => ({
      time: (1700000000 + i * 900) as UTCTimestamp,
      open: 50000 + i * 10,
      high: 50020 + i * 10,
      low: 49990 + i * 10,
      close: 50015 + i * 10,
    }));

    // 1. Evaluate with 15m timeframe
    const eval15m = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      bars: dummyBars,
      accountBalance: 1000,
      positions: [],
      timeframe: '15m',
    });
    expect(eval15m.riskPlan.timeframe).toBe('15m');
    expect(eval15m.riskPlan.recommendedStopLoss).toBeNull();
    expect(eval15m.riskPlan.circuitBreakerTripped).toBe(false);

    // 2. Evaluate with 2 consecutive losses -> throttles risk by 50%
    const mockPositionsWith2Losses = [
      {
        contractId: 1,
        underlyingSymbol: 'cryBTCUSD',
        isSold: true,
        buyPrice: 10,
        profit: -10,
        purchaseTime: Math.floor(Date.now() / 1000) - 300,
      },
      {
        contractId: 2,
        underlyingSymbol: 'cryBTCUSD',
        isSold: true,
        buyPrice: 10,
        profit: -10,
        purchaseTime: Math.floor(Date.now() / 1000) - 100,
      },
    ] as any;

    const evalThrottled = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      bars: dummyBars,
      accountBalance: 1000,
      positions: mockPositionsWith2Losses,
      timeframe: '15m',
    });
    expect(evalThrottled.riskPlan.consecutiveLosses).toBe(2);
    expect(evalThrottled.riskPlan.throttledByDrawdown).toBe(true);

    // 3. Evaluate with 3 consecutive losses -> trips circuit breaker
    const mockPositionsWith3Losses = [
      ...mockPositionsWith2Losses,
      {
        contractId: 3,
        underlyingSymbol: 'cryBTCUSD',
        isSold: true,
        buyPrice: 10,
        profit: -10,
        purchaseTime: Math.floor(Date.now() / 1000) - 50,
      },
    ] as any;

    const evalTripped = evaluateQuantSignal({
      symbol: 'cryBTCUSD',
      bars: dummyBars,
      accountBalance: 1000,
      positions: mockPositionsWith3Losses,
      timeframe: '15m',
    });
    expect(evalTripped.riskPlan.consecutiveLosses).toBe(3);
    expect(evalTripped.riskPlan.circuitBreakerTripped).toBe(true);
    expect(evalTripped.riskPlan.circuitBreakerReason).toContain('3 consecutive losses');
  });

  it('snaps unsupported preferred multipliers to the closest valid exchange multiplier', () => {
    // 1HZ100V supports [40, 100, 200, 300, 400] -> 30 snaps to 40
    expect(pickClosestMultiplier([40, 100, 200, 300, 400], 30, 40)).toBe(40);
    // R_75 supports [50, 100, 200, 300, 500] -> 30 snaps to 50
    expect(pickClosestMultiplier([50, 100, 200, 300, 500], 30, 50)).toBe(50);
    // 1HZ50V supports [80, 200, 400, 600, 800] -> 30 snaps to 80
    expect(pickClosestMultiplier([80, 200, 400, 600, 800], 30, 80)).toBe(80);
    // Exact match returns itself
    expect(pickClosestMultiplier([100, 200, 300], 100, 100)).toBe(100);
  });
});


