import WebSocket from 'ws';

/**
 * 15-MINUTE QUANT RETURN OPTIMIZER & ENHANCEMENT ENGINE
 * 
 * Testing 4 strategies to boost returns on 35,000 15M candles:
 * 1. BASELINE: Fixed +200% TP / -65% SL (Current +26.6% 1-yr return)
 * 2. TRAILING RUNNER: Break-Even at +120%, Trailing EMA12 exit (captures fat tails)
 * 3. MULTI-TIMEFRAME CONFLUENCE: 1H Macro EMA filter + 15M Donchian breakout
 * 4. HIGH-CONVICTION VOLATILITY SIZING: 2.5% on ADX >= 35, 1.5% on standard
 * 5. MULTI-ASSET 15M BASKET: 1HZ100V + R_75
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
        if (msg.error) p.rej(new Error(msg.error.message));
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

function runBacktest(bars, options = {}) {
  const {
    name = 'Strategy',
    multiplier = 30,
    lookback = 32,
    minAdx = 28,
    tpR = 2.0,
    slR = 0.65,
    useTrailingRunner = false,
    useConvictionSizing = false,
    baseRisk = 0.02,
    maxHold = 48,
  } = options;

  const commDollars = 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map(b => b.close);
  const emaFast = computeEMA(closes, 12);
  const emaSlow = computeEMA(closes, 26);
  const emaFilter = computeEMA(closes, 100);
  const emaMacro = computeEMA(closes, 400); // ~100-bar on 1H (4x 15m)
  const { adx } = computeADXandATR(bars, 14);

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let maxConsecLoss = 0;
  let consecLoss = 0;

  const trades = [];
  let i = 150;

  while (i < bars.length - 2) {
    let dir = 0;

    if (adx[i] >= minAdx) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - lookback; k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }

      if (bars[i].close > hi && emaFast[i] > emaSlow[i] && emaSlow[i] > emaFilter[i] && bars[i].close > emaMacro[i]) {
        dir = 1;
      } else if (bars[i].close < lo && emaFast[i] < emaSlow[i] && emaSlow[i] < emaFilter[i] && bars[i].close < emaMacro[i]) {
        dir = -1;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    let riskPct = baseRisk;
    if (useConvictionSizing) {
      if (adx[i] >= 38) riskPct = 0.030; // 3.0% on high conviction
      else if (adx[i] >= 32) riskPct = 0.022; // 2.2%
      else riskPct = 0.015; // 1.5%
    }

    const stake = balance * riskPct;
    const entry = bars[i + 1].open;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    let curSlR = slR;
    let slMove = (curSlR * 100 + commDollars) / (100 * multiplier);
    let slPrice = dir === 1 ? entry * (1 - slMove) : entry * (1 + slMove);

    const tpMove = (tpR * 100 + commDollars) / (100 * multiplier);
    const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);

    const lastBar = Math.min(bars.length - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;
    let lockedBe = false;

    for (let j = i + 1; j <= lastBar; j++) {
      // Check KO
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }

      // Trailing Runner: lock break-even (+15%) once price reaches +100%
      if (useTrailingRunner && !lockedBe) {
        const floatingMove = dir === 1 ? (bars[j].high - entry) / entry : (entry - bars[j].low) / entry;
        const floatingPct = floatingMove * multiplier * 100 - commDollars;
        if (floatingPct >= 100) {
          lockedBe = true;
          // Move SL to +15% profit (guaranteed green trade)
          const beMove = (15 + commDollars) / (100 * multiplier);
          slPrice = dir === 1 ? entry * (1 + beMove) : entry * (1 - beMove);
        }
      }

      // Check SL
      if ((dir === 1 && bars[j].low <= slPrice) || (dir === -1 && bars[j].high >= slPrice)) {
        pnlPct = lockedBe ? 15 : -(curSlR * 100);
        exitIdx = j;
        break;
      }

      // If trailing runner enabled, trail with EMA12 after +100%
      if (useTrailingRunner && lockedBe && j - (i + 1) >= 6) {
        if ((dir === 1 && bars[j].close < emaFast[j]) || (dir === -1 && bars[j].close > emaFast[j])) {
          const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
          pnlPct = move * multiplier * 100 - commDollars;
          exitIdx = j;
          break;
        }
      }

      // Check standard TP
      if (!useTrailingRunner && ((dir === 1 && bars[j].high >= tpPrice) || (dir === -1 && bars[j].low <= tpPrice))) {
        pnlPct = tpR * 100;
        exitIdx = j;
        break;
      }

      // Time exit
      if (j === lastBar) {
        const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
        pnlPct = move * multiplier * 100 - commDollars;
      }
    }

    if (pnlPct < -100) pnlPct = -100;
    const dollarPnl = stake * (pnlPct / 100);
    balance += dollarPnl;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDd) maxDd = dd;

    if (dollarPnl > 0) {
      wins++;
      consecLoss = 0;
    } else {
      losses++;
      consecLoss++;
      if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
    }

    trades.push(dollarPnl);
    i = exitIdx + 1;
  }

  const total = wins + losses;
  const grossWin = trades.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(trades.filter(p => p < 0).reduce((s, p) => s + p, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 99.9;

  return {
    name,
    total,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0',
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(2),
    finalBalance: balance.toFixed(2),
    maxDd: maxDd.toFixed(2),
    pf: pf.toFixed(2),
  };
}

async function run() {
  const client = await createClient();
  console.log('Fetching 35,000 15M candles for 1HZ100V...');
  const bars = await fetch15mCandles(client, '1HZ100V', 35000);
  console.log(`Loaded ${bars.length} candles.\n`);

  console.log('========================================================================');
  console.log('  BENCHMARKING ENHANCEMENT METHODS TO BOOST 15M QUANT RETURNS');
  console.log('========================================================================\n');

  // Baseline
  const res1 = runBacktest(bars, {
    name: '1. Baseline Fixed (TP +200%, SL -65%, 2% Risk)',
    tpR: 2.0,
    slR: 0.65,
    baseRisk: 0.02,
  });

  // Enhancement A: Dynamic Trailing Runner
  const res2 = runBacktest(bars, {
    name: '2. Dynamic Trailing Runner (Lock BE at +100%, Trail EMA12)',
    useTrailingRunner: true,
    slR: 0.65,
    baseRisk: 0.02,
  });

  // Enhancement B: High-Conviction Volatility Sizing
  const res3 = runBacktest(bars, {
    name: '3. Conviction Sizing (ADX 38+ -> 3% Risk, ADX 32 -> 2.2%, else 1.5%)',
    tpR: 2.0,
    slR: 0.65,
    useConvictionSizing: true,
  });

  // Enhancement C: Combination (Trailing Runner + Conviction Sizing)
  const res4 = runBacktest(bars, {
    name: '4. Turbo Combo (Trailing Runner + Conviction Sizing)',
    useTrailingRunner: true,
    useConvictionSizing: true,
    slR: 0.65,
  });

  const results = [res1, res2, res3, res4];
  for (const r of results) {
    console.log(`------------------------------------------------------------------------`);
    console.log(`  Strategy:     ${r.name}`);
    console.log(`  • Trades:     ${r.total} | Win Rate: ${r.winRate}% | Profit Factor: ${r.pf}`);
    console.log(`  • Net Return: +${r.returnPct}% ($1,000 -> $${r.finalBalance})`);
    console.log(`  • Max DD:     -${r.maxDd}%`);
  }
  console.log(`------------------------------------------------------------------------\n`);

  client.close();
}

run().catch(console.error);
