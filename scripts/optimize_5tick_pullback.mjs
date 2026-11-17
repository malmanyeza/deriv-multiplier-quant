import WebSocket from 'ws';

/**
 * 5-TICK RISE/FALL QUANT OPTIMIZATION: CONFLUENCE FILTERS
 * 
 * Target: Push the 55.20% win rate on 1HZ50V and R_75 towards 58%-62%
 * by adding:
 * 1. Trend Momentum Velocity (Slope of EMA 12)
 * 2. Volatility Expansion (Tick range / standard deviation filter)
 * 3. Exact 2-Tick vs 2-Tick + Rejection Wick Trigger
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

async function fetchTicks(client, symbol, targetCount) {
  let end = 'latest';
  const allPrices = [];
  const allTimes = [];
  const pages = Math.ceil(targetCount / 5000);

  for (let p = 0; p < pages; p++) {
    try {
      await sleep(350);
      const res = await client.request({
        ticks_history: symbol,
        end,
        count: 5000,
        style: 'ticks',
      });
      const h = res.history;
      if (!h || !Array.isArray(h.prices) || h.prices.length === 0) break;
      allPrices.unshift(...h.prices);
      allTimes.unshift(...h.times);
      end = h.times[0] - 1;
      if (h.prices.length < 500) break;
    } catch {
      break;
    }
  }

  return { prices: allPrices, times: allTimes };
}

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
  console.log('  5-TICK HIGH-WIN-RATE QUANT: DEEP OPTIMIZATION ON 1HZ50V & R_75');
  console.log('  Testing Velocity Filters, Momentum Slopes & Reversal Rejections');
  console.log('========================================================================\n');

  for (const sym of ['1HZ50V', 'R_75', '1HZ25V']) {
    process.stdout.write(`Fetching 15,000 real ticks for ${sym}... `);
    const { prices } = await fetchTicks(client, sym, 15000);
    console.log(`Loaded ${prices.length} ticks.`);

    if (prices.length < 3000) continue;

    const emaFast = computeEMA(prices, 10);
    const emaMid = computeEMA(prices, 25);
    const emaSlow = computeEMA(prices, 60);

    const configs = [
      { name: 'Standard 2-Tick Pullback (Baseline)', minSlope: 0, requireTurnTick: false },
      { name: '2-Tick Pullback + Strong EMA Velocity', minSlope: 0.00005, requireTurnTick: false },
      { name: '2-Tick Pullback + Confirmation Turn Tick', minSlope: 0, requireTurnTick: true },
      { name: 'Elite Confluence: Velocity + Confirmation Turn Tick', minSlope: 0.00005, requireTurnTick: true },
    ];

    for (const cfg of configs) {
      let wins = 0;
      let losses = 0;
      let netProfit = 0;
      let maxConsecLosses = 0;
      let curConsec = 0;
      const stake = 10;
      const payout = 9.50;

      let i = 80;
      while (i < prices.length - 6) {
        const isUpTrend = emaFast[i] > emaMid[i] && emaMid[i] > emaSlow[i];
        const isDnTrend = emaFast[i] < emaMid[i] && emaMid[i] < emaSlow[i];

        const slopeFast = (emaFast[i] - emaFast[i - 5]) / emaFast[i];

        let signal = null;

        if (isUpTrend && slopeFast >= cfg.minSlope) {
          if (cfg.requireTurnTick) {
            // Price pulled back for 2 ticks, then tick i shows the first green uptick!
            if (prices[i - 1] < prices[i - 2] && prices[i - 2] < prices[i - 3] && prices[i] > prices[i - 1]) {
              signal = 'rise';
            }
          } else {
            // Exactly 2 red ticks down in up-trend
            if (prices[i] < prices[i - 1] && prices[i - 1] < prices[i - 2]) {
              signal = 'rise';
            }
          }
        } else if (isDnTrend && -slopeFast >= cfg.minSlope) {
          if (cfg.requireTurnTick) {
            // Price pulled back for 2 ticks up, then tick i shows the first red downtick!
            if (prices[i - 1] > prices[i - 2] && prices[i - 2] > prices[i - 3] && prices[i] < prices[i - 1]) {
              signal = 'fall';
            }
          } else {
            // Exactly 2 green ticks up in down-trend
            if (prices[i] > prices[i - 1] && prices[i - 1] > prices[i - 2]) {
              signal = 'fall';
            }
          }
        }

        if (!signal) {
          i++;
          continue;
        }

        const res = evaluate5TickTrade(prices, i, signal);
        if (res === 'WIN') {
          wins++;
          netProfit += payout;
          curConsec = 0;
        } else if (res === 'LOSS') {
          losses++;
          netProfit -= stake;
          curConsec++;
          if (curConsec > maxConsecLosses) maxConsecLosses = curConsec;
        }

        i += 5; // non-overlapping evaluation
      }

      const total = wins + losses;
      if (total < 15) continue;
      const wr = ((wins / total) * 100).toFixed(2);
      const edge = (Number(wr) - 51.28).toFixed(2);
      const sign = netProfit >= 0 ? '+' : '';
      const flag = Number(wr) >= 57 ? '🚀 EXCELLENT (>57%)' : Number(wr) >= 53 ? '✅ PROFITABLE' : '⚠️ WEAK';

      console.log(`    • ${cfg.name}:`);
      console.log(`      Trades: ${total} | Win Rate: ${wr}% (Edge: ${edge > 0 ? '+' : ''}${edge}%) | P&L: ${sign}$${netProfit.toFixed(2)} | Max Cons. Losses: ${maxConsecLosses} | ${flag}`);
    }
    console.log('');
  }

  client.close();
}

run().catch(console.error);
