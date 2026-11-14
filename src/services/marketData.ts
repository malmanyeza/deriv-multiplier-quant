import type {
  ActiveSymbolItem,
  AvailableContractEntry,
  DurationUnit,
  MultiplierContractType,
  RiseFallContractType,
  SupportedContractType,
} from '../types/deriv';
import type { DerivSocketOwner } from './derivSocket';

export const RISE_FALL_CONTRACT_TYPES: RiseFallContractType[] = [
  'CALL',
  'PUT',
  'CALLE',
  'PUTE',
];

export const MULTIPLIER_CONTRACT_TYPES: MultiplierContractType[] = [
  'MULTUP',
  'MULTDOWN',
];

export const ALL_SUPPORTED_CONTRACT_TYPES: SupportedContractType[] = [
  ...RISE_FALL_CONTRACT_TYPES,
  ...MULTIPLIER_CONTRACT_TYPES,
];

export const QUANT_CORE_SYMBOLS = [
  'cryBTCUSD',
  'cryETHUSD',
  'frxXAUUSD',
  'frxXAGUSD',
  'frxUSDJPY',
  'frxAUDJPY',
  'frxEURUSD',
  'frxUSDCAD',
  'frxGBPJPY',
  'frxUSDCHF',
  'frxAUDUSD',
  'frxGBPUSD',
  'frxGBPAUD',
  '1HZ100V',
  'R_75',
  'OTC_NDX',
  'OTC_SPC',
] as const;

export function isQuantCoreSymbol(symbol: string): boolean {
  return (QUANT_CORE_SYMBOLS as readonly string[]).includes(symbol);
}

export function isCsprngSyntheticSymbol(symbol: string, market?: string): boolean {
  if (market === 'synthetic_index') return true;
  return /^(1HZ\d+V|R_\d+|RDBULL|RDBEAR|BOOM\d+|CRASH\d+|JD\d+|stpRNG|RB\d+)$/i.test(
    symbol,
  );
}

const SUBMARKET_LABELS: Record<string, string> = {
  non_stable_coin: 'Crypto 24/7 (BTC / ETH)',
  random_index: 'Volatility Indices',
  crash_index: 'Crash / Boom Indices',
  jump_index: 'Jump Indices',
  step_index: 'Step Indices',
  random_daily: 'Daily Reset Indices',
  range_break: 'Range Break Indices',
  metals: 'Precious Metals (Gold / Silver)',
  energy: 'Energy Commodities',
  americas_OTC: 'US Equity Indices',
  europe_OTC: 'European Equity Indices',
  asia_oceania_OTC: 'Asian Equity Indices',
  major_pairs: 'Forex Majors',
  minor_pairs: 'Forex Minors',
  smart_fx: 'Smart FX Indices',
  forex_basket: 'Forex Baskets',
  commodity_basket: 'Commodity Baskets',
};

const MARKET_LABELS: Record<string, string> = {
  cryptocurrency: '24/7 Crypto',
  commodities: 'Gold & Commodities',
  indices: 'Stock Indices',
  forex: 'Forex',
  synthetic_index: 'Synthetics (CSPRNG)',
};

export function formatMarketLabel(market: string): string {
  if (MARKET_LABELS[market]) return MARKET_LABELS[market];
  return market
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function formatSubmarketLabel(submarket: string): string {
  if (SUBMARKET_LABELS[submarket]) return SUBMARKET_LABELS[submarket];
  return submarket
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * In `active_symbols`, `pip_size` is the minimum fluctuation amount (e.g. 0.01 -> 2 decimals).
 * In `ticks_history`/`tick`, `pip_size` is the decimal count (e.g. 2).
 */
export function fluctuationToDecimals(pipFluctuation: number): number {
  if (!Number.isFinite(pipFluctuation) || pipFluctuation <= 0) return 2;
  if (Number.isInteger(pipFluctuation) && pipFluctuation >= 1) return 0;
  const expMatch = pipFluctuation.toExponential().match(/e-(\d+)$/i);
  if (expMatch) return Math.min(8, Number(expMatch[1]));
  const str = String(pipFluctuation);
  const dotIdx = str.indexOf('.');
  return dotIdx === -1 ? 0 : Math.min(8, str.length - dotIdx - 1);
}

export function decimalsToMinMove(decimals: number): number {
  const clamped = Math.max(0, Math.min(8, Math.round(decimals)));
  return Number((10 ** -clamped).toFixed(clamped));
}

export interface UnitDurationBounds {
  unit: DurationUnit;
  label: string;
  min: number;
  max: number;
  defaultValue: number;
}

export interface RiseFallSymbolRules {
  underlyingSymbol: string;
  supportsPlainRiseFall: boolean;
  supportsEquals: boolean;
  supportsMultipliers: boolean;
  multiplierRange: number[];
  cancellationRange: string[];
  defaultMultiplier: number;
  defaultStake: number;
  payoutLimit: number | null;
  unitsByVariant: {
    plain: UnitDurationBounds[];
    equals: UnitDurationBounds[];
  };
}

const TIME_UNIT_SECONDS: Record<Exclude<DurationUnit, 't'>, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Parses duration bounds from `contracts_for`.
 * Accepts suffixed values (`15s`, `1d`, `10t`) AND bare numeric strings (`"5"`),
 * where bare numbers fall back to the `expiry_type`'s natural unit (`tick` -> `t`, `daily` -> `d`, `intraday` -> `s`).
 */
export function parseDurationBound(
  raw: string,
  expiryType: string,
): { kind: 'tick'; ticks: number } | { kind: 'time'; seconds: number } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d+)([smhdt])?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const suffix = (
    match[2]?.toLowerCase() ??
    (expiryType === 'tick' ? 't' : expiryType === 'daily' ? 'd' : 's')
  ) as DurationUnit;

  if (suffix === 't') {
    return { kind: 'tick', ticks: value };
  }
  return {
    kind: 'time',
    seconds: value * TIME_UNIT_SECONDS[suffix],
  };
}

function deriveUnitBoundsForEntries(entries: AvailableContractEntry[]): UnitDurationBounds[] {
  let minTicks = Infinity;
  let maxTicks = -Infinity;
  let minSeconds = Infinity;
  let maxSeconds = -Infinity;

  for (const entry of entries) {
    const minParsed = parseDurationBound(entry.min_contract_duration, entry.expiry_type);
    const maxParsed = parseDurationBound(entry.max_contract_duration, entry.expiry_type);
    if (!minParsed || !maxParsed) continue;

    if (minParsed.kind === 'tick' && maxParsed.kind === 'tick') {
      minTicks = Math.min(minTicks, minParsed.ticks);
      maxTicks = Math.max(maxTicks, maxParsed.ticks);
    } else if (minParsed.kind === 'time' && maxParsed.kind === 'time') {
      minSeconds = Math.min(minSeconds, minParsed.seconds);
      maxSeconds = Math.max(maxSeconds, maxParsed.seconds);
    }
  }

  const units: UnitDurationBounds[] = [];

  if (Number.isFinite(minTicks) && maxTicks >= minTicks) {
    units.push({
      unit: 't',
      label: 'Ticks',
      min: minTicks,
      max: maxTicks,
      defaultValue: Math.min(maxTicks, Math.max(minTicks, 5)),
    });
  }

  if (Number.isFinite(minSeconds) && maxSeconds >= minSeconds) {
    // Seconds (cap practical seconds picker to intraday <= 3600s when available)
    if (minSeconds < 60) {
      const sMin = Math.max(1, Math.ceil(minSeconds));
      const sMax = Math.min(maxSeconds, 3600);
      if (sMax >= sMin) {
        units.push({
          unit: 's',
          label: 'Seconds',
          min: sMin,
          max: sMax,
          defaultValue: Math.min(sMax, Math.max(sMin, 15)),
        });
      }
    }

    // Minutes
    const mMin = Math.max(1, Math.ceil(minSeconds / 60));
    const mMax = Math.floor(Math.min(maxSeconds, 86400) / 60);
    if (mMax >= mMin && minSeconds <= 86400) {
      units.push({
        unit: 'm',
        label: 'Minutes',
        min: mMin,
        max: mMax,
        defaultValue: Math.min(mMax, Math.max(mMin, 5)),
      });
    }

    // Hours
    const hMin = Math.max(1, Math.ceil(minSeconds / 3600));
    const hMax = Math.floor(Math.min(maxSeconds, 86400) / 3600);
    if (hMax >= hMin && maxSeconds >= 3600 && minSeconds <= 86400) {
      units.push({
        unit: 'h',
        label: 'Hours',
        min: hMin,
        max: hMax,
        defaultValue: Math.min(hMax, Math.max(hMin, 1)),
      });
    }

    // Days
    if (maxSeconds >= 86400) {
      const dMin = Math.max(1, Math.ceil(minSeconds / 86400));
      const dMax = Math.floor(maxSeconds / 86400);
      if (dMax >= dMin) {
        units.push({
          unit: 'd',
          label: 'Days',
          min: dMin,
          max: dMax,
          defaultValue: dMin,
        });
      }
    }
  }

  return units;
}

/**
 * Extracts both Multipliers (`MULTUP`/`MULTDOWN`) and Rise/Fall (`CALL`/`PUT`/`CALLE`/`PUTE`)
 * contract rules from New API `contracts_for.available`.
 */
export function extractRiseFallRules(
  underlyingSymbol: string,
  available: AvailableContractEntry[],
): RiseFallSymbolRules {
  const plainEntries = available.filter(
    (entry) =>
      entry.contract_category === 'callput' &&
      (entry.contract_type === 'CALL' || entry.contract_type === 'PUT'),
  );

  const equalsEntries = available.filter(
    (entry) =>
      entry.contract_category === 'callputequal' &&
      (entry.contract_type === 'CALLE' || entry.contract_type === 'PUTE'),
  );

  const multEntries = available.filter(
    (entry) =>
      entry.contract_type === 'MULTUP' ||
      entry.contract_type === 'MULTDOWN' ||
      entry.contract_category === 'multipliers',
  );

  const multSet = new Set<number>();
  const cancelSet = new Set<string>();
  for (const entry of multEntries) {
    if (Array.isArray(entry.multiplier_range)) {
      for (const m of entry.multiplier_range) {
        if (typeof m === 'number' && Number.isFinite(m) && m > 0) {
          multSet.add(m);
        }
      }
    }
    if (Array.isArray(entry.cancellation_range)) {
      for (const c of entry.cancellation_range) {
        if (typeof c === 'string' && c.trim()) {
          cancelSet.add(c.trim());
        }
      }
    }
  }
  const multiplierRange = Array.from(multSet).sort((a, b) => a - b);
  const cancellationRange = Array.from(cancelSet);
  const supportsMultipliers =
    multEntries.some((e) => e.contract_type === 'MULTUP') &&
    multEntries.some((e) => e.contract_type === 'MULTDOWN') &&
    multiplierRange.length > 0;
  const defaultMultiplier = multiplierRange.includes(100)
    ? 100
    : multiplierRange[0] ?? 100;

  const plainUnits = deriveUnitBoundsForEntries(plainEntries);
  const equalsUnits = deriveUnitBoundsForEntries(equalsEntries);

  const allRelevant = [...multEntries, ...plainEntries, ...equalsEntries];
  const defaultStake =
    allRelevant.find((e) => typeof e.default_stake === 'number' && e.default_stake > 0)
      ?.default_stake ?? 10;

  const payoutLimits = allRelevant
    .map((e) => e.payout_limit)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  return {
    underlyingSymbol,
    supportsPlainRiseFall:
      plainEntries.some((e) => e.contract_type === 'CALL') &&
      plainEntries.some((e) => e.contract_type === 'PUT') &&
      plainUnits.length > 0,
    supportsEquals:
      equalsEntries.some((e) => e.contract_type === 'CALLE') &&
      equalsEntries.some((e) => e.contract_type === 'PUTE') &&
      equalsUnits.length > 0,
    supportsMultipliers,
    multiplierRange,
    cancellationRange,
    defaultMultiplier,
    defaultStake,
    payoutLimit: payoutLimits.length > 0 ? Math.max(...payoutLimits) : null,
    unitsByVariant: {
      plain: plainUnits,
      equals: equalsUnits,
    },
  };
}

export async function fetchSyntheticActiveSymbols(
  socket: DerivSocketOwner,
): Promise<ActiveSymbolItem[]> {
  const response = await socket.request<{ active_symbols?: ActiveSymbolItem[] }>({
    active_symbols: 'full',
    contract_type: RISE_FALL_CONTRACT_TYPES,
  });

  const list = Array.isArray(response.active_symbols) ? response.active_symbols : [];
  return list
    .filter((item) => item.market === 'synthetic_index')
    .sort((a, b) => a.underlying_symbol_name.localeCompare(b.underlying_symbol_name));
}

const MARKET_PRIORITY: Record<string, number> = {
  cryptocurrency: 1,
  commodities: 2,
  indices: 3,
  forex: 4,
  synthetic_index: 5,
};

/**
 * Fetches all symbols supporting Multipliers (`MULTUP`/`MULTDOWN`) or Rise/Fall (`CALL`/`PUT`)
 * across 24/7 Crypto (`cryBTCUSD`, `cryETHUSD`), Gold (`frxXAUUSD`), US Equity Indices (`OTC_NDX`),
 * Forex, and Synthetic Indices.
 */
export async function fetchAllTradableSymbols(
  socket: DerivSocketOwner,
): Promise<ActiveSymbolItem[]> {
  const response = await socket.request<{ active_symbols?: ActiveSymbolItem[] }>({
    active_symbols: 'full',
    contract_type: ALL_SUPPORTED_CONTRACT_TYPES,
  });

  const list = Array.isArray(response.active_symbols) ? response.active_symbols : [];
  const deduped = new Map<string, ActiveSymbolItem>();
  for (const item of list) {
    if (item && typeof item.underlying_symbol === 'string') {
      deduped.set(item.underlying_symbol, item);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const aCore = isQuantCoreSymbol(a.underlying_symbol) ? 0 : 1;
    const bCore = isQuantCoreSymbol(b.underlying_symbol) ? 0 : 1;
    if (aCore !== bCore) return aCore - bCore;

    const aMkt = MARKET_PRIORITY[a.market] ?? 99;
    const bMkt = MARKET_PRIORITY[b.market] ?? 99;
    if (aMkt !== bMkt) return aMkt - bMkt;

    return a.underlying_symbol_name.localeCompare(b.underlying_symbol_name);
  });
}

export async function fetchSymbolRiseFallRules(
  socket: DerivSocketOwner,
  underlyingSymbol: string,
): Promise<RiseFallSymbolRules> {
  const response = await socket.request<{
    contracts_for?: { available?: AvailableContractEntry[] };
  }>({
    contracts_for: underlyingSymbol,
  });

  const available = Array.isArray(response.contracts_for?.available)
    ? response.contracts_for!.available
    : [];

  return extractRiseFallRules(underlyingSymbol, available);
}
