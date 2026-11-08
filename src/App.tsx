import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type {
  ActiveSymbolItem,
  AmountBasis,
  ChartGranularity,
  ContractFamily,
  DurationUnit,
  HoverPreviewLevels,
} from './types/deriv';
import { useAuth } from './context/AuthContext';
import {
  fetchAllTradableSymbols,
  fetchSymbolRiseFallRules,
  type RiseFallSymbolRules,
} from './services/marketData';
import {
  getAllowedUnitsForSelection,
  reconcileRiseFallControls,
} from './adapters/riseFallAdapter';
import { useTradeLifecycle } from './hooks/useTradeLifecycle';
import { HeaderBar } from './components/HeaderBar';
import { SymbolSelector } from './components/SymbolSelector';
import { PriceChart } from './components/PriceChart';
import { QuantStrategyLab } from './components/QuantStrategyLab';
import { OrderTicket } from './components/OrderTicket';
import { PositionsPanel } from './components/PositionsPanel';
import { LicensesModal } from './components/LicensesModal';

const PUBLIC_QUOTE_CURRENCY =
  (import.meta.env.VITE_PUBLIC_QUOTE_CURRENCY as string | undefined)?.trim() || 'USD';

export const App: React.FC = () => {
  const {
    oauthConfigured,
    patConfigured,
    patReady,
    authenticated,
    selectedAccount,
    authNotice,
    dismissAuthNotice,
    connectionStatus,
    connectionGeneration,
    connectionError,
    socket,
    startLogin,
  } = useAuth();

  const [symbols, setSymbols] = useState<ActiveSymbolItem[]>([]);
  const [symbolsLoading, setSymbolsLoading] = useState<boolean>(true);
  const [marketError, setMarketError] = useState<string | null>(null);

  // Default to 24/7 Bitcoin (`cryBTCUSD`) on 1h candles with Multipliers
  const [selectedSymbol, setSelectedSymbol] = useState<string>('cryBTCUSD');
  const [granularity, setGranularity] = useState<ChartGranularity>(3600);
  const [contractFamily, setContractFamily] =
    useState<ContractFamily>('multipliers');

  const [rules, setRules] = useState<RiseFallSymbolRules | null>(null);
  const [rulesLoading, setRulesLoading] = useState<boolean>(true);

  const [basis, setBasis] = useState<AmountBasis>('stake');
  const [amount, setAmount] = useState<number>(10);
  const [multiplier, setMultiplier] = useState<number>(100);
  const [takeProfit, setTakeProfit] = useState<number | null>(null);
  const [stopLoss, setStopLoss] = useState<number | null>(null);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('t');
  const [duration, setDuration] = useState<number>(5);
  const [allowEquals, setAllowEquals] = useState<boolean>(false);
  const [hoverPreview, setHoverPreview] = useState<HoverPreviewLevels | null>(
    null,
  );

  const [licensesOpen, setLicensesOpen] = useState<boolean>(false);

  const rulesGenerationRef = useRef<number>(0);

  const quoteCurrency =
    authenticated && selectedAccount
      ? selectedAccount.currency
      : PUBLIC_QUOTE_CURRENCY;

  const isSocketReady =
    connectionStatus === 'ready_public' ||
    connectionStatus === 'ready_authenticated';

  // 1. Discover all tradable markets (`active_symbols`) supporting Multipliers and/or Rise/Fall
  useEffect(() => {
    if (!isSocketReady) return;
    let active = true;
    setSymbolsLoading(true);
    setMarketError(null);

    void fetchAllTradableSymbols(socket)
      .then((list) => {
        if (!active) return;
        setSymbols(list);
        if (list.length > 0) {
          setSelectedSymbol((prev) => {
            if (list.some((item) => item.underlying_symbol === prev)) {
              return prev;
            }
            const preferred =
              list.find((item) => item.underlying_symbol === 'cryBTCUSD') ??
              list.find((item) => item.underlying_symbol === '1HZ100V') ??
              list[0];
            return preferred.underlying_symbol;
          });
        }
      })
      .catch((err) => {
        if (!active) return;
        setMarketError(
          err instanceof Error
            ? err.message
            : 'Unable to load Deriv markets directory.',
        );
      })
      .finally(() => {
        if (active) setSymbolsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [socket, isSocketReady, connectionGeneration]);

  // 2. Load contract rules (`contracts_for`) for selected symbol & reconcile controls
  useEffect(() => {
    if (!isSocketReady || !selectedSymbol) return;

    const myRuleReq = ++rulesGenerationRef.current;
    setRulesLoading(true);

    void fetchSymbolRiseFallRules(socket, selectedSymbol)
      .then((loadedRules) => {
        if (rulesGenerationRef.current !== myRuleReq) return;
        setRules(loadedRules);

        // Reconcile contractFamily based on what the selected symbol supports
        setContractFamily((prevFamily) => {
          if (prevFamily === 'multipliers' && loadedRules.supportsMultipliers) {
            return 'multipliers';
          }
          if (prevFamily === 'rise_fall' && loadedRules.supportsPlainRiseFall) {
            return 'rise_fall';
          }
          if (loadedRules.supportsMultipliers) return 'multipliers';
          if (loadedRules.supportsPlainRiseFall) return 'rise_fall';
          return prevFamily;
        });

        // Reconcile Multiplier value
        setMultiplier((prevMult) =>
          loadedRules.multiplierRange.includes(prevMult)
            ? prevMult
            : loadedRules.defaultMultiplier,
        );

        const reconciled = reconcileRiseFallControls(
          { allowEquals, duration, durationUnit, amount },
          selectedSymbol,
          loadedRules,
        );
        setAllowEquals(reconciled.allowEquals);
        setDurationUnit(reconciled.durationUnit);
        setDuration(reconciled.duration);
        setAmount(reconciled.amount);
      })
      .catch((err) => {
        if (rulesGenerationRef.current !== myRuleReq) return;
        setMarketError(
          err instanceof Error
            ? err.message
            : `Unable to load contract rules for ${selectedSymbol}.`,
        );
      })
      .finally(() => {
        if (rulesGenerationRef.current === myRuleReq) {
          setRulesLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, isSocketReady, connectionGeneration, selectedSymbol]);

  const handleToggleAllowEquals = useCallback(
    (nextAllow: boolean) => {
      setAllowEquals(nextAllow);
      if (!rules) return;
      const units = getAllowedUnitsForSelection(rules, nextAllow);
      const match = units.find((u) => u.unit === durationUnit) ?? units[0];
      if (match) {
        setDurationUnit(match.unit);
        if (duration < match.min || duration > match.max) {
          setDuration(match.defaultValue);
        }
      }
    },
    [rules, durationUnit, duration],
  );

  const handleApplyQuantTicketSetup = useCallback(
    (setup: {
      contractFamily: ContractFamily;
      multiplier: number;
      amount: number;
      takeProfit: number | null;
      stopLoss: null;
    }) => {
      if (rules?.supportsMultipliers) {
        setContractFamily('multipliers');
        if (rules.multiplierRange.includes(setup.multiplier)) {
          setMultiplier(setup.multiplier);
        } else {
          setMultiplier(rules.defaultMultiplier);
        }
      }
      setBasis('stake');
      setAmount(setup.amount);
      setTakeProfit(setup.takeProfit);
      setStopLoss(setup.stopLoss);
    },
    [rules],
  );

  const selectedSymbolInfo = useMemo(
    () => symbols.find((s) => s.underlying_symbol === selectedSymbol) ?? null,
    [symbols, selectedSymbol],
  );

  const lifecycle = useTradeLifecycle({
    socket,
    connectionStatus,
    connectionGeneration,
    authenticated,
    accountId: selectedAccount?.account_id ?? null,
    currency: quoteCurrency,
    contractFamily,
    underlyingSymbol: selectedSymbol,
    rules,
    allowEquals,
    basis,
    amount,
    duration,
    durationUnit,
    multiplier,
    takeProfit,
    stopLoss,
  });

  return (
    <div className="app-shell">
      <HeaderBar onOpenLicenses={() => setLicensesOpen(true)} />

      {(authNotice || connectionError || marketError) && (
        <div className="global-banners">
          {authNotice && (
            <div className="alert-banner alert-warn" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{authNotice}</span>
              <button
                type="button"
                className="btn-icon"
                aria-label="Dismiss authentication notice"
                onClick={dismissAuthNotice}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {connectionError && (
            <div className="alert-banner alert-error" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{connectionError}</span>
            </div>
          )}

          {marketError && (
            <div className="alert-banner alert-error" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{marketError}</span>
              <button
                type="button"
                className="btn-icon"
                aria-label="Dismiss market error"
                onClick={() => setMarketError(null)}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      <main className="desk-grid">
        <SymbolSelector
          symbols={symbols}
          selectedSymbol={selectedSymbol}
          loading={symbolsLoading}
          onSelectSymbol={(sym) => {
            setHoverPreview(null);
            setSelectedSymbol(sym);
          }}
        />

        <div className="center-column">
          <PriceChart
            socket={socket}
            connectionStatus={connectionStatus}
            connectionGeneration={connectionGeneration}
            symbolInfo={selectedSymbolInfo}
            symbol={selectedSymbol}
            granularity={granularity}
            onChangeGranularity={setGranularity}
            positions={lifecycle.positions}
            hoverPreview={hoverPreview}
          />

          <QuantStrategyLab
            socket={socket}
            connectionStatus={connectionStatus}
            connectionGeneration={connectionGeneration}
            authenticated={authenticated}
            accountType={selectedAccount?.account_type ?? null}
            accountBalance={selectedAccount?.balance ?? 0}
            currency={quoteCurrency}
            symbol={selectedSymbol}
            symbolInfo={selectedSymbolInfo}
            positions={lifecycle.positions}
            stakeLimits={lifecycle.stakeLimits}
            onSelectSymbol={(sym) => {
              setHoverPreview(null);
              setSelectedSymbol(sym);
            }}
            onApplyQuantTicketSetup={handleApplyQuantTicketSetup}
            onExecuteDirectBuy={lifecycle.executeDirectBuy}
            onSellAtMarket={lifecycle.sellAtMarket}
            onStartLogin={startLogin}
          />

          <PositionsPanel
            authenticated={authenticated}
            positions={lifecycle.positions}
            sellingContractIds={lifecycle.sellingContractIds}
            onSellAtMarket={lifecycle.sellAtMarket}
            onSelectSymbol={(sym) => {
              setHoverPreview(null);
              setSelectedSymbol(sym);
            }}
          />
        </div>

        <OrderTicket
          phase={lifecycle.phase}
          authenticated={authenticated}
          oauthConfigured={oauthConfigured}
          patConfigured={patConfigured}
          patReady={patReady}
          currency={quoteCurrency}
          accountBalance={selectedAccount?.balance ?? 0}
          contractFamily={contractFamily}
          onChangeContractFamily={(fam) => {
            setHoverPreview(null);
            setContractFamily(fam);
          }}
          rules={rules}
          rulesLoading={rulesLoading}
          basis={basis}
          onChangeBasis={setBasis}
          amount={amount}
          onChangeAmount={setAmount}
          multiplier={multiplier}
          onChangeMultiplier={setMultiplier}
          takeProfit={takeProfit}
          onChangeTakeProfit={setTakeProfit}
          stopLoss={stopLoss}
          onChangeStopLoss={setStopLoss}
          durationUnit={durationUnit}
          onChangeDurationUnit={setDurationUnit}
          duration={duration}
          onChangeDuration={setDuration}
          allowEquals={allowEquals}
          onChangeAllowEquals={handleToggleAllowEquals}
          stakeLimits={lifecycle.stakeLimits}
          validationError={lifecycle.validationError}
          riseQuote={lifecycle.riseQuote}
          fallQuote={lifecycle.fallQuote}
          confirmation={lifecycle.confirmation}
          buyingInFlight={lifecycle.buyingInFlight}
          tradeError={lifecycle.tradeError}
          onClearTradeError={lifecycle.clearTradeError}
          onRequestConfirmation={lifecycle.requestConfirmation}
          onCancelConfirmation={lifecycle.cancelConfirmation}
          onConfirmAndBuy={lifecycle.confirmAndBuy}
          onStartLogin={startLogin}
          onHoverPreviewChange={setHoverPreview}
        />
      </main>

      <LicensesModal open={licensesOpen} onClose={() => setLicensesOpen(false)} />
    </div>
  );
};
