import { createOpaqueToken } from './pkce.js';

export interface DerivAccountSummary {
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: 'active' | 'inactive';
  account_type: 'demo' | 'real';
}

export interface PendingOAuthAttempt {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  returnPath: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface AuthSession {
  sessionId: string;
  csrfToken: string;
  accessToken: string | null;
  tokenExpiresAtMs: number | null;
  accounts: DerivAccountSummary[];
  selectedAccountId: string | null;
  patOptedOut: boolean;
  createdAtMs: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export class InMemorySessionStore {
  private readonly pendingByState = new Map<string, PendingOAuthAttempt>();
  private readonly sessions = new Map<string, AuthSession>();

  createAnonymousSession(patOptedOut = false): AuthSession {
    const session: AuthSession = {
      sessionId: createOpaqueToken(32),
      csrfToken: createOpaqueToken(24),
      accessToken: null,
      tokenExpiresAtMs: null,
      accounts: [],
      selectedAccountId: null,
      patOptedOut,
      createdAtMs: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  getOrCreateSession(sessionId: string | undefined): AuthSession {
    if (sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        if (
          existing.accessToken &&
          existing.tokenExpiresAtMs !== null &&
          Date.now() >= existing.tokenExpiresAtMs
        ) {
          this.clearSessionCredentials(existing.sessionId);
        }
        return existing;
      }
    }
    return this.createAnonymousSession();
  }

  rotateAuthenticatedSession(
    oldSessionId: string | undefined,
    accessToken: string,
    expiresInSeconds: number | null,
    accounts: DerivAccountSummary[],
  ): AuthSession {
    if (oldSessionId) {
      this.sessions.delete(oldSessionId);
    }
    const activeAccounts = accounts.filter((a) => a.status === 'active');
    const defaultDemo =
      activeAccounts.find((a) => a.account_type === 'demo') ??
      activeAccounts[0] ??
      accounts[0] ??
      null;

    const rotated: AuthSession = {
      sessionId: createOpaqueToken(32),
      csrfToken: createOpaqueToken(24),
      accessToken,
      tokenExpiresAtMs:
        expiresInSeconds !== null
          ? Date.now() + Math.max(1, expiresInSeconds - 30) * 1000
          : null,
      accounts,
      selectedAccountId: defaultDemo ? defaultDemo.account_id : null,
      patOptedOut: false,
      createdAtMs: Date.now(),
    };
    this.sessions.set(rotated.sessionId, rotated);
    return rotated;
  }

  clearSessionCredentials(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.accessToken = null;
    existing.tokenExpiresAtMs = null;
    existing.accounts = [];
    existing.selectedAccountId = null;
  }

  destroySession(sessionId: string | undefined): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
  }

  savePendingOAuth(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    returnPath: string;
  }): void {
    this.pruneExpiredPending();
    const now = Date.now();
    this.pendingByState.set(input.state, {
      ...input,
      createdAtMs: now,
      expiresAtMs: now + PENDING_TTL_MS,
    });
  }

  consumePendingOAuth(state: string | undefined): PendingOAuthAttempt | null {
    this.pruneExpiredPending();
    if (!state) return null;
    const found = this.pendingByState.get(state) ?? null;
    if (found) {
      this.pendingByState.delete(state);
    }
    return found;
  }

  private pruneExpiredPending(): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingByState.entries()) {
      if (now >= entry.expiresAtMs) {
        this.pendingByState.delete(key);
      }
    }
  }
}
