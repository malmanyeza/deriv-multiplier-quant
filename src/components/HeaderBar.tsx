import React, { useState } from 'react';
import {
  Activity,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  Scale,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface HeaderBarProps {
  onOpenLicenses: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({ onOpenLicenses }) => {
  const {
    oauthConfigured,
    patConfigured,
    patReady,
    authenticated,
    accounts,
    selectedAccount,
    liveBalance,
    connectionStatus,
    startLogin,
    startSignup,
    switchAccount,
    resetDemoBalance,
    reconnectSocket,
    logout,
  } = useAuth();

  const [resettingDemo, setResettingDemo] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);

  const handleAccountChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextId = e.target.value;
    if (!nextId) return;
    setSwitchingAccount(true);
    try {
      await switchAccount(nextId);
    } finally {
      setSwitchingAccount(false);
    }
  };

  const handleResetDemo = async () => {
    setResettingDemo(true);
    try {
      await resetDemoBalance();
    } finally {
      setResettingDemo(false);
    }
  };

  const renderStatusBadge = () => {
    switch (connectionStatus) {
      case 'ready_authenticated':
        return (
          <span className="status-badge status-auth" role="status">
            <Wifi size={14} aria-hidden="true" />
            <span>
              {selectedAccount?.account_type === 'real' ? 'Live Real' : 'Live Demo'}
            </span>
          </span>
        );
      case 'ready_public':
        return (
          <span className="status-badge status-public" role="status">
            <Wifi size={14} aria-hidden="true" />
            <span>Public Feed</span>
          </span>
        );
      case 'connecting':
      case 'authenticating':
      case 'reconnecting':
        return (
          <span className="status-badge status-warn" role="status">
            <RefreshCw size={14} className="spin" aria-hidden="true" />
            <span>
              {connectionStatus === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
            </span>
          </span>
        );
      case 'error':
        return (
          <div className="status-error-group">
            <span className="status-badge status-danger" role="alert">
              <WifiOff size={14} aria-hidden="true" />
              <span>Disconnected</span>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void reconnectSocket()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Reconnect
            </button>
          </div>
        );
    }
  };

  const displayBalance =
    liveBalance !== null
      ? liveBalance
      : selectedAccount
        ? selectedAccount.balance
        : null;

  return (
    <header className="header-bar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <Activity size={20} />
        </div>
        <div>
          <h1 className="brand-title">Synthetic Pulse</h1>
          <p className="brand-subtitle">Synthetic Indices &bull; Rise / Fall Desk</p>
        </div>
      </div>

      <div className="header-controls">
        {renderStatusBadge()}

        {authenticated && selectedAccount ? (
          <div className="account-cluster">
            <div className="account-select-wrap">
              <label htmlFor="account-selector" className="sr-only">
                Trading Account
              </label>
              <select
                id="account-selector"
                className="account-select"
                value={selectedAccount.account_id}
                disabled={switchingAccount}
                onChange={(e) => void handleAccountChange(e)}
              >
                {accounts
                  .filter((a) => a.status === 'active')
                  .map((acct) => (
                    <option key={acct.account_id} value={acct.account_id}>
                      {acct.account_type.toUpperCase()} &bull; {acct.account_id} (
                      {acct.currency})
                    </option>
                  ))}
              </select>
            </div>

            <div className="balance-pill" aria-live="polite">
              <span
                className={`acct-tag ${
                  selectedAccount.account_type === 'real' ? 'tag-real' : 'tag-demo'
                }`}
              >
                {selectedAccount.account_type}
              </span>
              <span className="balance-amount tabular">
                {displayBalance !== null ? displayBalance.toFixed(2) : '—'}{' '}
                {selectedAccount.currency}
              </span>
              {selectedAccount.account_type === 'demo' && (
                <button
                  type="button"
                  className="btn-icon"
                  title="Reset demo account balance"
                  aria-label="Reset demo account balance"
                  disabled={resettingDemo}
                  onClick={() => void handleResetDemo()}
                >
                  <RotateCcw
                    size={14}
                    className={resettingDemo ? 'spin' : undefined}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void logout()}
            >
              <LogOut size={14} aria-hidden="true" />
              <span>Log out</span>
            </button>
          </div>
        ) : (
          <div className="auth-cta-group">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={startLogin}
              title={
                patReady
                  ? 'Connect using your server-side Personal Access Token'
                  : patConfigured
                    ? 'Add DERIV_APP_ID in .env to enable PAT authentication'
                    : oauthConfigured
                      ? 'Sign in with OAuth 2.0 to place Rise/Fall orders'
                      : 'Configure DERIV_APP_ID + DERIV_PAT or DERIV_CLIENT_ID in .env'
              }
            >
              <LogIn size={14} aria-hidden="true" />
              <span>{patConfigured ? 'Connect PAT' : 'Log in'}</span>
            </button>
            {!patConfigured && (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={startSignup}
              >
                <UserPlus size={14} aria-hidden="true" />
                <span>Sign up</span>
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onOpenLicenses}
          aria-label="Open-source licences"
          title="Open-source licences"
        >
          <Scale size={14} aria-hidden="true" />
          <span className="hide-mobile">Licences</span>
        </button>
      </div>
    </header>
  );
};
