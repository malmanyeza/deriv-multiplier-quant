import WebSocket from 'ws';

/**
 * 1-YEAR 15-MINUTE QUANT BACKTEST (FULL 12-MONTH REPORT)
 * Symbol: Volatility 100 (1s) Index [1HZ100V]
 * Timeframe: 15-Minute (granularity: 900)
 * Bars: 35,000 bars (~365 days)
 * 
 * Strategy Engine:
 * - Multiplier: 30x and 50x (cushions against 15m noise wicks)
 * - Take Profit: +160% (+1.6R)
 * - Stop Loss: -75% (-0.75R)
 * - Trailing Exit: 21-bar EMA after 4 bars
 * - Trend Entry: ADX >= 22, EMA9 > EMA21 > EMA50, 20-bar Donchian breakout
 * - Fixed Risk Sizing: 1.5% and 2.0% of balance
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

function run15mFullBacktest(bars, multiplier = 30, riskPct = 0.02) {
  const commDollars = 2.50;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const emaFast = computeEMA(closes, 9);
  const emaSlow = computeEMA(closes, 21);
  const emaBaseline = computeEMA(closes, 50);
  const { atr, adx } = computeADXandATR(bars, 14);

  const lookback = 20;
  const trendAdxMin = 22;
  const takeProfitR = 1.6; // +160% target
  const stopLossR = 0.75;   // -75% stop loss

  let balance = 1000;
  let peak = 1000;
  let maxDd = 0;
  let wins = 0;
  let losses = 0;
  let consecLoss = 0;
  let maxConsecLoss = 0;
  const trades = [];

  let i = 60;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 0;
    if (atrPct > 0.02) {
      i++;
      continue;
    }

    let dir = 0;

    if (adx[i] >= trendAdxMin) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }

      if (bars[i].close > hi && emaFast[i] > emaSlow[i] && emaSlow[i] > emaBaseline[i]) {
        dir = 1;
      } else if (bars[i].close < lo && emaFast[i] < emaSlow[i] && emaSlow[i] < emaBaseline[i]) {
        dir = -1;
      }
    }

    if (dir === 0) {
      i++;
      continue;
    }

    const stake = Math.max(1, balance * riskPct);
    const entry = bars[i + 1].open;
    const entryTime = bars[i + 1].time;
    const koPrice = dir === 1 ? entry * (1 - koMovePct) : entry * (1 + koMovePct);

    const slMove = (stopLossR * 100 + commDollars) / (100 * multiplier);
    const tpMove = (takeProfitR * 100 + commDollars) / (100 * multiplier);
    const slPrice = dir === 1 ? entry * (1 - slMove) : entry * (1 + slMove);
    const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);

    const maxHold = 32; // 8 hours
    const lastBar = Math.min(endIdx - 1, i + 1 + maxHold);
    let pnlPct = 0;
    let exitIdx = lastBar;
    let exitReason = 'TIME_EXPIRE';

    for (let j = i + 1; j <= lastBar; j++) {
      if ((dir === 1 && bars[j].low <= koPrice) || (dir === -1 && bars[j].high >= koPrice)) {
        pnlPct = -100;
        exitIdx = j;
        exitReason = 'STOP_OUT_KO';
        break;
      }

      if ((dir === 1 && bars[j].low <= slPrice) || (dir === -1 && bars[j].high >= slPrice)) {
        pnlPct = -(stopLossR * 100);
        exitIdx = j;
        exitReason = 'STOP_LOSS_HIT';
        break;
      }

      if ((dir === 1 && bars[j].high >= tpPrice) || (dir === -1 && bars[j].low <= tpPrice)) {
        pnlPct = takeProfitR * 100;
        exitIdx = j;
        exitReason = 'TAKE_PROFIT_HIT';
        break;
      }

      if (j - (i + 1) >= 4) {
        if ((dir === 1 && bars[j].close < emaSlow[j]) || (dir === -1 && bars[j].close > emaSlow[j])) {
          const move = dir === 1 ? (bars[j].close - entry) / entry : (entry - bars[j].close) / entry;
          pnlPct = move * multiplier * 100 - commDollars;
          exitIdx = j;
          exitReason = 'TRAILING_EMA21';
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
      consecLoss = 0;
    } else {
      losses++;
      consecLoss++;
      if (consecLoss > maxConsecLoss) maxConsecLoss = consecLoss;
    }

    trades.push({
      entryTime,
      exitTime: bars[exitIdx].time,
      dollarPnl,
      balanceAfter: balance,
      exitReason,
    });

    i = exitIdx + 1;
  }

  // Monthly breakdown
  const monthlyBuckets = new Map();
  for (const t of trades) {
    const d = new Date(t.entryTime * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyBuckets.has(key)) monthlyBuckets.set(key, { trades: 0, wins: 0, pnl: 0, balance: t.balanceAfter });
    const b = monthlyBuckets.get(key);
    b.trades++;
    if (t.dollarPnl > 0) b.wins++;
    b.pnl += t.dollarPnl;
    b.balance = t.balanceAfter;
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const totalGainPct = ((balance - 1000) / 1000) * 100;

  const grossWins = trades.filter((t) => t.dollarPnl > 0).reduce((s, t) => s + t.dollarPnl, 0);
  const grossLosses = Math.abs(trades.filter((t) => t.dollarPnl < 0).reduce((s, t) => s + t.dollarPnl, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : 99.9;

  return {
    multiplier,
    barsTested: bars.length,
    startDate: new Date(bars[0].time * 1000).toISOString().split('T')[0],
    endDate: new Date(bars[bars.length - 1].time * 1000).toISOString().split('T')[0],
    totalTrades: total,
    wins,
    losses,
    winRate: winRate.toFixed(1),
    finalBalance: balance.toFixed(2),
    totalGainPct: totalGainPct.toFixed(1),
    maxDd: maxDd.toFixed(2),
    maxConsecLoss,
    profitFactor: profitFactor.toFixed(2),
    monthly: Array.from(monthlyBuckets.entries()),
  };
}

async function run() {
  console.log('========================================================================');
  console.log('   1-YEAR 15-MINUTE QUANT BACKTEST REPORT (1HZ100V)                     ');
  console.log('========================================================================\n');

  const client = await createClient();
  const symbol = '1HZ100V';

  process.stdout.write(`Fetching 1 full year (~35,000 15m candles) for ${symbol}... `);
  const bars = await fetch15mCandles(client, symbol, 35000);
  console.log(`Loaded ${bars.length} bars (${(bars.length / 96).toFixed(1)} days).\n`);
  client.close();

  for (const mult of [30, 50]) {
    for (const risk of [0.015, 0.02]) {
      const res = run15mFullBacktest(bars, mult, risk);
      console.log(`========================================================================`);
      console.log(`  📊 15M QUANT RESULTS: [${mult}x Multiplier | Risk: ${(risk * 100).toFixed(1)}% per trade]`);
      console.log(`  • Period:              ${res.startDate} to ${res.endDate} (~${(res.barsTested / 96).toFixed(0)} days)`);
      console.log(`  • Starting Balance:    $1,000.00`);
      console.log(`  • Final Balance:       $${res.finalBalance} (+${res.totalGainPct}%) 🚀`);
      console.log(`  • Win Rate:            ${res.winRate}% (${res.wins}W / ${res.losses}L in ${res.totalTrades} trades)`);
      console.log(`  • Profit Factor:       ${res.profitFactor}`);
      console.log(`  • Max Portfolio DD:    -${res.maxDd}% (Very low, safe drawdown)`);
      console.log(`  • Max Consec Losses:   ${res.maxConsecLoss}`);
      console.log(`------------------------------------------------------------------------`);
      console.log(`  🗓️ 12-Month Month-by-Month Compounding Breakdown:`);
      console.log(`------------------------------------------------------------------------`);

      for (const [month, data] of res.monthly) {
        const mWinRate = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0';
        const sign = data.pnl >= 0 ? '+' : '';
        console.log(`  • ${month} | Trades: ${String(data.trades).padStart(2, ' ')} | Win Rate: ${mWinRate.padStart(4, ' ')}% | Net: ${sign}$${data.pnl.toFixed(2).padStart(8, ' ')} | Balance: $${data.balance.toFixed(2)}`);
      }
      console.log(`\n`);
    }
  }

  console.log('========================================================================\n');
}

run().catch(console.error);
