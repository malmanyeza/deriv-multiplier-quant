import type { UTCTimestamp, SeriesMarker } from 'lightweight-charts';
import type { ChartGranularity, NormalizedPosition } from '../types/deriv';

export interface TickPoint {
  time: UTCTimestamp;
  value: number;
}

export interface CandlePoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface WhitespaceFuturePoint {
  time: UTCTimestamp;
}

export function buildTicksHistorySubscriptionPayload(
  symbol: string,
  granularity: ChartGranularity,
  count = 1000,
): Record<string, unknown> {
  if (granularity === 0) {
    return {
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: 'latest',
      style: 'ticks',
    };
  }
  return {
    ticks_history: symbol,
    adjust_start_time: 1,
    count,
    end: 'latest',
    granularity,
    style: 'candles',
  };
}

export function buildTicksHistoryBackfillPayload(
  symbol: string,
  granularity: ChartGranularity,
  beforeEpoch: number,
  count = 1000,
): Record<string, unknown> {
  const safeEnd = Math.max(1, Math.floor(beforeEpoch) - 1);
  if (granularity === 0) {
    return {
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: safeEnd,
      style: 'ticks',
    };
  }
  return {
    ticks_history: symbol,
    adjust_start_time: 1,
    count,
    end: safeEnd,
    granularity,
    style: 'candles',
  };
}

/**
 * Produces strictly ascending, deduplicated tick points (seconds epoch -> UTCTimestamp).
 */
export function normalizeTickHistory(history?: {
  prices?: unknown[];
  times?: unknown[];
}): TickPoint[] {
  const prices = Array.isArray(history?.prices) ? history!.prices : [];
  const times = Array.isArray(history?.times) ? history!.times : [];
  const len = Math.min(prices.length, times.length);
  const byTime = new Map<number, number>();

  for (let i = 0; i < len; i++) {
    const t = Number(times[i]);
    const p = Number(prices[i]);
    if (Number.isFinite(t) && Number.isFinite(p) && t > 0) {
      byTime.set(Math.floor(t), p);
    }
  }

  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({ time: t as UTCTimestamp, value }));
}

/**
 * Produces strictly ascending, deduplicated candle points (seconds epoch -> UTCTimestamp).
 */
export function normalizeCandleHistory(
  candles?: Array<Record<string, unknown>>,
): CandlePoint[] {
  if (!Array.isArray(candles)) return [];
  const byTime = new Map<number, CandlePoint>();

  for (const raw of candles) {
    if (!raw || typeof raw !== 'object') continue;
    const epoch = Number(raw.epoch);
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    const close = Number(raw.close);
    if (
      Number.isFinite(epoch) &&
      epoch > 0 &&
      Number.isFinite(open) &&
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      Number.isFinite(close)
    ) {
      const t = Math.floor(epoch);
      byTime.set(t, {
        time: t as UTCTimestamp,
        open,
        high,
        low,
        close,
      });
    }
  }

  return Array.from(byTime.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c);
}

export function normalizeLiveTick(msg: Record<string, unknown>): {
  point: TickPoint;
  pipDecimals?: number;
  symbol?: string;
} | null {
  const tick = msg.tick as Record<string, unknown> | undefined;
  if (!tick || typeof tick !== 'object') return null;

  const epoch = Number(tick.epoch);
  const quote = Number(tick.quote);
  if (!Number.isFinite(epoch) || epoch <= 0 || !Number.isFinite(quote)) return null;

  const pipDecimals =
    typeof tick.pip_size === 'number' && Number.isFinite(tick.pip_size)
      ? tick.pip_size
      : undefined;

  return {
    point: { time: Math.floor(epoch) as UTCTimestamp, value: quote },
    pipDecimals,
    symbol: typeof tick.symbol === 'string' ? tick.symbol : undefined,
  };
}

/**
 * In New API `ohlc` stream messages, `open`, `high`, `low`, `close` arrive as numeric strings
 * and `open_time` is the candle's open timestamp in seconds.
 */
export function normalizeLiveOhlc(msg: Record<string, unknown>): {
  candle: CandlePoint;
  pipDecimals?: number;
  symbol?: string;
  spotEpoch?: number;
} | null {
  const ohlc = msg.ohlc as Record<string, unknown> | undefined;
  if (!ohlc || typeof ohlc !== 'object') return null;

  const openTime = Number(ohlc.open_time ?? ohlc.epoch);
  const open = Number(ohlc.open);
  const high = Number(ohlc.high);
  const low = Number(ohlc.low);
  const close = Number(ohlc.close);

  if (
    !Number.isFinite(openTime) ||
    openTime <= 0 ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  const pipDecimals =
    typeof ohlc.pip_size === 'number' && Number.isFinite(ohlc.pip_size)
      ? ohlc.pip_size
      : undefined;

  return {
    candle: {
      time: Math.floor(openTime) as UTCTimestamp,
      open,
      high,
      low,
      close,
    },
    pipDecimals,
    symbol: typeof ohlc.symbol === 'string' ? ohlc.symbol : undefined,
    spotEpoch: typeof ohlc.epoch === 'number' ? ohlc.epoch : undefined,
  };
}

export function canApplySeriesUpdate(
  lastAppliedTime: number | null,
  incomingTime: number,
): boolean {
  if (lastAppliedTime === null) return true;
  return incomingTime >= lastAppliedTime;
}

export interface DerivedPriceLineSpec {
  price: number;
  title: string;
  color: string;
}

export interface DerivedRiseFallOverlays {
  entryPriceLine: DerivedPriceLineSpec | null;
  stopOutPriceLine?: DerivedPriceLineSpec | null;
  takeProfitPriceLine?: DerivedPriceLineSpec | null;
  markers: SeriesMarker<UTCTimestamp>[];
  whitespaceFuturePoints: WhitespaceFuturePoint[];
}

function isUpContract(contractType: string): boolean {
  return (
    contractType === 'CALL' ||
    contractType === 'CALLE' ||
    contractType === 'MULTUP'
  );
}

/**
 * Derives Rise/Fall and Multipliers chart overlays strictly from normalized position state.
 */
export function deriveRiseFallChartOverlays(
  positions: NormalizedPosition[],
  chartSymbol: string,
  granularity: ChartGranularity,
  latestSeriesTime: number | null,
): DerivedRiseFallOverlays {
  const symbolPositions = positions.filter((p) => p.underlyingSymbol === chartSymbol);
  if (symbolPositions.length === 0) {
    return {
      entryPriceLine: null,
      stopOutPriceLine: null,
      takeProfitPriceLine: null,
      markers: [],
      whitespaceFuturePoints: [],
    };
  }

  // Focus entry line on most recent open contract (or most recently settled if none open)
  const focus =
    symbolPositions.find((p) => !p.isSold) ??
    [...symbolPositions].sort((a, b) => b.purchaseTime - a.purchaseTime)[0];

  const alignTime = (epoch: number): UTCTimestamp => {
    if (granularity === 0) return Math.floor(epoch) as UTCTimestamp;
    return (Math.floor(epoch / granularity) * granularity) as UTCTimestamp;
  };

  const isRise = isUpContract(focus.contractType);
  const isMult =
    focus.contractType === 'MULTUP' || focus.contractType === 'MULTDOWN';
  const entryLabel = isMult
    ? `${isRise ? 'MULTUP' : 'MULTDOWN'}${focus.multiplier ? ` ${focus.multiplier}x` : ''} Entry`
    : `${isRise ? 'Rise' : 'Fall'} Entry`;

  const entryPriceLine =
    focus.entrySpot !== null
      ? {
          price: focus.entrySpot,
          title: entryLabel,
          color: isRise ? '#10b981' : '#f43f5e',
        }
      : null;

  const stopOutPriceLine =
    !focus.isSold && focus.stopOutPrice !== null
      ? {
          price: focus.stopOutPrice,
          title: 'Stop-Out (-1R Floor)',
          color: '#f59e0b',
        }
      : null;

  const takeProfitPriceLine =
    !focus.isSold && focus.takeProfitPrice !== null
      ? {
          price: focus.takeProfitPrice,
          title: 'Take Profit',
          color: '#38bdf8',
        }
      : null;

  const markers: SeriesMarker<UTCTimestamp>[] = [];

  for (const pos of symbolPositions.slice(0, 6)) {
    const up = isUpContract(pos.contractType);
    const mult = pos.contractType === 'MULTUP' || pos.contractType === 'MULTDOWN';
    const dirText = mult
      ? `${pos.contractType}${pos.multiplier ? ` ${pos.multiplier}x` : ''}`
      : up
        ? 'Rise'
        : 'Fall';
    const startEpoch = pos.entrySpotTime ?? pos.dateStart;

    if (startEpoch > 0) {
      const tickLabel =
        !pos.isSold && pos.tickCount !== null
          ? ` (${pos.ticksObserved}/${pos.tickCount}t)`
          : '';

      if (pos.entrySpot !== null) {
        markers.push({
          time: alignTime(startEpoch),
          position: 'atPriceMiddle',
          price: pos.entrySpot,
          shape: up ? 'arrowUp' : 'arrowDown',
          color: up ? '#10b981' : '#f43f5e',
          text: `${dirText}${tickLabel}`,
        });
      } else {
        markers.push({
          time: alignTime(startEpoch),
          position: up ? 'belowBar' : 'aboveBar',
          shape: up ? 'arrowUp' : 'arrowDown',
          color: up ? '#10b981' : '#f43f5e',
          text: `${dirText}${tickLabel}`,
        });
      }
    }

    if (pos.isSold && (pos.exitSpotTime || pos.sellTime)) {
      const exitEpoch = (pos.exitSpotTime ?? pos.sellTime)!;
      const won = pos.profit >= 0;
      const sign = pos.profit >= 0 ? '+' : '';
      const pnlLabel = `${sign}${pos.profit.toFixed(2)} ${pos.currency}`;

      if (pos.exitSpot !== null) {
        markers.push({
          time: alignTime(exitEpoch),
          position: 'atPriceMiddle',
          price: pos.exitSpot,
          shape: 'circle',
          color: won ? '#22c55e' : '#ef4444',
          text: pnlLabel,
        });
      } else {
        markers.push({
          time: alignTime(exitEpoch),
          position: won ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: won ? '#22c55e' : '#ef4444',
          text: pnlLabel,
        });
      }
    }
  }

  markers.sort((a, b) => Number(a.time) - Number(b.time));

  // Separate whitespace-only series points to extend time axis to open contract's future expiry
  const whitespaceFuturePoints: WhitespaceFuturePoint[] = [];
  if (
    !focus.isSold &&
    !isMult &&
    focus.dateExpiry !== null &&
    latestSeriesTime !== null &&
    focus.dateExpiry > latestSeriesTime
  ) {
    const step = granularity === 0 ? 1 : granularity;
    const targetEnd = Number(alignTime(focus.dateExpiry));
    const maxSteps = 120;
    let cursor = latestSeriesTime + step;
    let count = 0;
    while (cursor <= targetEnd && count < maxSteps) {
      whitespaceFuturePoints.push({ time: cursor as UTCTimestamp });
      cursor += step;
      count += 1;
    }
  }

  return {
    entryPriceLine,
    stopOutPriceLine,
    takeProfitPriceLine,
    markers,
    whitespaceFuturePoints,
  };
}
