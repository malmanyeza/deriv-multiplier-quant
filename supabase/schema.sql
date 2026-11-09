-- =========================================================================
-- DERIV QUANT TRADING BOT: SUPABASE SCHEMA MIGRATION
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)
-- =========================================================================

-- 1. Table: quant_trades (Tracks all bot and manual trade executions)
CREATE TABLE IF NOT EXISTS public.quant_trades (
  id BIGSERIAL PRIMARY KEY,
  contract_id BIGINT UNIQUE,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'demo', -- 'demo' or 'real'
  symbol TEXT NOT NULL,
  market TEXT,
  timeframe TEXT NOT NULL, -- '15m', '1h', 'dual', '5m'
  engine TEXT NOT NULL,    -- '15M Turbo' or '1H Macro'
  direction TEXT NOT NULL, -- 'rise' or 'fall'
  contract_type TEXT NOT NULL DEFAULT 'multipliers',
  multiplier NUMERIC NOT NULL,
  stake NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  entry_price NUMERIC,
  exit_price NUMERIC,
  entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_time TIMESTAMPTZ,
  take_profit NUMERIC,
  stop_loss NUMERIC,
  profit_loss NUMERIC,
  r_multiple NUMERIC,
  status TEXT NOT NULL DEFAULT 'open', -- 'open', 'won', 'lost', 'sold'
  exit_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quant_trades_account ON public.quant_trades(account_id);
CREATE INDEX IF NOT EXISTS idx_quant_trades_symbol ON public.quant_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_quant_trades_status ON public.quant_trades(status);
CREATE INDEX IF NOT EXISTS idx_quant_trades_entry_time ON public.quant_trades(entry_time DESC);

-- 2. Table: bot_audit_logs (Live activity and circuit breaker logs)
CREATE TABLE IF NOT EXISTS public.bot_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT,
  log_type TEXT NOT NULL, -- 'entry', 'exit', 'info', 'blocked'
  symbol TEXT,
  timeframe TEXT,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_audit_logs_created ON public.bot_audit_logs(created_at DESC);

-- 3. Table: user_bot_configs (Persistent user settings and risk parameters)
CREATE TABLE IF NOT EXISTS public.user_bot_configs (
  account_id TEXT PRIMARY KEY,
  selected_timeframe TEXT NOT NULL DEFAULT 'dual',
  risk_pct NUMERIC NOT NULL DEFAULT 0.02,
  max_concurrent_positions INT NOT NULL DEFAULT 3,
  circuit_breaker_max_r NUMERIC NOT NULL DEFAULT 3.0,
  streak_throttle_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  auto_pilot_armed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.quant_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_bot_configs ENABLE ROW LEVEL SECURITY;

-- Allow anonymous reads & writes with the Supabase Anon key for demo trading
CREATE POLICY "Allow public read-write for demo bot trades"
  ON public.quant_trades
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public read-write for bot audit logs"
  ON public.bot_audit_logs
  FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow public read-write for user bot configs"
  ON public.user_bot_configs
  FOR ALL
  USING (true)
  WITH CHECK (true);
