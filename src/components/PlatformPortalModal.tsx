import React, { useCallback, useEffect, useState } from 'react';
import {
  Coins,
  ExternalLink,
  LogIn,
  RotateCcw,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface MarkupResponse {
  summary: {
    totalUsers: number;
    totalConnections: number;
    armedConnections: number;
    totalTrades: number;
  };
  markup: {
    total_app_markup_usd: number;
    total_volume_usd: number;
    total_payout_usd: number;
    total_contract_count: number;
    total_client_count: number;
  } | null;
  markupError: string | null;
  dateFrom: string;
  dateTo: string;
  appId: string | null;
}

interface PlatformPortalModalProps {
  open: boolean;
  onClose: () => void;
}

export const PlatformPortalModal: React.FC<PlatformPortalModalProps> = ({ open, onClose }) => {
  const {
    authenticated,
    selectedAccount,
    liveBalance,
    resetDemoBalance,
  } = useAuth();

  const [revenue, setRevenue] = useState<MarkupResponse | null>(null);
  const [resetting, setResetting] = useState(false);

  const loadRevenue = useCallback(async () => {
    try {
      const res = await fetch('/api/platform/admin/markup', { credentials: 'include' });
      const data = await res.json();
      setRevenue(data);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadRevenue();
  }, [open, loadRevenue]);

  if (!open) return null;

  const displayBalance =
    liveBalance !== null
      ? liveBalance
      : selectedAccount
        ? selectedAccount.balance
        : null;

  const handleResetDemo = async () => {
    setResetting(true);
    try {
      await resetDemoBalance();
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Deriv Account & App Markup">
      <div className="modal-card" style={{ maxWidth: 520, width: '92vw', padding: 20 }}>
        <div className="modal-header">
          <div className="panel-title-row">
            <Coins size={18} className="accent-icon" aria-hidden="true" />
            <h3>Deriv Account &amp; App Markup</h3>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'grid', gap: 14, marginTop: 12 }}>
          {!authenticated || !selectedAccount ? (
            <div
              style={{
                padding: 16,
                borderRadius: 10,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                display: 'grid',
                gap: 12,
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '0.9rem', opacity: 0.85 }}>
                Connect your Deriv account to deposit, run WF-13 Auto-Pilot, and trade directly on your own balance.
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => window.location.assign('/api/auth/login')}
                >
                  <LogIn size={15} /> Connect with Deriv
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => window.location.assign('/api/auth/signup')}
                >
                  <UserPlus size={15} /> Create Deriv Account
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: 14,
                borderRadius: 10,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ShieldCheck size={15} className="accent-icon" />
                  <strong>{selectedAccount.account_id}</strong>
                  <span className={`acct-tag ${selectedAccount.account_type === 'real' ? 'tag-real' : 'tag-demo'}`}>
                    {selectedAccount.account_type}
                  </span>
                </div>
                <div style={{ fontSize: '0.88rem', marginTop: 4, opacity: 0.85 }}>
                  Balance: <strong>{displayBalance !== null ? displayBalance.toFixed(2) : '—'} {selectedAccount.currency}</strong>
                </div>
              </div>

              {selectedAccount.account_type === 'real' ? (
                <a
                  href="https://app.deriv.com/cashier/deposit"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary btn-sm"
                >
                  Deposit on Deriv <ExternalLink size={13} />
                </a>
              ) : (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => void handleResetDemo()}
                  disabled={resetting}
                >
                  <RotateCcw size={13} className={resetting ? 'spin' : undefined} /> Reset $10k Demo
                </button>
              )}
            </div>
          )}

          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>
              Deriv App Markup ({revenue?.dateFrom ?? '30d'} → {revenue?.dateTo ?? 'today'})
            </div>
            {revenue?.markup ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: '0.84rem' }}>
                <div>
                  <div style={{ opacity: 0.65 }}>Markup USD</div>
                  <strong>${revenue.markup.total_app_markup_usd.toFixed(2)}</strong>
                </div>
                <div>
                  <div style={{ opacity: 0.65 }}>Volume</div>
                  <strong>${revenue.markup.total_volume_usd.toFixed(2)}</strong>
                </div>
                <div>
                  <div style={{ opacity: 0.65 }}>Contracts</div>
                  <strong>{revenue.markup.total_contract_count}</strong>
                </div>
                <div>
                  <div style={{ opacity: 0.65 }}>Clients</div>
                  <strong>{revenue.markup.total_client_count}</strong>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.82rem', opacity: 0.75 }}>
                {revenue?.markupError || 'No App Markup stats yet.'}
              </div>
            )}
            <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>
              App ID: <code>{revenue?.appId ?? 'Not set'}</code> &bull; Configure markup % in{' '}
              <a href="https://developers.deriv.com" target="_blank" rel="noopener noreferrer">
                developers.deriv.com
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
