import type {
  AmountBasis,
  DurationUnit,
  RiseFallContractType,
  TradeDirection,
} from '../types/deriv';
import type { RiseFallSymbolRules, UnitDurationBounds } from '../services/marketData';

export interface RiseFallControlState {
  underlyingSymbol: string;
  direction: TradeDirection;
  allowEquals: boolean;
  basis: AmountBasis;
  amount: number;
  currency: string;
  duration: number;
  durationUnit: DurationUnit;
}

export interface RiseFallProposalPayload {
  proposal: 1;
  amount: number;
  basis: AmountBasis;
  contract_type: RiseFallContractType;
  currency: string;
  duration: number;
  duration_unit: DurationUnit;
  underlying_symbol: string;
}

export interface ValidationFailure {
  ok: false;
  field: 'symbol' | 'variant' | 'duration' | 'amount' | 'currency';
  message: string;
}

export interface ValidationSuccess {
  ok: true;
  payload: RiseFallProposalPayload;
}

export type ProposalBuildResult = ValidationSuccess | ValidationFailure;

export function resolveRiseFallContractType(
  direction: TradeDirection,
  allowEquals: boolean,
): RiseFallContractType {
  if (direction === 'rise') {
    return allowEquals ? 'CALLE' : 'CALL';
  }
  return allowEquals ? 'PUTE' : 'PUT';
}

export function getAllowedUnitsForSelection(
  rules: RiseFallSymbolRules | null,
  allowEquals: boolean,
): UnitDurationBounds[] {
  if (!rules) return [];
  return allowEquals ? rules.unitsByVariant.equals : rules.unitsByVariant.plain;
}

/**
 * Reconciles controls when switching symbols or toggling `allowEquals`
 * so unsupported equality or out-of-range duration units reset cleanly.
 */
export function reconcileRiseFallControls(
  prev: Pick<RiseFallControlState, 'allowEquals' | 'duration' | 'durationUnit' | 'amount'>,
  nextSymbol: string,
  rules: RiseFallSymbolRules,
): Pick<
  RiseFallControlState,
  'underlyingSymbol' | 'allowEquals' | 'duration' | 'durationUnit' | 'amount'
> {
  const allowEquals = prev.allowEquals && rules.supportsEquals;
  const units = getAllowedUnitsForSelection(rules, allowEquals);
  const matchingUnit = units.find((u) => u.unit === prev.durationUnit) ?? units[0];

  if (!matchingUnit) {
    return {
      underlyingSymbol: nextSymbol,
      allowEquals: false,
      duration: 5,
      durationUnit: 't',
      amount: prev.amount > 0 ? prev.amount : rules.defaultStake,
    };
  }

  const clampedDuration = Math.min(
    matchingUnit.max,
    Math.max(matchingUnit.min, Math.round(prev.duration) || matchingUnit.defaultValue),
  );

  return {
    underlyingSymbol: nextSymbol,
    allowEquals,
    durationUnit: matchingUnit.unit,
    duration: clampedDuration,
    amount: prev.amount > 0 ? prev.amount : rules.defaultStake,
  };
}

/**
 * Pure proposal builder for entry-relative Rise/Fall (`CALL`, `PUT`, `CALLE`, `PUTE`).
 * Never attaches a `barrier` or Legacy `symbol` field.
 */
export function buildRiseFallProposal(
  state: RiseFallControlState,
  rules: RiseFallSymbolRules | null,
  stakeLimits?: { min?: number; max?: number },
): ProposalBuildResult {
  if (!state.underlyingSymbol || !/^\w{2,30}$/.test(state.underlyingSymbol)) {
    return { ok: false, field: 'symbol', message: 'Select a valid Synthetic Index symbol.' };
  }

  if (!state.currency || !/^[a-zA-Z0-9]{2,20}$/.test(state.currency)) {
    return { ok: false, field: 'currency', message: 'Quote currency is not configured.' };
  }

  if (!rules || rules.underlyingSymbol !== state.underlyingSymbol) {
    return { ok: false, field: 'symbol', message: 'Loading contract rules for this symbol…' };
  }

  if (state.allowEquals && !rules.supportsEquals) {
    return {
      ok: false,
      field: 'variant',
      message: 'Rise/Fall Equals is not supported on this symbol.',
    };
  }

  if (!state.allowEquals && !rules.supportsPlainRiseFall) {
    return {
      ok: false,
      field: 'variant',
      message: 'Rise/Fall contracts are currently unavailable on this symbol.',
    };
  }

  const units = getAllowedUnitsForSelection(rules, state.allowEquals);
  const unitRule = units.find((u) => u.unit === state.durationUnit);
  if (!unitRule) {
    return {
      ok: false,
      field: 'duration',
      message: `Duration unit "${state.durationUnit}" is not available for this contract.`,
    };
  }

  if (
    !Number.isInteger(state.duration) ||
    state.duration < unitRule.min ||
    state.duration > unitRule.max
  ) {
    return {
      ok: false,
      field: 'duration',
      message: `Duration must be a whole number between ${unitRule.min} and ${unitRule.max} ${unitRule.label.toLowerCase()}.`,
    };
  }

  if (!Number.isFinite(state.amount) || state.amount <= 0) {
    return {
      ok: false,
      field: 'amount',
      message: `Enter a positive ${state.basis} amount.`,
    };
  }

  if (state.basis === 'stake') {
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
  } else if (rules.payoutLimit !== null && state.amount > rules.payoutLimit) {
    return {
      ok: false,
      field: 'amount',
      message: `Maximum payout is ${rules.payoutLimit.toFixed(2)} ${state.currency}.`,
    };
  }

  const contractType = resolveRiseFallContractType(state.direction, state.allowEquals);

  return {
    ok: true,
    payload: {
      proposal: 1,
      amount: Number(state.amount.toFixed(2)),
      basis: state.basis,
      contract_type: contractType,
      currency: state.currency,
      duration: state.duration,
      duration_unit: state.durationUnit,
      underlying_symbol: state.underlyingSymbol,
    },
  };
}

export function buildSelectionKey(params: {
  accountId: string | null;
  connectionGeneration: number;
  contractFamily?: 'multipliers' | 'rise_fall';
  underlyingSymbol: string;
  allowEquals: boolean;
  basis: AmountBasis;
  amount: number;
  currency: string;
  duration: number;
  durationUnit: DurationUnit;
  multiplier?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}): string {
  if (params.contractFamily === 'multipliers') {
    return [
      params.accountId ?? 'public',
      params.connectionGeneration,
      'multipliers',
      params.underlyingSymbol,
      Number.isFinite(params.amount) ? params.amount.toFixed(2) : 'invalid',
      params.currency,
      params.multiplier ?? 100,
      params.takeProfit && params.takeProfit > 0 ? params.takeProfit.toFixed(2) : 'no-tp',
      params.stopLoss && params.stopLoss > 0 ? params.stopLoss.toFixed(2) : 'no-sl',
    ].join('|');
  }
  return [
    params.accountId ?? 'public',
    params.connectionGeneration,
    'rise-fall',
    params.underlyingSymbol,
    params.allowEquals ? 'eq' : 'plain',
    params.basis,
    Number.isFinite(params.amount) ? params.amount.toFixed(2) : 'invalid',
    params.currency,
    params.duration,
    params.durationUnit,
  ].join('|');
}
