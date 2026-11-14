import WebSocket from 'ws';
import {
  fetchOptionsAccounts,
  issueAccountOtpSocketUrl,
} from './derivClient.js';
import {
  getBotConfig,
  getRecentAuditLogs,
  logBotAudit,
  saveBotConfig,
  saveQuantTrade,
} from './supabaseClient.js';
import {
  evaluateQuantSignal,
  getRatchetFloorForPeakR,
  type QuantTimeframe,
} from '../src/services/quantStrategyEngine';
import { normalizeCandleHistory, type CandlePoint } from '../src/services/chartFeed';
import {
  normalizeOpenContract,
  normalizePortfolioContract,
  normalizeProfitTableTransaction,
  type PortfolioContractWire,
  type ProfitTableTransactionWire,
} from '../src/services/positionNormalizer';
import type {
  BuyWire,
  NormalizedPosition,
  ProposalOpenContractWire,
  ProposalWire,
} from '../src/types/deriv';

const BASKET_15M = [
  { code: '1HZ100V', name: 'Vol 100 (1s)', market: 'synthetic_index', engine: '15m' as const },
  { code: 'R_75', name: 'Volatility 75', market: 'synthetic_index', engine: '15m' as const },
];

const BASKET_1H = [
  { code: 'cryBTCUSD', name: 'BTC/USD', market: 'cryptocurrency', engine: '1h' as const },
  { code: 'cryETHUSD', name: 'ETH/USD', market: 'cryptocurrency', engine: '1h' as const },
  { code: 'frxXAUUSD', name: 'Gold XAU/USD', market: 'commodities', engine: '1h' as const },
  { code: 'frxXAGUSD', name: 'Silver XAG/USD', market: 'commodities', engine: '1h' as const },
  { code: 'frxUSDJPY', name: 'USD/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxAUDJPY', name: 'AUD/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxEURUSD', name: 'EUR/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxUSDCAD', name: 'USD/CAD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPJPY', name: 'GBP/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxUSDCHF', name: 'USD/CHF', market: 'forex', engine: '1h' as const },
  { code: 'frxAUDUSD', name: 'AUD/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPUSD', name: 'GBP/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPAUD', name: 'GBP/AUD', market: 'forex', engine: '1h' as const },
];

interface SymbolMultiplierRule {
  supportsMultipliers: boolean;
  multiplierRange: number[];
  defaultMultiplier: number;
  minStake?: number;
  maxStake?: number;
  fetchedAtMs: number;
}

export interface ServerAuditEntry {
  id: string;
  time: string;
  type: 'info' | 'entry' | 'exit' | 'blocked';
  message: string;
}

export interface ServerRunnerStatus {
  available: boolean;
  armed: boolean;
  running: boolean;
  socketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  accountId: string | null;
  accountType: 'demo' | 'real' | null;
  balance: number;
  currency: string;
  timeframe: QuantTimeframe;
  riskPct: number;
  lastScanAt: string | null;
  lastError: string | null;
  openPositionsCount: number;
  recentLogs: ServerAuditEntry[];
}

function parseFinite(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function pickClosestMultiplier(
  supported: number[],
  preferred: number,
  fallback: number,
): number {
  if (supported.length === 0) return fallback;
  if (supported.includes(preferred)) return preferred;
  const sorted = [...supported].sort((a, b) => a - b);
  const ge = sorted.find((m) => m >= preferred);
  return ge ?? sorted[0] ?? fallback;
}

export class QuantServerRunner {
  private readonly derivPat: string;
  private readonly derivAppId: string;

  private ws: WebSocket | null = null;
  private reqId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (msg: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private socketStatus: ServerRunnerStatus['socketStatus'] = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private scanInFlight = false;
  private disposed = false;

  private accountId: string | null = null;
  private accountType: 'demo' | 'real' | null = null;
  private balance = 0;
  private currency = 'USD';

  private armed = false;
  private timeframe: QuantTimeframe = 'dual';
  private riskPct = 0.03;
  private lastScanAt: string | null = null;
  private lastError: string | null = null;

  private readonly lastScannedBarByEngine: Record<'15m' | '1h' | '5m', number> = {
    '15m': 0,
    '1h': 0,
    '5m': 0,
  };
  private readonly rulesCache = new Map<string, SymbolMultiplierRule>();
  private readonly peakRByContract = new Map<number, number>();
  private readonly armedStageByContract = new Map<number, number>();
  private readonly sellingContracts = new Set<number>();
  private openPositionsCount = 0;
  private readonly recentLogs: ServerAuditEntry[] = [];

  constructor(opts: { derivPat: string; derivAppId: string }) {
    this.derivPat = opts.derivPat.trim();
    this.derivAppId = opts.derivAppId.trim();
  }

  isAvailable(): boolean {
    return Boolean(this.derivPat && this.derivAppId);
  }

  private pushLog(
    type: ServerAuditEntry['type'],
    message: string,
    extra?: { symbol?: string; timeframe?: string; persist?: boolean },
  ): void {
    const entry: ServerAuditEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      time: new Date().toLocaleTimeString(),
      type,
      message,
    };
    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > 30) {
      this.recentLogs.length = 30;
    }

    if (extra?.persist !== false) {
      void logBotAudit({
        account_id: this.accountId ?? 'demo',
        log_type: type,
        symbol: extra?.symbol,
        timeframe: extra?.timeframe ?? this.timeframe,
        message,
      }).catch(() => {});
    }
  }

  async init(): Promise<void> {
    if (!this.isAvailable() || this.disposed) return;

    try {
      await this.resolveDemoAccount();
      if (!this.accountId) return;

      // Hydrate persistent state from Supabase
      const [cfg, dbLogs] = await Promise.all([
        getBotConfig(this.accountId),
        getRecentAuditLogs(this.accountId, 20),
      ]);

      if (Array.isArray(dbLogs) && dbLogs.length > 0 && this.recentLogs.length === 0) {
        for (const row of dbLogs as Array<{
          id?: number | string;
          created_at?: string;
          log_type?: string;
          message?: string;
        }>) {
          const logType =
            row.log_type === 'entry' ||
            row.log_type === 'exit' ||
            row.log_type === 'blocked'
              ? row.log_type
              : 'info';
          this.recentLogs.push({
            id: String(row.id ?? Math.random()),
            time: row.created_at
              ? new Date(row.created_at).toLocaleTimeString()
              : new Date().toLocaleTimeString(),
            type: logType,
            message: String(row.message ?? ''),
          });
        }
      }

      if (cfg) {
        const tf = cfg.selected_timeframe;
        if (tf === 'dual' || tf === '15m' || tf === '1h' || tf === '5m') {
          this.timeframe = tf;
        }
        const rp = Number(cfg.risk_pct);
        if (Number.isFinite(rp) && rp >= 0.0025 && rp <= 0.05) {
          this.riskPct = rp;
        }
        this.armed = Boolean(cfg.auto_pilot_armed);
      } else if (process.env.AUTO_PILOT_DEFAULT_ARMED !== 'false') {
        this.armed = true;
        await saveBotConfig({
          account_id: this.accountId,
          selected_timeframe: this.timeframe,
          risk_pct: this.riskPct,
          auto_pilot_armed: true,
        }).catch(() => {});
      }

      if (this.armed) {
        this.pushLog(
          'info',
          `24/7 Server Auto-Pilot ${cfg ? 'resumed' : 'auto-armed on startup'} (${this.timeframe.toUpperCase()} · ${(this.riskPct * 100).toFixed(2)}% risk) on ${this.accountId}.`,
        );
        await this.startLoop();
        void this.runCycle(true);
      }
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : 'Failed to initialize server runner.';
      console.warn('[QuantRunner] Init error:', this.lastError);
    }
  }

  private async resolveDemoAccount(): Promise<void> {
    const accounts = await fetchOptionsAccounts(this.derivPat, this.derivAppId);
    const demo =
      accounts.find((a) => a.account_type === 'demo' && a.status === 'active') ??
      accounts.find((a) => a.account_type === 'demo') ??
      null;

    if (!demo) {
      this.lastError = 'No active Demo account found for DERIV_PAT.';
      return;
    }

    this.accountId = demo.account_id;
    this.accountType = demo.account_type;
    this.balance = demo.balance;
    this.currency = demo.currency || 'USD';
    this.lastError = null;
  }

  getStatus(): ServerRunnerStatus {
    return {
      available: this.isAvailable(),
      armed: this.armed,
      running: this.armed && this.schedulerTimer !== null,
      socketStatus: this.socketStatus,
      accountId: this.accountId,
      accountType: this.accountType,
      balance: this.balance,
      currency: this.currency,
      timeframe: this.timeframe,
      riskPct: this.riskPct,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      openPositionsCount: this.openPositionsCount,
      recentLogs: [...this.recentLogs],
    };
  }

  async setArmed(params: {
    armed: boolean;
    timeframe?: QuantTimeframe;
    riskPct?: number;
  }): Promise<ServerRunnerStatus> {
    if (!this.isAvailable()) {
      throw new Error('Server runner unavailable (DERIV_PAT or DERIV_APP_ID missing).');
    }

    if (!this.accountId) {
      await this.resolveDemoAccount();
    }
    if (!this.accountId) {
      throw new Error('No active Demo trading account available.');
    }

    if (params.timeframe) {
      this.timeframe = params.timeframe;
    }
    if (
      typeof params.riskPct === 'number' &&
      Number.isFinite(params.riskPct) &&
      params.riskPct >= 0.0025 &&
      params.riskPct <= 0.05
    ) {
      this.riskPct = params.riskPct;
    }

    const wasArmed = this.armed;
    this.armed = params.armed;

    await saveBotConfig({
      account_id: this.accountId,
      selected_timeframe: this.timeframe,
      risk_pct: this.riskPct,
      auto_pilot_armed: this.armed,
    });

    if (this.armed) {
      this.pushLog(
        'info',
        `24/7 Server Auto-Pilot ARMED on ${this.accountId} (${this.timeframe.toUpperCase()} · ${(this.riskPct * 100).toFixed(2)}% risk).`,
      );
      await this.startLoop();
      void this.runCycle(true);
    } else {
      if (wasArmed) {
        this.pushLog('info', '24/7 Server Auto-Pilot DISARMED by user.');
      }
      this.stopLoop();
    }

    return this.getStatus();
  }

  async triggerScanNow(): Promise<ServerRunnerStatus> {
    if (!this.isAvailable()) return this.getStatus();
    if (!this.accountId) {
      await this.resolveDemoAccount();
    }
    await this.ensureSocketConnected();
    await this.runCycle(true);
    return this.getStatus();
  }

  private async startLoop(): Promise<void> {
    if (this.disposed) return;
    await this.ensureSocketConnected().catch(() => {});

    if (!this.schedulerTimer) {
      this.schedulerTimer = setInterval(() => {
        if (this.armed && !this.disposed) {
          void this.runCycle(false);
        }
      }, 15_000);
    }
  }

  private stopLoop(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
  }

  dispose(): void {
    this.disposed = true;
    this.armed = false;
    this.stopLoop();
  }

  private closeSocket(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(new Error('Socket closed.'));
      this.pending.delete(id);
    }
    this.socketStatus = 'disconnected';
  }

  private async ensureSocketConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.socketStatus === 'connecting') {
      return;
    }
    if (!this.accountId) {
      await this.resolveDemoAccount();
    }
    if (!this.accountId) {
      throw new Error('Cannot connect server socket without Demo account.');
    }

    this.closeSocket();
    this.socketStatus = 'connecting';

    const otpUrl = await issueAccountOtpSocketUrl(
      this.derivPat,
      this.accountId,
      this.derivAppId,
    );

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(otpUrl);
      this.ws = socket;

      const connectTimeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('Server WebSocket connection timed out.'));
      }, 12_000);

      socket.on('open', () => {
        clearTimeout(connectTimeout);
        this.socketStatus = 'connected';
        this.reconnectAttempt = 0;
        this.lastError = null;

        this.heartbeatTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            void this.request({ ping: 1 }, 8_000).catch(() => {});
          }
        }, 25_000);

        // Subscribe to open contract updates so TP/SL/KO closes log automatically
        this.ws?.send(
          JSON.stringify({
            proposal_open_contract: 1,
            subscribe: 1,
            req_id: this.reqId++,
          }),
        );
        resolve();
      });

      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>;
          const rid = typeof msg.req_id === 'number' ? msg.req_id : null;
          if (rid !== null && this.pending.has(rid)) {
            const p = this.pending.get(rid)!;
            clearTimeout(p.timer);
            this.pending.delete(rid);
            if (msg.error && typeof msg.error === 'object') {
              const errObj = msg.error as { message?: string; code?: string };
              p.reject(
                new Error(errObj.message || errObj.code || 'Deriv API error.'),
              );
            } else {
              p.resolve(msg);
            }
            return;
          }

          if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
            const wire = msg.proposal_open_contract as ProposalOpenContractWire;
            const norm = normalizeOpenContract(wire);
            if (norm && norm.isSold) {
              this.peakRByContract.delete(norm.contractId);
              this.armedStageByContract.delete(norm.contractId);
              this.sellingContracts.delete(norm.contractId);

              void saveQuantTrade({
                contract_id: norm.contractId,
                account_id: this.accountId ?? 'demo',
                account_type: 'demo',
                symbol: norm.underlyingSymbol,
                timeframe: this.timeframe,
                engine:
                  norm.underlyingSymbol.startsWith('1HZ') ||
                  norm.underlyingSymbol.startsWith('R_')
                    ? '15M Turbo'
                    : '1H Macro',
                direction: norm.contractType === 'MULTUP' ? 'rise' : 'fall',
                multiplier: norm.multiplier || 40,
                stake: norm.buyPrice,
                entry_price: norm.entrySpot ?? undefined,
                exit_price: (norm.exitSpot ?? norm.currentSpot) ?? undefined,
                profit_loss: norm.profit,
                r_multiple:
                  norm.buyPrice > 0
                    ? Number((norm.profit / norm.buyPrice).toFixed(2))
                    : 0,
                status: norm.status,
                exit_reason: norm.status,
              }).catch(() => {});

              this.pushLog(
                'exit',
                `Position closed on ${norm.underlyingSymbol} (#${norm.contractId}): ${norm.profit >= 0 ? '+' : ''}${norm.profit.toFixed(2)} ${this.currency} (${norm.status.toUpperCase()}).`,
                { symbol: norm.underlyingSymbol },
              );
            } else if (norm && !norm.isSold) {
              void this.checkAndExecuteProfitRatchet(norm);
            }
          }
        } catch {
          // ignore malformed WS frames
        }
      });

      socket.on('error', (err) => {
        clearTimeout(connectTimeout);
        this.lastError = err.message || 'Server WebSocket error.';
        this.socketStatus = 'error';
      });

      socket.on('close', () => {
        clearTimeout(connectTimeout);
        this.closeSocket();
        if (this.armed && !this.disposed) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.armed || this.reconnectTimer) return;
    const delayMs = Math.min(
      30_000,
      1_500 * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.armed && !this.disposed) {
        void this.ensureSocketConnected().catch((err) => {
          this.lastError =
            err instanceof Error ? err.message : 'Reconnect attempt failed.';
          this.scheduleReconnect();
        });
      }
    }, delayMs);
  }

  private request<T extends Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Server WebSocket is not open.'));
        return;
      }
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout for ${Object.keys(payload).join(',')}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (msg: Record<string, unknown>) => void,
        reject,
        timer,
      });

      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  private async getSymbolMultiplierRules(
    symbol: string,
  ): Promise<SymbolMultiplierRule> {
    const cached = this.rulesCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAtMs < 3600_000) {
      return cached;
    }

    const res = await this.request<{
      contracts_for?: { available?: Array<Record<string, unknown>> };
    }>({ contracts_for: symbol });

    const available = res.contracts_for?.available ?? [];
    const multEntries = available.filter(
      (c) => c.contract_type === 'MULTUP' || c.contract_type === 'MULTDOWN',
    );

    const multSet = new Set<number>();
    let minStake: number | undefined;
    let maxStake: number | undefined;

    for (const entry of multEntries) {
      const range = entry.multiplier_range;
      if (Array.isArray(range)) {
        for (const v of range) {
          const n = parseFinite(v);
          if (n !== undefined && n > 0) multSet.add(n);
        }
      }
      const mn = parseFinite(entry.min_stake);
      const mx = parseFinite(entry.max_stake);
      if (mn !== undefined) {
        minStake = minStake === undefined ? mn : Math.max(minStake, mn);
      }
      if (mx !== undefined) {
        maxStake = maxStake === undefined ? mx : Math.min(maxStake, mx);
      }
    }

    const sortedMults = Array.from(multSet).sort((a, b) => a - b);
    const rule: SymbolMultiplierRule = {
      supportsMultipliers: multEntries.length > 0 && sortedMults.length > 0,
      multiplierRange: sortedMults,
      defaultMultiplier: sortedMults[0] ?? 100,
      minStake,
      maxStake,
      fetchedAtMs: Date.now(),
    };
    this.rulesCache.set(symbol, rule);
    return rule;
  }

  private async fetchPositionsSnapshot(): Promise<NormalizedPosition[]> {
    const [portRes, ptRes] = await Promise.all([
      this.request<{ portfolio?: { contracts?: PortfolioContractWire[] } }>({
        portfolio: 1,
      }).catch(() => ({ portfolio: { contracts: [] } })),
      this.request<{ profit_table?: { transactions?: ProfitTableTransactionWire[] } }>(
        { profit_table: 1, description: 1, limit: 50 },
      ).catch(() => ({ profit_table: { transactions: [] } })),
    ]);

    const byId = new Map<number, NormalizedPosition>();
    for (const raw of portRes.portfolio?.contracts ?? []) {
      const norm = normalizePortfolioContract(raw);
      if (norm) byId.set(norm.contractId, norm);
    }
    for (const raw of ptRes.profit_table?.transactions ?? []) {
      const norm = normalizeProfitTableTransaction(raw);
      if (norm && !byId.has(norm.contractId)) {
        byId.set(norm.contractId, norm);
      }
    }

    const list = Array.from(byId.values()).sort(
      (a, b) => b.purchaseTime - a.purchaseTime,
    );
    this.openPositionsCount = list.filter((p) => !p.isSold).length;
    return list;
  }

  private async checkAndExecuteProfitRatchet(
    norm: NormalizedPosition,
  ): Promise<boolean> {
    if (norm.isSold || norm.buyPrice <= 0) {
      this.peakRByContract.delete(norm.contractId);
      this.armedStageByContract.delete(norm.contractId);
      this.sellingContracts.delete(norm.contractId);
      return false;
    }

    const currentR = norm.profit / norm.buyPrice;
    const prevPeak = this.peakRByContract.get(norm.contractId) ?? currentR;
    const peakR = Math.max(prevPeak, currentR);
    this.peakRByContract.set(norm.contractId, peakR);

    const engine: QuantTimeframe =
      norm.underlyingSymbol.startsWith('1HZ') ||
      norm.underlyingSymbol.startsWith('R_')
        ? '15m'
        : '1h';

    const ratchet = getRatchetFloorForPeakR(
      norm.underlyingSymbol,
      engine,
      peakR,
    );
    if (!ratchet) return false;

    const prevStage = this.armedStageByContract.get(norm.contractId) ?? 0;
    if (ratchet.stage > prevStage) {
      this.armedStageByContract.set(norm.contractId, ratchet.stage);
      this.pushLog(
        'info',
        `Profit-Ratchet Stage ${ratchet.stage} ARMED on ${norm.underlyingSymbol} (#${norm.contractId}): floating peak +${(peakR * 100).toFixed(1)}% reached -> locked +${(ratchet.floorR * 100).toFixed(0)}% profit floor.`,
        { symbol: norm.underlyingSymbol, timeframe: engine },
      );
    }

    if (
      currentR <= ratchet.floorR &&
      !this.sellingContracts.has(norm.contractId)
    ) {
      this.sellingContracts.add(norm.contractId);
      try {
        await this.request({ sell: norm.contractId, price: 0 }, 10_000);
        this.pushLog(
          'exit',
          `Server Profit-Ratchet Exit on ${norm.underlyingSymbol} (#${norm.contractId}): locked +${(ratchet.floorR * 100).toFixed(0)}% floor triggered at ${(currentR * 100).toFixed(1)}% after +${(peakR * 100).toFixed(1)}% peak.`,
          { symbol: norm.underlyingSymbol, timeframe: engine },
        );
        return true;
      } catch {
        this.sellingContracts.delete(norm.contractId);
      }
    }

    return false;
  }

  private async runCycle(forceScan: boolean): Promise<void> {
    if (this.scanInFlight || this.disposed) return;
    this.scanInFlight = true;

    try {
      await this.ensureSocketConnected();
      await this.resolveDemoAccount().catch(() => {});

      const nowSec = Math.floor(Date.now() / 1000);
      const enginesToCheck: Array<{
        engine: '15m' | '1h' | '5m';
        granularity: number;
        basket: Array<{
          code: string;
          name: string;
          market: string;
          engine: '15m' | '1h';
        }>;
      }> = [];

      if (this.timeframe === 'dual' || this.timeframe === '15m') {
        enginesToCheck.push({
          engine: '15m',
          granularity: 900,
          basket: BASKET_15M,
        });
      }
      if (this.timeframe === 'dual' || this.timeframe === '1h') {
        enginesToCheck.push({
          engine: '1h',
          granularity: 3600,
          basket: BASKET_1H,
        });
      }
      if (this.timeframe === '5m') {
        enginesToCheck.push({
          engine: '5m',
          granularity: 300,
          basket: BASKET_15M,
        });
      }

      const positions = await this.fetchPositionsSnapshot();

      // Always check live Profit-Ratchet on open positions every 15s (even between candle closes)
      for (const openPos of positions.filter((p) => !p.isSold)) {
        await this.checkAndExecuteProfitRatchet(openPos);
      }

      for (const group of enginesToCheck) {
        const latestCompletedBarEpoch =
          Math.floor(nowSec / group.granularity) * group.granularity -
          group.granularity;

        if (
          !forceScan &&
          latestCompletedBarEpoch <= this.lastScannedBarByEngine[group.engine]
        ) {
          continue;
        }

        const summaries: string[] = [];
        let tradeExecuted = false;

        for (const item of group.basket) {
          try {
            const rule = await this.getSymbolMultiplierRules(item.code);
            if (!rule.supportsMultipliers) {
              summaries.push(`${item.code}: no mult`);
              continue;
            }

            const candleRes = await this.request<{
              candles?: Array<Record<string, unknown>>;
            }>({
              ticks_history: item.code,
              style: 'candles',
              granularity: group.granularity,
              count: 350,
              end: 'latest',
            });

            const bars: CandlePoint[] = normalizeCandleHistory(candleRes.candles);
            const ev = evaluateQuantSignal({
              symbol: item.code,
              market: item.market,
              bars,
              accountBalance: this.balance,
              positions,
              stakeLimits: { min: rule.minStake, max: rule.maxStake },
              riskPctOfBalance: this.riskPct,
              timeframe: group.engine,
              peakRByContract: this.peakRByContract,
            });

            // 1. Check automated exit first
            if (
              ev.exitSignalForOpenPosition.shouldExit &&
              ev.exitSignalForOpenPosition.contractId !== null
            ) {
              const cid = ev.exitSignalForOpenPosition.contractId;
              await this.request({ sell: cid, price: 0 }, 10_000);
              this.pushLog(
                'exit',
                `Server Auto-Exit on ${item.code} (#${cid}): ${ev.exitSignalForOpenPosition.reason}`,
                { symbol: item.code, timeframe: group.engine },
              );
            }

            // 2. Check automated entry
            const alreadyOpenOnSymbol = positions.some(
              (p) => !p.isSold && p.underlyingSymbol === item.code,
            );
            const openTotal = positions.filter((p) => !p.isSold).length;

            if (
              !tradeExecuted &&
              ev.signalDirection &&
              !ev.riskPlan.circuitBreakerTripped &&
              !alreadyOpenOnSymbol &&
              openTotal < 6
            ) {
              const chosenMultiplier = pickClosestMultiplier(
                rule.multiplierRange,
                ev.riskPlan.recommendedMultiplier,
                rule.defaultMultiplier,
              );
              const stake = ev.riskPlan.recommendedStake;
              const tp = ev.riskPlan.recommendedTakeProfit;
              const sl =
                ev.riskPlan.recommendedStopLoss !== null &&
                ev.riskPlan.recommendedStopLoss < stake
                  ? ev.riskPlan.recommendedStopLoss
                  : null;

              const limitOrder: { take_profit?: number; stop_loss?: number } = {};
              if (tp && tp > 0) limitOrder.take_profit = Number(tp.toFixed(2));
              if (sl && sl > 0) limitOrder.stop_loss = Number(sl.toFixed(2));

              const proposalPayload: Record<string, unknown> = {
                proposal: 1,
                amount: stake,
                basis: 'stake',
                contract_type:
                  ev.signalDirection === 'rise' ? 'MULTUP' : 'MULTDOWN',
                currency: this.currency,
                multiplier: chosenMultiplier,
                underlying_symbol: item.code,
              };
              if (Object.keys(limitOrder).length > 0) {
                proposalPayload.limit_order = limitOrder;
              }

              const propRes = await this.request<{ proposal?: ProposalWire }>(
                proposalPayload,
                10_000,
              );
              const prop = propRes.proposal;
              if (!prop || typeof prop.id !== 'string') {
                throw new Error(`No proposal returned for ${item.code}`);
              }

              const ask = Number(prop.ask_price);
              const buyRes = await this.request<{ buy?: BuyWire }>(
                { buy: prop.id, price: ask },
                12_000,
              );

              if (buyRes.buy) {
                tradeExecuted = true;
                this.openPositionsCount = openTotal + 1;
                await saveQuantTrade({
                  contract_id: buyRes.buy.contract_id,
                  account_id: this.accountId ?? 'demo',
                  account_type: 'demo',
                  symbol: item.code,
                  market: item.market,
                  timeframe: group.engine,
                  engine: group.engine === '15m' ? '15M Turbo' : '1H Macro',
                  direction: ev.signalDirection,
                  multiplier: chosenMultiplier,
                  stake: ask,
                  currency: this.currency,
                  entry_price: Number(prop.spot),
                  take_profit: limitOrder.take_profit ?? null,
                  stop_loss: limitOrder.stop_loss ?? null,
                  status: 'open',
                });

                this.pushLog(
                  'entry',
                  `24/7 Server Executed ${ev.signalDirection === 'rise' ? 'MULTUP' : 'MULTDOWN'} ${chosenMultiplier}x on ${item.code} (#${buyRes.buy.contract_id}) @ ${ask.toFixed(2)} ${this.currency} — ${ev.signalHeadline}`,
                  { symbol: item.code, timeframe: group.engine },
                );
              }
            } else if (ev.signalDirection && ev.riskPlan.circuitBreakerTripped) {
              summaries.push(`${item.code}: CB (${ev.riskPlan.circuitBreakerReason})`);
            } else {
              const adxText = ev.indicators
                ? `ADX ${ev.indicators.adx14.toFixed(1)}`
                : 'warmup';
              summaries.push(`${item.code}: ${ev.regime.split('_')[0]} (${adxText})`);
            }
          } catch (symErr) {
            const msg = symErr instanceof Error ? symErr.message : 'scan error';
            summaries.push(`${item.code}: err(${msg})`);
          }
          await new Promise((r) => setTimeout(r, 180));
        }

        this.lastScannedBarByEngine[group.engine] = latestCompletedBarEpoch;
        this.lastScanAt = new Date().toISOString();

        if (!tradeExecuted) {
          this.pushLog(
            'info',
            `[${group.engine.toUpperCase()} Scan] Checked ${group.basket.length} markets: 0 entries | ${summaries.join(' · ')}`,
            { timeframe: group.engine },
          );
        }
      }
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : 'Auto-Pilot cycle failed.';
      this.pushLog('blocked', `Server scan error: ${this.lastError}`);
    } finally {
      this.scanInFlight = false;
    }
  }
}
