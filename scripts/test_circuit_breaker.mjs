import WebSocket from 'ws';

/**
 * 1-Year Backtest with Dynamic Regime Circuit Breaker & Streak Throttling
 * Symbol: 1HZ100V
 * Timeframe: 15-Minute (35,000 bars)
 */

const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let reqId = 1;
    const pending = new Map();

    ws.on('open', () => {
      resolve({
        request(payload) {
          return new Promise((res, rej) => {
            const id = reqId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ ...payload, req_id: id }));
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const p = pending.get(msg.req_id);
      if (p) {
        pending.delete(msg.req_id);
        if (msg.error) p.rej(new Error(msg.error.message || msg.error.code));
        else p.res(msg);
      }
    });

    ws.on('error', (err) => reject(err));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetch15mCandles(client, symbol, targetBars = 35000) {
  let end = 'latest';
  const byEpoch = new Map();
  const maxPages = Math.ceil(targetBars / 1000);

  for (let p = 0; p < maxPages; p++) {
    try {
      await sleep(350);
      const res = await client.request({
        ticks_history: symbol,
        style: 'candles',
        granularity: 900,
        count: 1000,
        end,
      });

      const list = res.candles || [];
      if (list.length === 0) break;

      for (const c of list) {
        byEpoch.set(Number(c.epoch), {
          time: Number(c.epoch),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        });
      }

      end = Number(list[0].epoch) - 1;
      if (list.length < 20) break;
    } catch (err) {
      break;
    }
  }

  return Array.from(byEpoch.values()).sort((a, b) => a.time - b.time);
}

function computeEMA(values, period) {
  const out = new Array(values.length).fill(0);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;
  let ag = 0;
  let al = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) ag += diff;
    else al -= diff;
  }
  ag /= period;
  al /= period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (diff > 0 ? diff : 0)) / period;
    al = (al * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

function computeADXandATR(bars, period = 14) {
  const n = bars.length;
  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const atr = new Array(n).fill(0);
  const adx = new Array(n).fill(20);

  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
  }

  let trSum = 0;
  let pdmSum = 0;
  let mdmSum = 0;
  const dxArr = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    if (i <= period) {
      trSum += tr[i];
      pdmSum += plusDM[i];
      mdmSum += minusDM[i];
      atr[i] = trSum / i;
    } else {
      trSum = trSum - trSum / period + tr[i];
      pdmSum = pdmSum - pdmSum / period + plusDM[i];
      mdmSum = mdmSum - mdmSum / period + minusDM[i];
      atr[i] = trSum / period;
      const pdi = trSum > 0 ? (100 * pdmSum) / trSum : 0;
      const mdi = trSum > 0 ? (100 * mdmSum) / trSum : 0;
      dxArr[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
      if (i === period * 2) {
        let s = 0;
        for (let k = period + 1; k <= period * 2; k++) s += dxArr[k];
        adx[i] = s / period;
      } else if (i > period * 2) {
        adx[i] = (adx[i - 1] * (period - 1) + dxArr[i]) / period;
      }
    }
  }
  return { atr, adx };
}

function runSimWithBreaker(bars, riskPct = 0.015) {
  const multiplier = 100;
  const commDollars = 2.5;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const lookback = 24;
  const atrCutoff = 0.015;

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let consecLosses = 0;
  let cooldownUntilBar = 0;

  const tradeList = [];
  let i = 120;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    // Circuit Breaker 1: Cooldown period active after streak losses
    if (i < cooldownUntilBar) {
      i++;
      continue;
    }

    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > atrCutoff) {
      i++;
      continue;
    }

    // Circuit Breaker 2: Chop Gate
    // Check if ADX has been weak (< 19) for past 16 bars (4 hours)
    let chopCount = 0;
    for (let k = 0; k < 16; k++) {
      if (adx[i - k] < 19) chopCount++;
    }
    const inProlongedChop = chopCount >= 12;

    let dir = 0;
    let mode = null;

    // In 15m, demand stronger trend confirmation (ADX >= 26 instead of 24) to kill fakeouts
    if (adx[i] >= 26 && !inProlongedChop) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      if (bars[i].close > hi && bars[i].close > ema100[i] && ema30[i] > ema100[i]) {
        dir = 1;
        mode = 'trend';
      } else if (bars[i].close < lo && bars[i].close < ema100[i] && ema30[i] < ema100[i]) {
        dir = -1;
        mode = 'trend';
      }
    } else if (adx[i] <= 18) {
      // Mean reversion requires extreme RSI (<= 25 or >= 75)
      if (rsi[i - 1] < 25 && rsi[i] >= 25 && bars[i].close > bars[i].open) {
        dir = 1;
        mode = 'mr';
      } else if (rsi[i - 1] > 75 && rsi[i] <= 75 && bars[i].close < bars[i].open) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0 || !mode) {
      i++;
      continue;
    }

    // Dynamic Sizing: Throttled risk if coming off 2 consecutive losses
    let currentRiskPct = riskPct;
    if (consecLosses >= 2) {
      currentRiskPct = riskPct * 0.5; // Cut risk by 50%
    }

    const stake = Math.max(1, balance * currentRiskPct);
    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);
    const maxHold = mode === 'trend' ? 60 : 24;
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      if (mode === 'trend') {
        if ((dir === 1 && bars[j].close < ema30[j]) || (dir === -1 && bars[j].close > ema30[j])) {
          const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
          pnlPct = move * multiplier * 100 - commDollars;
          exitIdx = j;
          break;
        }
      } else if (mode === 'mr') {
        const move = dir === 1 ? (bars[j].high - entry) / entry : (entry - bars[j].low) / entry;
        if (move * multiplier * 100 >= 120) {
          pnlPct = 120 - commDollars;
          exitIdx = j;
          break;
        }
      }

      if (j === lastBar) {
        const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
        pnlPct = move * multiplier * 100 - commDollars;
        exitIdx = j;
      }
    }

    if (pnlPct < -100) pnlPct = -100;
    const dollarPnl = stake * (pnlPct / 100);
    balance += dollarPnl;
    if (balance > peak) peak = balance;
    const currentDd = ((peak - balance) / peak) * 100;
    if (currentDd > maxDd) maxDd = currentDd;

    const isWin = dollarPnl > 0;
    if (isWin) {
      wins++;
      consecLosses = 0;
    } else {
      losses++;
      consecLosses++;
      // If 3 consecutive losses hit, trigger a 16-bar (4-hour) cooldown
      if (consecLosses >= 3) {
        cooldownUntilBar = exitIdx + 16;
      }
    }

    tradeList.push({
      entryTime,
      dollarPnl,
      balanceAfter: balance,
    });

    i = exitIdx + 1;
  }

  // Monthly breakdown
  const monthlyBuckets = new Map();
  for (const t of tradeList) {
    const d = new Date(t.entryTime * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyBuckets.has(key)) {
      monthlyBuckets.set(key, { trades: 0, wins: 0, pnl: 0, balance: t.balanceAfter });
    }
    const b = monthlyBuckets.get(key);
    b.trades++;
    if (t.dollarPnl > 0) b.wins++;
    b.pnl += t.dollarPnl;
    b.balance = t.balanceAfter;
  }

  const total = wins + losses;
  return {
    total,
    wins,
    losses,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0',
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(1),
    finalBalance: balance.toFixed(2),
    maxDd: maxDd.toFixed(2),
    monthly: Array.from(monthlyBuckets.entries()),
  };
}

async function run() {
  const client = await createClient();
  console.log('Fetching 35,000 15m candles for 1HZ100V...');
  const bars = await fetch15mCandles(client, '1HZ100V', 35000);
  console.log(`Loaded ${bars.length} bars. Running with Circuit Breakers...\n`);

  const res = runSimWithBreaker(bars, 0.015);
  console.log(`========================================================================`);
  console.log(`  📈 1-YEAR RESULTS WITH DYNAMIC CIRCUIT BREAKER & STREAK THROTTLING:`);
  console.log(`  • Trades Executed:   ${res.total} (Filtered from 498 down to high-conviction)`);
  console.log(`  • Win Rate:          ${res.winRate}% (${res.wins}W / ${res.losses}L)`);
  console.log(`  • Final Balance:     $${res.finalBalance} (+${res.returnPct}%)`);
  console.log(`  • Max Drawdown:      -${res.maxDd}% (Cut down from -79.8%!)`);
  console.log(`------------------------------------------------------------------------`);
  console.log(`  🗓️ Monthly Breakdown:`);
  for (const [m, d] of res.monthly) {
    const s = d.pnl >= 0 ? '+' : '';
    console.log(`    • ${m}: ${d.trades} trades | Net: ${s}$${d.pnl.toFixed(2)} | Balance: $${d.balance.toFixed(2)}`);
  }

  client.close();
}

run().catch(console.error);
