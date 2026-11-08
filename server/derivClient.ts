import type { DerivAccountSummary } from './sessionStore.js';

const DERIV_TOKEN_ENDPOINT = 'https://auth.deriv.com/oauth2/token';
const DERIV_API_BASE = 'https://api.derivws.com';
const ALLOWED_DERIV_HOSTS = new Set(['auth.deriv.com', 'api.derivws.com']);

function assertDerivHost(rawUrl: string, allowedProtocols: string[]): URL {
  const parsed = new URL(rawUrl);
  if (
    !allowedProtocols.includes(parsed.protocol) ||
    !ALLOWED_DERIV_HOSTS.has(parsed.hostname)
  ) {
    throw new DerivUpstreamError(
      'terminal',
      502,
      'Upstream URL failed Deriv host verification.',
    );
  }
  return parsed;
}

export type FailureKind = 'terminal' | 'transient' | 'scope' | 'validation';

export class DerivUpstreamError extends Error {
  readonly kind: FailureKind;
  readonly httpStatus: number;
  readonly safeMessage: string;

  constructor(kind: FailureKind, httpStatus: number, safeMessage: string) {
    super(safeMessage);
    this.name = 'DerivUpstreamError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.safeMessage = safeMessage;
  }
}

interface RestErrorItem {
  status?: number;
  code?: string;
  message?: string;
}

interface RestErrorEnvelope {
  errors?: RestErrorItem[];
}

function classifyHttpFailure(status: number, body: unknown): DerivUpstreamError {
  const envelope = (body && typeof body === 'object' ? body : {}) as RestErrorEnvelope;
  const firstCode = envelope.errors?.[0]?.code ?? '';
  const firstMsg = envelope.errors?.[0]?.message ?? '';

  if (status === 401 && /Deriv-App-ID/i.test(firstMsg)) {
    return new DerivUpstreamError(
      'validation',
      401,
      'Deriv-App-ID header is required or invalid for Personal Access Token authentication. Verify DERIV_APP_ID in .env.',
    );
  }

  if (status === 401 || firstCode === 'InvalidToken' || firstCode === 'Unauthorized') {
    return new DerivUpstreamError(
      'terminal',
      401,
      'Your Deriv credential expired, was revoked, or is invalid.',
    );
  }
  if (status === 403) {
    return new DerivUpstreamError(
      'scope',
      403,
      'Your Deriv token is missing the required trade scope. Ensure the token has trade permission.',
    );
  }
  if (status === 429 || firstCode === 'RateLimit') {
    return new DerivUpstreamError(
      'transient',
      429,
      'Deriv API rate limit reached. Please wait a moment and try again.',
    );
  }
  if (status >= 500) {
    return new DerivUpstreamError(
      'transient',
      502,
      'Deriv API is temporarily unavailable. Your session is still active—please retry shortly.',
    );
  }
  return new DerivUpstreamError(
    'validation',
    status >= 400 && status < 500 ? status : 400,
    'Deriv API rejected the request.',
  );
}

function buildRestAuthHeaders(
  accessToken: string,
  derivAppId?: string,
): Record<string, string> {
  const cleanAppId = derivAppId?.trim() ?? '';
  if (accessToken.startsWith('pat_') && !cleanAppId) {
    throw new DerivUpstreamError(
      'validation',
      400,
      'PAT authentication requires DERIV_APP_ID (your registered App ID from developers.deriv.com) in deriv-rise-fall-app/.env.',
    );
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
  if (cleanAppId) {
    headers['Deriv-App-ID'] = cleanAppId;
  }
  return headers;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TokenExchangeResult {
  accessToken: string;
  expiresIn: number;
}

export async function exchangeAuthorizationCode(params: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenExchangeResult> {
  const url = assertDerivHost(DERIV_TOKEN_ENDPOINT, ['https:']);
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new DerivUpstreamError(
      'transient',
      502,
      'Network error while completing Deriv OAuth exchange.',
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!res.ok || typeof payload.access_token !== 'string') {
    throw new DerivUpstreamError(
      res.status >= 500 || res.status === 429 ? 'transient' : 'terminal',
      res.status >= 500 ? 502 : 401,
      'Authorization code exchange with Deriv failed.',
    );
  }

  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;

  return {
    accessToken: payload.access_token,
    expiresIn,
  };
}

export async function fetchOptionsAccounts(
  accessToken: string,
  derivAppId?: string,
): Promise<DerivAccountSummary[]> {
  const url = assertDerivHost(`${DERIV_API_BASE}/trading/v1/options/accounts`, ['https:']);
  const headers = buildRestAuthHeaders(accessToken, derivAppId);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt < maxAttempts) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      throw new DerivUpstreamError(
        'transient',
        502,
        'Unable to reach Deriv account service. Please retry shortly.',
      );
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (!res.ok) {
      const err = classifyHttpFailure(res.status, body);
      if (err.kind === 'transient' && attempt < maxAttempts) {
        await sleep(300 * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }

    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      return [];
    }

    return data.flatMap((raw): DerivAccountSummary[] => {
      if (!raw || typeof raw !== 'object') return [];
      const item = raw as Record<string, unknown>;
      const parsedBalance =
        typeof item.balance === 'number'
          ? item.balance
          : typeof item.balance === 'string' && item.balance.trim() !== ''
            ? Number(item.balance)
            : NaN;

      if (
        typeof item.account_id !== 'string' ||
        !Number.isFinite(parsedBalance) ||
        typeof item.currency !== 'string' ||
        typeof item.group !== 'string' ||
        (item.status !== 'active' && item.status !== 'inactive') ||
        (item.account_type !== 'demo' && item.account_type !== 'real')
      ) {
        return [];
      }
      return [
        {
          account_id: item.account_id,
          balance: parsedBalance,
          currency: item.currency,
          group: item.group,
          status: item.status,
          account_type: item.account_type,
        },
      ];
    });
  }

  return [];
}

export async function issueAccountOtpSocketUrl(
  accessToken: string,
  accountId: string,
  derivAppId?: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(accountId)) {
    throw new DerivUpstreamError('validation', 400, 'Invalid account identifier.');
  }

  const endpointUrl = assertDerivHost(
    `${DERIV_API_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    ['https:'],
  );
  const headers = buildRestAuthHeaders(accessToken, derivAppId);

  let res: Response;
  try {
    res = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DerivUpstreamError(
      'transient',
      502,
      'Unable to reach Deriv WebSocket OTP service. Please retry.',
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw classifyHttpFailure(res.status, body);
  }

  const otpUrl = (body as { data?: { url?: unknown } })?.data?.url;
  if (typeof otpUrl !== 'string') {
    throw new DerivUpstreamError(
      'transient',
      502,
      'Deriv OTP service returned an unexpected response.',
    );
  }

  const validatedSocketUrl = assertDerivHost(otpUrl, ['wss:']);
  return validatedSocketUrl.toString();
}

export async function resetDemoAccountBalance(
  accessToken: string,
  accountId: string,
  derivAppId?: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(accountId)) {
    throw new DerivUpstreamError('validation', 400, 'Invalid account identifier.');
  }

  const endpointUrl = assertDerivHost(
    `${DERIV_API_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/reset-demo-balance`,
    ['https:'],
  );
  const headers = buildRestAuthHeaders(accessToken, derivAppId);

  let res: Response;
  try {
    res = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DerivUpstreamError(
      'transient',
      502,
      'Unable to reset demo balance right now.',
    );
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw classifyHttpFailure(res.status, body);
  }
}
