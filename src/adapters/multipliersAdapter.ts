import type {
  HoverPreviewLevels,
  MultiplierContractType,
  ProposalWire,
  TradeDirection,
} from '../types/deriv';
import type { RiseFallSymbolRules } from '../services/marketData';

export interface MultipliersControlState {
  underlyingSymbol: string;
  direction: TradeDirection;
  amount: number;
  currency: string;
  multiplier: number;
  takeProfit: number | null;
  stopLoss: number | null;
}

export interface MultipliersProposalPayload {
  proposal: 1;
  amount: number;
  basis: 'stake';
  contract_type: MultiplierContractType;
  currency: string;
  multiplier: number;
  underlying_symbol: string;
  limit_order?: {
    take_profit?: number;
    stop_loss?: number;
  };
}

export interface MultiplierValidationFailure {
  ok: false;
  field: 'symbol' | 'multiplier' | 'amount' | 'currency' | 'limit_order';
  message: string;
}

export interface MultiplierValidationSuccess {
  ok: true;
  payload: MultipliersProposalPayload;
}

export type MultiplierProposalBuildResult =
  | MultiplierValidationSuccess
  | MultiplierValidationFailure;

export interface MultiplierQuoteTelemetry {
  commissionDollar: number;
  commissionBpsOfNotional: number;
  appMarkupDollar: number;
  appMarkupPctOfStake: number;
  effectiveNotional: number;
  stopOutPrice: number | null;
  stopOutMovePct: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
}

export function resolveMultiplierContractType(
  direction: TradeDirection,
): MultiplierContractType {
  return direction === 'rise' ? 'MULTUP' : 'MULTDOWN';
}

/**
 * Pure proposal builder for Multipliers (`MULTUP`, `MULTDOWN`).
 * Verified against live `deriv_deriv` MCP `validate_payload` for `proposal`:
 * - Always uses `basis: 'stake'`
 * - Never attaches `duration`, `duration_unit`, or `barrier`
 * - Attaches `limit_order` only when `takeProfit` or `stopLoss` is a positive finite number
 */
export function buildMultipliersProposal(
  state: MultipliersControlState,
  rules: RiseFallSymbolRules | null,
  stakeLimits?: { min?: number; max?: number },
): MultiplierProposalBuildResult {
  if (!state.underlyingSymbol || !/^\w{2,30}$/.test(state.underlyingSymbol)) {
    return { ok: false, field: 'symbol', message: 'Select a valid market symbol.' };
  }

  if (!state.currency || !/^[a-zA-Z0-9]{2,20}$/.test(state.currency)) {
    return { ok: false, field: 'currency', message: 'Quote currency is not configured.' };
  }

  if (!rules || rules.underlyingSymbol !== state.underlyingSymbol) {
    return { ok: false, field: 'symbol', message: 'Loading contract rules for this symbol…' };
  }

  if (!rules.supportsMultipliers || rules.multiplierRange.length === 0) {
    return {
      ok: false,
      field: 'multiplier',
      message: 'Multipliers (MULTUP / MULTDOWN) are not available on this symbol.',
    };
  }

  if (!rules.multiplierRange.includes(state.multiplier)) {
    return {
      ok: false,
      field: 'multiplier',
      message: `Select a supported multiplier (${rules.multiplierRange.map((m) => `${m}x`).join(', ')}).`,
    };
  }

  if (!Number.isFinite(state.amount) || state.amount <= 0) {
    return {
      ok: false,
      field: 'amount',
      message: 'Enter a positive stake amount.',
    };
  }

  if (stakeLimits?.min !== undefined && state.amount < stakeLimits.min) {
    return {
      ok: false,
      field: 'amount',
      message: `Minimum stake is ${stakeLimits.min.toFixed(2)} ${state.currency}.`,
    };
  }

  if (stakeLimits?.max !== undefined && state.amount > stakeLimits.max) {
    return {
      ok: false,
      field: 'amount',
      message: `Maximum stake is ${stakeLimits.max.toFixed(2)} ${state.currency}.`,
    };
  }

  const limitOrder: { take_profit?: number; stop_loss?: number } = {};
  if (state.takeProfit !== null && state.takeProfit > 0) {
    if (!Number.isFinite(state.takeProfit)) {
      return {
        ok: false,
        field: 'limit_order',
        message: 'Take Profit must be a valid positive amount.',
      };
    }
    limitOrder.take_profit = Number(state.takeProfit.toFixed(2));
  }

  if (state.stopLoss !== null && state.stopLoss > 0) {
    if (!Number.isFinite(state.stopLoss)) {
      return {
        ok: false,
        field: 'limit_order',
        message: 'Stop Loss must be a valid positive amount.',
      };
    }
    if (state.stopLoss >= state.amount) {
      return {
        ok: false,
        field: 'limit_order',
        message: `Custom Stop Loss must be less than your ${state.amount.toFixed(2)} ${state.currency} stake (built-in Stop-Out already caps loss at 100% of stake).`,
      };
    }
    limitOrder.stop_loss = Number(state.stopLoss.toFixed(2));
  }

  const payload: MultipliersProposalPayload = {
    proposal: 1,
    amount: Number(state.amount.toFixed(2)),
    basis: 'stake',
    contract_type: resolveMultiplierContractType(state.direction),
    currency: state.currency,
    multiplier: state.multiplier,
    underlying_symbol: state.underlyingSymbol,
  };

  if (limitOrder.take_profit !== undefined || limitOrder.stop_loss !== undefined) {
    payload.limit_order = limitOrder;
  }

  return { ok: true, payload };
}

export function extractMultiplierQuoteTelemetry(
  proposal: ProposalWire | null,
  amount: number,
  multiplier: number,
): MultiplierQuoteTelemetry | null {
  if (!proposal || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(multiplier)) {
    return null;
  }

  const effectiveNotional = amount * multiplier;
  const rawCommission =
    typeof proposal.commission === 'number' && Number.isFinite(proposal.commission)
      ? proposal.commission
      : 0;
  const rawMarkup = proposal.contract_details?.app_markup_amount
    ? Number(proposal.contract_details.app_markup_amount)
    : 0;
  const appMarkupDollar = Number.isFinite(rawMarkup) && rawMarkup > 0 ? rawMarkup : 0;

  // On Deriv Multipliers, `proposal.commission` includes any developer `app_markup_amount`;
  // base platform commission is `max(0, rawCommission - appMarkupDollar)`.
  const baseCommissionDollar = Math.max(0, rawCommission - appMarkupDollar);
  const commissionBpsOfNotional =
    effectiveNotional > 0 ? (baseCommissionDollar / effectiveNotional) * 10_000 : 0;
  const appMarkupPctOfStake = amount > 0 ? (appMarkupDollar / amount) * 100 : 0;

  const parsePrice = (val?: string | null): number | null => {
    if (!val) return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
  };

  const stopOutPrice = parsePrice(proposal.limit_order?.stop_out?.value);
  const spot = Number(proposal.spot);
  const stopOutMovePct =
    stopOutPrice !== null && Number.isFinite(spot) && spot > 0
      ? (Math.abs(stopOutPrice - spot) / spot) * 100
      : ((amount - rawCommission) / Math.max(1, effectiveNotional)) * 100;

  return {
    commissionDollar: baseCommissionDollar,
    commissionBpsOfNotional,
    appMarkupDollar,
    appMarkupPctOfStake,
    effectiveNotional,
    stopOutPrice,
    stopOutMovePct,
    takeProfitPrice: parsePrice(proposal.limit_order?.take_profit?.value),
    stopLossPrice: parsePrice(proposal.limit_order?.stop_loss?.value),
  };
}

/**
 * Computes exact Entry, Loss (Stop-Out or Custom Stop Loss), and Take Profit price levels
 * for chart visualization when the user hovers over the Buy (MULTUP) or Sell (MULTDOWN) button.
 * If the user has not typed a custom Take Profit yet, previews the +1.6R Quant Target level.
 */
export function computeMultiplierHoverPreview(params: {
  direction: TradeDirection;
  proposal: ProposalWire | null;
  fallbackSpot?: number | null;
  amount: number;
  multiplier: number;
  takeProfit: number | null;
  stopLoss: number | null;
  currency: string;
}): HoverPreviewLevels | null {
  const {
    direction,
    proposal,
    fallbackSpot = null,
    amount,
    multiplier,
    takeProfit,
    stopLoss,
    currency,
  } = params;

  const spot =
    proposal && Number.isFinite(Number(proposal.spot)) && Number(proposal.spot) > 0
      ? Number(proposal.spot)
      : fallbackSpot && Number.isFinite(fallbackSpot) && fallbackSpot > 0
        ? fallbackSpot
        : null;

  if (
    spot === null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(multiplier) ||
    multiplier <= 0
  ) {
    return null;
  }

  const dir = direction === 'rise' ? 1 : -1;
  const contractType = resolveMultiplierContractType(direction);
  const notional = amount * multiplier;
  const rawComm =
    proposal && typeof proposal.commission === 'number' && Number.isFinite(proposal.commission)
      ? proposal.commission
      : amount * 0.03;

  const parseWirePrice = (val?: string | null): number | null => {
    if (!val) return null;
    const n = Number(val);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // 1. Loss Point (Custom Stop Loss if set, otherwise Deriv's built-in -100% Stake Stop-Out)
  const hasCustomSl = stopLoss !== null && Number.isFinite(stopLoss) && stopLoss > 0 && stopLoss < amount;
  const lossAmount = hasCustomSl ? Number(stopLoss.toFixed(2)) : Number(amount.toFixed(2));
  const wireSlPrice = hasCustomSl
    ? parseWirePrice(proposal?.limit_order?.stop_loss?.value)
    : parseWirePrice(proposal?.limit_order?.stop_out?.value);

  const computedLossMoveFrac = Math.max(0.0005, (lossAmount - rawComm) / notional);
  const lossPrice =
    wireSlPrice !== null ? wireSlPrice : spot * (1 - dir * computedLossMoveFrac);
  const lossMovePct = (Math.abs(lossPrice - spot) / spot) * 100;
  const lossLabel = hasCustomSl
    ? `Stop Loss (-${lossAmount.toFixed(2)} ${currency} · -${lossMovePct.toFixed(2)}%)`
    : `Stop-Out Floor (-${lossAmount.toFixed(2)} ${currency} / -1R · -${lossMovePct.toFixed(2)}%)`;

  // 2. Take Profit Point (Custom Take Profit if set, otherwise +1.6R Quant Target preview)
  const hasCustomTp = takeProfit !== null && Number.isFinite(takeProfit) && takeProfit > 0;
  const tpAmount = hasCustomTp
    ? Number(takeProfit.toFixed(2))
    : Number((amount * 1.6).toFixed(2));
  const wireTpPrice = hasCustomTp
    ? parseWirePrice(proposal?.limit_order?.take_profit?.value)
    : null;

  const computedTpMoveFrac = Math.max(0.0005, (tpAmount + rawComm) / notional);
  const takeProfitPrice =
    wireTpPrice !== null ? wireTpPrice : spot * (1 + dir * computedTpMoveFrac);
  const takeProfitMovePct = (Math.abs(takeProfitPrice - spot) / spot) * 100;
  const takeProfitLabel = hasCustomTp
    ? `Take Profit (+${tpAmount.toFixed(2)} ${currency} · +${takeProfitMovePct.toFixed(2)}%)`
    : `Suggested +1.6R TP (+${tpAmount.toFixed(2)} ${currency} · +${takeProfitMovePct.toFixed(2)}%)`;

  return {
    direction,
    contractType,
    entryPrice: spot,
    lossPrice,
    lossAmount,
    lossMovePct,
    lossLabel,
    takeProfitPrice,
    takeProfitAmount: tpAmount,
    takeProfitMovePct,
    takeProfitLabel,
    isDefaultTakeProfit: !hasCustomTp,
    currency,
  };
}

