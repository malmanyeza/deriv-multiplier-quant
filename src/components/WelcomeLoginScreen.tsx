import React from 'react';
import { Activity, ArrowRight, Eye, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';

interface WelcomeLoginScreenProps {
  loading: boolean;
  authenticated: boolean;
  oauthConfigured: boolean;
  patConfigured: boolean;
  onAdminPatLogin: () => void;
  onPreviewCharts: () => void;
}

export const WelcomeLoginScreen: React.FC<WelcomeLoginScreenProps> = ({
  loading,
  authenticated,
  oauthConfigured,
  patConfigured,
  onAdminPatLogin,
  onPreviewCharts,
}) => {
  const showAuthButtons = !loading && !authenticated;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          background: 'var(--bg-panel)',
          backdropFilter: 'var(--glass-blur)',
          WebkitBackdropFilter: 'var(--glass-blur)',
          border: '1px solid var(--border-specular)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--glass-shadow)',
          padding: '36px 30px 28px',
          display: 'grid',
          gap: 24,
        }}
      >
        <div style={{ display: 'grid', justifyItems: 'center', textAlign: 'center', gap: 12 }}>
          <div
            className="brand-mark"
            style={{ width: 46, height: 46, borderRadius: 12 }}
            aria-hidden="true"
          >
            <Activity size={22} />
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            <h1
              style={{
                margin: 0,
                fontSize: '1.25rem',
                fontWeight: 700,
                letterSpacing: '-0.015em',
                color: 'var(--text-primary)',
              }}
            >
              Deriv Quant Desk
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: '0.84rem',
                color: 'var(--text-secondary)',
              }}
            >
              WF-13 Automated Multipliers &bull; 13 Markets
            </p>
          </div>
        </div>

        {!showAuthButtons ? (
          <div
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              color: 'var(--text-secondary)',
              fontSize: '0.85rem',
            }}
          >
            <RefreshCw size={15} className="spin" aria-hidden="true" />
            <span>{authenticated ? 'Opening desk…' : 'Checking session…'}</span>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {oauthConfigured && (
              <button
                type="button"
                className="btn btn-primary"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  padding: '12px 16px',
                  fontSize: '0.92rem',
                  fontWeight: 600,
                  borderRadius: 'var(--radius-sm)',
                }}
                onClick={() => window.location.assign('/api/auth/login')}
              >
                <span>Connect with Deriv</span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            )}

            {oauthConfigured && (
              <button
                type="button"
                className="btn btn-outline"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  padding: '10px 16px',
                  fontSize: '0.86rem',
                  borderRadius: 'var(--radius-sm)',
                }}
                onClick={() => window.location.assign('/api/auth/signup')}
              >
                <UserPlus size={14} aria-hidden="true" />
                <span>Create Deriv Account</span>
              </button>
            )}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
          }}
        >
          <ShieldCheck size={13} color="var(--rise)" aria-hidden="true" />
          <span>Official Deriv OAuth &bull; Non-custodial</span>
        </div>

        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 14,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onPreviewCharts}
          >
            <Eye size={13} aria-hidden="true" />
            <span>Preview Desk</span>
          </button>

          {showAuthButtons && patConfigured && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onAdminPatLogin}
            >
              <span>Admin PAT</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
