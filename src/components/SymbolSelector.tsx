import React, { useMemo, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import type { ActiveSymbolItem } from '../types/deriv';
import {
  formatMarketLabel,
  formatSubmarketLabel,
  isCsprngSyntheticSymbol,
  isQuantCoreSymbol,
} from '../services/marketData';

interface SymbolSelectorProps {
  symbols: ActiveSymbolItem[];
  selectedSymbol: string;
  loading: boolean;
  onSelectSymbol: (symbol: string) => void;
}

type MarketFilterTab = 'quant_core' | 'all' | 'cryptocurrency' | 'macro' | 'synthetic_index' | 'forex';

export const SymbolSelector: React.FC<SymbolSelectorProps> = ({
  symbols,
  selectedSymbol,
  loading,
  onSelectSymbol,
}) => {
  const [query, setQuery] = useState('');
  const [marketFilter, setMarketFilter] = useState<MarketFilterTab>('all');

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matching = symbols.filter((item) => {
      if (marketFilter === 'quant_core' && !isQuantCoreSymbol(item.underlying_symbol)) {
        return false;
      }
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
      const groupKey = isQuantCoreSymbol(item.underlying_symbol) && marketFilter !== 'synthetic_index'
        ? '__quant_core__'
        : item.submarket;
      const list = map.get(groupKey) ?? [];
      list.push(item);
      map.set(groupKey, list);
    }

    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === '__quant_core__') return -1;
      if (b[0] === '__quant_core__') return 1;
      return formatSubmarketLabel(a[0]).localeCompare(formatSubmarketLabel(b[0]));
    });
  }, [symbols, query, marketFilter]);

  return (
    <aside className="panel symbol-panel" aria-label="Markets Watchlist">
      <div className="panel-header">
        <div className="panel-title-row">
          <Sparkles size={15} className="accent-icon" aria-hidden="true" />
          <h2 className="panel-title">Markets &amp; Alpha Basket</h2>
        </div>
        <span className="count-chip">{symbols.length}</span>
      </div>

      <div className="symbol-search-box">
        <Search size={14} className="search-icon" aria-hidden="true" />
        <input
          type="search"
          className="search-input"
          placeholder="Search BTC, Gold, Nasdaq, R_100…"
          aria-label="Search Markets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="submarket-pills" role="tablist" aria-label="Filter by market class">
        {[
          { id: 'all', label: 'All' },
          { id: 'quant_core', label: '★ Quant Core' },
          { id: 'cryptocurrency', label: '24/7 Crypto' },
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

      <div className="symbol-list" role="listbox" aria-label="Available Markets">
        {loading && symbols.length === 0 ? (
          <div className="empty-state">Loading Deriv Markets…</div>
        ) : filteredGroups.length === 0 ? (
          <div className="empty-state">No markets match &ldquo;{query}&rdquo;.</div>
        ) : (
          filteredGroups.map(([groupKey, items]) => (
            <div key={groupKey} className="symbol-group">
              <div className="symbol-group-label">
                {groupKey === '__quant_core__'
                  ? '★ Audited Quant Core Basket'
                  : formatSubmarketLabel(groupKey)}
              </div>
              {items.map((item) => {
                const isSelected = item.underlying_symbol === selectedSymbol;
                const isOpen =
                  item.exchange_is_open === 1 && item.is_trading_suspended === 0;
                const is24x7 =
                  item.market === 'cryptocurrency' || item.market === 'synthetic_index';
                const isCore = isQuantCoreSymbol(item.underlying_symbol);
                const isCsprng = isCsprngSyntheticSymbol(
                  item.underlying_symbol,
                  item.market,
                );

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
                      <span className="symbol-code">
                        {item.underlying_symbol}
                        {isCore && ' · ★ ALPHA'}
                        {isCsprng && ' · CSPRNG'}
                      </span>
                    </div>
                    <span
                      className={`market-dot ${isOpen ? 'open' : 'closed'}`}
                      title={
                        isOpen
                          ? is24x7
                            ? '24/7 Open (Including Weekends)'
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
