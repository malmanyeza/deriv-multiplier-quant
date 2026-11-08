// New Deriv Options API wire & domain types (verified against live MCP get_schema)

export type RiseFallContractType = 'CALL' | 'PUT' | 'CALLE' | 'PUTE';
export type MultiplierContractType = 'MULTUP' | 'MULTDOWN';
export type SupportedContractType = RiseFallContractType | MultiplierContractType;
export type ContractFamily = 'multipliers' | 'rise_fall';
export type TradeDirection = 'rise' | 'fall';
export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';
export type AmountBasis = 'stake' | 'payout';
export type ChartGranularity =
  | 0
  | 60
  | 120
  | 180
  | 300
  | 900
  | 3600
  | 14400
  | 86400;

export interface DerivAccount {
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: 'active' | 'inactive';
  account_type: 'demo' | 'real';
}

export interface DerivWsError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ActiveSymbolItem {
  exchange_is_open: 0 | 1;
  is_trading_suspended: 0 | 1;
  market: string;
  pip_size: number; // Minimum fluctuation amount, e.g. 0.01 or 0.0001
  subgroup: string;
  submarket: string;
  trade_count: number;
  underlying_symbol: string;
  underlying_symbol_name: string;
  underlying_symbol_type: string;
}

export interface AvailableContractEntry {
  barriers: number;
  barrier?: string | null;
  cancellation_range?: string[];
  contract_category: string;
  contract_type: string;
  default_stake?: number;
  expiry_type: string; // 'tick' | 'intraday' | 'daily' | 'no_expiry'
  market: string;
  max_contract_duration: string;
  min_contract_duration: string;
  multiplier_range?: number[];
  payout_limit?: number;
  sentiment: string;
  submarket: string;
  underlying_symbol: string;
}

export interface ProposalLimitOrderEntryWire {
  display_name?: string;
  display_order_amount?: string | null;
  order_amount?: number | null;
  order_date?: number;
  value?: string | null;
}

export interface ProposalWire {
  id: string;
  ask_price: number;
  payout: number;
  spot: number;
  spot_time: number;
  date_start: number;
  date_expiry?: number;
  longcode: string;
  commission?: number | null;
  cancellation?: {
    ask_price?: number;
    date_expiry?: number;
  };
  contract_details?: {
    app_markup_amount?: string;
    barrier?: string;
    minimum_stake?: string;
    maximum_stake?: string;
    maximum_payout?: number;
  };
  limit_order?: {
    stop_loss?: ProposalLimitOrderEntryWire;
    stop_out?: ProposalLimitOrderEntryWire;
    take_profit?: ProposalLimitOrderEntryWire;
  };
  validation_params?: {
    payout?: { max?: string };
    stake?: { min?: string; max?: string };
    stop_loss?: { min?: string; max?: string };
    take_profit?: { min?: string; max?: string };
  };
}

export interface BuyWire {
  balance_after: number;
  buy_price: number;
  contract_id: number;
  longcode: string;
  payout: number;
  purchase_time: number;
  shortcode: string;
  start_time: number;
  transaction_id: number;
}

export interface ProposalOpenContractWire {
  account_id?: number;
  bid_price?: string;
  buy_price?: string;
  commission?: string | number | null;
  contract_id?: number;
  contract_type?: string;
  currency?: string;
  current_spot?: string;
  current_spot_time?: number;
  date_expiry?: number;
  date_settlement?: number;
  date_start?: number;
  entry_spot?: string | null;
  entry_spot_time?: number | null;
  exit_spot?: string | null;
  exit_spot_time?: number | null;
  expiry_time?: number;
  id?: string;
  is_expired?: 0 | 1;
  is_intraday?: 0 | 1;
  is_path_dependent?: 0 | 1;
  is_settleable?: 0 | 1;
  is_sold?: 0 | 1;
  is_valid_to_cancel?: 0 | 1;
  is_valid_to_sell?: 0 | 1;
  limit_order?: {
    stop_loss?: ProposalLimitOrderEntryWire;
    stop_out?: ProposalLimitOrderEntryWire;
    take_profit?: ProposalLimitOrderEntryWire;
  };
  longcode?: string;
  multiplier?: number | string;
  payout?: string;
  profit?: string;
  profit_percentage?: number;
  purchase_time?: number;
  sell_price?: string | null;
  sell_time?: number | null;
  shortcode?: string;
  status?: 'open' | 'sold' | 'won' | 'lost' | 'cancelled' | null;
  tick_count?: number;
  tick_stream?: Array<{
    epoch?: number;
    tick?: number | null;
    tick_display_value?: string | null;
  }>;
  transaction_ids?: {
    buy?: number;
    sell?: number;
  };
  underlying_symbol?: string;
}

export interface NormalizedPosition {
  contractId: number;
  contractType: string;
  underlyingSymbol: string;
    currency: string;
  longcode: string;
  shortcode: string;
  buyPrice: number;
  bidPrice: number;
  payout: number;
  profit: number;
  profitPercentage: number;
  multiplier: number | null;
  stopOutPrice: number | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  purchaseTime: number;
  dateStart: number;
  dateExpiry: number | null;
  entrySpot: number | null;
  entrySpotTime: number | null;
  currentSpot: number | null;
  currentSpotTime: number | null;
  exitSpot: number | null;
  exitSpotTime: number | null;
  sellPrice: number | null;
  sellTime: number | null;
  tickCount: number | null;
  ticksObserved: number;
  isSold: boolean;
  isExpired: boolean;
  isValidToSell: boolean;
  status: 'open' | 'sold' | 'won' | 'lost' | 'cancelled';
  buyTransactionId: number | null;
  sellTransactionId: number | null;
}

export type LifecyclePhase =
  | 'idle'
  | 'pricing'
  | 'quoted'
  | 'confirming'
  | 'buying'
  | 'open'
  | 'sellable'
  | 'settling'
  | 'closed'
  | 'reconnecting'
  | 'failed';

export type ConnectionStatus =
  | 'connecting'
  | 'ready_public'
  | 'authenticating'
  | 'ready_authenticated'
  | 'reconnecting'
  | 'error';

export interface HoverPreviewLevels {
  direction: TradeDirection;
  contractType: string;
  entryPrice: number;
  lossPrice: number;
  lossAmount: number;
  lossMovePct: number;
  lossLabel: string;
  takeProfitPrice: number;
  takeProfitAmount: number;
  takeProfitMovePct: number;
  takeProfitLabel: string;
  isDefaultTakeProfit: boolean;
  currency: string;
}

