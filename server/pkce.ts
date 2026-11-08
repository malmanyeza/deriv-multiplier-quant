import crypto from 'node:crypto';

export interface PkceBundle {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
  csrfToken?: string;
}

export function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createPkceTransaction(): PkceBundle {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const digest = crypto.createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = base64UrlEncode(digest);
  const state = base64UrlEncode(crypto.randomBytes(24));

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
    state,
  };
}

export function createOpaqueToken(byteLength = 32): string {
  return base64UrlEncode(crypto.randomBytes(byteLength));
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  promptRegistration?: boolean;
}

const DERIV_AUTH_URL = 'https://auth.deriv.com/oauth2/auth';

export function buildDerivAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(DERIV_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.promptRegistration) {
    url.searchParams.set('prompt', 'registration');
  }
  return url.toString();
}
