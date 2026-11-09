import type { NormalizedPosition, ProposalOpenContractWire } from '../types/deriv';

function parseFiniteNum(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalizes a New API `proposal_open_contract` wire object at one domain boundary.
 * Uses `exit_spot` and `exit_spot_time` per New API guard (never deprecated `sell_spot`).
 */
export function normalizeOpenContract(
  wire: ProposalOpenContractWire,
): NormalizedPosition | null {
  if (typeof wire.contract_id !== 'number') return null;

  const buyPrice = parseFiniteNum(wire.buy_price) ?? 0;
  const bidPrice = parseFiniteNum(wire.bid_price) ?? 0;
  const payout = parseFiniteNum(wire.payout) ?? 0;
  const profit = parseFiniteNum(wire.profit) ?? bidPrice - buyPrice;
  const profitPercentage =
    typeof wire.profit_percentage === 'number' && Number.isFinite(wire.profit_percentage)
      ? wire.profit_percentage
      : buyPrice > 0
        ? ((profit / buyPrice) * 100)
        : 0;

  const isSold = wire.is_sold === 1;
  const isExpired = wire.is_expired === 1;
  const isValidToSell = wire.is_valid_to_sell === 1 && !isSold;

  let status: NormalizedPosition['status'] = 'open';
  if (
    wire.status === 'sold' ||
    wire.status === 'won' ||
    wire.status === 'lost' ||
    wire.status === 'cancelled'
  ) {
    status = wire.status;
  } else if (isSold) {
    status = profit >= 0 ? 'won' : 'lost';
  }

  return {
    contractId: wire.contract_id,
    contractType: wire.contract_type ?? 'CALL',
    underlyingSymbol: wire.underlying_symbol ?? '',
    currency: wire.currency ?? 'USD',
    longcode: wire.longcode ?? '',
    shortcode: wire.shortcode ?? '',
    buyPrice,
    bidPrice,
    payout,
    profit,
    profitPercentage,
    multiplier: parseFiniteNum(wire.multiplier),
    stopOutPrice: parseFiniteNum(wire.limit_order?.stop_out?.value),
    takeProfitPrice: parseFiniteNum(wire.limit_order?.take_profit?.value),
    stopLossPrice: parseFiniteNum(wire.limit_order?.stop_loss?.value),
    purchaseTime: wire.purchase_time ?? wire.date_start ?? 0,
    dateStart: wire.date_start ?? 0,
    dateExpiry: typeof wire.date_expiry === 'number' ? wire.date_expiry : wire.expiry_time ?? null,
    entrySpot: parseFiniteNum(wire.entry_spot),
    entrySpotTime: typeof wire.entry_spot_time === 'number' ? wire.entry_spot_time : null,
    currentSpot: parseFiniteNum(wire.current_spot),
    currentSpotTime: typeof wire.current_spot_time === 'number' ? wire.current_spot_time : null,
    exitSpot: parseFiniteNum(wire.exit_spot),
    exitSpotTime: typeof wire.exit_spot_time === 'number' ? wire.exit_spot_time : null,
    sellPrice: parseFiniteNum(wire.sell_price),
    sellTime: typeof wire.sell_time === 'number' ? wire.sell_time : null,
    tickCount: typeof wire.tick_count === 'number' ? wire.tick_count : null,
    ticksObserved: Array.isArray(wire.tick_stream) ? wire.tick_stream.length : 0,
    isSold,
    isExpired,
    isValidToSell,
    status,
    buyTransactionId:
      typeof wire.transaction_ids?.buy === 'number' ? wire.transaction_ids.buy : null,
    sellTransactionId:
      typeof wire.transaction_ids?.sell === 'number' ? wire.transaction_ids.sell : null,
  };
}

export interface PortfolioContractWire {
  buy_price?: number;
  contract_id?: number;
  contract_type?: string;
  currency?: string;
  date_start?: number;
  expiry_time?: number;
  longcode?: string;
  payout?: number;
  purchase_time?: number;
  shortcode?: string;
  transaction_id?: number;
  underlying_symbol?: string;
}

export function normalizePortfolioContract(
  wire: PortfolioContractWire,
): NormalizedPosition | null {
  if (typeof wire.contract_id !== 'number') return null;
  const buyPrice = typeof wire.buy_price === 'number' ? wire.buy_price : 0;
  return {
    contractId: wire.contract_id,
    contractType: wire.contract_type ?? 'CALL',
    underlyingSymbol: wire.underlying_symbol ?? '',
    currency: wire.currency ?? 'USD',
    longcode: wire.longcode ?? '',
    shortcode: wire.shortcode ?? '',
    buyPrice,
    bidPrice: buyPrice,
    payout: typeof wire.payout === 'number' ? wire.payout : 0,
    profit: 0,
    profitPercentage: 0,
    multiplier: null,
    stopOutPrice: null,
    takeProfitPrice: null,
    stopLossPrice: null,
    purchaseTime: wire.purchase_time ?? wire.date_start ?? 0,
    dateStart: wire.date_start ?? 0,
    dateExpiry: typeof wire.expiry_time === 'number' ? wire.expiry_time : null,
    entrySpot: null,
    entrySpotTime: null,
    currentSpot: null,
    currentSpotTime: null,
    exitSpot: null,
    exitSpotTime: null,
    sellPrice: null,
    sellTime: null,
    tickCount: null,
    ticksObserved: 0,
    isSold: false,
    isExpired: false,
    isValidToSell: false,
    status: 'open',
    buyTransactionId: typeof wire.transaction_id === 'number' ? wire.transaction_id : null,
    sellTransactionId: null,
  };
}

export interface ProfitTableTransactionWire {
  contract_id?: number;
  transaction_id?: number;
  buy_price?: number;
  sell_price?: number;
  purchase_time?: number;
  sell_time?: number;
  shortcode?: string;
  longcode?: string;
  pnl?: number;
  underlying_symbol?: string;
}

export function normalizeProfitTableTransaction(
  wire: ProfitTableTransactionWire,
): NormalizedPosition | null {
  if (typeof wire.contract_id !== 'number') return null;
  const buyPrice = typeof wire.buy_price === 'number' ? wire.buy_price : 0;
  const sellPrice = typeof wire.sell_price === 'number' ? wire.sell_price : 0;
  const profit = typeof wire.pnl === 'number' ? wire.pnl : sellPrice - buyPrice;
  const profitPercentage = buyPrice > 0 ? (profit / buyPrice) * 100 : 0;

  let sym = wire.underlying_symbol ?? '';
  let contractType = 'CALL';
  if (wire.shortcode) {
    const parts = wire.shortcode.split('_');
    if (parts.length >= 2) {
      contractType = parts[0];
      if (!sym) sym = parts[1];
    }
  }

  return {
    contractId: wire.contract_id,
    contractType,
    underlyingSymbol: sym,
    currency: 'USD',
    longcode: wire.longcode ?? '',
    shortcode: wire.shortcode ?? '',
    buyPrice,
    bidPrice: sellPrice,
    payout: sellPrice,
    profit,
    profitPercentage,
    multiplier: null,
    stopOutPrice: null,
    takeProfitPrice: null,
    stopLossPrice: null,
    purchaseTime: wire.purchase_time ?? 0,
    dateStart: wire.purchase_time ?? 0,
    dateExpiry: wire.sell_time ?? null,
    entrySpot: null,
    entrySpotTime: null,
    currentSpot: null,
    currentSpotTime: null,
    exitSpot: null,
    exitSpotTime: null,
    sellPrice,
    sellTime: wire.sell_time ?? null,
    tickCount: null,
    ticksObserved: 0,
    isSold: true,
    isExpired: true,
    isValidToSell: false,
    status: profit >= 0 ? 'won' : 'lost',
    buyTransactionId: null,
    sellTransactionId: typeof wire.transaction_id === 'number' ? wire.transaction_id : null,
  };
}
