import React from 'react';
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Lock,
  ShieldCheck,
  Zap,
  X,
} from 'lucide-react';
import type {
  AmountBasis,
  ContractFamily,
  DurationUnit,
  HoverPreviewLevels,
  LifecyclePhase,
  TradeDirection,
} from '../types/deriv';
import type { RiseFallSymbolRules } from '../services/marketData';
import { getAllowedUnitsForSelection } from '../adapters/riseFallAdapter';
import {
  computeMultiplierHoverPreview,
  extractMultiplierQuoteTelemetry,
} from '../adapters/multipliersAdapter';
import type {
  DirectionQuote,
  PendingConfirmation,
} from '../hooks/useTradeLifecycle';

interface OrderTicketProps {
  phase: LifecyclePhase;
  authenticated: boolean;
  oauthConfigured: boolean;
  patConfigured: boolean;
  patReady: boolean;
  currency: string;
  accountBalance?: number;
  contractFamily: ContractFamily;
  onChangeContractFamily: (family: ContractFamily) => void;
  rules: RiseFallSymbolRules | null;
  rulesLoading: boolean;
  basis: AmountBasis;
  onChangeBasis: (basis: AmountBasis) => void;
  amount: number;
  onChangeAmount: (amount: number) => void;
  multiplier: number;
  onChangeMultiplier: (multiplier: number) => void;
  takeProfit: number | null;
  onChangeTakeProfit: (tp: number | null) => void;
  stopLoss: number | null;
  onChangeStopLoss: (sl: number | null) => void;
  durationUnit: DurationUnit;
  onChangeDurationUnit: (unit: DurationUnit) => void;
  duration: number;
  onChangeDuration: (duration: number) => void;
  allowEquals: boolean;
  onChangeAllowEquals: (allow: boolean) => void;
  stakeLimits: { min?: number; max?: number };
  validationError: string | null;
  riseQuote: DirectionQuote | null;
  fallQuote: DirectionQuote | null;
  confirmation: PendingConfirmation | null;
  buyingInFlight: boolean;
  tradeError: string | null;
  onClearTradeError: () => void;
  onRequestConfirmation: (direction: TradeDirection) => void;
  onCancelConfirmation: () => void;
  onConfirmAndBuy: () => Promise<void>;
  onStartLogin: () => void;
  onHoverPreviewChange?: (preview: HoverPreviewLevels | null) => void;
}

const PHASE_LABELS: Record<LifecyclePhase, string> = {
  idle: 'Ready',
  pricing: 'Pricing…',
  quoted: 'Live Quote',
  confirming: 'Confirm Order',
  buying: 'Submitting…',
  open: 'Position Open',
  sellable: 'Resale Active',
  settling: 'Settling…',
  closed: 'Settled',
  reconnecting: 'Reconnecting…',
  failed: 'Attention',
};

export const OrderTicket: React.FC<OrderTicketProps> = ({
  phase,
  authenticated,
  oauthConfigured,
  patConfigured,
  patReady,
  currency,
  accountBalance = 0,
  contractFamily,
  onChangeContractFamily,
  rules,
  rulesLoading,
  basis,
  onChangeBasis,
  amount,
  onChangeAmount,
  multiplier,
  onChangeMultiplier,
  takeProfit,
  onChangeTakeProfit,
  stopLoss,
  onChangeStopLoss,
  durationUnit,
  onChangeDurationUnit,
  duration,
  onChangeDuration,
  allowEquals,
  onChangeAllowEquals,
  stakeLimits,
  validationError,
  riseQuote,
  fallQuote,
  confirmation,
  buyingInFlight,
  tradeError,
  onClearTradeError,
  onRequestConfirmation,
  onCancelConfirmation,
  onConfirmAndBuy,
  onStartLogin,
  onHoverPreviewChange,
}) => {
  const isMultipliers = contractFamily === 'multipliers';
  const allowedUnits = getAllowedUnitsForSelection(rules, allowEquals);
  const currentUnitRule =
    allowedUnits.find((u) => u.unit === durationUnit) ?? allowedUnits[0];

  const handleUnitSelect = (unit: DurationUnit) => {
    const nextRule = allowedUnits.find((u) => u.unit === unit);
    onChangeDurationUnit(unit);
    if (nextRule && (duration < nextRule.min || duration > nextRule.max)) {
      onChangeDuration(nextRule.defaultValue);
    }
  };

  const adjustAmount = (delta: number) => {
    const next = Math.max(0.35, Number((amount + delta).toFixed(2)));
    onChangeAmount(next);
  };

  const applyQuarterKellyStake = () => {
    if (accountBalance <= 0) return;
    const raw = accountBalance * 0.03;
    const min = stakeLimits.min ?? 1;
    const max = stakeLimits.max ?? accountBalance * 0.05;
    const clamped = Number(Math.min(max, Math.max(min, raw)).toFixed(2));
    onChangeAmount(clamped);
  };

  const sampleProposal = riseQuote?.proposal ?? fallQuote?.proposal ?? null;
  const multTelemetry = isMultipliers
    ? extractMultiplierQuoteTelemetry(sampleProposal, amount, multiplier)
    : null;
  const activeMarkupDollar = sampleProposal?.contract_details?.app_markup_amount
    ? Number(sampleProposal.contract_details.app_markup_amount)
    : 0;

  const activateHoverPreview = (
    direction: TradeDirection,
    quoteState: DirectionQuote | null,
  ) => {
    if (!isMultipliers || !onHoverPreviewChange) return;
    const preview = computeMultiplierHoverPreview({
      direction,
      proposal: quoteState?.proposal ?? sampleProposal,
      amount,
      multiplier,
      takeProfit,
      stopLoss,
      currency,
    });
    onHoverPreviewChange(preview);
  };

  const clearHoverPreview = () => {
    onHoverPreviewChange?.(null);
  };

  const renderDirectionCard = (
    direction: TradeDirection,
    quoteState: DirectionQuote | null,
  ) => {
    const isRise = direction === 'rise';
    const proposal = quoteState?.proposal ?? null;
    const ask = proposal ? Number(proposal.ask_price) : null;
    const payout = proposal ? Number(proposal.payout) : null;
    const netProfit = ask !== null && payout !== null ? payout - ask : null;
    const returnPct =
      !isMultipliers && ask !== null && ask > 0 && netProfit !== null
        ? (netProfit / ask) * 100
        : null;

    const cardTelemetry = isMultipliers
      ? extractMultiplierQuoteTelemetry(proposal, amount, multiplier)
      : null;

    const previewLevels = isMultipliers
      ? computeMultiplierHoverPreview({
          direction,
          proposal: proposal ?? sampleProposal,
          amount,
          multiplier,
          takeProfit,
          stopLoss,
          currency,
        })
      : null;

    const canExecute =
      authenticated &&
      Boolean(proposal) &&
      Boolean(quoteState?.authenticatedSocket) &&
      !validationError &&
      !buyingInFlight;

    const lockedLabel = patReady
      ? 'Connect PAT Session to Trade'
      : patConfigured
        ? 'Add DERIV_APP_ID in .env to Trade'
        : oauthConfigured
          ? 'Sign in to Trade'
          : 'Configure Credentials to Trade';

    const dirTitle = isMultipliers
      ? isRise
        ? `Buy / Long (${multiplier}x MULTUP)`
        : `Sell / Short (${multiplier}x MULTDOWN)`
      : isRise
        ? allowEquals
          ? 'Rise or Equal'
          : 'Rise'
        : allowEquals
          ? 'Fall or Equal'
          : 'Fall';

    return (
      <div
        className={`quote-card ${isRise ? 'quote-rise' : 'quote-fall'}`}
        onMouseEnter={() => activateHoverPreview(direction, quoteState)}
        onMouseLeave={clearHoverPreview}
      >
        <div className="quote-card-top">
          <span className="quote-direction-label">
            {isRise ? (
              <ArrowUpRight size={16} aria-hidden="true" />
            ) : (
              <ArrowDownRight size={16} aria-hidden="true" />
            )}
            {dirTitle}
          </span>
          {isMultipliers && cardTelemetry ? (
            <span className="quote-return tabular">
              Notional {cardTelemetry.effectiveNotional.toFixed(0)} {currency}
            </span>
          ) : (
            returnPct !== null && (
              <span className="quote-return tabular">+{returnPct.toFixed(1)}%</span>
            )
          )}
        </div>

        {isMultipliers ? (
          <div className="quote-metrics tabular">
            <div>
              <span className="metric-caption">Loss Point (Stop-Out / SL)</span>
              <strong className="metric-val text-down">
                {previewLevels
                  ? `${previewLevels.lossPrice.toFixed(2)} (-${previewLevels.lossAmount.toFixed(2)} ${currency})`
                  : '—'}
              </strong>
            </div>
            <div>
              <span className="metric-caption">
                {previewLevels?.isDefaultTakeProfit
                  ? 'Target TP (+1.6R Preview)'
                  : 'Take Profit Point'}
              </span>
              <strong className="metric-val text-up">
                {previewLevels
                  ? `${previewLevels.takeProfitPrice.toFixed(2)} (+${previewLevels.takeProfitAmount.toFixed(2)} ${currency})`
                  : '—'}
              </strong>
            </div>
          </div>
        ) : (
          <div className="quote-metrics tabular">
            <div>
              <span className="metric-caption">Stake</span>
              <strong className="metric-val">
                {ask !== null ? `${ask.toFixed(2)} ${currency}` : '—'}
              </strong>
            </div>
            <div>
              <span className="metric-caption">Payout</span>
              <strong className="metric-val">
                {payout !== null ? `${payout.toFixed(2)} ${currency}` : '—'}
              </strong>
            </div>
          </div>
        )}

        {quoteState?.error && (
          <p className="quote-inline-error" role="alert">
            {quoteState.error}
          </p>
        )}

        {authenticated ? (
          <button
            type="button"
            className={`btn btn-trade ${isRise ? 'btn-rise' : 'btn-fall'}`}
            disabled={!canExecute}
            onMouseEnter={() => activateHoverPreview(direction, quoteState)}
            onFocus={() => activateHoverPreview(direction, quoteState)}
            onMouseLeave={clearHoverPreview}
            onBlur={clearHoverPreview}
            onClick={() => onRequestConfirmation(direction)}
          >
            {isRise ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
            <span>
              {isMultipliers
                ? isRise
                  ? 'Buy MULTUP'
                  : 'Sell MULTDOWN'
                : `Purchase ${isRise ? 'Rise' : 'Fall'}`}
              {ask !== null ? ` (${ask.toFixed(2)} ${currency})` : ''}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-trade btn-locked"
            onMouseEnter={() => activateHoverPreview(direction, quoteState)}
            onFocus={() => activateHoverPreview(direction, quoteState)}
            onMouseLeave={clearHoverPreview}
            onBlur={clearHoverPreview}
            onClick={onStartLogin}
          >
            <Lock size={14} aria-hidden="true" />
            <span>{lockedLabel}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <aside className="panel ticket-panel" aria-label="Order Ticket">
      <div className="panel-header">
        <h2 className="panel-title">
          {isMultipliers ? 'Multipliers Order' : 'Rise / Fall Order'}
        </h2>
        <span className={`phase-pill phase-${phase}`}>{PHASE_LABELS[phase]}</span>
      </div>

      {/* Contract Family Switcher: Multipliers vs Rise/Fall */}
      <div className="ticket-section">
        <div
          className="segmented-control"
          role="group"
          aria-label="Contract family"
        >
          <button
            type="button"
            className={`seg-btn ${isMultipliers ? 'active' : ''}`}
            aria-pressed={isMultipliers}
            disabled={rules !== null && !rules.supportsMultipliers}
            onClick={() => onChangeContractFamily('multipliers')}
          >
            ★ Multipliers
          </button>
          <button
            type="button"
            className={`seg-btn ${!isMultipliers ? 'active' : ''}`}
            aria-pressed={!isMultipliers}
            disabled={rules !== null && !rules.supportsPlainRiseFall}
            onClick={() => onChangeContractFamily('rise_fall')}
          >
            Rise / Fall
          </button>
        </div>
      </div>

      {!authenticated && (
        <div className="indicative-banner" role="note">
          <span>
            Showing live indicative quotes ({currency}).{' '}
            {patReady
              ? 'Click Connect PAT to trade on your Demo or Real account.'
              : patConfigured
                ? 'Set DERIV_APP_ID in .env (from developers.deriv.com) to activate your PAT.'
                : oauthConfigured
                  ? 'Log in to execute trades on your Demo or Real account.'
                  : 'Set DERIV_APP_ID + DERIV_PAT (or DERIV_CLIENT_ID for OAuth) in .env to trade.'}
          </span>
        </div>
      )}

      {/* Live Commission & App Markup Audit Badge */}
      {sampleProposal && (
        <div
          className={`fee-audit-banner ${
            activeMarkupDollar > 0 ? 'fee-audit-warn' : 'fee-audit-ok'
          }`}
        >
          <div className="fee-audit-row tabular">
            <span>
              {isMultipliers && multTelemetry
                ? `Base Fee: ${multTelemetry.commissionDollar.toFixed(2)} ${currency} (${multTelemetry.commissionBpsOfNotional.toFixed(2)} bps)`
                : 'Contract Fee Audit'}
            </span>
            <strong>
              {activeMarkupDollar > 0
                ? `App Markup: +${activeMarkupDollar.toFixed(2)} ${currency} (Set to 0% in developers.deriv.com)`
                : 'App Markup: 0% (Optimal)'}
            </strong>
          </div>
        </div>
      )}

      {tradeError && (
        <div className="alert-banner alert-error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{tradeError}</span>
          <button
            type="button"
            className="btn-icon"
            aria-label="Dismiss trade error"
            onClick={onClearTradeError}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="ticket-section">
        {!isMultipliers && (
          <div className="segmented-control" role="group" aria-label="Amount basis">
            <button
              type="button"
              className={`seg-btn ${basis === 'stake' ? 'active' : ''}`}
              aria-pressed={basis === 'stake'}
              onClick={() => onChangeBasis('stake')}
            >
              Stake
            </button>
            <button
              type="button"
              className={`seg-btn ${basis === 'payout' ? 'active' : ''}`}
              aria-pressed={basis === 'payout'}
              onClick={() => onChangeBasis('payout')}
            >
              Payout
            </button>
          </div>
        )}

        <div className="field-group">
          <div className="field-label-row">
            <label htmlFor="ticket-amount">
              {isMultipliers
                ? `Stake / 1R Capped Risk (${currency})`
                : `${basis === 'stake' ? 'Stake' : 'Target Payout'} (${currency})`}
            </label>
            {(isMultipliers || basis === 'stake') &&
              (stakeLimits.min !== undefined || stakeLimits.max !== undefined) && (
                <span className="field-hint tabular">
                  {stakeLimits.min !== undefined ? `Min ${stakeLimits.min}` : ''}
                  {stakeLimits.min !== undefined && stakeLimits.max !== undefined
                    ? ' · '
                    : ''}
                  {stakeLimits.max !== undefined ? `Max ${stakeLimits.max}` : ''}
                </span>
              )}
          </div>
          <div className="stepper-row">
            <button
              type="button"
              className="stepper-btn"
              aria-label="Decrease amount"
              onClick={() => adjustAmount(-1)}
            >
              &minus;
            </button>
            <input
              id="ticket-amount"
              type="number"
              min={0.35}
              step="0.5"
              className="number-input tabular"
              value={Number.isFinite(amount) ? amount : ''}
              onChange={(e) => onChangeAmount(Number(e.target.value))}
            />
            <button
              type="button"
              className="stepper-btn"
              aria-label="Increase amount"
              onClick={() => adjustAmount(1)}
            >
              +
            </button>
          </div>
          <div className="quick-amounts">
            {[1, 5, 10, 25, 50].map((preset) => (
              <button
                key={preset}
                type="button"
                className={`chip-btn ${amount === preset ? 'active' : ''}`}
                onClick={() => onChangeAmount(preset)}
              >
                {preset}
              </button>
            ))}
            {accountBalance > 0 && (
                <button
                type="button"
                className="chip-btn chip-kelly"
                title="Set Stake to 3.0% (1R) of Account Balance"
                onClick={applyQuarterKellyStake}
              >
                <Zap size={11} aria-hidden="true" /> 1R (3.0%)
              </button>
            )}
          </div>
        </div>
      </div>

      {isMultipliers ? (
        <>
          <div className="ticket-section">
            <div className="field-label-row">
              <label>Multiplier Leverage</label>
              <span className="field-hint tabular">
                Notional: {(amount * multiplier).toFixed(0)} {currency}
              </span>
            </div>
            {rulesLoading ? (
              <div className="empty-state-sm">Loading multiplier tiers…</div>
            ) : (
              <div className="unit-tabs" role="group" aria-label="Multiplier value">
                {(rules?.multiplierRange.length
                  ? rules.multiplierRange
                  : [100, 200, 300, 500]
                ).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`gran-btn ${multiplier === m ? 'active' : ''}`}
                    aria-pressed={multiplier === m}
                    onClick={() => onChangeMultiplier(m)}
                  >
                    {m}x{m === 100 ? ' ★' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ticket-section">
            <div className="field-label-row">
              <label htmlFor="ticket-tp">Take Profit ({currency}, optional)</label>
              <button
                type="button"
                className="link-btn"
                onClick={() =>
                  onChangeTakeProfit(Number((amount * 1.6).toFixed(2)))
                }
              >
                Set +1.6R ({(amount * 1.6).toFixed(2)})
              </button>
            </div>
            <input
              id="ticket-tp"
              type="number"
              min={0}
              step="0.5"
              placeholder="Leave blank for open-ended trend trail"
              className="number-input tabular"
              value={takeProfit !== null && takeProfit > 0 ? takeProfit : ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                onChangeTakeProfit(v === '' ? null : Number(v));
              }}
            />

            <div className="field-label-row" style={{ marginTop: '0.55rem' }}>
              <label htmlFor="ticket-sl">Custom Stop Loss ({currency}, optional)</label>
              <span className="field-hint">Built-in Stop-Out = -100% stake (-1R)</span>
            </div>
            <input
              id="ticket-sl"
              type="number"
              min={0}
              step="0.5"
              placeholder={`Default: Built-in Stop-Out at -${amount.toFixed(2)} ${currency}`}
              className="number-input tabular"
              value={stopLoss !== null && stopLoss > 0 ? stopLoss : ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                onChangeStopLoss(v === '' ? null : Number(v));
              }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="ticket-section">
            <div className="field-label-row">
              <label htmlFor="ticket-duration">Duration</label>
              {currentUnitRule && (
                <span className="field-hint tabular">
                  Range: {currentUnitRule.min}&ndash;{currentUnitRule.max}{' '}
                  {currentUnitRule.label.toLowerCase()}
                </span>
              )}
            </div>

            {rulesLoading ? (
              <div className="empty-state-sm">Loading duration rules…</div>
            ) : (
              <>
                <div className="unit-tabs" role="group" aria-label="Duration unit">
                  {allowedUnits.map((u) => (
                    <button
                      key={u.unit}
                      type="button"
                      className={`gran-btn ${durationUnit === u.unit ? 'active' : ''}`}
                      aria-pressed={durationUnit === u.unit}
                      onClick={() => handleUnitSelect(u.unit)}
                    >
                      {u.label}
                    </button>
                  ))}
                </div>

                <input
                  id="ticket-duration"
                  type="number"
                  min={currentUnitRule?.min ?? 1}
                  max={currentUnitRule?.max ?? 10}
                  step={1}
                  className="number-input tabular"
                  value={Number.isFinite(duration) ? duration : ''}
                  onChange={(e) => onChangeDuration(Math.round(Number(e.target.value)))}
                />

                {durationUnit === 't' &&
                  currentUnitRule &&
                  currentUnitRule.max <= 10 && (
                    <div className="quick-amounts">
                      {[1, 2, 3, 5, 7, 10]
                        .filter(
                          (t) =>
                            t >= currentUnitRule.min && t <= currentUnitRule.max,
                        )
                        .map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={`chip-btn ${duration === t ? 'active' : ''}`}
                            onClick={() => onChangeDuration(t)}
                          >
                            {t}t
                          </button>
                        ))}
                    </div>
                  )}
              </>
            )}
          </div>

          <div className="ticket-section equals-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allowEquals}
                disabled={!rules?.supportsEquals}
                onChange={(e) => onChangeAllowEquals(e.target.checked)}
              />
              <span>
                Allow Equals (win if exit spot equals entry spot)
                {rules && !rules.supportsEquals && (
                  <em className="muted-note"> &mdash; unavailable on this symbol</em>
                )}
              </span>
            </label>
          </div>
        </>
      )}

      {validationError && (
        <div className="alert-banner alert-warn" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{validationError}</span>
        </div>
      )}

      <div className="quote-cards-stack">
        {renderDirectionCard('rise', riseQuote)}
        {renderDirectionCard('fall', fallQuote)}
      </div>

      {/* Explicit Confirmation Step before sending `buy` */}
      {confirmation && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-order-title"
        >
          <div className="modal-card confirm-modal">
            <div className="modal-header">
              <div className="panel-title-row">
                <ShieldCheck size={18} className="accent-icon" aria-hidden="true" />
                <h3 id="confirm-order-title">Confirm Contract Purchase</h3>
              </div>
              <button
                type="button"
                className="btn-icon"
                disabled={buyingInFlight}
                aria-label="Cancel confirmation"
                onClick={onCancelConfirmation}
              >
                <X size={16} />
              </button>
            </div>

            <div className="confirm-body">
              <p className="confirm-longcode">{confirmation.longcode}</p>
              <dl className="confirm-grid tabular">
                <div>
                  <dt>Symbol</dt>
                  <dd>{confirmation.underlyingSymbol}</dd>
                </div>
                <div>
                  <dt>Contract</dt>
                  <dd
                    className={
                      confirmation.direction === 'rise' ? 'text-up' : 'text-down'
                    }
                  >
                    {confirmation.contractType}
                    {confirmation.multiplier ? ` (${confirmation.multiplier}x)` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Max Stake / Risk</dt>
                  <dd>
                    {confirmation.askPrice.toFixed(2)} {confirmation.currency}
                  </dd>
                </div>
                <div>
                  <dt>
                    {confirmation.contractFamily === 'multipliers'
                      ? 'Effective Notional'
                      : 'Potential Payout'}
                  </dt>
                  <dd>
                    {confirmation.contractFamily === 'multipliers'
                      ? `${(confirmation.askPrice * (confirmation.multiplier ?? 100)).toFixed(2)} ${confirmation.currency}`
                      : `${confirmation.payout.toFixed(2)} ${confirmation.currency}`}
                  </dd>
                </div>
                <div>
                  <dt>Indicative Spot</dt>
                  <dd>{confirmation.spot}</dd>
                </div>
                <div>
                  <dt>
                    {confirmation.contractFamily === 'multipliers'
                      ? 'Take Profit / Floor'
                      : 'Duration'}
                  </dt>
                  <dd>
                    {confirmation.contractFamily === 'multipliers'
                      ? `${confirmation.takeProfit ? `TP +${confirmation.takeProfit.toFixed(2)}` : 'Trail EMA30'} · -1R Stop-Out`
                      : `${confirmation.duration} ${confirmation.durationUnit}`}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={buyingInFlight}
                onClick={onCancelConfirmation}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${
                  confirmation.direction === 'rise' ? 'btn-rise' : 'btn-fall'
                }`}
                disabled={buyingInFlight}
                onClick={() => void onConfirmAndBuy()}
              >
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>{buyingInFlight ? 'Executing…' : 'Confirm & Buy'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
