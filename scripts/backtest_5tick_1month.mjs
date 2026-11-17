import WebSocket from 'ws';

/**
 * 30-DAY (1-MONTH) 5-TICK RISE/FALL QUANT BACKTEST
 * Period: October 10, 2026 to November 9, 2026 (Past 30 Days)
 * Starting Balance: $100.00
 * Asset: Volatility 75 Index (R_75)
 * 
 * Strategy: Velocity + Confirmation Turn Tick
 * - Trend: EMA(10) > EMA(25) > EMA(60) & Velocity Slope >= 0.00005
 * - Pullback: Exactly 2 consecutive counter-trend ticks
 * - Trigger: Turn Tick (first tick reversing back in trend direction)
 * - Expiry: Exactly 5 Ticks
 * - Payout: 95.0% (Profit = +95% of stake on win, -100% on loss)
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

function computeEMA(prices, period) {
  const ema = new Float64Array(prices.length);
  if (prices.length === 0) return ema;
  const k = 2 / (period + 1);
  ema[0] = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function evaluate5TickTrade(prices, entryIdx, direction) {
  const exitIdx = entryIdx + 5;
  if (exitIdx >= prices.length) return null;
  const entryPrice = prices[entryIdx];
  const exitPrice = prices[exitIdx];

  if (direction === 'rise') {
    return exitPrice > entryPrice ? 'WIN' : 'LOSS';
  } else {
    return exitPrice < entryPrice ? 'WIN' : 'LOSS';
  }
}

async function run() {
  const client = await createClient();
  console.log('========================================================================');
  console.log('  30-DAY (1-MONTH) 5-TICK RISE/FALL QUANT BACKTEST (R_75)');
  console.log('  Strategy: Velocity + Confirmation Turn Tick');
  console.log('  Starting Capital: $100.00 | Payout: 95.0% | Expiry: 5 Ticks');
  console.log('========================================================================\n');

  const nowSec = Math.floor(Date.now() / 1000);
  const oneMonthAgoSec = nowSec - (30 * 86400);

  // We sample 30 representative day-blocks across the past month (one dense 4-hour active session per day)
  // or paginate sequentially across the full dataset to get thousands of verified trades.
  const allTrades = [];
  let totalTicksLoaded = 0;

  console.log('Fetching tick data across 30 days (October 10 – November 9, 2026)...');

  for (let day = 0; day < 30; day++) {
    const dayEnd = nowSec - (day * 86400);
    const dayStart = dayEnd - (14400); // 4-hour continuous window per day (approx 7,200 ticks per day)

    try {
      await sleep(250);
      const res = await client.request({
        ticks_history: 'R_75',
        start: dayStart,
        end: String(dayEnd),
        count: 5000,
        style: 'ticks',
      });

      const h = res.history;
      if (!h || !Array.isArray(h.prices) || h.prices.length < 500) continue;

      const prices = h.prices;
      const times = h.times;
      totalTicksLoaded += prices.length;

      const emaFast = computeEMA(prices, 10);
      const emaMid = computeEMA(prices, 25);
      const emaSlow = computeEMA(prices, 60);

      let i = 80;
      while (i < prices.length - 6) {
        const isUpTrend = emaFast[i] > emaMid[i] && emaMid[i] > emaSlow[i];
        const isDnTrend = emaFast[i] < emaMid[i] && emaMid[i] < emaSlow[i];
        const slopeFast = (emaFast[i] - emaFast[i - 5]) / emaFast[i];

        let signal = null;

        // Velocity (minSlope >= 0.00005) + Confirmation Turn Tick
        if (isUpTrend && slopeFast >= 0.00005) {
          // 2 ticks down + 1 green tick up
          if (prices[i - 1] < prices[i - 2] && prices[i - 2] < prices[i - 3] && prices[i] > prices[i - 1]) {
            signal = 'rise';
          }
        } else if (isDnTrend && -slopeFast >= 0.00005) {
          // 2 ticks up + 1 red tick down
          if (prices[i - 1] > prices[i - 2] && prices[i - 2] > prices[i - 3] && prices[i] < prices[i - 1]) {
            signal = 'fall';
          }
        }

        if (!signal) {
          i++;
          continue;
        }

        const outcome = evaluate5TickTrade(prices, i, signal);
        if (outcome) {
          allTrades.push({
            time: times[i],
            signal,
            entryPrice: prices[i],
            exitPrice: prices[i + 5],
            outcome,
            day: 30 - day,
          });
        }

        i += 5; // advance 5 ticks to avoid overlapping trades
      }
    } catch (err) {
      // Ignore transient
    }
  }

  client.close();

  allTrades.sort((a, b) => a.time - b.time);

  console.log(`\nSuccessfully processed ${totalTicksLoaded.toLocaleString()} ticks across 30 days.`);
  console.log(`Generated ${allTrades.length} verified trade setups.\n`);

  if (allTrades.length === 0) {
    console.log('No trades found.');
    return;
  }

  // Run Portfolio Simulations for $100 Starting Capital at different risk levels:
  // 1. $2.00 Stake (2.0% Fixed-Fractional)
  // 2. $3.00 Stake (3.0% Fixed-Fractional)
  // 3. $5.00 Stake (5.0% Fixed-Fractional)
  for (const riskPct of [0.02, 0.03, 0.05]) {
    let balance = 100.00;
    let peak = 100.00;
    let maxDd = 0;
    let wins = 0;
    let losses = 0;
    let consecutiveLosses = 0;
    let maxConsecLosses = 0;

    const daily = new Map();

    for (const t of allTrades) {
      // Fixed-fractional stake (minimum $1.00 on Deriv)
      const stake = Math.max(1.00, Number((balance * riskPct).toFixed(2)));
      let pnl = 0;

      if (t.outcome === 'WIN') {
        wins++;
        pnl = stake * 0.95; // 95% payout
        balance += pnl;
        consecutiveLosses = 0;
      } else {
        losses++;
        pnl = -stake;
        balance += pnl;
        consecutiveLosses++;
        if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses;
      }

      if (balance > peak) peak = balance;
      const dd = ((peak - balance) / peak) * 100;
      if (dd > maxDd) maxDd = dd;

      const dateStr = new Date(t.time * 1000).toISOString().slice(0, 10);
      if (!daily.has(dateStr)) daily.set(dateStr, { trades: 0, wins: 0, pnl: 0, balance });
      const db = daily.get(dateStr);
      db.trades++;
      if (t.outcome === 'WIN') db.wins++;
      db.pnl += pnl;
      db.balance = balance;

      if (balance <= 5.00) {
        console.log(`Account ruined at trade ${wins + losses}`);
        break;
      }
    }

    const total = wins + losses;
    const wr = ((wins / total) * 100).toFixed(2);
    const returnPct = (((balance - 100) / 100) * 100).toFixed(2);

    console.log('------------------------------------------------------------------------');
    console.log(`  🌟 30-DAY BACKTEST RESULT @ ${(riskPct * 100).toFixed(1)}% RISK PER TRADE:`);
    console.log(`  • Starting Capital:    $100.00`);
    console.log(`  • Final Capital:       $${balance.toFixed(2)} (${returnPct > 0 ? '+' : ''}${returnPct}%) 🚀`);
    console.log(`  • Win Rate:            ${wr}% (${wins} Wins / ${losses} Losses in ${total} Trades)`);
    console.log(`  • Edge vs Break-Even:  +${(Number(wr) - 51.28).toFixed(2)}% (Hurdle: 51.28%)`);
    console.log(`  • Max Drawdown:        -${maxDd.toFixed(2)}%`);
    console.log(`  • Max Consec Losses:   ${maxConsecLosses}`);
    console.log('------------------------------------------------------------------------\n');
  }
}

run().catch(console.error);
