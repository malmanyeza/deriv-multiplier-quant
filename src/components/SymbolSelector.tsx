import React, { useMemo, useState } from 'react';
import { Globe, Search, Sparkles } from 'lucide-react';
import type { ActiveSymbolItem } from '../types/deriv';
import {
  formatMarketLabel,
  formatSubmarketLabel,
  isQuantCoreSymbol,
} from '../services/marketData';

interface SymbolSelectorProps {
  symbols: ActiveSymbolItem[];
  selectedSymbol: string;
  loading: boolean;
  onSelectSymbol: (symbol: string) => void;
}

type WatchlistScope = 'basket' | 'all';
type MarketFilterTab =
  | 'all'
  | 'cryptocurrency'
  | 'macro'
  | 'synthetic_index'
  | 'forex';

interface BotMarketMeta {
  code: string;
  fallbackName: string;
  engine: '1H Macro' | '15M Turbo';
  multLabel: string;
}

const ACTIVE_BOT_MARKETS: BotMarketMeta[] = [
  { code: 'cryBTCUSD', fallbackName: 'BTC/USD', engine: '1H Macro', multLabel: '100x' },
  { code: 'cryETHUSD', fallbackName: 'ETH/USD', engine: '1H Macro', multLabel: '100x' },
  { code: 'frxXAUUSD', fallbackName: 'Gold/USD', engine: '1H Macro', multLabel: '100x' },
  { code: 'OTC_NDX', fallbackName: 'US Tech 100', engine: '1H Macro', multLabel: '100x' },
  { code: '1HZ100V', fallbackName: 'Volatility 100 (1s)', engine: '15M Turbo', multLabel: '40x' },
  { code: 'R_75', fallbackName: 'Volatility 75', engine: '15M Turbo', multLabel: '50x' },
];

export const SymbolSelector: React.FC<SymbolSelectorProps> = ({
  symbols,
  selectedSymbol,
  loading,
  onSelectSymbol,
}) => {
  const [scope, setScope] = useState<WatchlistScope>('basket');
  const [query, setQuery] = useState('');
  const [marketFilter, setMarketFilter] = useState<MarketFilterTab>('all');

  const symbolByCode = useMemo(() => {
    const map = new Map<string, ActiveSymbolItem>();
    for (const s of symbols) {
      map.set(s.underlying_symbol, s);
    }
    return map;
  }, [symbols]);

  const botGroups = useMemo(() => {
    const macro = ACTIVE_BOT_MARKETS.filter((m) => m.engine === '1H Macro');
    const turbo = ACTIVE_BOT_MARKETS.filter((m) => m.engine === '15M Turbo');
    return [
      { label: '1H Macro (100x)', items: macro },
      { label: '15M Turbo (40x–50x)', items: turbo },
    ];
  }, []);

  const filteredAllGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matching = symbols.filter((item) => {
      if (marketFilter === 'cryptocurrency' && item.market !== 'cryptocurrency') {
        return false;
      }
      if (
        marketFilter === 'macro' &&
        item.market !== 'commodities' &&
        item.market !== 'indices'
      ) {
        return false;
      }
      if (marketFilter === 'synthetic_index' && item.market !== 'synthetic_index') {
        return false;
      }
      if (marketFilter === 'forex' && item.market !== 'forex') {
        return false;
      }

      if (!normalizedQuery) return true;
      return (
        item.underlying_symbol_name.toLowerCase().includes(normalizedQuery) ||
        item.underlying_symbol.toLowerCase().includes(normalizedQuery) ||
        formatSubmarketLabel(item.submarket).toLowerCase().includes(normalizedQuery) ||
        formatMarketLabel(item.market).toLowerCase().includes(normalizedQuery)
      );
    });

    const map = new Map<string, ActiveSymbolItem[]>();
    for (const item of matching) {
      const groupKey = isQuantCoreSymbol(item.underlying_symbol)
        ? '__bot_core__'
        : item.submarket;
      const list = map.get(groupKey) ?? [];
      list.push(item);
      map.set(groupKey, list);
    }

    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === '__bot_core__') return -1;
      if (b[0] === '__bot_core__') return 1;
      return formatSubmarketLabel(a[0]).localeCompare(formatSubmarketLabel(b[0]));
    });
  }, [symbols, query, marketFilter]);

  return (
    <aside className="panel symbol-panel" aria-label="Markets Watchlist">
      <div className="panel-header">
        <div className="panel-title-row">
          <Sparkles size={15} className="accent-icon" aria-hidden="true" />
          <h2 className="panel-title">
            {scope === 'basket' ? 'Bot Markets' : 'All Markets'}
          </h2>
        </div>
        <span className="count-chip">
          {scope === 'basket' ? ACTIVE_BOT_MARKETS.length : symbols.length}
        </span>
      </div>

      <div className="watchlist-scope-wrap">
        <div className="segmented-control" role="tablist" aria-label="Watchlist scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'basket'}
            className={`seg-btn ${scope === 'basket' ? 'active' : ''}`}
            onClick={() => setScope('basket')}
          >
            <Sparkles size={12} aria-hidden="true" />
            <span>Active (6)</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'all'}
            className={`seg-btn ${scope === 'all' ? 'active' : ''}`}
            onClick={() => setScope('all')}
          >
            <Globe size={12} aria-hidden="true" />
            <span>All Markets</span>
          </button>
        </div>
      </div>

      {scope === 'all' && (
        <>
          <div className="symbol-search-box">
            <Search size={14} className="search-icon" aria-hidden="true" />
            <input
              type="search"
              className="search-input"
              placeholder="Search BTC, Gold, Nasdaq, R_75…"
              aria-label="Search Markets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="submarket-pills" role="tablist" aria-label="Filter by market class">
            {[
              { id: 'all', label: 'All' },
              { id: 'cryptocurrency', label: 'Crypto' },
              { id: 'macro', label: 'Gold & Indices' },
              { id: 'forex', label: 'Forex' },
              { id: 'synthetic_index', label: 'Synthetics' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={marketFilter === tab.id}
                className={`chip-btn ${marketFilter === tab.id ? 'active' : ''}`}
                onClick={() => setMarketFilter(tab.id as MarketFilterTab)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="symbol-list" role="listbox" aria-label="Available Markets">
        {scope === 'basket' ? (
          botGroups.map((group) => (
            <div key={group.label} className="symbol-group">
              <div className="symbol-group-label">{group.label}</div>
              {group.items.map((meta) => {
                const live = symbolByCode.get(meta.code);
                const isSelected = meta.code === selectedSymbol;
                const isOpen = live
                  ? live.exchange_is_open === 1 && live.is_trading_suspended === 0
                  : true;
                const is24x7 =
                  meta.code.startsWith('cry') ||
                  meta.code.startsWith('1HZ') ||
                  meta.code.startsWith('R_');

                return (
                  <button
                    key={meta.code}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`symbol-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSelectSymbol(meta.code)}
                  >
                    <div className="symbol-row-main">
                      <span className="symbol-name">
                        {live?.underlying_symbol_name ?? meta.fallbackName}
                      </span>
                      <span className="symbol-code">
                        {meta.code} &middot; {meta.multLabel}
                      </span>
                    </div>
                    <span
                      className={`market-dot ${isOpen ? 'open' : 'closed'}`}
                      title={
                        isOpen
                          ? is24x7
                            ? '24/7 Open'
                            : 'Market Open'
                          : 'Closed for Weekend / Session'
                      }
                    >
                      {isOpen ? (is24x7 ? '24/7' : 'OPEN') : 'CLOSED'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        ) : loading && symbols.length === 0 ? (
          <div className="empty-state">Loading Deriv Markets…</div>
        ) : filteredAllGroups.length === 0 ? (
          <div className="empty-state">No markets match &ldquo;{query}&rdquo;.</div>
        ) : (
          filteredAllGroups.map(([groupKey, items]) => (
            <div key={groupKey} className="symbol-group">
              <div className="symbol-group-label">
                {groupKey === '__bot_core__'
                  ? 'Bot Core Markets'
                  : formatSubmarketLabel(groupKey)}
              </div>
              {items.map((item) => {
                const isSelected = item.underlying_symbol === selectedSymbol;
                const isOpen =
                  item.exchange_is_open === 1 && item.is_trading_suspended === 0;
                const is24x7 =
                  item.market === 'cryptocurrency' || item.market === 'synthetic_index';

                return (
                  <button
                    key={item.underlying_symbol}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`symbol-row ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSelectSymbol(item.underlying_symbol)}
                  >
                    <div className="symbol-row-main">
                      <span className="symbol-name">
                        {item.underlying_symbol_name}
                      </span>
                      <span className="symbol-code">{item.underlying_symbol}</span>
                    </div>
                    <span
                      className={`market-dot ${isOpen ? 'open' : 'closed'}`}
                      title={
                        isOpen
                          ? is24x7
                            ? '24/7 Open'
                            : 'Market Open'
                          : 'Closed for Weekend / Session'
                      }
                    >
                      {isOpen ? (is24x7 ? '24/7' : 'OPEN') : 'CLOSED'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
