import type { Express, Request, Response } from 'express';
import {
  DerivUpstreamError,
  fetchMarkupStatistics,
  fetchOptionsAccounts,
  resetDemoAccountBalance,
} from './derivClient.js';
import {
  getPlatformAdminSummary,
  getPlatformUser,
  getPlatformUserTrades,
  getUserDerivConnectionToken,
  listUserDerivConnections,
  updateUserDerivConnectionConfig,
  upsertPlatformUser,
  upsertUserDerivConnection,
  type PlatformUserProfile,
} from './platformStore.js';
import { getSupabase } from './supabaseClient.js';
import type { InMemorySessionStore } from './sessionStore.js';

export const PLATFORM_COOKIE_NAME = 'caimex_platform_jwt';
const isProduction = process.env.NODE_ENV === 'production';

function setPlatformCookie(res: Response, jwt: string): void {
  res.cookie(PLATFORM_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearPlatformCookie(res: Response): void {
  res.clearCookie(PLATFORM_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

export async function resolvePlatformUser(req: Request): Promise<PlatformUserProfile | null> {
  const jwt = req.cookies?.[PLATFORM_COOKIE_NAME] as string | undefined;
  if (!jwt) return null;
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const existing = await getPlatformUser(data.user.id);
    if (existing) return existing;
    return await upsertPlatformUser({
      id: data.user.id,
      email: data.user.email ?? '',
      fullName: (data.user.user_metadata?.full_name as string | undefined) ?? null,
    });
  } catch {
    return null;
  }
}

export function registerPlatformRoutes(
  app: Express,
  opts: {
    derivAppId: string;
    derivPat?: string;
    oauthSessionStore: InMemorySessionStore;
    oauthCookieName: string;
  },
): void {
  app.post('/api/platform/signup', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      res.status(503).json({ error: { message: 'Supabase is not configured on the server.' } });
      return;
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';

    if (!email || !email.includes('@') || password.length < 6) {
      res.status(400).json({
        error: { message: 'Valid email and password (at least 6 characters) are required.' },
      });
      return;
    }

    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName || null } },
    });

    if (error) {
      res.status(400).json({ error: { message: error.message } });
      return;
    }

    const user = data.user
      ? await upsertPlatformUser({
          id: data.user.id,
          email: data.user.email ?? email,
          fullName: fullName || null,
        })
      : null;

    if (data.session?.access_token) {
      setPlatformCookie(res, data.session.access_token);
    }

    res.json({
      user,
      needsEmailConfirmation: !data.session,
      connections: [],
    });
  });

  app.post('/api/platform/login', async (req, res) => {
    const sb = getSupabase();
    if (!sb) {
      res.status(503).json({ error: { message: 'Supabase is not configured on the server.' } });
      return;
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: { message: 'Email and password are required.' } });
      return;
    }

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !data.session?.access_token || !data.user) {
      res.status(401).json({
        error: { message: error?.message || 'Invalid email or password.' },
      });
      return;
    }

    const user = await upsertPlatformUser({
      id: data.user.id,
      email: data.user.email ?? email,
      fullName: (data.user.user_metadata?.full_name as string | undefined) ?? null,
    });

    setPlatformCookie(res, data.session.access_token);
    const connections = user ? await listUserDerivConnections(user.id) : [];
    const trades = user ? await getPlatformUserTrades(user.id, 30) : [];

    res.json({ user, connections, trades });
  });

  app.post('/api/platform/logout', (_req, res) => {
    clearPlatformCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/platform/me', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = await resolvePlatformUser(req);
    if (!user) {
      res.json({ authenticated: false, user: null, connections: [], trades: [] });
      return;
    }

    const [connections, trades] = await Promise.all([
      listUserDerivConnections(user.id),
      getPlatformUserTrades(user.id, 30),
    ]);
    res.json({ authenticated: true, user, connections, trades });
  });

  app.post('/api/platform/deriv/connect-pat', async (req, res) => {
    const user = await resolvePlatformUser(req);
    if (!user) {
      res.status(401).json({ error: { message: 'Sign in to your platform account first.' } });
      return;
    }

    const pat = typeof req.body?.pat === 'string' ? req.body.pat.trim() : '';
    if (!pat || pat.length < 8) {
      res.status(400).json({ error: { message: 'A valid Deriv API token is required.' } });
      return;
    }

    try {
      const accounts = await fetchOptionsAccounts(pat, opts.derivAppId);
      const active = accounts.filter((a) => a.status === 'active');
      if (active.length === 0) {
        res.status(400).json({
          error: { message: 'No active Deriv options accounts found for this token.' },
        });
        return;
      }

      for (const acct of active) {
        await upsertUserDerivConnection({
          userId: user.id,
          derivAccountId: acct.account_id,
          accountType: acct.account_type,
          currency: acct.currency,
          balance: acct.balance,
          authMethod: 'pat',
          derivToken: pat,
        });
      }

      const connections = await listUserDerivConnections(user.id);
      res.json({ ok: true, connections });
    } catch (err) {
      const msg =
        err instanceof DerivUpstreamError
          ? err.safeMessage
          : 'Unable to validate Deriv token with Deriv API.';
      res.status(400).json({ error: { message: msg } });
    }
  });

  app.post('/api/platform/deriv/link-current-oauth', async (req, res) => {
    const user = await resolvePlatformUser(req);
    if (!user) {
      res.status(401).json({ error: { message: 'Sign in to your platform account first.' } });
      return;
    }

    const sid = req.cookies?.[opts.oauthCookieName] as string | undefined;
    const oauthSession = opts.oauthSessionStore.getOrCreateSession(sid);
    if (!oauthSession.accessToken || oauthSession.accounts.length === 0) {
      res.status(400).json({
        error: { message: 'Connect your Deriv account via OAuth first.' },
      });
      return;
    }

    for (const acct of oauthSession.accounts.filter((a) => a.status === 'active')) {
      await upsertUserDerivConnection({
        userId: user.id,
        derivAccountId: acct.account_id,
        accountType: acct.account_type,
        currency: acct.currency,
        balance: acct.balance,
        authMethod: 'oauth',
        derivToken: oauthSession.accessToken,
      });
    }

    const connections = await listUserDerivConnections(user.id);
    res.json({ ok: true, connections });
  });

  app.post('/api/platform/deriv/arm', async (req, res) => {
    const user = await resolvePlatformUser(req);
    if (!user) {
      res.status(401).json({ error: { message: 'Sign in to your platform account first.' } });
      return;
    }

    const derivAccountId =
      typeof req.body?.derivAccountId === 'string' ? req.body.derivAccountId.trim() : '';
    if (!derivAccountId) {
      res.status(400).json({ error: { message: 'derivAccountId is required.' } });
      return;
    }

    const armed = typeof req.body?.armed === 'boolean' ? req.body.armed : undefined;
    const timeframe =
      req.body?.timeframe === 'dual' ||
      req.body?.timeframe === '15m' ||
      req.body?.timeframe === '1h'
        ? req.body.timeframe
        : undefined;
    const riskPct =
      typeof req.body?.riskPct === 'number' &&
      Number.isFinite(req.body.riskPct) &&
      req.body.riskPct >= 0.005 &&
      req.body.riskPct <= 0.05
        ? req.body.riskPct
        : undefined;

    const updated = await updateUserDerivConnectionConfig({
      userId: user.id,
      derivAccountId,
      armed,
      timeframe,
      riskPct,
    });
    if (!updated) {
      res.status(404).json({ error: { message: 'Connected Deriv account not found.' } });
      return;
    }

    const connections = await listUserDerivConnections(user.id);
    res.json({ ok: true, connection: updated, connections });
  });

  app.post('/api/platform/deriv/refresh-balance', async (req, res) => {
    const user = await resolvePlatformUser(req);
    if (!user) {
      res.status(401).json({ error: { message: 'Sign in to your platform account first.' } });
      return;
    }

    const derivAccountId =
      typeof req.body?.derivAccountId === 'string' ? req.body.derivAccountId.trim() : '';
    const token = derivAccountId
      ? await getUserDerivConnectionToken(user.id, derivAccountId)
      : null;

    if (!token) {
      res.status(404).json({ error: { message: 'No stored credential for this Deriv account.' } });
      return;
    }

    try {
      const accounts = await fetchOptionsAccounts(token, opts.derivAppId);
      for (const acct of accounts) {
        await updateUserDerivConnectionConfig({
          userId: user.id,
          derivAccountId: acct.account_id,
          balance: acct.balance,
        });
      }
      const connections = await listUserDerivConnections(user.id);
      res.json({ ok: true, connections });
    } catch (err) {
      const msg =
        err instanceof DerivUpstreamError
          ? err.safeMessage
          : 'Unable to refresh Deriv balance right now.';
      res.status(400).json({ error: { message: msg } });
    }
  });

  app.post('/api/platform/deriv/reset-demo', async (req, res) => {
    const user = await resolvePlatformUser(req);
    if (!user) {
      res.status(401).json({ error: { message: 'Sign in to your platform account first.' } });
      return;
    }

    const derivAccountId =
      typeof req.body?.derivAccountId === 'string' ? req.body.derivAccountId.trim() : '';
    const token = derivAccountId
      ? await getUserDerivConnectionToken(user.id, derivAccountId)
      : null;

    if (!token) {
      res.status(404).json({ error: { message: 'No stored credential for this Deriv account.' } });
      return;
    }

    try {
      await resetDemoAccountBalance(token, derivAccountId, opts.derivAppId);
      const accounts = await fetchOptionsAccounts(token, opts.derivAppId);
      for (const acct of accounts) {
        await updateUserDerivConnectionConfig({
          userId: user.id,
          derivAccountId: acct.account_id,
          balance: acct.balance,
        });
      }
      const connections = await listUserDerivConnections(user.id);
      res.json({ ok: true, connections });
    } catch (err) {
      const msg =
        err instanceof DerivUpstreamError ? err.safeMessage : 'Demo balance reset failed.';
      res.status(400).json({ error: { message: msg } });
    }
  });

  app.get('/api/platform/admin/markup', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const summary = await getPlatformAdminSummary();

    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400 * 1000);
    const dateFrom = start.toISOString().slice(0, 10);
    const dateTo = end.toISOString().slice(0, 10);

    const sid = req.cookies?.[opts.oauthCookieName] as string | undefined;
    const oauthSession = opts.oauthSessionStore.getOrCreateSession(sid);
    const token = oauthSession.accessToken || opts.derivPat || '';

    if (!token || !opts.derivAppId) {
      res.json({
        summary,
        markup: null,
        markupError: 'Configure DERIV_PAT or sign in via Deriv OAuth to read live App Markup statistics.',
        dateFrom,
        dateTo,
        appId: opts.derivAppId || null,
      });
      return;
    }

    try {
      const markup = await fetchMarkupStatistics({
        accessToken: token,
        derivAppId: opts.derivAppId,
        dateFrom,
        dateTo,
      });
      res.json({
        summary,
        markup,
        markupError: null,
        dateFrom,
        dateTo,
        appId: opts.derivAppId,
      });
    } catch (err) {
      res.json({
        summary,
        markup: null,
        markupError:
          err instanceof DerivUpstreamError
            ? err.safeMessage
            : 'Unable to fetch Deriv App Markup statistics.',
        dateFrom,
        dateTo,
        appId: opts.derivAppId,
      });
    }
  });
}
