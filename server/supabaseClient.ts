import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;
let lastSupabaseError: string | null = null;

export function getLastSupabaseError(): string | null {
  return lastSupabaseError;
}

export function getSupabase(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null;
  }

  try {
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false },
    });
    return supabaseClient;
  } catch (err) {
    console.warn('[Supabase] Initialization failed:', err);
    return null;
  }
}

export interface QuantTradeRecord {
  contract_id: number;
  account_id: string;
  account_type?: string;
  symbol: string;
  market?: string;
  timeframe: string;
  engine: string;
  direction: 'rise' | 'fall';
  multiplier: number;
  stake: number;
  currency?: string;
  entry_price?: number;
  exit_price?: number;
  take_profit?: number | null;
  stop_loss?: number | null;
  profit_loss?: number;
  r_multiple?: number;
  status?: string;
  exit_reason?: string;
}

export async function saveQuantTrade(trade: QuantTradeRecord): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { error } = await sb.from('quant_trades').upsert(
      {
        ...trade,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'contract_id' },
    );
    if (error) {
      console.warn('[Supabase] Failed to save trade:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Supabase] Error saving trade:', err);
    return false;
  }
}

export async function logBotAudit(params: {
  account_id?: string;
  log_type: 'entry' | 'exit' | 'info' | 'blocked';
  symbol?: string;
  timeframe?: string;
  message: string;
}): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { error } = await sb.from('bot_audit_logs').insert([
      {
        ...params,
        created_at: new Date().toISOString(),
      },
    ]);
    if (error) {
      console.warn('[Supabase] Failed to log audit:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[Supabase] Error saving audit log:', err);
    return false;
  }
}

export async function getRecentTrades(accountId?: string, limit = 50) {
  const sb = getSupabase();
  if (!sb) return [];

  let query = sb
    .from('quant_trades')
    .select('*')
    .order('entry_time', { ascending: false })
    .limit(limit);

  if (accountId) {
    query = query.eq('account_id', accountId);
  }

  const { data, error } = await query;
  if (error) {
    console.warn('[Supabase] Failed to fetch trades:', error.message);
    return [];
  }
  return data || [];
}

export interface UserBotConfigRecord {
  account_id: string;
  selected_timeframe: string;
  risk_pct: number;
  max_concurrent_positions?: number;
  circuit_breaker_max_r?: number;
  streak_throttle_enabled?: boolean;
  auto_pilot_armed: boolean;
  updated_at?: string;
}

export async function getBotConfig(accountId: string): Promise<UserBotConfigRecord | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from('user_bot_configs')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      lastSupabaseError = `getBotConfig: ${error.message}`;
      console.warn('[Supabase] Failed to fetch bot config:', error.message);
      return null;
    }
    lastSupabaseError = null;
    return data as UserBotConfigRecord | null;
  } catch (err) {
    lastSupabaseError = `getBotConfig: ${err instanceof Error ? err.message : String(err)}`;
    console.warn('[Supabase] Error fetching bot config:', err);
    return null;
  }
}

export async function saveBotConfig(config: UserBotConfigRecord): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { error } = await sb.from('user_bot_configs').upsert(
      {
        ...config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    );
    if (error) {
      lastSupabaseError = `saveBotConfig: ${error.message}`;
      console.warn('[Supabase] Failed to save bot config:', error.message);
      return false;
    }
    lastSupabaseError = null;
    return true;
  } catch (err) {
    lastSupabaseError = `saveBotConfig: ${err instanceof Error ? err.message : String(err)}`;
    console.warn('[Supabase] Error saving bot config:', err);
    return false;
  }
}

export async function getRecentAuditLogs(accountId?: string, limit = 30) {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    let query = sb
      .from('bot_audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (accountId) {
      query = query.eq('account_id', accountId);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('[Supabase] Failed to fetch audit logs:', error.message);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn('[Supabase] Error fetching audit logs:', err);
    return [];
  }
}
