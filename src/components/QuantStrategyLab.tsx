import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Play,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type {
  ActiveSymbolItem,
  BuyWire,
  ConnectionStatus,
  ContractFamily,
  NormalizedPosition,
  TradeDirection,
} from '../types/deriv';
import type { DerivSocketOwner } from '../services/derivSocket';
import {
  normalizeCandleHistory,
  normalizeLiveOhlc,
  type CandlePoint,
} from '../services/chartFeed';
import {
  evaluateQuantSignal,
  type QuantTimeframe,
} from '../services/quantStrategyEngine';
import type { DirectBuyOverrideSetup } from '../hooks/useTradeLifecycle';

interface QuantStrategyLabProps {
  socket: DerivSocketOwner;
  connectionStatus: ConnectionStatus;
  connectionGeneration: number;
  authenticated: boolean;
  getCsrfToken?: () => string;
  accountType: 'demo' | 'real' | null;
  accountBalance: number;
  currency: string;
  symbol: string;
  symbolInfo: ActiveSymbolItem | null;
  positions: NormalizedPosition[];
  stakeLimits: { min?: number; max?: number };
  onSelectSymbol: (symbol: string) => void;
  onApplyQuantTicketSetup: (setup: {
    contractFamily: ContractFamily;
    multiplier: number;
    amount: number;
    takeProfit: number | null;
    stopLoss: number | null;
  }) => void;
  onExecuteDirectBuy: (
    direction: TradeDirection,
    overrideSetup?: DirectBuyOverrideSetup,
  ) => Promise<BuyWire | null>;
  onSellAtMarket: (contractId: number) => Promise<void>;
  onStartLogin: () => void;
}

interface ServerRunnerSnapshot {
  available: boolean;
  armed: boolean;
  running: boolean;
  socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  lastScanAt: string | null;
  lastError: string | null;
  recentLogs: BotAuditEntry[];
  timeframe: QuantTimeframe;
  riskPct: number;
}

interface BotAuditEntry {
  id: string;
  time: string;
  type: 'info' | 'entry' | 'exit' | 'blocked';
  message: string;
}

const REGIME_BADGES: Record<string, { label: string; className: string }> = {
  TREND_EXPANSION: { label: 'TREND (ADX ≥ 24)', className: 'regime-trend' },
  RANGE_MEAN_REVERSION: { label: 'RANGE (ADX ≤ 20)', className: 'regime-mr' },
  NEUTRAL_TRANSITION: { label: 'WAIT / FLAT', className: 'regime-neutral' },
  CHAOS_GATED_OUT: { label: 'CHAOS GATE', className: 'regime-warn' },
  CHOP_GATE_ACTIVE: { label: 'CHOP GATE', className: 'regime-warn' },
  CSPRNG_BLOCKED: { label: '1H DISABLED (USE 15M)', className: 'regime-error' },
};

const BASKET_15M = [
  { code: '1HZ100V', name: 'Vol 100 (1s)', market: 'synthetic_index', engine: '15m' as const },
  { code: 'R_75', name: 'Vol 75', market: 'synthetic_index', engine: '15m' as const },
];

const BASKET_1H = [
  { code: 'cryBTCUSD', name: 'BTC/USD', market: 'cryptocurrency', engine: '1h' as const },
  { code: 'cryETHUSD', name: 'ETH/USD', market: 'cryptocurrency', engine: '1h' as const },
  { code: 'frxXAUUSD', name: 'Gold/USD', market: 'commodities', engine: '1h' as const },
  { code: 'frxXAGUSD', name: 'Silver/USD', market: 'commodities', engine: '1h' as const },
  { code: 'frxUSDCHF', name: 'USD/CHF', market: 'forex', engine: '1h' as const },
  { code: 'frxUSDJPY', name: 'USD/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPJPY', name: 'GBP/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxAUDJPY', name: 'AUD/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxEURUSD', name: 'EUR/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPUSD', name: 'GBP/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPAUD', name: 'GBP/AUD', market: 'forex', engine: '1h' as const },
];

const BASKET_DUAL = [...BASKET_15M, ...BASKET_1H];

export const QuantStrategyLab: React.FC<QuantStrategyLabProps> = ({
  socket,
  connectionStatus,
  connectionGeneration,
  authenticated,
  getCsrfToken,
  accountType,
  accountBalance,
  currency,
  symbol,
  symbolInfo,
  positions,
  stakeLimits,
  onSelectSymbol,
  onApplyQuantTicketSetup,
  onExecuteDirectBuy,
  onSellAtMarket,
  onStartLogin,
}) => {
  const [selectedTimeframe, setSelectedTimeframe] = useState<QuantTimeframe>(() => {
    try {
      const saved = localStorage.getItem('deriv_quant_timeframe');
      if (saved === '1h' || saved === '15m' || saved === 'dual') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'dual';
  });
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [autoPilotArmed, setAutoPilotArmed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('deriv_quant_autopilot_armed') === 'true';
    } catch {
      return false;
    }
  });
  const [serverStatus, setServerStatus] = useState<ServerRunnerSnapshot | null>(null);
  const [togglingAutoPilot, setTogglingAutoPilot] = useState<boolean>(false);
  const [scanningBasket, setScanningBasket] = useState<boolean>(false);
  const [detailsOpen, setDetailsOpen] = useState<boolean>(false);
  const [nextBarCountdown, setNextBarCountdown] = useState<string>('—');
  const [auditLogs, setAuditLogs] = useState<BotAuditEntry[]>([]);
  const [riskPct, setRiskPct] = useState<number>(0.03);
  const hydratedServerOnceRef = useRef<boolean>(false);
  const lastAutoActedBarTimeRef = useRef<number>(0);

  const isSyntheticSymbol = symbol.startsWith('1HZ') || symbol.startsWith('R_');
  const effectiveEngineTf: '15m' | '1h' =
    selectedTimeframe === '15m'
      ? '15m'
      : selectedTimeframe === 'dual'
        ? isSyntheticSymbol
          ? '15m'
          : '1h'
        : '1h';
  const granularity = effectiveEngineTf === '15m' ? 900 : 3600;

  const appendLog = useCallback(
    (type: BotAuditEntry['type'], message: string) => {
      const entry: BotAuditEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        time: new Date().toLocaleTimeString(),
        type,
        message,
      };
      setAuditLogs((prev) => [entry, ...prev].slice(0, 25));
    },
    [],
  );

  // Live countdown to the next candle close for the selected mode
  useEffect(() => {
    const updateClock = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      if (selectedTimeframe === 'dual') {
        const next15m = Math.ceil((nowSec + 1) / 900) * 900;
        const diff15 = Math.max(0, next15m - nowSec);
        const m15 = Math.floor(diff15 / 60);
        const s15 = diff15 % 60;

        const next1h = Math.ceil((nowSec + 1) / 3600) * 3600;
        const diff1h = Math.max(0, next1h - nowSec);
        const m1h = Math.floor(diff1h / 60);
        const s1h = diff1h % 60;

        setNextBarCountdown(
          `15M ${String(m15).padStart(2, '0')}m${String(s15).padStart(2, '0')}s · 1H ${String(m1h).padStart(2, '0')}m${String(s1h).padStart(2, '0')}s`,
        );
      } else {
        const nextBarSec = Math.ceil((nowSec + 1) / granularity) * granularity;
        const diff = Math.max(0, nextBarSec - nowSec);
        const mins = Math.floor(diff / 60);
        const secs = diff % 60;
        setNextBarCountdown(
          `${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`,
        );
      }
    };
    updateClock();
    const timer = window.setInterval(updateClock, 1000);
    return () => window.clearInterval(timer);
  }, [granularity, selectedTimeframe]);

  // Fetch recent closed candles + stream live OHLC for active symbol indicator telemetry
  useEffect(() => {
    const isSocketReady =
      connectionStatus === 'ready_public' ||
      connectionStatus === 'ready_authenticated';
    if (!isSocketReady || !symbol) return;

    let cancelled = false;

    const sub = socket.subscribe(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 350,
        end: 'latest',
        granularity,
        style: 'candles',
      },
      {
        onMessage: (msg) => {
          if (cancelled) return;
          if (Array.isArray(msg.candles)) {
            const batch = normalizeCandleHistory(
              msg.candles as Array<Record<string, unknown>>,
            );
            setCandles(batch);
            return;
          }
          if (msg.ohlc) {
            const parsed = normalizeLiveOhlc(msg);
            if (!parsed) return;
            setCandles((prev) => {
              if (prev.length === 0) return [parsed.candle];
              const last = prev[prev.length - 1];
              if (Number(last.time) === Number(parsed.candle.time)) {
                const next = [...prev];
                next[next.length - 1] = parsed.candle;
                return next;
              }
              if (Number(parsed.candle.time) > Number(last.time)) {
                return [...prev, parsed.candle].slice(-400);
              }
              return prev;
            });
          }
        },
      },
      { expectedGeneration: connectionGeneration },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [socket, connectionStatus, connectionGeneration, symbol, granularity]);

  const syncServerAutoPilot = useCallback(async () => {
    try {
      const res = await fetch('/api/quant/autopilot', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as ServerRunnerSnapshot;
      setServerStatus(data);
      if (data.available && !hydratedServerOnceRef.current) {
        hydratedServerOnceRef.current = true;
        setAutoPilotArmed(data.armed);
        try {
          localStorage.setItem('deriv_quant_autopilot_armed', String(data.armed));
        } catch {
          // ignore
        }
        const savedTf = (() => {
          try {
            return localStorage.getItem('deriv_quant_timeframe');
          } catch {
            return null;
          }
        })();
        if (
          (data.armed || !savedTf) &&
          (data.timeframe === 'dual' ||
            data.timeframe === '15m' ||
            data.timeframe === '1h')
        ) {
          setSelectedTimeframe(data.timeframe);
        }
        if (typeof data.riskPct === 'number' && Number.isFinite(data.riskPct)) {
          setRiskPct(data.riskPct);
        }
      }
    } catch {
      // Backend polling non-fatal
    }
  }, []);

  useEffect(() => {
    void syncServerAutoPilot();
    const timer = window.setInterval(() => {
      void syncServerAutoPilot();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [syncServerAutoPilot]);

  const pushServerAutoPilot = useCallback(
    async (opts: { armed: boolean; timeframe?: QuantTimeframe; riskPct?: number }) => {
      if (!serverStatus?.available) return;
      setTogglingAutoPilot(true);
      try {
        const csrf = getCsrfToken ? getCsrfToken() : '';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (csrf) headers['X-CSRF-Token'] = csrf;

        let res = await fetch('/api/quant/autopilot', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify(opts),
        });

        if (res.status === 403) {
          await fetch('/api/auth/status', { credentials: 'include' }).catch(() => {});
          const refreshedCsrf = getCsrfToken ? getCsrfToken() : '';
          if (refreshedCsrf) headers['X-CSRF-Token'] = refreshedCsrf;
          res = await fetch('/api/quant/autopilot', {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify(opts),
          });
        }

        if (res.ok) {
          const data = (await res.json()) as ServerRunnerSnapshot;
          setServerStatus(data);
          setAutoPilotArmed(data.armed);
        }
      } catch {
        // Non-fatal
      } finally {
        setTogglingAutoPilot(false);
      }
    },
    [serverStatus?.available, getCsrfToken],
  );

  const evaluation = useMemo(
    () =>
      evaluateQuantSignal({
        symbol,
        market: symbolInfo?.market,
        bars: candles,
        accountBalance,
        positions,
        stakeLimits,
        riskPctOfBalance: riskPct,
        timeframe: selectedTimeframe,
      }),
    [
      symbol,
      symbolInfo?.market,
      candles,
      accountBalance,
      positions,
      stakeLimits,
      riskPct,
      selectedTimeframe,
    ],
  );

  const canArmAutoPilot = authenticated && accountType === 'demo';

  useEffect(() => {
    if (!authenticated) return;
    if (autoPilotArmed && accountType === 'real') {
      setAutoPilotArmed(false);
      try {
        localStorage.setItem('deriv_quant_autopilot_armed', 'false');
      } catch {
        // ignore
      }
      appendLog('blocked', 'Auto-Pilot disarmed: Real account selected.');
    }
  }, [autoPilotArmed, authenticated, accountType, appendLog]);

  // Browser fallback Auto-Pilot execution loop (only runs when backend runner is unavailable)
  useEffect(() => {
    if (serverStatus?.available) return;
    if (!autoPilotArmed || !canArmAutoPilot) return;
    const barTime = evaluation.indicators?.barTime ?? 0;
    if (!barTime || barTime === lastAutoActedBarTimeRef.current) return;

    if (
      evaluation.exitSignalForOpenPosition.shouldExit &&
      evaluation.exitSignalForOpenPosition.contractId !== null
    ) {
      lastAutoActedBarTimeRef.current = barTime;
      const cid = evaluation.exitSignalForOpenPosition.contractId;
      appendLog(
        'exit',
        `Auto-Exit on ${symbol} (#${cid}): ${evaluation.exitSignalForOpenPosition.reason}`,
      );
      void onSellAtMarket(cid);
      return;
    }

    if (evaluation.signalDirection && !evaluation.riskPlan.circuitBreakerTripped) {
      const alreadyOpenOnSymbol = positions.some(
        (p) => !p.isSold && p.underlyingSymbol === symbol,
      );
      if (alreadyOpenOnSymbol) return;

      lastAutoActedBarTimeRef.current = barTime;
      const dir = evaluation.signalDirection;
      const setup: DirectBuyOverrideSetup = {
        underlyingSymbol: symbol,
        multiplier: evaluation.riskPlan.recommendedMultiplier,
        amount: evaluation.riskPlan.recommendedStake,
        takeProfit: evaluation.riskPlan.recommendedTakeProfit,
        stopLoss: evaluation.riskPlan.recommendedStopLoss,
      };
      onApplyQuantTicketSetup({
        contractFamily: 'multipliers',
        multiplier: evaluation.riskPlan.recommendedMultiplier,
        amount: evaluation.riskPlan.recommendedStake,
        takeProfit: evaluation.riskPlan.recommendedTakeProfit,
        stopLoss: evaluation.riskPlan.recommendedStopLoss,
      });

      appendLog(
        'entry',
        `Auto-Pilot executing ${dir === 'rise' ? 'MULTUP' : 'MULTDOWN'} ${evaluation.riskPlan.recommendedMultiplier}x on ${symbol} (${evaluation.riskPlan.recommendedStake} ${currency})…`,
      );
      void onExecuteDirectBuy(dir, setup).then((receipt) => {
        if (receipt) {
          appendLog(
            'entry',
            `Opened #${receipt.contract_id} on ${symbol} @ ${receipt.buy_price.toFixed(2)} ${currency}.`,
          );
        }
      });
    } else if (
      (selectedTimeframe === '15m' || selectedTimeframe === 'dual') &&
      positions.filter((p) => !p.isSold).length < 8
    ) {
      lastAutoActedBarTimeRef.current = barTime;
      void (async () => {
        const basketToScan = selectedTimeframe === 'dual' ? BASKET_DUAL : BASKET_15M;
        for (const item of basketToScan) {
          if (item.code === symbol) continue;
          const openForSym = positions.some(
            (p) => !p.isSold && p.underlyingSymbol === item.code,
          );
          if (openForSym) continue;

          try {
            const gran = item.engine === '15m' ? 900 : 3600;
            const res = await socket.request<{
              candles?: Array<Record<string, unknown>>;
            }>(
              {
                ticks_history: item.code,
                style: 'candles',
                granularity: gran,
                count: 350,
                end: 'latest',
              },
              { expectedGeneration: connectionGeneration, timeoutMs: 6_000 },
            );
            const bars = normalizeCandleHistory(res.candles);
            const evalBasket = evaluateQuantSignal({
              symbol: item.code,
              market: item.market,
              bars,
              accountBalance,
              positions,
              stakeLimits,
              riskPctOfBalance: riskPct,
              timeframe: item.engine,
            });
            if (
              evalBasket.signalDirection &&
              !evalBasket.riskPlan.circuitBreakerTripped
            ) {
              const basketSetup: DirectBuyOverrideSetup = {
                underlyingSymbol: item.code,
                multiplier: evalBasket.riskPlan.recommendedMultiplier,
                amount: evalBasket.riskPlan.recommendedStake,
                takeProfit: evalBasket.riskPlan.recommendedTakeProfit,
                stopLoss: evalBasket.riskPlan.recommendedStopLoss,
              };
              onSelectSymbol(item.code);
              onApplyQuantTicketSetup({
                contractFamily: 'multipliers',
                multiplier: evalBasket.riskPlan.recommendedMultiplier,
                amount: evalBasket.riskPlan.recommendedStake,
                takeProfit: evalBasket.riskPlan.recommendedTakeProfit,
                stopLoss: evalBasket.riskPlan.recommendedStopLoss,
              });
              appendLog(
                'entry',
                `${item.engine.toUpperCase()} Breakout on ${item.name}. Executing ${evalBasket.signalDirection === 'rise' ? 'MULTUP' : 'MULTDOWN'} ${evalBasket.riskPlan.recommendedMultiplier}x…`,
              );
              void onExecuteDirectBuy(evalBasket.signalDirection, basketSetup);
              break;
            }
          } catch {
            // Non-fatal
          }
        }
      })();
    }
  }, [
    serverStatus?.available,
    autoPilotArmed,
    canArmAutoPilot,
    evaluation,
    positions,
    symbol,
    currency,
    riskPct,
    selectedTimeframe,
    socket,
    connectionGeneration,
    stakeLimits,
    accountBalance,
    onSelectSymbol,
    onApplyQuantTicketSetup,
    onExecuteDirectBuy,
    onSellAtMarket,
    appendLog,
  ]);

  const handleScanBasket = async () => {
    const isSocketReady =
      connectionStatus === 'ready_public' ||
      connectionStatus === 'ready_authenticated';
    if (!isSocketReady || scanningBasket) return;

    const targetBasket =
      selectedTimeframe === 'dual'
        ? BASKET_DUAL
        : selectedTimeframe === '15m'
          ? BASKET_15M
          : BASKET_1H;

    setScanningBasket(true);
    setDetailsOpen(true);
    appendLog(
      'info',
      `Scanning ${selectedTimeframe.toUpperCase()} across ${targetBasket.map((b) => b.name).join(', ')}…`,
    );

    try {
      let triggeredSymbol: string | null = null;
      for (const item of targetBasket) {
        const gran = item.engine === '15m' ? 900 : 3600;
        const res = await socket.request<{
          candles?: Array<Record<string, unknown>>;
        }>(
          {
            ticks_history: item.code,
            style: 'candles',
            granularity: gran,
            count: 350,
            end: 'latest',
          },
          { expectedGeneration: connectionGeneration, timeoutMs: 8_000 },
        );
        const bars = normalizeCandleHistory(res.candles);
        const evalRes = evaluateQuantSignal({
          symbol: item.code,
          market: item.market,
          bars,
          accountBalance,
          positions,
          stakeLimits,
          riskPctOfBalance: riskPct,
          timeframe: item.engine,
        });
        const adxStr = evalRes.indicators
          ? `ADX ${evalRes.indicators.adx14.toFixed(1)}, RSI ${evalRes.indicators.rsi14.toFixed(1)}`
          : 'No data';

        if (evalRes.signalDirection) {
          triggeredSymbol = item.code;
          appendLog(
            'entry',
            `SIGNAL on ${item.name} (${item.engine.toUpperCase()}): ${evalRes.signalHeadline} (${adxStr})`,
          );
        } else {
          appendLog(
            'info',
            `${item.name} (${item.engine.toUpperCase()}): ${evalRes.signalHeadline} (${adxStr})`,
          );
        }
      }

      if (triggeredSymbol && triggeredSymbol !== symbol) {
        onSelectSymbol(triggeredSymbol);
      }
    } catch (err) {
      appendLog(
        'blocked',
        `Scan error: ${err instanceof Error ? err.message : 'Network error'}`,
      );
    } finally {
      setScanningBasket(false);
    }
  };

  const handleSelectTimeframe = (tf: QuantTimeframe) => {
    setSelectedTimeframe(tf);
    try {
      localStorage.setItem('deriv_quant_timeframe', tf);
    } catch {
      // ignore
    }
    if (serverStatus?.available) {
      void pushServerAutoPilot({ armed: autoPilotArmed, timeframe: tf, riskPct });
    }
  };

  const regimeBadge =
    REGIME_BADGES[evaluation.regime] ?? REGIME_BADGES.NEUTRAL_TRANSITION;
  const combinedLogs = [...auditLogs, ...(serverStatus?.recentLogs ?? [])].slice(0, 8);
  const atrGateLabel = effectiveEngineTf === '15m' ? '15m ATR%' : '1h ATR%';
  const emaLabel = 'EMA (30 / 100)';
  const emaBullish = evaluation.indicators
    ? evaluation.indicators.ema30 >= evaluation.indicators.ema100
    : false;

  return (
    <section
      className="panel quant-lab-panel quant-compact-panel"
      aria-label="Auto-Pilot Control Bar"
    >
      {/* Row 1: Status, Countdown, Scan & Arm/Disarm */}
      <div className="quant-compact-top">
        <div className="panel-title-row">
          <Bot size={16} className="accent-icon" aria-hidden="true" />
          <h2 className="panel-title">
            {serverStatus?.available ? '24/7 Server Auto-Pilot' : 'Auto-Pilot'}
          </h2>
          <span className={`regime-pill ${regimeBadge.className}`}>
            {regimeBadge.label}
          </span>
          <span className="quant-countdown-chip tabular" title="Next candle close">
            Next Close: {nextBarCountdown}
          </span>
        </div>

        <div className="quant-header-actions">
          <button
            type="button"
            className="btn btn-outline btn-xs"
            disabled={scanningBasket}
            onClick={() => void handleScanBasket()}
            title="Scan active basket for signals"
          >
            <RefreshCw
              size={12}
              className={scanningBasket ? 'spin' : undefined}
              aria-hidden="true"
            />
            <span>{scanningBasket ? 'Scanning…' : 'Scan'}</span>
          </button>

          {!authenticated ? (
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={onStartLogin}
            >
              <Play size={12} aria-hidden="true" />
              <span>Connect Demo to Run</span>
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn-xs ${autoPilotArmed ? 'btn-rise' : 'btn-primary'}`}
              disabled={!canArmAutoPilot || togglingAutoPilot}
              onClick={() => {
                const next = !autoPilotArmed;
                setAutoPilotArmed(next);
                try {
                  localStorage.setItem('deriv_quant_autopilot_armed', String(next));
                } catch {
                  // ignore
                }
                if (serverStatus?.available) {
                  void pushServerAutoPilot({
                    armed: next,
                    timeframe: selectedTimeframe,
                    riskPct,
                  });
                } else {
                  appendLog(
                    'info',
                    next
                      ? `Browser Auto-Pilot ARMED (${selectedTimeframe.toUpperCase()}, ${(riskPct * 100).toFixed(2).replace(/\.00$/, '')}% stake).`
                      : 'Auto-Pilot DISARMED.',
                  );
                }
              }}
              title={
                accountType !== 'demo'
                  ? 'Switch to Demo account in the top header to arm Auto-Pilot'
                  : undefined
              }
            >
              <Play size={12} aria-hidden="true" />
              <span>
                {accountType === 'real'
                  ? 'Locked (Real Account)'
                  : autoPilotArmed
                    ? `ARMED (${selectedTimeframe.toUpperCase()})`
                    : `Arm Auto-Pilot (${selectedTimeframe.toUpperCase()})`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Engine Mode, Stake %, Portfolio Summary & Details Toggle */}
      <div className="quant-compact-bar">
        <div className="quant-compact-controls">
          <div className="quant-control-group">
            <span className="quant-tf-tag">MODE</span>
            {(
              [
                { id: 'dual', label: 'Dual (15M+1H)' },
                { id: '1h', label: '1H Macro' },
                { id: '15m', label: '15M Turbo' },
              ] as const
            ).map((tf) => (
              <button
                key={tf.id}
                type="button"
                className={`chip-btn ${selectedTimeframe === tf.id ? 'active' : ''}`}
                onClick={() => handleSelectTimeframe(tf.id)}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <div className="quant-control-group tabular">
            <span className="quant-tf-tag">STAKE</span>
            {[
              { val: 0.0075, label: '0.75%' },
              { val: 0.01, label: '1.0%' },
              { val: 0.02, label: '2.0%' },
              { val: 0.03, label: '3.0%' },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                className={`chip-btn ${riskPct === opt.val ? 'active' : ''}`}
                onClick={() => {
                  setRiskPct(opt.val);
                  if (serverStatus?.available && autoPilotArmed) {
                    void pushServerAutoPilot({
                      armed: true,
                      timeframe: selectedTimeframe,
                      riskPct: opt.val,
                    });
                  }
                }}
              >
                {opt.label}
              </button>
            ))}
            <span className="quant-stake-readout">
              ({evaluation.riskPlan.recommendedStake.toFixed(2)} {currency})
            </span>
          </div>
        </div>

        <div className="quant-compact-stats tabular">
          <span className="quant-stat-item">
            Risk <strong>{evaluation.riskPlan.openRiskR}/3R</strong>
          </span>
          <span className="quant-stat-item">
            Today{' '}
            <strong
              className={
                evaluation.riskPlan.dailyRealizedR >= 0 ? 'text-up' : 'text-down'
              }
            >
              {evaluation.riskPlan.dailyRealizedR >= 0 ? '+' : ''}
              {evaluation.riskPlan.dailyRealizedR.toFixed(2)}R
            </strong>
          </span>

          {evaluation.riskPlan.circuitBreakerTripped ? (
            <span
              className="circuit-breaker-pill tripped"
              title={evaluation.riskPlan.circuitBreakerReason || ''}
            >
              <AlertTriangle size={12} aria-hidden="true" />
              <span>Breaker Tripped</span>
            </span>
          ) : evaluation.riskPlan.throttledByDrawdown ? (
            <span className="circuit-breaker-pill throttled">
              <ShieldAlert size={12} aria-hidden="true" />
              <span>50% Throttle ({evaluation.riskPlan.consecutiveLosses}L)</span>
            </span>
          ) : (
            <span className="circuit-breaker-pill normal">
              <CheckCircle2 size={12} aria-hidden="true" />
              <span>Breaker OK ({evaluation.riskPlan.consecutiveLosses}/3)</span>
            </span>
          )}

          <button
            type="button"
            className="btn btn-outline btn-xs"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            <span>Indicators &amp; Logs</span>
            {detailsOpen ? (
              <ChevronUp size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Collapsible Indicators & Logs Drawer */}
      {detailsOpen && (
        <div className="quant-details-drawer">
          <div className="quant-signal-box">
            <div className="quant-signal-header">
              {evaluation.signalDirection ? (
                <CheckCircle2 size={15} className="text-up" aria-hidden="true" />
              ) : evaluation.isCsprng || !evaluation.chaosGatePassed ? (
                <AlertTriangle size={15} className="text-down" aria-hidden="true" />
              ) : (
                <Activity size={15} className="accent-icon" aria-hidden="true" />
              )}
              <strong>
                {symbol}: {evaluation.signalHeadline}
              </strong>
            </div>
            <p className="quant-rationale">{evaluation.signalRationale}</p>

            {evaluation.indicators && (
              <div className="quant-metrics-strip tabular">
                <div>
                  <span>{atrGateLabel}</span>
                  <strong className={evaluation.chaosGatePassed ? 'text-up' : 'text-down'}>
                    {evaluation.indicators.atrPct.toFixed(2)}%
                  </strong>
                </div>
                <div>
                  <span>ADX(14)</span>
                  <strong>{evaluation.indicators.adx14.toFixed(1)}</strong>
                </div>
                <div>
                  <span>RSI(14)</span>
                  <strong>{evaluation.indicators.rsi14.toFixed(1)}</strong>
                </div>
                <div>
                  <span>{emaLabel}</span>
                  <strong className={emaBullish ? 'text-up' : 'text-down'}>
                    {emaBullish ? 'Bullish' : 'Bearish'}
                  </strong>
                </div>
              </div>
            )}

            {evaluation.riskPlan.circuitBreakerReason && (
              <div className="quant-cb-alert">
                <ShieldAlert size={13} aria-hidden="true" />
                <span>{evaluation.riskPlan.circuitBreakerReason}</span>
              </div>
            )}
          </div>

          <div className="quant-audit-log tabular">
            {combinedLogs.length === 0 ? (
              <div className="muted-note">No bot events logged yet.</div>
            ) : (
              combinedLogs.map((entry) => (
                <div key={entry.id} className={`quant-log-item log-${entry.type}`}>
                  <span className="muted-note">[{entry.time}]</span>{' '}
                  <span>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
};
