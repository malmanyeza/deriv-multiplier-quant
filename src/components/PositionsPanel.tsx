import React, { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Layers } from 'lucide-react';
import type { NormalizedPosition } from '../types/deriv';

function formatEpoch(epochSec: number | null | undefined): string {
  if (!epochSec || epochSec <= 0) return '—';
  const d = new Date(epochSec * 1000);
  return (
    d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }) +
    ', ' +
    d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  );
}

function formatDuration(startSec: number, endSec?: number | null): string {
  if (!startSec || startSec <= 0) return '';
  const finish = endSec && endSec > 0 ? endSec : Math.floor(Date.now() / 1000);
  const totalSec = Math.max(0, finish - startSec);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

interface PositionsPanelProps {
  authenticated: boolean;
  positions: NormalizedPosition[];
  sellingContractIds: Set<number>;
  selectedContractId?: number | null;
  onSellAtMarket: (contractId: number) => Promise<void>;
  onSelectTrade: (position: NormalizedPosition) => void;
}

export const PositionsPanel: React.FC<PositionsPanelProps> = ({
  authenticated,
  positions,
  sellingContractIds,
  selectedContractId = null,
  onSellAtMarket,
  onSelectTrade,
}) => {
  const [tab, setTab] = useState<'open' | 'closed'>('open');

  const openPositions = positions
    .filter((p) => !p.isSold)
    .sort((a, b) => b.purchaseTime - a.purchaseTime);

  const closedPositions = positions
    .filter((p) => p.isSold)
    .sort((a, b) => {
      const timeA = a.sellTime ?? a.exitSpotTime ?? a.dateExpiry ?? a.purchaseTime;
      const timeB = b.sellTime ?? b.exitSpotTime ?? b.dateExpiry ?? b.purchaseTime;
      return timeB - timeA;
    });

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
                <th>Time &amp; Date</th>
                <th>Entry / Spot</th>
                <th>SL / TP / Expiry</th>
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
                const isSelected = selectedContractId === pos.contractId;

                return (
                  <tr
                    key={pos.contractId}
                    className={`position-row-clickable${isSelected ? ' position-row-selected' : ''}`}
                    title="Click to view this trade and its SL/TP levels on the chart"
                    onClick={() => onSelectTrade(pos)}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectTrade(pos);
                        }}
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
                        <span>{pos.isSold ? `In: ${formatEpoch(pos.purchaseTime)}` : `Open: ${formatEpoch(pos.purchaseTime)}`}</span>
                        <span className="muted-note">
                          {pos.isSold
                            ? `Out: ${formatEpoch(pos.sellTime ?? pos.exitSpotTime)} (${formatDuration(pos.purchaseTime, pos.sellTime ?? pos.exitSpotTime)})`
                            : `${formatDuration(pos.purchaseTime)} running`}
                        </span>
                      </div>
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
                          <span className={pos.takeProfitPrice !== null ? 'level-tp-text' : 'muted-note'}>
                            TP: {pos.takeProfitPrice !== null ? pos.takeProfitPrice : '—'}
                          </span>
                          <span className={pos.stopLossPrice !== null ? 'level-sl-text' : 'muted-note'}>
                            SL: {pos.stopLossPrice !== null ? pos.stopLossPrice : '—'}
                          </span>
                          <span className="muted-note">
                            KO: {pos.stopOutPrice !== null ? pos.stopOutPrice : '-1R'}
                          </span>
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
                            onClick={(e) => {
                              e.stopPropagation();
                              void onSellAtMarket(pos.contractId);
                            }}
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
