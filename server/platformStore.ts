import crypto from 'node:crypto';
import { getSupabase } from './supabaseClient.js';

export interface PlatformUserProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: 'trader' | 'admin';
  created_at?: string;
}

export interface PublicDerivConnection {
  id: number;
  user_id: string;
  deriv_account_id: string;
  account_type: 'demo' | 'real';
  currency: string;
  balance: number;
  auth_method: 'oauth' | 'pat';
  is_active: boolean;
  auto_pilot_armed: boolean;
  selected_timeframe: string;
  risk_pct: number;
  updated_at?: string;
}

export interface ArmedDerivConnection extends PublicDerivConnection {
  deriv_token: string;
}

function getEncryptionKey(): Buffer {
  const secret =
    process.env.PLATFORM_ENCRYPTION_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.DERIV_PAT ||
    'local-dev-deriv-quant-secret-key';
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptDerivToken(plainToken: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptDerivToken(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const data = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export async function upsertPlatformUser(params: {
  id: string;
  email: string;
  fullName?: string | null;
}): Promise<PlatformUserProfile | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const existing = await getPlatformUser(params.id);
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const role: 'trader' | 'admin' =
    existing?.role ?? (adminEmail && params.email.toLowerCase() === adminEmail ? 'admin' : 'trader');

  const { data, error } = await sb
    .from('platform_users')
    .upsert(
      {
        id: params.id,
        email: params.email.toLowerCase(),
        full_name: params.fullName ?? existing?.full_name ?? null,
        role,
      },
      { onConflict: 'id' },
    )
    .select('id, email, full_name, role, created_at')
    .single();

  if (error) {
    console.warn('[PlatformStore] upsertPlatformUser failed:', error.message);
    return null;
  }
  return data as PlatformUserProfile;
}

export async function getPlatformUser(userId: string): Promise<PlatformUserProfile | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from('platform_users')
    .select('id, email, full_name, role, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) return null;
  return data as PlatformUserProfile | null;
}

export async function upsertUserDerivConnection(params: {
  userId: string;
  derivAccountId: string;
  accountType: 'demo' | 'real';
  currency: string;
  balance: number;
  authMethod: 'oauth' | 'pat';
  derivToken: string;
}): Promise<PublicDerivConnection | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from('user_deriv_connections')
    .upsert(
      {
        user_id: params.userId,
        deriv_account_id: params.derivAccountId,
        account_type: params.accountType,
        currency: params.currency,
        balance: params.balance,
        auth_method: params.authMethod,
        deriv_token_encrypted: encryptDerivToken(params.derivToken),
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,deriv_account_id' },
    )
    .select(
      'id, user_id, deriv_account_id, account_type, currency, balance, auth_method, is_active, auto_pilot_armed, selected_timeframe, risk_pct, updated_at',
    )
    .single();

  if (error) {
    console.warn('[PlatformStore] upsertUserDerivConnection failed:', error.message);
    return null;
  }
  return data as PublicDerivConnection;
}

export async function listUserDerivConnections(
  userId: string,
): Promise<PublicDerivConnection[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from('user_deriv_connections')
    .select(
      'id, user_id, deriv_account_id, account_type, currency, balance, auth_method, is_active, auto_pilot_armed, selected_timeframe, risk_pct, updated_at',
    )
    .eq('user_id', userId)
    .order('account_type', { ascending: false })
    .order('deriv_account_id', { ascending: true });

  if (error) return [];
  return (data ?? []) as PublicDerivConnection[];
}

export async function getUserDerivConnectionToken(
  userId: string,
  derivAccountId: string,
): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await sb
    .from('user_deriv_connections')
    .select('deriv_token_encrypted')
    .eq('user_id', userId)
    .eq('deriv_account_id', derivAccountId)
    .maybeSingle();

  if (error || !data) return null;
  return decryptDerivToken((data as { deriv_token_encrypted?: string }).deriv_token_encrypted);
}

export async function updateUserDerivConnectionConfig(params: {
  userId: string;
  derivAccountId: string;
  armed?: boolean;
  timeframe?: string;
  riskPct?: number;
  balance?: number;
}): Promise<PublicDerivConnection | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof params.armed === 'boolean') patch.auto_pilot_armed = params.armed;
  if (typeof params.timeframe === 'string') patch.selected_timeframe = params.timeframe;
  if (typeof params.riskPct === 'number') patch.risk_pct = params.riskPct;
  if (typeof params.balance === 'number') patch.balance = params.balance;

  const { data, error } = await sb
    .from('user_deriv_connections')
    .update(patch)
    .eq('user_id', params.userId)
    .eq('deriv_account_id', params.derivAccountId)
    .select(
      'id, user_id, deriv_account_id, account_type, currency, balance, auth_method, is_active, auto_pilot_armed, selected_timeframe, risk_pct, updated_at',
    )
    .maybeSingle();

  if (error) return null;
  return data as PublicDerivConnection | null;
}

export async function listAllArmedDerivConnections(): Promise<ArmedDerivConnection[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from('user_deriv_connections')
    .select('*')
    .eq('auto_pilot_armed', true)
    .eq('is_active', true);

  if (error || !data) return [];
  const results: ArmedDerivConnection[] = [];
  for (const row of data as Array<PublicDerivConnection & { deriv_token_encrypted?: string }>) {
    const token = decryptDerivToken(row.deriv_token_encrypted);
    if (!token) continue;
    results.push({
      id: row.id,
      user_id: row.user_id,
      deriv_account_id: row.deriv_account_id,
      account_type: row.account_type,
      currency: row.currency,
      balance: Number(row.balance) || 0,
      auth_method: row.auth_method,
      is_active: row.is_active,
      auto_pilot_armed: row.auto_pilot_armed,
      selected_timeframe: row.selected_timeframe,
      risk_pct: Number(row.risk_pct) || 0.03,
      updated_at: row.updated_at,
      deriv_token: token,
    });
  }
  return results;
}

export async function getPlatformUserTrades(userId: string, limit = 50) {
  const sb = getSupabase();
  if (!sb) return [];

  const { data, error } = await sb
    .from('quant_trades')
    .select('*')
    .eq('user_id', userId)
    .order('entry_time', { ascending: false })
    .limit(limit);

  if (error) return [];
  return data ?? [];
}

export async function getPlatformAdminSummary() {
  const sb = getSupabase();
  if (!sb) {
    return { totalUsers: 0, totalConnections: 0, armedConnections: 0, totalTrades: 0 };
  }

  const [usersRes, connRes, armedRes, tradesRes] = await Promise.all([
    sb.from('platform_users').select('id', { count: 'exact', head: true }),
    sb.from('user_deriv_connections').select('id', { count: 'exact', head: true }),
    sb
      .from('user_deriv_connections')
      .select('id', { count: 'exact', head: true })
      .eq('auto_pilot_armed', true),
    sb.from('quant_trades').select('id', { count: 'exact', head: true }).not('user_id', 'is', null),
  ]);

  return {
    totalUsers: usersRes.count ?? 0,
    totalConnections: connRes.count ?? 0,
    armedConnections: armedRes.count ?? 0,
    totalTrades: tradesRes.count ?? 0,
  };
}
