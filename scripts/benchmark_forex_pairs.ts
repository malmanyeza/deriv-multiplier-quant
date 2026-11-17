import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import {
  computeADXandATR,
  computeEMA,
  computeRSI,
} from '../src/services/quantStrategyEngine.ts';
import { normalizeCandleHistory, type CandlePoint } from '../src/services/chartFeed.ts';

const CACHE_DIR =
  '/Users/admin/.gemini/antigravity/brain/501f9276-302b-4acf-baa0-10bff49b8dbe/scratch/data_cache';

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PublicDerivClient {
  private ws!: WebSocket;
  private reqId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const id = msg.req_id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        this.pending.delete(id);
        if (msg.error) p.reject(new Error(msg.error.message || 'API error'));
        else p.resolve(msg);
      }
    });
  }

  request<T = any>(payload: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout on ${Object.keys(payload).join(',')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function fetchOrLoad1Y(
  client: PublicDerivClient,
  symbol: string,
  granularity: number,
  maxPages = 10,
): Promise<CandlePoint[]> {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `deriv_1y_${symbol}_${granularity}.json`);
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.length > 4000) return cached;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const startCutoff = nowSec - 365 * 86400 - 250 * granularity;
  const byEpoch = new Map<number, CandlePoint>();
  let endCursor: number | 'latest' = 'latest';
  let minSeen = Infinity;

  for (let p = 0; p < maxPages; p++) {
    await sleep(350);
    let batch: CandlePoint[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity,
          count: 1000,
          end: endCursor,
        });
        batch = normalizeCandleHistory(res.candles);
        break;
      } catch {
        await sleep(1500 * attempt);
      }
    }
    if (batch.length === 0) break;
    const oldest = Number(batch[0].time);
    if (minSeen < Infinity && oldest >= minSeen) break;
    for (const c of batch) {
      const t = Number(c.time);
      byEpoch.set(t, c);
      if (t < minSeen) minSeen = t;
    }
    if (minSeen <= startCutoff || batch.length < 20) break;
    endCursor = oldest - 1;
  }

  const sorted = Array.from(byEpoch.values()).sort(
    (a, b) => Number(a.time) - Number(b.time),
  );
  fs.writeFileSync(cacheFile, JSON.stringify(sorted));
  return sorted;
}

interface SimTrade {
  symbol: string;
  engine: '1h' | '15m';
  mode: 'trend' | 'mr';
  direction: 'rise' | 'fall';
  entryTime: number;
  exitTime: number;
  pnlR: number;
  exitReason: string;
}

function simulateFxSymbol(params: {
  symbol: string;
  bars: CandlePoint[];
  M: number;
  commFrac: number;
  evalStartEpoch: number;
  lookback: number;
  trendAdxMin: number;
  atrCutoff: number;
  trailEmaPeriod: number;
  pureTrend: boolean;
  tpR: number | null;
  ratchet: Array<[number, number]>;
  sessionFilter?: boolean;
}): SimTrade[] {
  const {
    symbol,
    bars,
    M,
    commFrac,
    evalStartEpoch,
    lookback,
    trendAdxMin,
    atrCutoff,
    trailEmaPeriod,
    pureTrend,
    tpR,
    ratchet,
    sessionFilter = false,
  } = params;
  if (bars.length < 225) return [];

  const closes = bars.map((b) => b.close);
  const ema30 = computeEMA(closes, 30);
  const emaTrail = computeEMA(closes, trailEmaPeriod);
  const ema100 = computeEMA(closes, 100);
  const ema200 = computeEMA(closes, 200);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const trades: SimTrade[] = [];
  let i = 220;
  while (i < bars.length - 2) {
    const tSec = Number(bars[i].time);
    if (tSec < evalStartEpoch) {
      i++;
      continue;
    }

    if (sessionFilter) {
      const hr = new Date(tSec * 1000).getUTCHours();
      if (hr < 6 || hr > 18) {
        i++;
        continue;
      }
    }

    const b = bars[i];
    const atrPct = b.close > 0 ? atr[i] / b.close : 0;
    if (atrPct > atrCutoff) {
      i++;
      continue;
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - lookback; k < i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }

    let dir: 1 | -1 | 0 = 0;
    let mode: 'trend' | 'mr' = 'trend';
    let curTpR: number | null = tpR;

    if (adx[i] >= trendAdxMin) {
      if (b.close > hi && b.close > ema100[i] && ema30[i] > ema100[i] && b.close > ema200[i]) {
        dir = 1;
        mode = 'trend';
      } else if (
        b.close < lo &&
        b.close < ema100[i] &&
        ema30[i] < ema100[i] &&
        b.close < ema200[i]
      ) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!pureTrend && adx[i] <= 20) {
      const prevRsi = rsi[i - 1] ?? rsi[i];
      if (prevRsi < 27 && rsi[i] >= 27 && b.close > b.open) {
        dir = 1;
        mode = 'mr';
        curTpR = 1.2;
      } else if (prevRsi > 73 && rsi[i] <= 73 && b.close < b.open) {
        dir = -1;
        mode = 'mr';
        curTpR = 1.2;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = Number(bars[i + 1].time);
    const getPriceForR = (rTarget: number) => {
      const movePct = (rTarget + commFrac) / M;
      return dir === 1 ? entry * (1 + movePct) : entry * (1 - movePct);
    };
    const koPrice = getPriceForR(-1.0);
    let activeStopR = -1.0;
    let activeStopPrice = koPrice;
    const tpPrice = curTpR !== null ? getPriceForR(curTpR) : null;

    let exitIdx = bars.length - 1;
    let pnlR = Math.max(-1, M * dir * ((bars[exitIdx].close - entry) / entry) - commFrac);
    let exitReason = 'END';

    for (let j = i + 1; j < bars.length - 1; j++) {
      const bj = bars[j];
      if ((dir === 1 && bj.low <= koPrice) || (dir === -1 && bj.high >= koPrice)) {
        exitIdx = j;
        pnlR = -1.0;
        exitReason = 'KO';
        break;
      }
      if (
        (dir === 1 && bj.low <= activeStopPrice) ||
        (dir === -1 && bj.high >= activeStopPrice)
      ) {
        exitIdx = j;
        pnlR = activeStopR;
        exitReason = activeStopR > 0 ? 'RATCHET' : 'KO';
        break;
      }
      if (
        tpPrice !== null &&
        curTpR !== null &&
        ((dir === 1 && bj.high >= tpPrice) || (dir === -1 && bj.low <= tpPrice))
      ) {
        exitIdx = j;
        pnlR = curTpR;
        exitReason = 'TP';
        break;
      }

      if (ratchet.length > 0) {
        const favMove = dir === 1 ? (bj.high - entry) / entry : (entry - bj.low) / entry;
        const favR = M * favMove - commFrac;
        for (const [trig, lock] of ratchet) {
          if (favR >= trig && activeStopR < lock) {
            activeStopR = lock;
            activeStopPrice = getPriceForR(lock);
          }
        }
      }

      if (mode === 'mr') {
        if ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42)) {
          exitIdx = j + 1;
          pnlR = Math.max(-1, M * dir * ((bars[j + 1].open - entry) / entry) - commFrac);
          exitReason = 'MR_RSI';
          break;
        }
      } else {
        if ((dir === 1 && bj.close < emaTrail[j]) || (dir === -1 && bj.close > emaTrail[j])) {
          exitIdx = j + 1;
          pnlR = Math.max(-1, M * dir * ((bars[j + 1].open - entry) / entry) - commFrac);
          exitReason = 'TRAIL';
          break;
        }
      }
    }

    trades.push({
      symbol,
      engine: '1h',
      mode,
      direction: dir === 1 ? 'rise' : 'fall',
      entryTime,
      exitTime: Number(bars[exitIdx].time),
      pnlR,
      exitReason,
    });
    i = exitIdx + 1;
  }
  return trades;
}

function summarize(trades: SimTrade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlR > 0);
  const losses = trades.filter((t) => t.pnlR <= 0);
  const gw = wins.reduce((s, t) => s + t.pnlR, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnlR, 0));
  const netR = gw - gl;
  const pf = gl > 0 ? gw / gl : 0;
  return {
    n,
    winRate: n > 0 ? Number(((wins.length / n) * 100).toFixed(1)) : 0,
    pf: Number(pf.toFixed(2)),
    netR: Number(netR.toFixed(2)),
    ratchets: trades.filter((t) => t.exitReason === 'RATCHET').length,
    trails: trades.filter((t) => t.exitReason === 'TRAIL').length,
    tps: trades.filter((t) => t.exitReason === 'TP').length,
    kos: trades.filter((t) => t.exitReason === 'KO').length,
  };
}

async function main() {
  const client = new PublicDerivClient();
  await client.connect();

  const fxPairs = ['frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxAUDUSD'];
  const datasets = new Map<string, CandlePoint[]>();

  console.log('Fetching 1-Year 1H candle archives for Major Forex Pairs from Deriv...');
  for (const sym of fxPairs) {
    const bars = await fetchOrLoad1Y(client, sym, 3600, 8);
    datasets.set(sym, bars);
    const first = bars[0] ? new Date(Number(bars[0].time) * 1000).toISOString().slice(0, 10) : 'none';
    const last = bars.at(-1) ? new Date(Number(bars.at(-1)!.time) * 1000).toISOString().slice(0, 10) : 'none';
    console.log(`  • ${sym}: ${bars.length} hourly bars (${first} -> ${last})`);
  }
  client.close();

  const evalStart = Math.floor(Date.now() / 1000) - 365 * 86400;

  console.log('\n================ 1-YEAR FOREX CURRENCY PAIRS BENCHMARK (2025-11 -> 2026-11) ================');
  for (const sym of fxPairs) {
    const bars = datasets.get(sym)!;
    console.log(`\n--- ${sym} ---`);
    for (const [cfgName, cfg] of [
      [
        'Default 100x Pure Trend (48b lookback, EMA50 trail)',
        { M: 100, lookback: 48, trendAdxMin: 24, atrCutoff: 0.004, trailEmaPeriod: 50, pureTrend: true, tpR: null, ratchet: [[0.8, 0.2]] as Array<[number, number]>, sessionFilter: false },
      ],
      [
        'Calibrated 200x Pure Trend (24b lookback, EMA30 trail, Two-Stage Ratchet)',
        { M: 200, lookback: 24, trendAdxMin: 22, atrCutoff: 0.004, trailEmaPeriod: 30, pureTrend: true, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]] as Array<[number, number]>, sessionFilter: false },
      ],
      [
        'Calibrated 200x Trend + Range MR (24b lookback, EMA30 trail, Two-Stage Ratchet)',
        { M: 200, lookback: 24, trendAdxMin: 22, atrCutoff: 0.004, trailEmaPeriod: 30, pureTrend: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]] as Array<[number, number]>, sessionFilter: false },
      ],
      [
        'Calibrated 300x London/NY Session (24b lookback, EMA20 trail, Two-Stage Ratchet)',
        { M: 300, lookback: 24, trendAdxMin: 22, atrCutoff: 0.004, trailEmaPeriod: 20, pureTrend: false, tpR: 2.0, ratchet: [[0.75, 0.2], [1.2, 0.6]] as Array<[number, number]>, sessionFilter: true },
      ],
    ] as const) {
      const tr = simulateFxSymbol({
        symbol: sym,
        bars,
        commFrac: 0.025, // ~2.5% commission at 100x-300x FX
        evalStartEpoch: evalStart,
        ...cfg,
      });
      const s = summarize(tr);
      console.log(
        `  • ${cfgName.padEnd(78)} | Trades=${String(s.n).padStart(3)} | WR=${String(s.winRate).padStart(5)}% | PF=${s.pf.toFixed(2)} | NetR=${(s.netR >= 0 ? '+' : '') + s.netR.toFixed(2).padStart(6)}R (Ratchet=${s.ratchets}, Trail=${s.trails}, TP=${s.tps}, KO=${s.kos})`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
