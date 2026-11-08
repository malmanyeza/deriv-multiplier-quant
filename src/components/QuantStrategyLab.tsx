import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Play,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Zap,
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
  runChronologicalWalkForward,
  type WalkForwardReport,
} from '../services/quantStrategyEngine';

interface QuantStrategyLabProps {
  socket: DerivSocketOwner;
  connectionStatus: ConnectionStatus;
  connectionGeneration: number;
  authenticated: boolean;
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
    stopLoss: null;
  }) => void;
  onExecuteDirectBuy: (direction: TradeDirection) => Promise<BuyWire | null>;
  onSellAtMarket: (contractId: number) => Promise<void>;
  onStartLogin: () => void;
}

interface BotAuditEntry {
  id: string;
  time: string;
  type: 'info' | 'entry' | 'exit' | 'blocked';
  message: string;
}

const REGIME_BADGES: Record<
  string,
  { label: string; className: string }
> = {
  TREND_EXPANSION: { label: 'TREND EXPANSION (ADX ≥ 24)', className: 'regime-trend' },
  RANGE_MEAN_REVERSION: {
    label: 'RANGE MEAN-REVERSION (ADX ≤ 20)',
    className: 'regime-mr',
  },
  NEUTRAL_TRANSITION: {
    label: 'TRANSITION ZONE (FLAT)',
    labelShort: 'WAIT / FLAT',
    className: 'regime-neutral',
  } as { label: string; className: string },
  CHAOS_GATED_OUT: {
    label: 'CHAOS GATE ACTIVE (ATR > 0.65%)',
    className: 'regime-warn',
  },
  CSPRNG_BLOCKED: {
    label: 'CSPRNG BLOCKED (ACF ≈ 0)',
    className: 'regime-error',
  },
};

export const QuantStrategyLab: React.FC<QuantStrategyLabProps> = ({
  socket,
  connectionStatus,
  connectionGeneration,
  authenticated,
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
  const [candles1h, setCandles1h] = useState<CandlePoint[]>([]);
  const [loadingCandles, setLoadingCandles] = useState<boolean>(false);
  const [deepAuditLoading, setDeepAuditLoading] = useState<boolean>(false);
  const [autoPilotArmed, setAutoPilotArmed] = useState<boolean>(false);
  const [scanningBasket, setScanningBasket] = useState<boolean>(false);
  const [testFiring, setTestFiring] = useState<TradeDirection | null>(null);
  const [nextBarCountdown, setNextBarCountdown] = useState<string>('—');
  const [auditLogs, setAuditLogs] = useState<BotAuditEntry[]>([]);

  const lastAutoActedBarTimeRef = useRef<number>(0);

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

  // Live 1-second countdown to the next 1h candle close (top of the hour XX:00:00)
  useEffect(() => {
    const updateClock = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const nextHourSec = Math.ceil((nowSec + 1) / 3600) * 3600;
      const diff = Math.max(0, nextHourSec - nowSec);
      const mins = Math.floor(diff / 60);
      const secs = diff % 60;
      setNextBarCountdown(
        `${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`,
      );
    };
    updateClock();
    const timer = window.setInterval(updateClock, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Fetch initial 3,000 1h candles (~125 days) + stream live 1h OHLC for the active symbol
  const loadMultiPage1hCandles = useCallback(
    async (pagesToFetch: number) => {
      const isSocketReady =
        connectionStatus === 'ready_public' ||
        connectionStatus === 'ready_authenticated';
      if (!isSocketReady || !symbol) return;

      if (pagesToFetch > 3) {
        setDeepAuditLoading(true);
      } else {
        setLoadingCandles(true);
      }

      try {
        let end: number | 'latest' = 'latest';
        const byEpoch = new Map<number, CandlePoint>();

        for (let p = 0; p < pagesToFetch; p++) {
          const res = await socket.request<{
            candles?: Array<Record<string, unknown>>;
          }>(
            {
              ticks_history: symbol,
              style: 'candles',
              granularity: 3600,
              count: 1000,
              end,
            },
            { expectedGeneration: connectionGeneration, timeoutMs: 10_000 },
          );
          const batch = normalizeCandleHistory(res.candles);
          if (batch.length === 0) break;
          for (const c of batch) {
            byEpoch.set(Number(c.time), c);
          }
          end = Number(batch[0].time) - 1;
          if (batch.length < 20) break;
        }

        const merged = Array.from(byEpoch.values()).sort(
          (a, b) => Number(a.time) - Number(b.time),
        );
        setCandles1h(merged);
      } catch {
        // Non-fatal if symbol has shorter history
      } finally {
        setLoadingCandles(false);
        setDeepAuditLoading(false);
      }
    },
    [socket, connectionStatus, connectionGeneration, symbol],
  );

  useEffect(() => {
    const isSocketReady =
      connectionStatus === 'ready_public' ||
      connectionStatus === 'ready_authenticated';
    if (!isSocketReady || !symbol) return;

    let cancelled = false;
    void loadMultiPage1hCandles(3);

    const sub = socket.subscribe(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count: 500,
        end: 'latest',
        granularity: 3600,
        style: 'candles',
      },
      {
        onMessage: (msg) => {
          if (cancelled) return;
          if (Array.isArray(msg.candles)) {
            const batch = normalizeCandleHistory(
              msg.candles as Array<Record<string, unknown>>,
            );
            setCandles1h((prev) => {
              const map = new Map<number, CandlePoint>();
              for (const c of prev) map.set(Number(c.time), c);
              for (const c of batch) map.set(Number(c.time), c);
              return Array.from(map.values()).sort(
                (a, b) => Number(a.time) - Number(b.time),
              );
            });
            return;
          }
          if (msg.ohlc) {
            const parsed = normalizeLiveOhlc(msg);
            if (!parsed) return;
            setCandles1h((prev) => {
              if (prev.length === 0) return [parsed.candle];
              const last = prev[prev.length - 1];
              if (Number(last.time) === Number(parsed.candle.time)) {
                const next = [...prev];
                next[next.length - 1] = parsed.candle;
                return next;
              }
              if (Number(parsed.candle.time) > Number(last.time)) {
                return [...prev, parsed.candle];
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
  }, [socket, connectionStatus, connectionGeneration, symbol, loadMultiPage1hCandles]);

  const [riskPct, setRiskPct] = useState<number>(0.01);

  const evaluation = useMemo(
    () =>
      evaluateQuantSignal({
        symbol,
        market: symbolInfo?.market,
        bars: candles1h,
        accountBalance,
        positions,
        stakeLimits,
        riskPctOfBalance: riskPct,
      }),
    [
      symbol,
      symbolInfo?.market,
      candles1h,
      accountBalance,
      positions,
      stakeLimits,
      riskPct,
    ],
  );

  const walkForwardReport: WalkForwardReport = useMemo(
    () => runChronologicalWalkForward(candles1h, symbol),
    [candles1h, symbol],
  );

  const closedDemoCount = useMemo(
    () => positions.filter((p) => p.isSold).length,
    [positions],
  );
  const canArmAutoPilot = authenticated && accountType === 'demo';

  // Disarm Auto-Pilot automatically if user switches away from Demo account
  useEffect(() => {
    if (autoPilotArmed && accountType !== 'demo') {
      setAutoPilotArmed(false);
      appendLog(
        'blocked',
        'Auto-Pilot disarmed: Real account selected. Forward-test 50 Demo trades first.',
      );
    }
  }, [autoPilotArmed, accountType, appendLog]);

  // Auto-Pilot execution loop on newly closed 1h bar
  useEffect(() => {
    if (!autoPilotArmed || !canArmAutoPilot) return;
    const barTime = evaluation.indicators?.barTime ?? 0;
    if (!barTime || barTime === lastAutoActedBarTimeRef.current) return;

    // 1. Check automated exit on open position first
    if (
      evaluation.exitSignalForOpenPosition.shouldExit &&
      evaluation.exitSignalForOpenPosition.contractId !== null
    ) {
      lastAutoActedBarTimeRef.current = barTime;
      const cid = evaluation.exitSignalForOpenPosition.contractId;
      appendLog(
        'exit',
        `Auto-Exit triggered on ${symbol} (#${cid}): ${evaluation.exitSignalForOpenPosition.reason}`,
      );
      void onSellAtMarket(cid);
      return;
    }

    // 2. Check automated entry on closed bar signal
    if (evaluation.signalDirection && !evaluation.riskPlan.circuitBreakerTripped) {
      const alreadyOpenOnSymbol = positions.some(
        (p) => !p.isSold && p.underlyingSymbol === symbol,
      );
      if (alreadyOpenOnSymbol) return;

      lastAutoActedBarTimeRef.current = barTime;
      const dir = evaluation.signalDirection;
      onApplyQuantTicketSetup({
        contractFamily: 'multipliers',
        multiplier: evaluation.riskPlan.recommendedMultiplier,
        amount: evaluation.riskPlan.recommendedStake,
        takeProfit: evaluation.riskPlan.recommendedTakeProfit,
        stopLoss: null,
      });

      appendLog(
        'entry',
        `Auto-Pilot executing ${dir === 'rise' ? 'MULTUP' : 'MULTDOWN'} ${evaluation.riskPlan.recommendedMultiplier}x on ${symbol} (1R = ${evaluation.riskPlan.recommendedStake} ${currency})…`,
      );
      void onExecuteDirectBuy(dir).then((receipt) => {
        if (receipt) {
          appendLog(
            'entry',
            `Opened Contract #${receipt.contract_id} on ${symbol} @ ${receipt.buy_price.toFixed(2)} ${currency}.`,
          );
        }
      });
    }
  }, [
    autoPilotArmed,
    canArmAutoPilot,
    evaluation,
    positions,
    symbol,
    currency,
    onApplyQuantTicketSetup,
    onExecuteDirectBuy,
    onSellAtMarket,
    appendLog,
  ]);

  const handleApplySetup = () => {
    onApplyQuantTicketSetup({
      contractFamily: 'multipliers',
      multiplier: evaluation.riskPlan.recommendedMultiplier,
      amount: evaluation.riskPlan.recommendedStake,
      takeProfit: evaluation.riskPlan.recommendedTakeProfit,
      stopLoss: null,
    });
    appendLog(
      'info',
      `Applied 100x Multiplier + Quarter-Kelly 1R stake (${evaluation.riskPlan.recommendedStake} ${currency}) to Order Ticket.`,
    );
  };

  // Scan all 4 non-random alpha markets in parallel and log live signals
  const handleScanAllAlphaMarkets = async () => {
    const isSocketReady =
      connectionStatus === 'ready_public' ||
      connectionStatus === 'ready_authenticated';
    if (!isSocketReady || scanningBasket) return;

    setScanningBasket(true);
    appendLog(
      'info',
      'Scanning 1h closed candles across BTC/USD, ETH/USD, Gold XAU/USD, and US Tech 100…',
    );

    const basket = [
      { code: 'cryBTCUSD', name: 'BTC/USD', market: 'cryptocurrency' },
      { code: 'cryETHUSD', name: 'ETH/USD', market: 'cryptocurrency' },
      { code: 'frxXAUUSD', name: 'Gold XAU/USD', market: 'commodities' },
      { code: 'OTC_NDX', name: 'US Tech 100', market: 'indices' },
    ];

    try {
      let triggeredSymbol: string | null = null;
      for (const item of basket) {
        const res = await socket.request<{
          candles?: Array<Record<string, unknown>>;
        }>(
          {
            ticks_history: item.code,
            style: 'candles',
            granularity: 3600,
            count: 250,
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
        });
        const adxStr = evalRes.indicators
          ? `ADX=${evalRes.indicators.adx14.toFixed(1)}, ATR=${evalRes.indicators.atrPct.toFixed(2)}%`
          : 'No data';

        if (evalRes.signalDirection) {
          triggeredSymbol = item.code;
          appendLog(
            'entry',
            `SIGNAL FOUND on ${item.name} (${item.code}): ${evalRes.signalHeadline} (${adxStr})`,
          );
        } else {
          appendLog(
            'info',
            `${item.name}: ${evalRes.signalHeadline} (${adxStr})`,
          );
        }
      }

      if (triggeredSymbol && triggeredSymbol !== symbol) {
        onSelectSymbol(triggeredSymbol);
      }
    } catch (err) {
      appendLog(
        'blocked',
        `Scan interrupted: ${err instanceof Error ? err.message : 'Network error'}`,
      );
    } finally {
      setScanningBasket(false);
    }
  };

  // Immediately test-fire a Demo Multiplier trade so user can verify automated execution without waiting 60m
  const handleTestFireDemoTrade = async (dir: TradeDirection) => {
    if (!canArmAutoPilot || testFiring) return;
    setTestFiring(dir);
    onApplyQuantTicketSetup({
      contractFamily: 'multipliers',
      multiplier: evaluation.riskPlan.recommendedMultiplier,
      amount: evaluation.riskPlan.recommendedStake,
      takeProfit: evaluation.riskPlan.recommendedTakeProfit,
      stopLoss: null,
    });
    appendLog(
      'entry',
      `Test-Firing Demo ${dir === 'rise' ? 'MULTUP (Up)' : 'MULTDOWN (Down)'} ${evaluation.riskPlan.recommendedMultiplier}x on ${symbol} (Stake: ${evaluation.riskPlan.recommendedStake.toFixed(2)} ${currency})…`,
    );
    try {
      const receipt = await onExecuteDirectBuy(dir);
      if (receipt) {
        appendLog(
          'entry',
          `Demo Order Executed! Contract #${receipt.contract_id} opened on ${symbol} @ ${receipt.buy_price.toFixed(2)} ${currency}. Check Open Positions below!`,
        );
      } else {
        appendLog(
          'blocked',
          'Demo Test-Fire did not complete — check Order Ticket message on the right.',
        );
      }
    } finally {
      setTestFiring(null);
    }
  };

  const regimeBadge =
    REGIME_BADGES[evaluation.regime] ?? REGIME_BADGES.NEUTRAL_TRANSITION;

  return (
    <section
      className="panel quant-lab-panel"
      aria-label="Quantitative Strategy Lab and Walk-Forward Engine"
    >
      <div className="positions-header">
        <div className="panel-title-row">
          <Bot size={16} className="accent-icon" aria-hidden="true" />
          <h2 className="panel-title">
            Quant Strategy Lab &amp; Walk-Forward Engine (1h Multipliers)
          </h2>
          <span className={`regime-pill ${regimeBadge.className}`}>
            {regimeBadge.label}
          </span>
        </div>

        <div className="quant-header-actions">
          <button
            type="button"
            className="btn btn-outline btn-xs"
            disabled={loadingCandles || deepAuditLoading}
            onClick={() => void loadMultiPage1hCandles(9)}
            title="Fetch up to 8,760 hourly candles (365 days) for full walk-forward validation"
          >
            <RefreshCw size={12} aria-hidden="true" />
            <span>
              {deepAuditLoading
                ? 'Running 365d Audit…'
                : `Load 365d History (${walkForwardReport.daysCovered}d loaded)`}
            </span>
          </button>

          <button
            type="button"
            className="btn btn-outline btn-xs"
            onClick={handleApplySetup}
          >
            <Sliders size={12} aria-hidden="true" />
            <span>
              Apply 1R Setup ({evaluation.riskPlan.recommendedStake.toFixed(2)}{' '}
              {currency})
            </span>
          </button>

          {!authenticated ? (
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={onStartLogin}
            >
              <Play size={12} aria-hidden="true" />
              <span>Connect Demo Session to Run Bot</span>
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn-xs ${
                autoPilotArmed ? 'btn-rise' : 'btn-primary'
              }`}
              disabled={!canArmAutoPilot || evaluation.isCsprng}
              onClick={() => {
                const next = !autoPilotArmed;
                setAutoPilotArmed(next);
                appendLog(
                  'info',
                  next
                    ? `Demo Auto-Pilot ARMED on ${symbol}. Watching 1h candle closes (next evaluation in ${nextBarCountdown}) with Quarter-Kelly 1R = ${evaluation.riskPlan.recommendedStake} ${currency}.`
                    : 'Demo Auto-Pilot DISARMED.',
                );
              }}
              title={
                accountType !== 'demo'
                  ? 'Safety Lock: Switch to your Demo account in the top header to arm Auto-Pilot'
                  : 'Toggle automated 1h closed-bar execution on Demo account'
              }
            >
              <Play size={12} aria-hidden="true" />
              <span>
                {autoPilotArmed
                  ? `Auto-Pilot ARMED (Next 1h Close: ${nextBarCountdown})`
                  : accountType === 'real'
                    ? 'Locked (Switch to Demo Account)'
                    : 'Arm Demo Auto-Pilot'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Interactive Demo Auto-Pilot Control & Action Bar */}
      <div
        className={`quant-autopilot-banner ${
          autoPilotArmed ? 'autopilot-armed' : ''
        }`}
      >
        <div className="autopilot-status-copy">
          {!authenticated ? (
            <>
              <strong>Step 1 — Connect Your Deriv Account:</strong> Click{' '}
              <em>Connect Demo Session to Run Bot</em> above (or{' '}
              <em>Connect PAT Session</em> in the top-right header) so the bot
              can read your Demo balance and place Multiplier trades.
            </>
          ) : accountType === 'real' ? (
            <>
              <strong>Safety Lock Active (Real Account Selected):</strong> Switch
              the account dropdown in the top-right header to your{' '}
              <strong>DEMO</strong> account to unlock automated bot execution.
            </>
          ) : (
            <>
              <strong>
                {autoPilotArmed
                  ? `🟢 Demo Auto-Pilot is ARMED on ${symbol} (Next 1h Bar Close in ${nextBarCountdown}):`
                  : `⚪ Demo Auto-Pilot Ready (${symbol} · Next 1h Bar Close in ${nextBarCountdown}):`}
              </strong>{' '}
              Because this strategy trades on <strong>closed 1-hour candles</strong>{' '}
              (not random ticks), the bot automatically enters when an hourly
              candle closes with a confirmed breakout or pullback. Don&apos;t
              want to wait {nextBarCountdown}? Use the instant buttons on the
              right to scan all 4 markets or test-fire a Demo trade right now:
            </>
          )}
        </div>

        <div className="autopilot-action-buttons">
          <button
            type="button"
            className="btn btn-outline btn-xs"
            disabled={scanningBasket}
            onClick={() => void handleScanAllAlphaMarkets()}
          >
            <RefreshCw size={12} aria-hidden="true" />
            <span>
              {scanningBasket ? 'Scanning 4 Markets…' : 'Scan All 4 Alpha Markets'}
            </span>
          </button>

          {canArmAutoPilot && !evaluation.isCsprng && (
            <>
              <button
                type="button"
                className="btn btn-rise btn-xs"
                disabled={testFiring !== null}
                onClick={() => void handleTestFireDemoTrade('rise')}
                title="Immediately place a 100x MULTUP Demo trade using the 1R setup so you can see the bot execute live"
              >
                <Zap size={12} aria-hidden="true" />
                <span>
                  {testFiring === 'rise'
                    ? 'Firing MULTUP…'
                    : 'Test-Fire Demo MULTUP Now'}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-fall btn-xs"
                disabled={testFiring !== null}
                onClick={() => void handleTestFireDemoTrade('fall')}
                title="Immediately place a 100x MULTDOWN Demo trade using the 1R setup so you can see the bot execute live"
              >
                <Zap size={12} aria-hidden="true" />
                <span>
                  {testFiring === 'fall'
                    ? 'Firing MULTDOWN…'
                    : 'Test-Fire Demo MULTDOWN Now'}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Quick-Switch Audited Basket */}
      <div className="quant-basket-bar">
        <span className="quant-basket-caption">Audited Basket:</span>
        {[
          { code: 'cryBTCUSD', label: 'BTC/USD (24/7 · 2.99 bps)' },
          { code: 'cryETHUSD', label: 'ETH/USD (24/7 · +21.7R)' },
          { code: 'frxXAUUSD', label: 'Gold XAU/USD (Mon–Fri · PF 1.60)' },
          { code: 'OTC_NDX', label: 'US Tech 100 (Mon–Fri · OOS PF 4.86)' },
          { code: '1HZ100V', label: '1HZ100V (CSPRNG Control)' },
        ].map((item) => (
          <button
            key={item.code}
            type="button"
            className={`chip-btn ${symbol === item.code ? 'active' : ''}`}
            onClick={() => onSelectSymbol(item.code)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Live Signal & Indicator Strip */}
      <div className="quant-grid">
        <div className="quant-signal-box">
          <div className="quant-signal-header">
            {evaluation.signalDirection ? (
              <CheckCircle2 size={15} className="text-up" aria-hidden="true" />
            ) : evaluation.isCsprng || !evaluation.chaosGatePassed ? (
              <AlertTriangle size={15} className="text-down" aria-hidden="true" />
            ) : (
              <Activity size={15} className="accent-icon" aria-hidden="true" />
            )}
            <strong>{evaluation.signalHeadline}</strong>
          </div>
          <p className="quant-rationale">{evaluation.signalRationale}</p>

          {evaluation.indicators && (
            <div className="quant-metrics-strip tabular">
              <div>
                <span>1h ATR% (Gate ≤ 0.65%)</span>
                <strong
                  className={
                    evaluation.chaosGatePassed ? 'text-up' : 'text-down'
                  }
                >
                  {evaluation.indicators.atrPct.toFixed(2)}%
                </strong>
              </div>
              <div>
                <span>ADX(14) Regime</span>
                <strong>{evaluation.indicators.adx14.toFixed(1)}</strong>
              </div>
              <div>
                <span>RSI(14)</span>
                <strong>{evaluation.indicators.rsi14.toFixed(1)}</strong>
              </div>
              <div>
                <span>EMA(30 / 100)</span>
                <strong
                  className={
                    evaluation.indicators.ema30 >= evaluation.indicators.ema100
                      ? 'text-up'
                      : 'text-down'
                  }
                >
                  {evaluation.indicators.ema30 >= evaluation.indicators.ema100
                    ? 'Bullish'
                    : 'Bearish'}
                </strong>
              </div>
              <div>
                <span>Donchian Channel</span>
                <strong>
                  [{evaluation.indicators.donchianLow48.toFixed(1)},{' '}
                  {evaluation.indicators.donchianHigh48.toFixed(1)}]
                </strong>
              </div>
            </div>
          )}
        </div>

        {/* Position Sizing & Circuit Breaker Card */}
        <div className="quant-risk-box tabular">
          <div className="quant-signal-header" style={{ justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Zap size={15} className="accent-icon" aria-hidden="true" />
              <strong>Position Sizing &amp; Circuit Breakers</strong>
            </span>
            <span style={{ display: 'flex', gap: 4 }}>
              {[
                { val: 0.0075, label: '0.75%' },
                { val: 0.01, label: '1.0%' },
                { val: 0.02, label: '2.0%' },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`chip-btn ${riskPct === opt.val ? 'active' : ''}`}
                  onClick={() => setRiskPct(opt.val)}
                >
                  {opt.label}
                </button>
              ))}
            </span>
          </div>
          <div className="quant-risk-grid">
            <div>
              <span>1R Stake ({evaluation.riskPlan.stakePctOfBalance}%)</span>
              <strong>
                {evaluation.riskPlan.recommendedStake.toFixed(2)} {currency}
              </strong>
            </div>
            <div>
              <span>Open Portfolio Risk</span>
              <strong>{evaluation.riskPlan.openRiskR} / 3R Max</strong>
            </div>
            <div>
              <span>Daily Realized P&amp;L</span>
              <strong
                className={
                  evaluation.riskPlan.dailyRealizedR >= 0
                    ? 'text-up'
                    : 'text-down'
                }
              >
                {evaluation.riskPlan.dailyRealizedR >= 0 ? '+' : ''}
                {evaluation.riskPlan.dailyRealizedR.toFixed(2)}R (Stop: -3.0R)
              </strong>
            </div>
            <div>
              <span>Demo Forward Gate</span>
              <strong>{closedDemoCount} / 50 Trades</strong>
            </div>
          </div>
          {evaluation.riskPlan.circuitBreakerReason && (
            <div className="quant-cb-alert">
              <ShieldAlert size={13} aria-hidden="true" />
              <span>{evaluation.riskPlan.circuitBreakerReason}</span>
            </div>
          )}
        </div>
      </div>

      {/* Chronological Walk-Forward Validation Table (60% Train / 20% Val / 20% OOS) */}
      <div className="positions-table-wrap">
        <table className="positions-table tabular">
          <thead>
            <tr>
              <th>Chronological Split ({walkForwardReport.daysCovered}d · 1h)</th>
              <th>Trades (N)</th>
              <th>Trades / Mo</th>
              <th>Win Rate</th>
              <th>Avg Win / Loss</th>
              <th>Profit Factor</th>
              <th>Worst Consec. Streak</th>
              <th>Max Drawdown</th>
              <th>Net Return (R)</th>
            </tr>
          </thead>
          <tbody>
            {[
              { label: 'Train Split (First 60%)', data: walkForwardReport.train },
              { label: 'Validation Split (Next 20%)', data: walkForwardReport.val },
              {
                label: 'Out-of-Sample Test (Final 20% Untouched)',
                data: walkForwardReport.testOOS,
              },
              {
                label: 'Full Period @ 0% App Markup (Optimal)',
                data: walkForwardReport.fullZeroMarkup,
              },
              {
                label: 'Full Period @ 3% App Markup (Unoptimized)',
                data: walkForwardReport.fullWith3PctMarkup,
              },
            ].map((row) => (
              <tr key={row.label}>
                <td>
                  <strong>{row.label}</strong>
                </td>
                <td>{row.data.n}</td>
                <td>
                  {row.data.n > 0 ? `${row.data.tradesPerMonth.toFixed(1)} / mo` : '—'}
                </td>
                <td>{row.data.n > 0 ? `${row.data.winRate.toFixed(1)}%` : '—'}</td>
                <td>
                  {row.data.n > 0
                    ? `+${row.data.avgWinR.toFixed(2)}R / -${row.data.avgLossR.toFixed(2)}R`
                    : '—'}
                </td>
                <td>{row.data.n > 0 ? row.data.pf.toFixed(2) : '—'}</td>
                <td>
                  {row.data.n > 0
                    ? `${row.data.maxConsecLosses} in a row (-${row.data.maxConsecLossR.toFixed(2)}R)`
                    : '—'}
                </td>
                <td>{row.data.n > 0 ? `${row.data.maxDdR.toFixed(2)}R` : '—'}</td>
                <td
                  className={
                    row.data.netR > 0
                      ? 'text-up'
                      : row.data.netR < 0
                        ? 'text-down'
                        : ''
                  }
                >
                  <strong>
                    {row.data.netR > 0 ? '+' : ''}
                    {row.data.netR.toFixed(2)}R
                  </strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {auditLogs.length > 0 && (
        <div className="quant-audit-log tabular">
          {auditLogs.slice(0, 4).map((entry) => (
            <div key={entry.id} className={`quant-log-item log-${entry.type}`}>
              <span className="muted-note">[{entry.time}]</span>{' '}
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
