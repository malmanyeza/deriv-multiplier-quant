import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;

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
