import React, { useEffect, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';
import type {
  ActiveSymbolItem,
  ChartGranularity,
  ConnectionStatus,
  HoverPreviewLevels,
  NormalizedPosition,
} from '../types/deriv';
import type { DerivSocketOwner } from '../services/derivSocket';
import {
  buildTicksHistoryBackfillPayload,
  buildTicksHistorySubscriptionPayload,
  canApplySeriesUpdate,
  deriveRiseFallChartOverlays,
  normalizeCandleHistory,
  normalizeLiveOhlc,
  normalizeLiveTick,
  normalizeTickHistory,
  type CandlePoint,
  type TickPoint,
} from '../services/chartFeed';
import { decimalsToMinMove, fluctuationToDecimals } from '../services/marketData';

const GRANULARITY_OPTIONS: Array<{ value: ChartGranularity; label: string }> = [
  { value: 0, label: 'Ticks' },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 180, label: '3m' },
  { value: 300, label: '5m' },
  { value: 900, label: '15m' },
  { value: 3600, label: '1h' },
  { value: 14400, label: '4h' },
  { value: 86400, label: '1d' },
];

const MAX_HISTORICAL_POINTS = 15_000;

interface PriceChartProps {
  socket: DerivSocketOwner;
  connectionStatus: ConnectionStatus;
  connectionGeneration: number;
  symbolInfo: ActiveSymbolItem | null;
  symbol: string;
  granularity: ChartGranularity;
  onChangeGranularity: (g: ChartGranularity) => void;
  positions: NormalizedPosition[];
  hoverPreview?: HoverPreviewLevels | null;
}

export const PriceChart: React.FC<PriceChartProps> = ({
  socket,
  connectionStatus,
  connectionGeneration,
  symbolInfo,
  symbol,
  granularity,
  onChangeGranularity,
  positions,
  hoverPreview = null,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<'Area'> | ISeriesApi<'Candlestick'> | null>(
    null,
  );
  const futureWhitespaceSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const entryPriceLineRef = useRef<IPriceLine | null>(null);
  const stopOutPriceLineRef = useRef<IPriceLine | null>(null);
  const takeProfitPriceLineRef = useRef<IPriceLine | null>(null);
  const hoverEntryLineRef = useRef<IPriceLine | null>(null);
  const hoverTpLineRef = useRef<IPriceLine | null>(null);
  const hoverLossLineRef = useRef<IPriceLine | null>(null);
  const lastSeriesTimeRef = useRef<number | null>(null);
  const earliestSeriesTimeRef = useRef<number | null>(null);
  const ticksMapRef = useRef<Map<number, TickPoint>>(new Map());
  const candlesMapRef = useRef<Map<number, CandlePoint>>(new Map());
  const loadingOlderRef = useRef<boolean>(false);
  const reachedHistoryStartRef = useRef<boolean>(false);
  const fetchOlderHistoryRef = useRef<((fitAfterLoad?: boolean) => Promise<void>) | null>(
    null,
  );
  const symbolInfoRef = useRef<ActiveSymbolItem | null>(symbolInfo);
  symbolInfoRef.current = symbolInfo;

  const [latestSpot, setLatestSpot] = useState<number | null>(null);
  const [prevSpot, setPrevSpot] = useState<number | null>(null);
  const [decimals, setDecimals] = useState<number>(() =>
    symbolInfo ? fluctuationToDecimals(symbolInfo.pip_size) : 2,
  );
  const [feedLoading, setFeedLoading] = useState<boolean>(true);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const [earliestLoadedTime, setEarliestLoadedTime] = useState<number | null>(null);
  const [totalLoadedBars, setTotalLoadedBars] = useState<number>(0);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [seriesTickVersion, setSeriesTickVersion] = useState<number>(0);

  // Sync default decimals whenever symbol metadata changes
  useEffect(() => {
    if (symbolInfo) {
      const nextDec = fluctuationToDecimals(symbolInfo.pip_size);
      setDecimals(nextDec);
      mainSeriesRef.current?.applyOptions({
        priceFormat: {
          type: 'price',
          precision: nextDec,
          minMove: decimalsToMinMove(nextDec),
        },
      });
    }
  }, [symbolInfo]);

  // Create chart instance once per mount; preserve TradingView attributionLogo: true
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const initialRect = el.getBoundingClientRect();
    const chart = createChart(el, {
      autoSize: true,
      width: Math.max(300, Math.floor(initialRect.width) || 720),
      height: Math.max(360, Math.floor(initialRect.height) || 420),
      layout: {
        attributionLogo: true,
        background: { type: ColorType.Solid, color: '#0b1220' },
        textColor: '#94a3b8',
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(148, 163, 184, 0.07)' },
        horzLines: { color: 'rgba(148, 163, 184, 0.07)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        scaleMargins: { top: 0.14, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(148, 163, 184, 0.16)',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
        minBarSpacing: 0.35,
      },
      crosshair: {
        vertLine: { color: 'rgba(56, 189, 248, 0.35)' },
        horzLine: { color: 'rgba(56, 189, 248, 0.35)' },
      },
    });

    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        chart.resize(Math.floor(rect.width), Math.floor(rect.height));
      }
    });
    resizeObserver.observe(el);

    chartRef.current = chart;

    return () => {
      resizeObserver.disconnect();
      markersPluginRef.current = null;
      entryPriceLineRef.current = null;
      mainSeriesRef.current = null;
      futureWhitespaceSeriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  // Rebuild series & subscribe to `ticks_history` whenever symbol, granularity, or socket generation changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !symbol) return;

    chart.applyOptions({
      timeScale: {
        timeVisible: granularity < 86400,
        secondsVisible: granularity === 0,
        rightOffset: 8,
        minBarSpacing: 0.35,
      },
    });

    // Cleanly remove previous series (which also clears stale overlays/price lines)
    if (markersPluginRef.current) {
      markersPluginRef.current.detach();
      markersPluginRef.current = null;
    }
    entryPriceLineRef.current = null;
    stopOutPriceLineRef.current = null;
    takeProfitPriceLineRef.current = null;
    hoverEntryLineRef.current = null;
    hoverTpLineRef.current = null;
    hoverLossLineRef.current = null;
    if (mainSeriesRef.current) {
      chart.removeSeries(mainSeriesRef.current);
      mainSeriesRef.current = null;
    }
    if (futureWhitespaceSeriesRef.current) {
      chart.removeSeries(futureWhitespaceSeriesRef.current);
      futureWhitespaceSeriesRef.current = null;
    }
    lastSeriesTimeRef.current = null;
    earliestSeriesTimeRef.current = null;
    ticksMapRef.current.clear();
    candlesMapRef.current.clear();
    loadingOlderRef.current = false;
    reachedHistoryStartRef.current = false;
    fetchOlderHistoryRef.current = null;
    setLoadingOlder(false);
    setEarliestLoadedTime(null);
    setTotalLoadedBars(0);

    const currentInfo = symbolInfoRef.current;
    const initialDecimals = currentInfo ? fluctuationToDecimals(currentInfo.pip_size) : 2;
    const priceFormat = {
      type: 'price' as const,
      precision: initialDecimals,
      minMove: decimalsToMinMove(initialDecimals),
    };

    const mainSeries =
      granularity === 0
        ? chart.addSeries(AreaSeries, {
            lineColor: '#38bdf8',
            topColor: 'rgba(56, 189, 248, 0.28)',
            bottomColor: 'rgba(56, 189, 248, 0.01)',
            lineWidth: 2,
            priceFormat,
          })
        : chart.addSeries(CandlestickSeries, {
            upColor: '#10b981',
            downColor: '#f43f5e',
            borderUpColor: '#10b981',
            borderDownColor: '#f43f5e',
            wickUpColor: '#10b981',
            wickDownColor: '#f43f5e',
            priceFormat,
          });

    // Dedicated whitespace-only series so future expiry timestamps never block `mainSeries.update(...)`
    const futureSeries = chart.addSeries(LineSeries, {
      lineVisible: false,
      pointMarkersVisible: false,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    mainSeriesRef.current = mainSeries;
    futureWhitespaceSeriesRef.current = futureSeries;
    markersPluginRef.current = createSeriesMarkers(mainSeries, []);

    const isSocketReady =
      connectionStatus === 'ready_public' || connectionStatus === 'ready_authenticated';
    if (!isSocketReady) {
      setFeedLoading(true);
      return;
    }

    let active = true;
    let seeded = false;
    setFeedLoading(true);
    setFeedError(null);
    setLatestSpot(null);
    setPrevSpot(null);

    const applyPrecision = (pipDecimals?: number) => {
      if (pipDecimals === undefined || !active) return;
      setDecimals(pipDecimals);
      mainSeries.applyOptions({
        priceFormat: {
          type: 'price',
          precision: pipDecimals,
          minMove: decimalsToMinMove(pipDecimals),
        },
      });
    };

    const updateSpotBadge = (nextPrice: number) => {
      setLatestSpot((prev) => {
        if (prev !== null && prev !== nextPrice) {
          setPrevSpot(prev);
        }
        return nextPrice;
      });
    };

    // Function to backfill older historical bars/ticks when user zooms out or clicks "Load Older"
    const fetchOlderHistory = async (fitAfterLoad = false) => {
      if (
        !active ||
        !seeded ||
        loadingOlderRef.current ||
        reachedHistoryStartRef.current ||
        earliestSeriesTimeRef.current === null
      ) {
        return;
      }

      const currentSize =
        granularity === 0 ? ticksMapRef.current.size : candlesMapRef.current.size;
      if (currentSize >= MAX_HISTORICAL_POINTS) {
        reachedHistoryStartRef.current = true;
        return;
      }

      loadingOlderRef.current = true;
      setLoadingOlder(true);

      const beforeEpoch = earliestSeriesTimeRef.current;
      try {
        const reqPayload = buildTicksHistoryBackfillPayload(
          symbol,
          granularity,
          beforeEpoch,
          1000,
        );
        const res = await socket.request<{
          history?: { prices?: unknown[]; times?: unknown[] };
          candles?: Array<Record<string, unknown>>;
        }>(reqPayload, {
          expectedGeneration: connectionGeneration,
          timeoutMs: 10_000,
        });

        if (!active) return;

        if (granularity === 0) {
          const olderPoints = normalizeTickHistory(res.history);
          let addedCount = 0;
          for (const pt of olderPoints) {
            const t = Number(pt.time);
            if (!ticksMapRef.current.has(t)) {
              ticksMapRef.current.set(t, pt);
              if (t < beforeEpoch) addedCount += 1;
            }
          }
          if (addedCount === 0 || olderPoints.length < 5) {
            reachedHistoryStartRef.current = true;
            return;
          }
          const prevRange = chart.timeScale().getVisibleLogicalRange();
          const merged = Array.from(ticksMapRef.current.values()).sort(
            (a, b) => Number(a.time) - Number(b.time),
          );
          (mainSeries as ISeriesApi<'Area'>).setData(merged);
          earliestSeriesTimeRef.current = Number(merged[0].time);
          lastSeriesTimeRef.current = Number(merged[merged.length - 1].time);
          setEarliestLoadedTime(earliestSeriesTimeRef.current);
          setTotalLoadedBars(merged.length);

          if (fitAfterLoad) {
            chart.timeScale().fitContent();
          } else if (prevRange) {
            chart.timeScale().setVisibleLogicalRange({
              from: prevRange.from + addedCount,
              to: prevRange.to + addedCount,
            });
          }
          setSeriesTickVersion((v) => v + 1);
        } else {
          const olderCandles = normalizeCandleHistory(res.candles);
          let addedCount = 0;
          for (const c of olderCandles) {
            const t = Number(c.time);
            if (!candlesMapRef.current.has(t)) {
              candlesMapRef.current.set(t, c);
              if (t < beforeEpoch) addedCount += 1;
            }
          }
          if (addedCount === 0 || olderCandles.length < 5) {
            reachedHistoryStartRef.current = true;
            return;
          }
          const prevRange = chart.timeScale().getVisibleLogicalRange();
          const merged = Array.from(candlesMapRef.current.values()).sort(
            (a, b) => Number(a.time) - Number(b.time),
          );
          (mainSeries as ISeriesApi<'Candlestick'>).setData(merged);
          earliestSeriesTimeRef.current = Number(merged[0].time);
          lastSeriesTimeRef.current = Number(merged[merged.length - 1].time);
          setEarliestLoadedTime(earliestSeriesTimeRef.current);
          setTotalLoadedBars(merged.length);

          if (fitAfterLoad) {
            chart.timeScale().fitContent();
          } else if (prevRange) {
            chart.timeScale().setVisibleLogicalRange({
              from: prevRange.from + addedCount,
              to: prevRange.to + addedCount,
            });
          }
          setSeriesTickVersion((v) => v + 1);
        }
      } catch {
        // Non-fatal if end of Deriv historical archive reached
        reachedHistoryStartRef.current = true;
      } finally {
        if (active) {
          loadingOlderRef.current = false;
          setLoadingOlder(false);
        }
      }
    };

    fetchOlderHistoryRef.current = fetchOlderHistory;

    // Automatically fetch older dates whenever the user zooms out or scrolls near the left edge
    const onVisibleLogicalRangeChange = (
      range: { from: number; to: number } | null,
    ) => {
      if (!active || !seeded || !range) return;
      if (range.from < 80) {
        void fetchOlderHistory(false);
      }
    };

    chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);

    const payload = buildTicksHistorySubscriptionPayload(symbol, granularity, 1000);
    const sub = socket.subscribe(
      payload,
      {
        onMessage: (msg) => {
          if (!active) return;

          if (typeof msg.pip_size === 'number') {
            applyPrecision(msg.pip_size);
          }

          // Initial history snapshot (`history` for ticks, `candles` for OHLC)
          if (granularity === 0 && msg.history) {
            const points = normalizeTickHistory(
              msg.history as { prices?: unknown[]; times?: unknown[] },
            );
            ticksMapRef.current.clear();
            for (const pt of points) {
              ticksMapRef.current.set(Number(pt.time), pt);
            }
            (mainSeries as ISeriesApi<'Area'>).setData(points);
            const first = points[0];
            const last = points[points.length - 1];
            earliestSeriesTimeRef.current = first ? Number(first.time) : null;
            lastSeriesTimeRef.current = last ? Number(last.time) : null;
            setEarliestLoadedTime(earliestSeriesTimeRef.current);
            setTotalLoadedBars(points.length);
            if (last) updateSpotBadge(last.value);
            seeded = true;
            setFeedLoading(false);
            if (points.length > 160) {
              chart.timeScale().setVisibleLogicalRange({
                from: points.length - 140,
                to: points.length + 6,
              });
            } else {
              chart.timeScale().fitContent();
            }
            setSeriesTickVersion((v) => v + 1);
            // Proactively backfill a second 1,000-point historical page in the background
            void fetchOlderHistory(false);
            return;
          }

          if (granularity > 0 && Array.isArray(msg.candles)) {
            const candles = normalizeCandleHistory(
              msg.candles as Array<Record<string, unknown>>,
            );
            candlesMapRef.current.clear();
            for (const c of candles) {
              candlesMapRef.current.set(Number(c.time), c);
            }
            (mainSeries as ISeriesApi<'Candlestick'>).setData(candles);
            const first = candles[0];
            const last = candles[candles.length - 1];
            earliestSeriesTimeRef.current = first ? Number(first.time) : null;
            lastSeriesTimeRef.current = last ? Number(last.time) : null;
            setEarliestLoadedTime(earliestSeriesTimeRef.current);
            setTotalLoadedBars(candles.length);
            if (last) updateSpotBadge(last.close);
            seeded = true;
            setFeedLoading(false);
            if (candles.length > 160) {
              chart.timeScale().setVisibleLogicalRange({
                from: candles.length - 140,
                to: candles.length + 6,
              });
            } else {
              chart.timeScale().fitContent();
            }
            setSeriesTickVersion((v) => v + 1);
            // Proactively backfill a second 1,000-candle historical page in the background
            void fetchOlderHistory(false);
            return;
          }

          // Streaming updates (`tick` or `ohlc`) — only apply after initial seed and monotonic time check
          if (!seeded) return;

          if (granularity === 0 && msg.tick) {
            const parsed = normalizeLiveTick(msg);
            if (!parsed) return;
            if (parsed.symbol && parsed.symbol !== symbol) return;
            applyPrecision(parsed.pipDecimals);
            const t = Number(parsed.point.time);
            if (!canApplySeriesUpdate(lastSeriesTimeRef.current, t)) return;
            const isNewBar = !ticksMapRef.current.has(t);
            ticksMapRef.current.set(t, parsed.point);
            (mainSeries as ISeriesApi<'Area'>).update(parsed.point);
            lastSeriesTimeRef.current = t;
            if (isNewBar) setTotalLoadedBars(ticksMapRef.current.size);
            updateSpotBadge(parsed.point.value);
            setSeriesTickVersion((v) => v + 1);
            return;
          }

          if (granularity > 0 && msg.ohlc) {
            const parsed = normalizeLiveOhlc(msg);
            if (!parsed) return;
            if (parsed.symbol && parsed.symbol !== symbol) return;
            applyPrecision(parsed.pipDecimals);
            const t = Number(parsed.candle.time);
            if (!canApplySeriesUpdate(lastSeriesTimeRef.current, t)) return;
            const isNewBar = !candlesMapRef.current.has(t);
            candlesMapRef.current.set(t, parsed.candle);
            (mainSeries as ISeriesApi<'Candlestick'>).update(parsed.candle);
            lastSeriesTimeRef.current = t;
            if (isNewBar) setTotalLoadedBars(candlesMapRef.current.size);
            updateSpotBadge(parsed.candle.close);
            setSeriesTickVersion((v) => v + 1);
          }
        },
        onError: (err) => {
          if (!active) return;
          setFeedLoading(false);
          setFeedError(err.message);
        },
      },
      { expectedGeneration: connectionGeneration },
    );

    return () => {
      active = false;
      chart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
      sub.unsubscribe();
    };
  }, [socket, connectionStatus, connectionGeneration, symbol, granularity]);

  // Reconcile Rise/Fall & Multiplier open-position overlays
  useEffect(() => {
    const mainSeries = mainSeriesRef.current;
    const futureSeries = futureWhitespaceSeriesRef.current;
    const markersPlugin = markersPluginRef.current;
    if (!mainSeries || !futureSeries || !markersPlugin) return;

    const overlays = deriveRiseFallChartOverlays(
      positions,
      symbol,
      granularity,
      lastSeriesTimeRef.current,
    );

    if (entryPriceLineRef.current) {
      mainSeries.removePriceLine(entryPriceLineRef.current);
      entryPriceLineRef.current = null;
    }
    if (stopOutPriceLineRef.current) {
      mainSeries.removePriceLine(stopOutPriceLineRef.current);
      stopOutPriceLineRef.current = null;
    }
    if (takeProfitPriceLineRef.current) {
      mainSeries.removePriceLine(takeProfitPriceLineRef.current);
      takeProfitPriceLineRef.current = null;
    }

    if (overlays.entryPriceLine) {
      entryPriceLineRef.current = mainSeries.createPriceLine({
        price: overlays.entryPriceLine.price,
        color: overlays.entryPriceLine.color,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: overlays.entryPriceLine.title,
      });
    }

    if (overlays.stopOutPriceLine) {
      stopOutPriceLineRef.current = mainSeries.createPriceLine({
        price: overlays.stopOutPriceLine.price,
        color: overlays.stopOutPriceLine.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: overlays.stopOutPriceLine.title,
      });
    }

    if (overlays.takeProfitPriceLine) {
      takeProfitPriceLineRef.current = mainSeries.createPriceLine({
        price: overlays.takeProfitPriceLine.price,
        color: overlays.takeProfitPriceLine.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: overlays.takeProfitPriceLine.title,
      });
    }

    markersPlugin.setMarkers(overlays.markers);
    futureSeries.setData(overlays.whitespaceFuturePoints);
  }, [positions, symbol, granularity, seriesTickVersion]);

  // Draw live Hover Preview Price Lines (Entry, Take Profit Point, Loss / Stop-Out Point)
  // when user hovers over Buy MULTUP or Sell MULTDOWN buttons
  useEffect(() => {
    const mainSeries = mainSeriesRef.current;
    if (!mainSeries) return;

    if (hoverEntryLineRef.current) {
      mainSeries.removePriceLine(hoverEntryLineRef.current);
      hoverEntryLineRef.current = null;
    }
    if (hoverTpLineRef.current) {
      mainSeries.removePriceLine(hoverTpLineRef.current);
      hoverTpLineRef.current = null;
    }
    if (hoverLossLineRef.current) {
      mainSeries.removePriceLine(hoverLossLineRef.current);
      hoverLossLineRef.current = null;
    }

    if (!hoverPreview) {
      mainSeries.applyOptions({
        autoscaleInfoProvider: undefined,
      });
      return;
    }

    hoverEntryLineRef.current = mainSeries.createPriceLine({
      price: hoverPreview.entryPrice,
      color: '#38bdf8',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `▶ ${hoverPreview.contractType} Entry`,
    });

    hoverTpLineRef.current = mainSeries.createPriceLine({
      price: hoverPreview.takeProfitPrice,
      color: '#10b981',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `▲ ${hoverPreview.takeProfitLabel}`,
    });

    hoverLossLineRef.current = mainSeries.createPriceLine({
      price: hoverPreview.lossPrice,
      color: '#f43f5e',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `▼ ${hoverPreview.lossLabel}`,
    });

    // Expand Y-axis auto-scale range while hovering so both Take Profit and Loss lines are clearly visible on chart
    const targetMin = Math.min(
      hoverPreview.entryPrice,
      hoverPreview.lossPrice,
      hoverPreview.takeProfitPrice,
    );
    const targetMax = Math.max(
      hoverPreview.entryPrice,
      hoverPreview.lossPrice,
      hoverPreview.takeProfitPrice,
    );

    mainSeries.applyOptions({
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const res = original();
        if (!res || !res.priceRange) {
          const pad = Math.max(0.0001, (targetMax - targetMin) * 0.12);
          return {
            priceRange: {
              minValue: targetMin - pad,
              maxValue: targetMax + pad,
            },
          };
        }
        const minVal = Math.min(res.priceRange.minValue, targetMin);
        const maxVal = Math.max(res.priceRange.maxValue, targetMax);
        const pad = Math.max(0.0001, (maxVal - minVal) * 0.08);
        return {
          ...res,
          priceRange: {
            minValue: minVal - pad,
            maxValue: maxVal + pad,
          },
        };
      },
    });
  }, [hoverPreview, symbol, granularity, seriesTickVersion]);

  const priceDelta =
    latestSpot !== null && prevSpot !== null ? latestSpot - prevSpot : 0;

  const earliestDateLabel =
    earliestLoadedTime !== null
      ? new Date(earliestLoadedTime * 1000).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : null;

  return (
    <section className="panel chart-panel" aria-label="Live Price Chart">
      <div className="chart-toolbar">
        <div className="chart-symbol-meta">
          <div>
            <h2 className="chart-symbol-title">
              {symbolInfo?.underlying_symbol_name ?? symbol}
            </h2>
            <span className="chart-symbol-code">
              {symbol}
              {earliestDateLabel
                ? ` · History from ${earliestDateLabel} (${totalLoadedBars.toLocaleString()} bars)`
                : ''}
            </span>
          </div>

          <div className="spot-display tabular" aria-live="polite">
            <span
              className={`spot-value ${
                priceDelta > 0 ? 'spot-up' : priceDelta < 0 ? 'spot-down' : ''
              }`}
            >
              {latestSpot !== null ? latestSpot.toFixed(decimals) : '—'}
            </span>
            {priceDelta !== 0 && (
              <span className={`spot-delta ${priceDelta > 0 ? 'spot-up' : 'spot-down'}`}>
                {priceDelta > 0 ? '▲' : '▼'} {Math.abs(priceDelta).toFixed(decimals)}
              </span>
            )}
          </div>
        </div>

        <div className="chart-controls-right">
          <div className="chart-history-actions">
            <button
              type="button"
              className="btn btn-outline btn-xs"
              disabled={loadingOlder || feedLoading}
              onClick={() => void fetchOlderHistoryRef.current?.(true)}
              title="Fetch 1,000 older historical candles/ticks and zoom out to view earlier dates"
            >
              {loadingOlder ? 'Loading Older Dates…' : '◀ Load Older Dates'}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-xs"
              disabled={feedLoading}
              onClick={() => chartRef.current?.timeScale().fitContent()}
              title="Zoom out to fit all loaded historical dates on screen"
            >
              Fit All
            </button>
            <button
              type="button"
              className="btn btn-outline btn-xs"
              disabled={feedLoading}
              onClick={() => {
                if (!chartRef.current || totalLoadedBars === 0) return;
                chartRef.current.timeScale().setVisibleLogicalRange({
                  from: Math.max(0, totalLoadedBars - 120),
                  to: totalLoadedBars + 6,
                });
              }}
              title="Focus on the most recent 120 bars"
            >
              Latest ▶
            </button>
          </div>

          <div
            className="granularity-tabs"
            role="group"
            aria-label="Chart timeframe granularity"
          >
            {GRANULARITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`gran-btn ${granularity === opt.value ? 'active' : ''}`}
                aria-pressed={granularity === opt.value}
                onClick={() => onChangeGranularity(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-stage">
        <div ref={containerRef} className="chart-canvas" />

        {hoverPreview && (
          <div
            className="chart-hover-preview-card tabular"
            role="status"
            aria-live="polite"
          >
            <div className="hover-preview-title">
              <span
                className={`dir-badge ${
                  hoverPreview.direction === 'rise' ? 'dir-rise' : 'dir-fall'
                }`}
              >
                {hoverPreview.contractType}
              </span>
              <strong>Chart Level Preview (Hovering Order Button)</strong>
            </div>
            <div className="hover-preview-levels">
              <div className="hover-level-item level-tp">
                <span>▲ {hoverPreview.takeProfitLabel}</span>
                <strong>
                  {hoverPreview.takeProfitPrice.toFixed(decimals)} (
                  {hoverPreview.takeProfitMovePct >= 0 ? '+' : ''}
                  {hoverPreview.takeProfitMovePct.toFixed(2)}% · +
                  {hoverPreview.takeProfitAmount.toFixed(2)} {hoverPreview.currency})
                </strong>
              </div>
              <div className="hover-level-item level-entry">
                <span>▶ Entry Spot</span>
                <strong>{hoverPreview.entryPrice.toFixed(decimals)}</strong>
              </div>
              <div className="hover-level-item level-loss">
                <span>▼ {hoverPreview.lossLabel}</span>
                <strong>
                  {hoverPreview.lossPrice.toFixed(decimals)} (
                  {hoverPreview.lossMovePct >= 0 ? '+' : ''}
                  {hoverPreview.lossMovePct.toFixed(2)}% · -
                  {hoverPreview.lossAmount.toFixed(2)} {hoverPreview.currency})
                </strong>
              </div>
            </div>
          </div>
        )}

        {loadingOlder && !feedLoading && (
          <div className="chart-overlay-banner" role="status">
            Loading older historical dates…
          </div>
        )}

        {feedLoading && (
          <div className="chart-overlay-banner" role="status">
            Streaming {symbolInfo?.underlying_symbol_name ?? symbol}…
          </div>
        )}

        {feedError && !feedLoading && (
          <div className="chart-overlay-banner chart-overlay-error" role="alert">
            Feed error: {feedError}
          </div>
        )}
      </div>
    </section>
  );
};
