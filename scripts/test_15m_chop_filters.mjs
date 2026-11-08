import WebSocket from 'ws';

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

function runBacktest(bars, config) {
  const {
    multiplier = 30,
    lookback = 24,
    minAdx = 24,
    tpR = 1.6,
    slR = 0.75,
    riskPct = 0.015,
    emaPeriod = 100,
  } = config;

  const commDollars = 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map(b => b.close);
  const emaFast = computeEMA(closes, 12);
  const emaSlow = computeEMA(closes, 26);
  const emaFilter = computeEMA(closes, emaPeriod);
  const { adx } = computeADXandATR(bars, 14);

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;

  let i = 120;
  while (i < bars.length - 2) {
    let dir = 0;
    if (adx[i] >= minAdx) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = i - lookback; k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }

      if (bars[i].close > hi && emaFast[i] > emaSlow[i] && emaSlow[i] > emaFilter[i]) {
        dir = 1;
      } else if (bars[i].close < lo && emaFast[i] < emaSlow[i] && emaSlow[i] < emaFilter[i]) {
        dir = -1;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const stake = balance * riskPct;
    const entry = bars[i + 1].open;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    const slMove = (slR * 100 + commDollars) / (100 * multiplier);
    const tpMove = (tpR * 100 + commDollars) / (100 * multiplier);
    const slPrice = dir === 1 ? entry * (1 - slMove) : entry * (1 + slMove);
    const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);

    const maxHold = 36;
    const lastBar = Math.min(bars.length - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        break;
      }
      if ((dir === 1 && bars[j].low <= slPrice) || (dir === -1 && bars[j].high >= slPrice)) {
        pnlPct = -(slR * 100);
        exitIdx = j;
        break;
      }
      if ((dir === 1 && bars[j].high >= tpPrice) || (dir === -1 && bars[j].low <= tpPrice)) {
        pnlPct = tpR * 100;
        exitIdx = j;
        break;
      }
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

    if (dollarPnl > 0) wins++;
    else losses++;

    i = exitIdx + 1;
  }

  const total = wins + losses;
  return {
    config,
    total,
    wins,
    losses,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) : '0',
    returnPct: (((balance - 1000) / 1000) * 100).toFixed(1),
    finalBalance: balance.toFixed(2),
    maxDd: maxDd.toFixed(2),
  };
}

async function run() {
  const client = await createClient();
  const bars = await fetch15mCandles(client, '1HZ100V', 35000);
  console.log(`Loaded ${bars.length} 15m bars.\n`);

  const configs = [
    { multiplier: 30, lookback: 20, minAdx: 22, tpR: 1.6, slR: 0.75, emaPeriod: 50 },
    { multiplier: 30, lookback: 28, minAdx: 25, tpR: 1.8, slR: 0.70, emaPeriod: 100 },
    { multiplier: 30, lookback: 32, minAdx: 28, tpR: 2.0, slR: 0.65, emaPeriod: 100 },
    { multiplier: 40, lookback: 28, minAdx: 26, tpR: 1.8, slR: 0.70, emaPeriod: 100 },
  ];

  for (const cfg of configs) {
    const res = runBacktest(bars, cfg);
    console.log(`Lookback: ${cfg.lookback} | ADX: ${cfg.minAdx} | EMAFilter: ${cfg.emaPeriod} | Trades: ${res.total} | Win: ${res.winRate}% | Net: +${res.returnPct}% ($${res.finalBalance}) | MaxDD: -${res.maxDd}%`);
  }

  client.close();
}

run().catch(console.error);
