import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { buildDerivAuthorizeUrl, createPkceTransaction } from './pkce.js';
import { InMemorySessionStore, type AuthSession } from './sessionStore.js';
import {
  DerivUpstreamError,
  exchangeAuthorizationCode,
  fetchOptionsAccounts,
  issueAccountOtpSocketUrl,
  resetDemoAccountBalance,
} from './derivClient.js';

dotenv.config();

const SESSION_COOKIE_NAME = 'pulse_sid';
const isProduction = process.env.NODE_ENV === 'production';

export interface ServerConfig {
  port: number;
  frontendOrigin: string;
  derivAppId: string;
  derivClientId: string;
  derivRedirectUri: string;
  derivScopes: string[];
  derivPat?: string;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.BFF_PORT ?? 3001);
  const frontendOrigin = (env.FRONTEND_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
  const derivClientId = (env.DERIV_CLIENT_ID ?? '').trim();
  const derivAppId = (env.DERIV_APP_ID ?? derivClientId).trim();
  const derivRedirectUri = (env.DERIV_REDIRECT_URI ?? '').trim();
  const derivPat = (env.DERIV_PAT ?? '').trim();
  const rawScopes = (env.DERIV_SCOPES ?? 'trade')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3001,
    frontendOrigin,
    derivAppId,
    derivClientId: derivClientId || derivAppId,
    derivRedirectUri,
    derivScopes: rawScopes.length > 0 ? rawScopes : ['trade'],
    derivPat,
  };
}

function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

function sanitizeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/';
  }
  try {
    const parsed = new URL(raw, 'http://localhost');
    parsed.searchParams.delete('code');
    parsed.searchParams.delete('state');
    parsed.searchParams.delete('error');
    parsed.searchParams.delete('error_description');
    parsed.searchParams.delete('auth_error');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function buildFrontendCallbackRedirect(
  frontendOrigin: string,
  returnPath: string,
  authStatus?: { authError?: string },
): string {
  const base = new URL(returnPath, `${frontendOrigin}/`);
  if (authStatus?.authError) {
    base.searchParams.set('auth_error', authStatus.authError);
  }
  return base.toString();
}

export function createApp(
  config: ServerConfig = loadServerConfig(),
  store: InMemorySessionStore = new InMemorySessionStore(),
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cookieParser());
  app.use(express.json({ limit: '16kb' }));

  const appId = (config.derivAppId || config.derivClientId || '').trim();
  const serverPat = (config.derivPat ?? '').trim();

  const isOAuthConfigured = (): boolean =>
    Boolean(config.derivClientId && config.derivRedirectUri);
  const isPatConfigured = (): boolean => Boolean(serverPat);
  const isPatReady = (): boolean => Boolean(serverPat && appId);

  const requireCsrf = (req: Request, res: Response, session: AuthSession): boolean => {
    const token = req.header('x-csrf-token');
    if (!token || token !== session.csrfToken) {
      res.status(403).json({
        error: {
          code: 'CsrfRejected',
          message: 'Invalid security token. Please refresh the page and try again.',
        },
      });
      return false;
    }
    return true;
  };

  app.get('/api/auth/status', async (req, res) => {
    const existingSid = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    let session = store.getOrCreateSession(existingSid);
    let patError: string | null = null;

    // Auto-bootstrap server-side PAT session when both DERIV_PAT and DERIV_APP_ID are configured
    if (!session.accessToken && !session.patOptedOut && isPatReady()) {
      try {
        const accounts = await fetchOptionsAccounts(serverPat, appId);
        session = store.rotateAuthenticatedSession(
          session.sessionId,
          serverPat,
          null,
          accounts,
        );
      } catch (err) {
        patError =
          err instanceof DerivUpstreamError
            ? err.safeMessage
            : 'Unable to validate server Personal Access Token right now.';
      }
    } else if (session.accessToken && session.accounts.length === 0) {
      try {
        const accounts = await fetchOptionsAccounts(session.accessToken, appId);
        session.accounts = accounts;
        if (!session.selectedAccountId && accounts.length > 0) {
          const demo = accounts.find((a) => a.account_type === 'demo' && a.status === 'active');
          session.selectedAccountId = (demo ?? accounts[0]).account_id;
        }
      } catch (err) {
        if (err instanceof DerivUpstreamError && err.kind === 'terminal') {
          store.clearSessionCredentials(session.sessionId);
        }
      }
    }

    setSessionCookie(res, session.sessionId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      configured: isOAuthConfigured(),
      patConfigured: isPatConfigured(),
      patReady: isPatReady(),
      missingAppIdForPat: Boolean(serverPat && !appId),
      patError,
      authenticated: Boolean(session.accessToken),
      csrfToken: session.csrfToken,
      accounts: session.accounts,
      selectedAccountId: session.selectedAccountId,
      expiresAtMs: session.tokenExpiresAtMs,
    });
  });

  app.post('/api/auth/pat-login', async (req, res) => {
    const existingSid = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const session = store.getOrCreateSession(existingSid);
    setSessionCookie(res, session.sessionId);
    if (!requireCsrf(req, res, session)) return;

    if (!serverPat) {
      res.status(400).json({
        error: {
          code: 'PatNotConfigured',
          kind: 'validation',
          message: 'DERIV_PAT is not configured on the backend server.',
        },
      });
      return;
    }

    if (!appId) {
      res.status(400).json({
        error: {
          code: 'MissingAppId',
          kind: 'validation',
          message:
            'PAT authentication requires DERIV_APP_ID (your registered App ID from developers.deriv.com) in deriv-rise-fall-app/.env.',
        },
      });
      return;
    }

    try {
      const accounts = await fetchOptionsAccounts(serverPat, appId);
      const rotated = store.rotateAuthenticatedSession(
        session.sessionId,
        serverPat,
        null,
        accounts,
      );
      setSessionCookie(res, rotated.sessionId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        authenticated: true,
        csrfToken: rotated.csrfToken,
        accounts: rotated.accounts,
        selectedAccountId: rotated.selectedAccountId,
      });
    } catch (err) {
      if (err instanceof DerivUpstreamError) {
        res.status(err.httpStatus).json({
          error: { code: err.kind, kind: err.kind, message: err.safeMessage },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: 'transient',
          kind: 'transient',
          message: 'Unable to validate server Personal Access Token right now.',
        },
      });
    }
  });

  const handleStartOAuth = (promptRegistration: boolean) => (req: Request, res: Response) => {
    if (!isOAuthConfigured()) {
      res.redirect(
        buildFrontendCallbackRedirect(config.frontendOrigin, '/', {
          authError: 'oauth_not_configured',
        }),
      );
      return;
    }

    const returnPath = sanitizeReturnPath(req.query.returnTo);
    const pkce = createPkceTransaction();
    store.savePendingOAuth({
      state: pkce.state,
      codeVerifier: pkce.codeVerifier,
      redirectUri: config.derivRedirectUri,
      returnPath,
    });

    const authorizeUrl = buildDerivAuthorizeUrl({
      clientId: config.derivClientId,
      redirectUri: config.derivRedirectUri,
      scopes: config.derivScopes,
      state: pkce.state,
      codeChallenge: pkce.codeChallenge,
      promptRegistration,
    });

    res.redirect(authorizeUrl);
  };

  app.get('/api/auth/login', handleStartOAuth(false));
  app.get('/api/auth/signup', handleStartOAuth(true));

  app.get('/api/auth/callback', async (req, res) => {
    const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined;
    const codeParam = typeof req.query.code === 'string' ? req.query.code : undefined;
    const errorParam = typeof req.query.error === 'string' ? req.query.error : undefined;

    // Validate single-use state BEFORE trusting either `code` or `error`
    const pending = store.consumePendingOAuth(stateParam);
    if (!pending) {
      res.redirect(
        buildFrontendCallbackRedirect(config.frontendOrigin, '/', {
          authError: 'state_mismatch',
        }),
      );
      return;
    }

    if (errorParam) {
      const safeCode =
        errorParam === 'access_denied'
          ? 'access_denied'
          : errorParam === 'invalid_scope'
            ? 'invalid_scope'
            : 'provider_rejected';
      res.redirect(
        buildFrontendCallbackRedirect(config.frontendOrigin, pending.returnPath, {
          authError: safeCode,
        }),
      );
      return;
    }

    if (!codeParam || !isOAuthConfigured()) {
      res.redirect(
        buildFrontendCallbackRedirect(config.frontendOrigin, pending.returnPath, {
          authError: 'missing_code',
        }),
      );
      return;
    }

    try {
      const tokenResult = await exchangeAuthorizationCode({
        clientId: config.derivClientId,
        code: codeParam,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
      });

      const accounts = await fetchOptionsAccounts(tokenResult.accessToken, appId);
      const oldSid = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
      const rotated = store.rotateAuthenticatedSession(
        oldSid,
        tokenResult.accessToken,
        tokenResult.expiresIn,
        accounts,
      );
      setSessionCookie(res, rotated.sessionId);
      res.redirect(buildFrontendCallbackRedirect(config.frontendOrigin, pending.returnPath));
    } catch (err) {
      const code =
        err instanceof DerivUpstreamError && err.kind === 'scope'
          ? 'insufficient_scope'
          : err instanceof DerivUpstreamError && err.kind === 'transient'
            ? 'upstream_unavailable'
            : 'exchange_failed';
      res.redirect(
        buildFrontendCallbackRedirect(config.frontendOrigin, pending.returnPath, {
          authError: code,
        }),
      );
    }
  });

  app.post('/api/auth/refresh-accounts', async (req, res) => {
    const session = store.getOrCreateSession(req.cookies?.[SESSION_COOKIE_NAME]);
    setSessionCookie(res, session.sessionId);
    if (!requireCsrf(req, res, session)) return;

    if (!session.accessToken) {
      res.status(401).json({
        error: { code: 'Unauthenticated', kind: 'terminal', message: 'Please sign in first.' },
      });
      return;
    }

    try {
      const accounts = await fetchOptionsAccounts(session.accessToken, appId);
      session.accounts = accounts;
      if (
        session.selectedAccountId &&
        !accounts.some((a) => a.account_id === session.selectedAccountId)
      ) {
        session.selectedAccountId = accounts[0]?.account_id ?? null;
      }
      res.json({ accounts: session.accounts, selectedAccountId: session.selectedAccountId });
    } catch (err) {
      if (err instanceof DerivUpstreamError) {
        if (err.kind === 'terminal') {
          store.clearSessionCredentials(session.sessionId);
        }
        res.status(err.httpStatus).json({
          error: { code: err.kind, kind: err.kind, message: err.safeMessage },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: 'transient',
          kind: 'transient',
          message: 'Unable to refresh accounts right now.',
        },
      });
    }
  });

  app.post('/api/auth/select-account', (req, res) => {
    const session = store.getOrCreateSession(req.cookies?.[SESSION_COOKIE_NAME]);
    setSessionCookie(res, session.sessionId);
    if (!requireCsrf(req, res, session)) return;

    if (!session.accessToken) {
      res.status(401).json({
        error: { code: 'Unauthenticated', kind: 'terminal', message: 'Please sign in first.' },
      });
      return;
    }

    const accountId =
      typeof req.body?.accountId === 'string' ? req.body.accountId.trim() : '';
    const target = session.accounts.find(
      (a) => a.account_id === accountId && a.status === 'active',
    );
    if (!target) {
      res.status(400).json({
        error: {
          code: 'InvalidAccount',
          kind: 'validation',
          message: 'Selected Options account is not available.',
        },
      });
      return;
    }

    session.selectedAccountId = target.account_id;
    res.json({ selectedAccountId: session.selectedAccountId, account: target });
  });

  app.post('/api/auth/otp', async (req, res) => {
    const session = store.getOrCreateSession(req.cookies?.[SESSION_COOKIE_NAME]);
    setSessionCookie(res, session.sessionId);
    if (!requireCsrf(req, res, session)) return;

    if (!session.accessToken) {
      res.status(401).json({
        error: { code: 'Unauthenticated', kind: 'terminal', message: 'Please sign in first.' },
      });
      return;
    }

    const requestedId =
      typeof req.body?.accountId === 'string' && req.body.accountId.trim()
        ? req.body.accountId.trim()
        : session.selectedAccountId;

    const target = session.accounts.find(
      (a) => a.account_id === requestedId && a.status === 'active',
    );
    if (!target) {
      res.status(400).json({
        error: {
          code: 'NoActiveAccount',
          kind: 'validation',
          message: 'No active Options trading account selected.',
        },
      });
      return;
    }

    try {
      const otpSocketUrl = await issueAccountOtpSocketUrl(
        session.accessToken,
        target.account_id,
        appId,
      );
      session.selectedAccountId = target.account_id;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        url: otpSocketUrl,
        accountId: target.account_id,
        accountType: target.account_type,
        currency: target.currency,
      });
    } catch (err) {
      if (err instanceof DerivUpstreamError) {
        if (err.kind === 'terminal') {
          store.clearSessionCredentials(session.sessionId);
        }
        res.status(err.httpStatus).json({
          error: { code: err.kind, kind: err.kind, message: err.safeMessage },
        });
        return;
      }
      res.status(502).json({
        error: {
          code: 'transient',
          kind: 'transient',
          message: 'Unable to mint authenticated trading socket URL.',
        },
      });
    }
  });

  app.post('/api/auth/reset-demo-balance', async (req, res) => {
    const session = store.getOrCreateSession(req.cookies?.[SESSION_COOKIE_NAME]);
    setSessionCookie(res, session.sessionId);
    if (!requireCsrf(req, res, session)) return;

    if (!session.accessToken) {
      res.status(401).json({
        error: { code: 'Unauthenticated', kind: 'terminal', message: 'Please sign in first.' },
      });
      return;
    }

    const target = session.accounts.find(
      (a) => a.account_id === session.selectedAccountId && a.account_type === 'demo',
    );
    if (!target) {
      res.status(400).json({
        error: {
          code: 'DemoOnly',
          kind: 'validation',
          message: 'Balance reset is only available for active Demo accounts.',
        },
      });
      return;
    }

    try {
      await resetDemoAccountBalance(session.accessToken, target.account_id, appId);
      const refreshed = await fetchOptionsAccounts(session.accessToken, appId);
      session.accounts = refreshed;
      res.json({ accounts: refreshed, selectedAccountId: session.selectedAccountId });
    } catch (err) {
      if (err instanceof DerivUpstreamError) {
        if (err.kind === 'terminal') {
          store.clearSessionCredentials(session.sessionId);
        }
        res.status(err.httpStatus).json({
          error: { code: err.kind, kind: err.kind, message: err.safeMessage },
        });
        return;
      }
      res.status(502).json({
        error: { code: 'transient', kind: 'transient', message: 'Demo balance reset failed.' },
      });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const sid = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const session = store.getOrCreateSession(sid);
    if (!requireCsrf(req, res, session)) return;

    store.destroySession(session.sessionId);
    if (isPatConfigured()) {
      const optedOut = store.createAnonymousSession(true);
      setSessionCookie(res, optedOut.sessionId);
      res.json({ ok: true, csrfToken: optedOut.csrfToken });
      return;
    }

    clearSessionCookie(res);
    res.json({ ok: true });
  });

  if (isProduction) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const distDir = path.resolve(__dirname, '../dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const cfg = loadServerConfig();
  const app = createApp(cfg);
  app.listen(cfg.port, () => {
    const hasAppId = Boolean(cfg.derivAppId || cfg.derivClientId);
    console.log(
      `[BFF] Listening on http://localhost:${cfg.port} (OAuth ready: ${Boolean(cfg.derivClientId && cfg.derivRedirectUri)}, Server PAT present: ${Boolean(cfg.derivPat)}, App ID present: ${hasAppId})`,
    );
  });
}
