import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ConnectionStatus, DerivAccount } from '../types/deriv';
import { DerivSocketOwner, type WebSocketFactory } from '../services/derivSocket';

const SAFE_AUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_not_configured:
    'Deriv OAuth is not configured yet. Add DERIV_CLIENT_ID and DERIV_REDIRECT_URI in deriv-rise-fall-app/.env to sign in and place trades.',
  state_mismatch:
    'Sign-in session expired or failed CSRF state verification. Please try signing in again.',
  access_denied: 'Sign-in was cancelled.',
  invalid_scope:
    'The requested trade scope is not enabled on your registered Deriv application.',
  insufficient_scope:
    'Your Deriv authorization did not grant the required trade permission.',
  upstream_unavailable:
    'Deriv authentication servers were temporarily unreachable. Please retry in a moment.',
  missing_code: 'OAuth callback did not contain an authorization code.',
  provider_rejected: 'Deriv rejected the authorization request.',
  exchange_failed:
    'Unable to complete OAuth token exchange. Verify DERIV_CLIENT_ID and DERIV_REDIRECT_URI.',
};

interface AuthStatusResponse {
  configured: boolean;
  patConfigured?: boolean;
  patReady?: boolean;
  missingAppIdForPat?: boolean;
  patError?: string | null;
  authenticated: boolean;
  csrfToken: string;
  accounts: DerivAccount[];
  selectedAccountId: string | null;
  expiresAtMs: number | null;
}

export interface AuthContextValue {
  loading: boolean;
  oauthConfigured: boolean;
  patConfigured: boolean;
  patReady: boolean;
  authenticated: boolean;
  accounts: DerivAccount[];
  selectedAccount: DerivAccount | null;
  liveBalance: number | null;
  authNotice: string | null;
  dismissAuthNotice: () => void;
  connectionStatus: ConnectionStatus;
  connectionGeneration: number;
  connectionError: string | null;
  socket: DerivSocketOwner;
  startLogin: () => void;
  startSignup: () => void;
  switchAccount: (accountId: string) => Promise<void>;
  resetDemoBalance: () => Promise<void>;
  reconnectSocket: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function stripCallbackParamsFromBrowserUrl(): string | null {
  const url = new URL(window.location.href);
  const authErrorCode = url.searchParams.get('auth_error');
  const hadAuthParams =
    url.searchParams.has('auth_error') ||
    url.searchParams.has('code') ||
    url.searchParams.has('state') ||
    url.searchParams.has('error') ||
    url.searchParams.has('error_description');

  if (hadAuthParams) {
    url.searchParams.delete('auth_error');
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    const clean = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, '', clean);
  }

  if (!authErrorCode) return null;
  return (
    SAFE_AUTH_ERROR_MESSAGES[authErrorCode] ??
    'Authentication could not be completed. Please try again.'
  );
}

export const AuthProvider: React.FC<{
  children: React.ReactNode;
  createWs?: WebSocketFactory;
}> = ({ children, createWs }) => {
  const [loading, setLoading] = useState(true);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [patConfigured, setPatConfigured] = useState(false);
  const [patReady, setPatReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [liveBalance, setLiveBalance] = useState<number | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  const csrfTokenRef = useRef<string>('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [connectionGeneration, setConnectionGeneration] = useState<number>(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const fetchOtpUrl = useCallback(async (accountId: string): Promise<string> => {
    const res = await fetch('/api/auth/otp', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfTokenRef.current,
      },
      body: JSON.stringify({ accountId }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      url?: string;
      error?: { kind?: string; message?: string };
    };

    if (!res.ok || typeof data.url !== 'string') {
      if (res.status === 401 || data.error?.kind === 'terminal') {
        setAuthenticated(false);
        setAccounts([]);
        setSelectedAccountId(null);
        setLiveBalance(null);
      }
      throw new Error(data.error?.message ?? 'Failed to acquire authenticated trading socket.');
    }

    return data.url;
  }, []);

  const socketRef = useRef<DerivSocketOwner | null>(null);
  if (!socketRef.current) {
    socketRef.current = new DerivSocketOwner({ fetchOtpUrl, createWs });
  }
  const socket = socketRef.current;

  useEffect(() => {
    socket.revive();
    const off = socket.onStateChange((snap) => {
      setConnectionStatus(snap.status);
      setConnectionGeneration(snap.generation);
      setConnectionError(snap.lastError);
    });
    return () => {
      off();
      socket.dispose();
    };
  }, [socket]);

  // Initial bootstrap: clean OAuth params & query BFF session status
  useEffect(() => {
    const callbackNotice = stripCallbackParamsFromBrowserUrl();
    if (callbackNotice) {
      setAuthNotice(callbackNotice);
    }

    let active = true;
    void (async () => {
      try {
        const res = await fetch('/api/auth/status', { credentials: 'include' });
        if (!res.ok) throw new Error('BFF unreachable');
        const status = (await res.json()) as AuthStatusResponse;
        if (!active) return;

        csrfTokenRef.current = status.csrfToken;
        setOauthConfigured(status.configured);
        setPatConfigured(Boolean(status.patConfigured));
        setPatReady(Boolean(status.patReady));
        setAuthenticated(status.authenticated);
        setAccounts(status.accounts);
        setSelectedAccountId(status.selectedAccountId);

        if (!callbackNotice) {
          if (status.missingAppIdForPat) {
            setAuthNotice(
              'Server PAT is configured in deriv-rise-fall-app/.env, but Deriv requires your registered App ID (DERIV_APP_ID) alongside a PAT. Add DERIV_APP_ID in .env and restart.',
            );
          } else if (status.patError) {
            setAuthNotice(status.patError);
          }
        }

        if (status.authenticated && status.selectedAccountId) {
          await socket.connectAuthenticated(status.selectedAccountId);
        } else {
          await socket.connectPublic();
        }
      } catch {
        if (!active) return;
        // Even if BFF isn't running, public market view still connects cleanly
        await socket.connectPublic().catch(() => {});
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [socket]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.account_id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  );

  // Subscribe to live `balance` when authenticated socket is ready
  useEffect(() => {
    if (connectionStatus !== 'ready_authenticated' || !selectedAccount) {
      setLiveBalance(selectedAccount ? selectedAccount.balance : null);
      return;
    }

    setLiveBalance(selectedAccount.balance);
    const sub = socket.subscribe(
      { balance: 1 },
      {
        onMessage: (msg) => {
          const balObj = msg.balance as { balance?: unknown } | undefined;
          const rawBal = balObj?.balance;
          const parsedBal =
            typeof rawBal === 'number'
              ? rawBal
              : typeof rawBal === 'string' && rawBal.trim() !== ''
                ? Number(rawBal)
                : NaN;
          if (Number.isFinite(parsedBal)) {
            setLiveBalance(parsedBal);
          }
        },
      },
      { expectedGeneration: connectionGeneration },
    );

    return () => {
      sub.unsubscribe();
    };
  }, [connectionStatus, connectionGeneration, selectedAccount, socket]);

  const startLogin = useCallback(() => {
    if (patConfigured && (!oauthConfigured || patReady)) {
      void (async () => {
        const res = await fetch('/api/auth/pat-login', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfTokenRef.current,
          },
        }).catch(() => null);

        if (!res) {
          setAuthNotice('Unable to reach local backend server.');
          return;
        }

        const body = (await res.json().catch(() => ({}))) as {
          authenticated?: boolean;
          csrfToken?: string;
          accounts?: DerivAccount[];
          selectedAccountId?: string | null;
          error?: { message?: string };
        };

        if (!res.ok || !body.authenticated) {
          setAuthNotice(body.error?.message ?? 'Unable to connect with server PAT.');
          return;
        }

        if (body.csrfToken) csrfTokenRef.current = body.csrfToken;
        setAuthNotice(null);
        setAuthenticated(true);
        setAccounts(body.accounts ?? []);
        setSelectedAccountId(body.selectedAccountId ?? null);
        if (body.selectedAccountId) {
          await socket.connectAuthenticated(body.selectedAccountId).catch(() => {});
        }
      })();
      return;
    }

    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [patConfigured, oauthConfigured, patReady, socket]);

  const startSignup = useCallback(() => {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/api/auth/signup?returnTo=${encodeURIComponent(returnTo)}`);
  }, []);

  const switchAccount = useCallback(
    async (accountId: string) => {
      if (accountId === selectedAccountId && connectionStatus === 'ready_authenticated') {
        return;
      }

      const res = await fetch('/api/auth/select-account', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfTokenRef.current,
        },
        body: JSON.stringify({ accountId }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        selectedAccountId?: string;
        error?: { message?: string };
      };

      if (!res.ok || !body.selectedAccountId) {
        setAuthNotice(body.error?.message ?? 'Could not switch account.');
        return;
      }

      setSelectedAccountId(body.selectedAccountId);
      await socket.connectAuthenticated(body.selectedAccountId);
    },
    [selectedAccountId, connectionStatus, socket],
  );

  const resetDemoBalance = useCallback(async () => {
    const res = await fetch('/api/auth/reset-demo-balance', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfTokenRef.current,
      },
    });
    const body = (await res.json().catch(() => ({}))) as {
      accounts?: DerivAccount[];
      error?: { message?: string };
    };
    if (!res.ok) {
      setAuthNotice(body.error?.message ?? 'Unable to reset demo balance.');
      return;
    }
    if (Array.isArray(body.accounts)) {
      setAccounts(body.accounts);
      const updated = body.accounts.find((a) => a.account_id === selectedAccountId);
      if (updated) setLiveBalance(updated.balance);
    }
  }, [selectedAccountId]);

  const reconnectSocket = useCallback(async () => {
    if (authenticated && selectedAccountId) {
      await socket.connectAuthenticated(selectedAccountId).catch(() => {});
    } else {
      await socket.connectPublic().catch(() => {});
    }
  }, [authenticated, selectedAccountId, socket]);

  const logout = useCallback(async () => {
    const logoutRes = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfTokenRef.current },
    }).catch(() => null);

    if (logoutRes?.ok) {
      const logoutBody = (await logoutRes.json().catch(() => ({}))) as {
        csrfToken?: string;
      };
      if (logoutBody.csrfToken) {
        csrfTokenRef.current = logoutBody.csrfToken;
      }
    }

    setAuthenticated(false);
    setAccounts([]);
    setSelectedAccountId(null);
    setLiveBalance(null);
    await socket.connectPublic().catch(() => {});

    if (!patConfigured) {
      const statusRes = await fetch('/api/auth/status', { credentials: 'include' }).catch(
        () => null,
      );
      if (statusRes?.ok) {
        const nextStatus = (await statusRes.json()) as AuthStatusResponse;
        csrfTokenRef.current = nextStatus.csrfToken;
      }
    }
  }, [socket, patConfigured]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      oauthConfigured,
      patConfigured,
      patReady,
      authenticated,
      accounts,
      selectedAccount,
      liveBalance,
      authNotice,
      dismissAuthNotice: () => setAuthNotice(null),
      connectionStatus,
      connectionGeneration,
      connectionError,
      socket,
      startLogin,
      startSignup,
      switchAccount,
      resetDemoBalance,
      reconnectSocket,
      logout,
    }),
    [
      loading,
      oauthConfigured,
      patConfigured,
      patReady,
      authenticated,
      accounts,
      selectedAccount,
      liveBalance,
      authNotice,
      connectionStatus,
      connectionGeneration,
      connectionError,
      socket,
      startLogin,
      startSignup,
      switchAccount,
      resetDemoBalance,
      reconnectSocket,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
