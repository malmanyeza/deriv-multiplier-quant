import React, { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Layers } from 'lucide-react';
import type { NormalizedPosition } from '../types/deriv';

interface PositionsPanelProps {
  authenticated: boolean;
  positions: NormalizedPosition[];
  sellingContractIds: Set<number>;
  onSellAtMarket: (contractId: number) => Promise<void>;
  onSelectSymbol: (symbol: string) => void;
}

export const PositionsPanel: React.FC<PositionsPanelProps> = ({
  authenticated,
  positions,
  sellingContractIds,
  onSellAtMarket,
  onSelectSymbol,
}) => {
  const [tab, setTab] = useState<'open' | 'closed'>('open');

  const openPositions = positions.filter((p) => !p.isSold);
  const closedPositions = positions.filter((p) => p.isSold);
  const activeList = tab === 'open' ? openPositions : closedPositions;

  return (
    <section className="panel positions-panel" aria-label="Contract Positions">
      <div className="positions-header">
        <div className="panel-title-row">
          <Layers size={15} className="accent-icon" aria-hidden="true" />
          <h2 className="panel-title">Positions</h2>
        </div>

        <div className="positions-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'open'}
            className={`gran-btn ${tab === 'open' ? 'active' : ''}`}
            onClick={() => setTab('open')}
          >
            Open ({openPositions.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'closed'}
            className={`gran-btn ${tab === 'closed' ? 'active' : ''}`}
            onClick={() => setTab('closed')}
          >
            Closed / Settled ({closedPositions.length})
          </button>
        </div>
      </div>

      {!authenticated ? (
        <div className="empty-state">
          Sign in with your Deriv account to monitor live open contracts, early market
          resale, and settlement PnL.
        </div>
      ) : activeList.length === 0 ? (
        <div className="empty-state">
          {tab === 'open'
            ? 'No open Multiplier or Rise/Fall contracts right now.'
            : 'No settled contracts in this session yet.'}
        </div>
      ) : (
        <div className="positions-table-wrap">
          <table className="positions-table tabular">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Contract</th>
                <th>Entry / Spot</th>
                <th>Stop-Out / Expiry</th>
                <th>Buy Price</th>
                <th>{tab === 'open' ? 'Indicative Value' : 'Final Sale / Payout'}</th>
                <th>Net PnL</th>
                <th>Action / Status</th>
              </tr>
            </thead>
            <tbody>
              {activeList.map((pos) => {
                const isRise =
                  pos.contractType === 'CALL' ||
                  pos.contractType === 'CALLE' ||
                  pos.contractType === 'MULTUP';
                const isMult =
                  pos.contractType === 'MULTUP' || pos.contractType === 'MULTDOWN';
                const isSelling = sellingContractIds.has(pos.contractId);
                const pnlPositive = pos.profit >= 0;

                return (
                  <tr key={pos.contractId}>
                    <td>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => onSelectSymbol(pos.underlyingSymbol)}
                      >
                        {pos.underlyingSymbol}
                      </button>
                    </td>
                    <td>
                      <span
                        className={`dir-badge ${isRise ? 'dir-rise' : 'dir-fall'}`}
                      >
                        {isRise ? (
                          <ArrowUpRight size={13} aria-hidden="true" />
                        ) : (
                          <ArrowDownRight size={13} aria-hidden="true" />
                        )}
                        {pos.contractType}
                        {pos.multiplier ? ` ${pos.multiplier}x` : ''}
                      </span>
                    </td>
                    <td>
                      <div className="spot-pair">
                        <span>In: {pos.entrySpot ?? '—'}</span>
                        <span className="muted-note">
                          {pos.isSold
                            ? `Out: ${pos.exitSpot ?? '—'}`
                            : `Now: ${pos.currentSpot ?? '—'}`}
                        </span>
                      </div>
                    </td>
                    <td>
                      {isMult ? (
                        <div className="spot-pair">
                          <span>
                            KO: {pos.stopOutPrice !== null ? pos.stopOutPrice : '-1R'}
                          </span>
                          {pos.takeProfitPrice !== null && (
                            <span className="muted-note">TP: {pos.takeProfitPrice}</span>
                          )}
                        </div>
                      ) : pos.tickCount !== null ? (
                        `${pos.ticksObserved} / ${pos.tickCount} ticks`
                      ) : pos.dateExpiry ? (
                        new Date(pos.dateExpiry * 1000).toLocaleTimeString()
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {pos.buyPrice.toFixed(2)} {pos.currency}
                    </td>
                    <td>
                      {(pos.isSold && pos.sellPrice !== null
                        ? pos.sellPrice
                        : pos.bidPrice
                      ).toFixed(2)}{' '}
                      {pos.currency}
                    </td>
                    <td className={pnlPositive ? 'text-up' : 'text-down'}>
                      {pnlPositive ? '+' : ''}
                      {pos.profit.toFixed(2)} {pos.currency} (
                      {pnlPositive ? '+' : ''}
                      {pos.profitPercentage.toFixed(1)}%)
                    </td>
                    <td>
                      {!pos.isSold ? (
                        pos.isValidToSell ? (
                          <button
                            type="button"
                            className="btn btn-outline btn-xs"
                            disabled={isSelling}
                            onClick={() => void onSellAtMarket(pos.contractId)}
                          >
                            {isSelling ? 'Selling…' : 'Sell at Market'}
                          </button>
                        ) : (
                          <span className="muted-note">
                            {pos.isExpired ? 'Settling…' : 'Running'}
                          </span>
                        )
                      ) : (
                        <span
                          className={`status-tag status-${pos.status}`}
                        >
                          {pos.status.toUpperCase()}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
