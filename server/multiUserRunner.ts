import WebSocket from 'ws';
import {
  fetchOptionsAccounts,
  issueAccountOtpSocketUrl,
} from './derivClient.js';
import {
  listAllArmedDerivConnections,
  updateUserDerivConnectionConfig,
  type ArmedDerivConnection,
} from './platformStore.js';
import { logBotAudit, saveQuantTrade } from './supabaseClient.js';
import {
  evaluateQuantSignal,
  getSymbolStrategyProfile,
  type QuantTimeframe,
} from '../src/services/quantStrategyEngine';
import { normalizeCandleHistory, type CandlePoint } from '../src/services/chartFeed';

const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

const BASKET_15M = [
  { code: '1HZ100V', name: 'Vol 100 (1s)', market: 'synthetic_index', engine: '15m' as const },
  { code: 'R_75', name: 'Volatility 75', market: 'synthetic_index', engine: '15m' as const },
];

const BASKET_1H = [
  { code: 'cryBTCUSD', name: 'BTC/USD', market: 'cryptocurrency', engine: '1h' as const },
  { code: 'cryETHUSD', name: 'ETH/USD', market: 'cryptocurrency', engine: '1h' as const },
  { code: 'frxXAUUSD', name: 'Gold XAU/USD', market: 'commodities', engine: '1h' as const },
  { code: 'frxXAGUSD', name: 'Silver XAG/USD', market: 'commodities', engine: '1h' as const },
  { code: 'frxUSDCHF', name: 'USD/CHF', market: 'forex', engine: '1h' as const },
  { code: 'frxUSDJPY', name: 'USD/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPJPY', name: 'GBP/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxAUDJPY', name: 'AUD/JPY', market: 'forex', engine: '1h' as const },
  { code: 'frxEURUSD', name: 'EUR/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPUSD', name: 'GBP/USD', market: 'forex', engine: '1h' as const },
  { code: 'frxGBPAUD', name: 'GBP/AUD', market: 'forex', engine: '1h' as const },
];

interface SymbolMultiplierRule {
  supportsMultipliers: boolean;
  multiplierRange: number[];
  defaultMultiplier: number;
  minStake?: number;
  maxStake?: number;
}

function parseNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function sendWsRequest<T = any>(
  ws: WebSocket,
  payload: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`WebSocket timeout for ${Object.keys(payload)[0] ?? 'request'}`));
    }, timeoutMs);

    const onMsg = (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.req_id === reqId) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          if (msg.error) {
            reject(new Error(msg.error.message || msg.error.code || 'Deriv API error'));
          } else {
            resolve(msg as T);
          }
        }
      } catch {
        // Ignore malformed frames
      }
    };

    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...payload, req_id: reqId }));
  });
}

function extractMultiplierRule(symbol: string, payload: unknown): SymbolMultiplierRule {
  const available = Array.isArray((payload as any)?.contracts_for?.available)
    ? ((payload as any).contracts_for.available as any[])
    : [];
  const multContracts = available.filter(
    (c) => c?.contract_type === 'MULTUP' || c?.contract_type === 'MULTDOWN',
  );
  if (multContracts.length === 0) {
    return { supportsMultipliers: false, multiplierRange: [], defaultMultiplier: 0 };
  }
  const rangeSet = new Set<number>();
  let minStake: number | undefined;
  let maxStake: number | undefined;
  for (const c of multContracts) {
    if (Array.isArray(c.multiplier_range)) {
      for (const m of c.multiplier_range) {
        const n = parseNum(m);
        if (n && n > 0) rangeSet.add(n);
      }
    }
    const cMin = parseNum(c.min_contract_amount);
    const cMax = parseNum(c.max_contract_amount);
    if (cMin !== undefined) minStake = minStake === undefined ? cMin : Math.max(minStake, cMin);
    if (cMax !== undefined) maxStake = maxStake === undefined ? cMax : Math.min(maxStake, cMax);
  }
  let multiplierRange = Array.from(rangeSet).sort((a, b) => a - b);
  if (symbol === 'cryBTCUSD') multiplierRange = [50, 100, 150, 200, 300];
  else if (symbol === 'cryETHUSD') multiplierRange = [50, 75, 100, 150, 200];
  else if (symbol.startsWith('frx')) multiplierRange = [50, 100, 150, 250, 500];
  return {
    supportsMultipliers: true,
    multiplierRange,
    defaultMultiplier: multiplierRange[0] ?? 100,
    minStake,
    maxStake,
  };
}

export class MultiUserQuantManager {
  private readonly derivAppId: string;
  private scanTimer: NodeJS.Timeout | null = null;
  private publicWs: WebSocket | null = null;
  private last15mBoundary = -1;
  private last1hBoundary = -1;
  private readonly lastBarSignaled = new Map<string, number>();
  private scanning = false;

  constructor(derivAppId: string) {
    this.derivAppId = derivAppId;
  }

  start(): void {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      void this.tick();
    }, 20_000);
    console.log('[MultiUserQuant] Started shared WF-13 multi-user scanner.');
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.publicWs) {
      try {
        this.publicWs.close();
      } catch {
        // ignore
      }
      this.publicWs = null;
    }
  }

  private async ensurePublicWs(): Promise<WebSocket> {
    if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
      return this.publicWs;
    }
    if (this.publicWs) {
      try {
        this.publicWs.close();
      } catch {
        // ignore
      }
    }
    const ws = new WebSocket(PUBLIC_WS_URL);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Public WS connect timeout')), 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    this.publicWs = ws;
    return ws;
  }

  private async tick(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const armedConnections = await listAllArmedDerivConnections();
      if (armedConnections.length === 0) return;

      const nowSec = Math.floor(Date.now() / 1000);
      const boundary15m = Math.floor(nowSec / 900);
      const boundary1h = Math.floor(nowSec / 3600);

      const need15m = boundary15m !== this.last15mBoundary;
      const need1h = boundary1h !== this.last1hBoundary;
      if (!need15m && !need1h) return;

      const ws = await this.ensurePublicWs();
      const signals: Array<{
        symbol: string;
        market: string;
        timeframe: '15m' | '1h';
        direction: 'rise' | 'fall';
        multiplier: number;
        stopLoss?: number | null;
        takeProfit?: number | null;
        convictionWeight: number;
        entryPrice: number;
      }> = [];

      if (need15m) {
        this.last15mBoundary = boundary15m;
        for (const item of BASKET_15M) {
          const sig = await this.evaluateSymbol(ws, item.code, item.market, '15m', 900);
          if (sig) signals.push(sig);
          await new Promise((r) => setTimeout(r, 180));
        }
      }

      if (need1h) {
        this.last1hBoundary = boundary1h;
        for (const item of BASKET_1H) {
          const sig = await this.evaluateSymbol(ws, item.code, item.market, '1h', 3600);
          if (sig) signals.push(sig);
          await new Promise((r) => setTimeout(r, 180));
        }
      }

      if (signals.length === 0) return;

      for (const conn of armedConnections) {
        const tf = (conn.selected_timeframe || 'dual') as QuantTimeframe;
        const matching = signals.filter((s) => tf === 'dual' || tf === s.timeframe);
        for (const sig of matching) {
          await this.executeForUser(conn, sig);
        }
      }
    } catch (err) {
      console.warn('[MultiUserQuant] Tick error:', err instanceof Error ? err.message : err);
    } finally {
      this.scanning = false;
    }
  }

  private async evaluateSymbol(
    ws: WebSocket,
    symbol: string,
    market: string,
    timeframe: '15m' | '1h',
    granularity: number,
  ) {
    try {
      const [histRes, cfRes] = await Promise.all([
        sendWsRequest(ws, {
          ticks_history: symbol,
          adjust_start_time: 1,
          count: 350,
          end: 'latest',
          granularity,
          style: 'candles',
        }),
        sendWsRequest(ws, {
          contracts_for: symbol,
          currency: 'USD',
          product_type: 'multipliers',
        }),
      ]);

      const bars: CandlePoint[] = normalizeCandleHistory(histRes?.candles ?? []);
      if (bars.length < 220) return null;
      const evalIdx = bars.length - 2;
      const barTime = Number(bars[evalIdx].time);
      const key = `${symbol}:${timeframe}`;
      if (this.lastBarSignaled.get(key) === barTime) return null;

      const rule = extractMultiplierRule(symbol, cfRes);
      if (!rule.supportsMultipliers) return null;

      const sig = evaluateQuantSignal({
        symbol,
        market,
        bars,
        accountBalance: 1000,
        positions: [],
        timeframe,
        riskPctOfBalance: 0.03,
      });
      if (sig.signalDirection === 'rise' || sig.signalDirection === 'fall') {
        this.lastBarSignaled.set(key, barTime);
        const profile = getSymbolStrategyProfile(symbol);
        const mult = rule.multiplierRange.includes(sig.riskPlan.recommendedMultiplier)
          ? sig.riskPlan.recommendedMultiplier
          : rule.defaultMultiplier;
        return {
          symbol,
          market,
          timeframe,
          direction: sig.signalDirection,
          multiplier: mult,
          stopLoss: sig.riskPlan.recommendedStopLoss ?? null,
          takeProfit: sig.riskPlan.recommendedTakeProfit ?? null,
          convictionWeight: profile.convictionWeight,
          entryPrice: bars[evalIdx].close,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async executeForUser(
    conn: ArmedDerivConnection,
    sig: {
      symbol: string;
      market: string;
      timeframe: '15m' | '1h';
      direction: 'rise' | 'fall';
      multiplier: number;
      convictionWeight: number;
      entryPrice: number;
    },
  ): Promise<void> {
    let userWs: WebSocket | null = null;
    try {
      const accounts = await fetchOptionsAccounts(conn.deriv_token, this.derivAppId);
      const acct = accounts.find((a) => a.account_id === conn.deriv_account_id);
      const liveBalance = acct?.balance ?? conn.balance;
      if (acct && Math.abs(acct.balance - conn.balance) > 0.01) {
        await updateUserDerivConnectionConfig({
          userId: conn.user_id,
          derivAccountId: conn.deriv_account_id,
          balance: acct.balance,
        });
      }
      if (liveBalance < 2) return;

      const effectiveRisk = Math.min(0.05, conn.risk_pct * sig.convictionWeight);
      const stake = Math.max(1, Number((liveBalance * effectiveRisk).toFixed(2)));
      if (stake > liveBalance) return;

      const otpUrl = await issueAccountOtpSocketUrl(
        conn.deriv_token,
        conn.deriv_account_id,
        this.derivAppId,
      );
      userWs = new WebSocket(otpUrl);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('User OTP WS timeout')), 10_000);
        userWs!.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        userWs!.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });

      const portfolioRes = await sendWsRequest(userWs, { portfolio: 1 });
      const openContracts = Array.isArray(portfolioRes?.portfolio?.contracts)
        ? portfolioRes.portfolio.contracts
        : [];
      if (openContracts.length >= 8) return;
      if (openContracts.some((c: any) => c?.underlying_symbol === sig.symbol || c?.symbol === sig.symbol)) {
        return;
      }

      const contractType = sig.direction === 'rise' ? 'MULTUP' : 'MULTDOWN';
      const propRes = await sendWsRequest(userWs, {
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: contractType,
        currency: conn.currency || 'USD',
        underlying_symbol: sig.symbol,
        multiplier: sig.multiplier,
      });

      const proposalId = propRes?.proposal?.id;
      if (!proposalId) return;

      const buyRes = await sendWsRequest(userWs, {
        buy: proposalId,
        price: stake,
      });

      const contractId = Number(buyRes?.buy?.contract_id);
      if (!Number.isFinite(contractId)) return;

      await saveQuantTrade({
        contract_id: contractId,
        user_id: conn.user_id,
        account_id: conn.deriv_account_id,
        account_type: conn.account_type,
        symbol: sig.symbol,
        market: sig.market,
        timeframe: sig.timeframe,
        engine: sig.timeframe === '15m' ? '15M Turbo' : '1H Macro',
        direction: sig.direction,
        multiplier: sig.multiplier,
        stake,
        currency: conn.currency || 'USD',
        entry_price: sig.entryPrice,
        status: 'open',
      });

      await logBotAudit({
        account_id: conn.deriv_account_id,
        log_type: 'entry',
        symbol: sig.symbol,
        timeframe: sig.timeframe,
        message: `[MultiUser ${conn.deriv_account_id}] Opened ${sig.direction.toUpperCase()} ${sig.symbol} ${sig.multiplier}x ($${stake.toFixed(2)})`,
      });
    } catch (err) {
      console.warn(
        `[MultiUserQuant] Trade failed for ${conn.deriv_account_id}:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      if (userWs) {
        try {
          userWs.close();
        } catch {
          // ignore
        }
      }
    }
  }
}
