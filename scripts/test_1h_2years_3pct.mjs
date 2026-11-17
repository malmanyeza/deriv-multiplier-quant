import WebSocket from 'ws';

/**
 * 2-YEAR 1-HOUR MACRO QUANT BACKTEST (NOVEMBER 2024 TO NOVEMBER 2026)
 * Sizing: 1.5%, 2.0%, and 3.0% Risk Per Trade
 * Assets: Bitcoin (cryBTCUSD), Ethereum (cryETHUSD), Gold (frxXAUUSD)
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

async function fetchCandles(client, symbol, granularity = 3600, targetBars = 18000) {
  let end = 'latest';
  const byEpoch = new Map();
  const maxPages = Math.ceil(targetBars / 1000);

  for (let p = 0; p < maxPages; p++) {
    let retries = 3;
    let list = null;

    while (retries > 0) {
      try {
        await sleep(400);
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity,
          count: 1000,
          end,
        });

        list = res.candles || [];
        break;
      } catch (err) {
        if (err.message.includes('rate limit') || err.message.includes('ticks_history_expensive')) {
          await sleep(2500);
          retries--;
        } else {
          break;
        }
      }
    }

    if (!list || list.length === 0) break;

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

function getAssetConfig(symbol) {
  if (symbol === 'cryBTCUSD') return { comm: 2.99, lookback: 48, longOnly: false, pureTrend: false };
  if (symbol === 'cryETHUSD') return { comm: 7.99, lookback: 48, longOnly: false, pureTrend: false };
  if (symbol === 'frxXAUUSD') return { comm: 2.50, lookback: 72, longOnly: true,  pureTrend: true  };
  return { comm: 2.50, lookback: 48, longOnly: false, pureTrend: false };
}

function extractAssetTrades(bars, symbol) {
  const cfg = getAssetConfig(symbol);
  const multiplier = 100;
  const commDollars = cfg.comm;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);

  const trades = [];
  let i = 120;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > 0.0065) {
      i++;
      continue;
    }

    let dir = 0;
    let mode = null;
    const trendAdxMin = cfg.pureTrend ? 20 : 24;

    if (adx[i] >= trendAdxMin) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - cfg.lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      if (bars[i].close > hi && bars[i].close > ema100[i] && ema30[i] > ema100[i]) {
        dir = 1;
        mode = 'trend';
      } else if (!cfg.longOnly && bars[i].close < lo && bars[i].close < ema100[i] && ema30[i] < ema100[i]) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!cfg.pureTrend && adx[i] <= 20) {
      if (rsi[i - 1] < 27 && rsi[i] >= 27 && bars[i].close > bars[i].open && (!cfg.longOnly || bars[i].close > ema100[i] * 0.97)) {
        dir = 1;
        mode = 'mr';
      } else if (!cfg.longOnly && rsi[i - 1] > 73 && rsi[i] <= 73 && bars[i].close < bars[i].open) {
        dir = -1;
        mode = 'mr';
      }
    }

    if (dir === 0 || !mode) {
      i++;
      continue;
    }

    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    const maxHold = mode === 'trend' ? 140 : 36;
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
        if (move * multiplier * 100 >= 160) {
          pnlPct = 160 - commDollars;
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
    trades.push({
      symbol,
      entryTime,
      exitTime: bars[exitIdx].time,
      pnlPct,
      mode,
    });

    i = exitIdx + 1;
  }

  return trades;
}

async function run() {
  const client = await createClient();
  console.log('========================================================================');
  console.log('  2-YEAR 1-HOUR MACRO QUANT BACKTEST (FULL 730 DAYS)');
  console.log('  Period: November 2024 to November 2026 (~17,500 1h Candles)');
  console.log('  Sizing Comparison: 1.5% vs 2.0% vs 3.0% Risk Per Trade');
  console.log('========================================================================\n');

  const assets = ['cryBTCUSD', 'cryETHUSD', 'frxXAUUSD'];
  const allTrades = [];

  for (const s of assets) {
    process.stdout.write(`Fetching 2 full years (~17,500 1h candles) for ${s}... `);
    const bars = await fetchCandles(client, s, 3600, 18000);
    console.log(`Loaded ${bars.length} candles (${new Date(bars[0].time * 1000).toISOString().split('T')[0]} to ${new Date(bars[bars.length - 1].time * 1000).toISOString().split('T')[0]}).`);
    const assetTrades = extractAssetTrades(bars, s);
    console.log(`  -> Found ${assetTrades.length} trades for ${s}`);
    allTrades.push(...assetTrades);
  }

  client.close();

  // Sort chronologically across the entire portfolio
  allTrades.sort((a, b) => a.entryTime - b.entryTime);

  console.log(`\n========================================================================`);
  console.log(`  TOTAL 1H BASKET TRADES OVER 2 FULL YEARS: ${allTrades.length}`);
  console.log(`========================================================================`);

  for (const risk of [0.015, 0.020, 0.030]) {
    let balance = 1000;
    let peak = 1000;
    let maxDd = 0;
    let wins = 0;
    let losses = 0;
    let consecLoss = 0;
    let maxConsecLoss = 0;
    const quarterly = new Map();
    const tradeLedger = [];

    for (const t of allTrades) {
      const stake = balance * risk;
      const dollarPnl = stake * (t.pnlPct / 100);
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

      const d = new Date(t.entryTime * 1000);
      const qKey = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
      if (!quarterly.has(qKey)) quarterly.set(qKey, { trades: 0, wins: 0, pnl: 0, balance });
      const qb = quarterly.get(qKey);
      qb.trades++;
      if (dollarPnl > 0) qb.wins++;
      qb.pnl += dollarPnl;
      qb.balance = balance;

      tradeLedger.push(dollarPnl);
    }

    const total = wins + losses;
    const wr = ((wins / total) * 100).toFixed(1);
    const returnPct = (((balance - 1000) / 1000) * 100).toFixed(2);
    const grossW = tradeLedger.filter(p => p > 0).reduce((s, p) => s + p, 0);
    const grossL = Math.abs(tradeLedger.filter(p => p < 0).reduce((s, p) => s + p, 0));
    const pf = grossL > 0 ? (grossW / grossL).toFixed(2) : '99.9';

    console.log(`\n------------------------------------------------------------------------`);
    console.log(`  🌟 2-YEAR 1H RESULT @ ${(risk * 100).toFixed(1)}% RISK PER TRADE:`);
    console.log(`  • Starting Capital:    $1,000.00`);
    console.log(`  • Final Capital:       $${balance.toFixed(2)} (+${returnPct}%) 🚀`);
    console.log(`  • Win Rate:            ${wr}% (${wins} Wins / ${losses} Losses in ${total} Trades)`);
    console.log(`  • Profit Factor:       ${pf}`);
    console.log(`  • Max Portfolio DD:    -${maxDd.toFixed(2)}%`);
    console.log(`  • Max Consec Losses:   ${maxConsecLoss}`);
    console.log(`\n  🗓️ Quarter-by-Quarter Ledger:`);
    for (const [q, d] of quarterly) {
      const qwr = ((d.wins / d.trades) * 100).toFixed(1);
      const sign = d.pnl >= 0 ? '+' : '';
      console.log(`    • ${q} | Trades: ${String(d.trades).padStart(2, ' ')} | WinRate: ${qwr.padStart(5, ' ')}% | Net: ${sign}$${d.pnl.toFixed(2).padStart(8, ' ')} | Balance: $${d.balance.toFixed(2)}`);
    }
  }

  console.log(`\n========================================================================\n`);
}

run().catch(console.error);
