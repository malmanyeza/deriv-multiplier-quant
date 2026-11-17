import WebSocket from 'ws';

/**
 * 5-TICK RISE/FALL QUANTITATIVE PULLBACK RESEARCH
 * 
 * Objective:
 * Discover if micro-pullbacks (1, 2, or 3 ticks in opposite direction)
 * inside a confirmed 1-2 minute macro trend generate a statistically
 * significant edge (>51.28% break-even win rate) on 5-tick Rise/Fall contracts.
 * 
 * Payout Model:
 * - Stake: $10.00
 * - Payout: 95.0% (Profit = +$9.50 on win, Loss = -$10.00 on loss)
 * - Break-even Win Rate = 1 / (1 + 0.95) = 51.28%
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

      const history = res.history;
      if (!history || !Array.isArray(history.prices) || history.prices.length === 0) break;

      allPrices.unshift(...history.prices);
      allTimes.unshift(...history.times);

      end = history.times[0] - 1;
      if (history.prices.length < 500) break;
    } catch (err) {
      console.warn(`[Fetch error on ${symbol}]:`, err.message);
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

function computeTickRSI(prices, period = 5) {
  const rsi = new Float64Array(prices.length).fill(50);
  if (prices.length <= period) return rsi;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  rsi[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    gain = (gain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    loss = (loss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return rsi;
}

// Evaluate 5-tick Rise/Fall outcome:
// direction: 'rise' (CALL) or 'fall' (PUT)
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
  console.log('  5-TICK RISE/FALL QUANT RESEARCH: TREND PULLBACK OPTIMIZATION');
  console.log('  Testing on Live Deriv Synthetic Index Ticks (Duration: Exactly 5 Ticks)');
  console.log('  Break-even Win Rate Hurdle: 51.28% (at 95% payout)');
  console.log('========================================================================\n');

  const symbols = ['1HZ100V', 'R_75', '1HZ50V', 'R_100'];

  for (const sym of symbols) {
    process.stdout.write(`Fetching 25,000 live ticks for ${sym}... `);
    const { prices } = await fetchTicks(client, sym, 25000);
    console.log(`Loaded ${prices.length} ticks.`);

    if (prices.length < 5000) continue;

    // Precalculate technical indicators on tick stream
    const emaFast = computeEMA(prices, 12);
    const emaSlow = computeEMA(prices, 36);
    const emaTrend = computeEMA(prices, 90);
    const tickRsi = computeTickRSI(prices, 5);

    // 1. Benchmark: Null Hypothesis (Random entry on every 5th tick)
    let bWins = 0, bLosses = 0;
    for (let i = 100; i < prices.length - 10; i += 5) {
      const res = evaluate5TickTrade(prices, i, Math.random() > 0.5 ? 'rise' : 'fall');
      if (res === 'WIN') bWins++;
      else if (res === 'LOSS') bLosses++;
    }
    const bTotal = bWins + bLosses;
    const bWr = ((bWins / bTotal) * 100).toFixed(2);
    console.log(`  📊 Baseline Random Win Rate on ${sym}: ${bWr}% (${bWins}W / ${bLosses}L in ${bTotal} trades)`);

    // 2. Test Variations of User's Concept:
    // Strategy A: 1-Tick Pullback in Macro Trend
    // Strategy B: 2-Tick Pullback in Macro Trend
    // Strategy C: 3-Tick Pullback in Macro Trend
    // Strategy D: Deep Pullback + RSI Oversold Hook in Macro Trend

    const strategies = [
      { name: '1-Tick Pullback (1 opposite tick)', pullbacks: 1, useRsi: false },
      { name: '2-Tick Pullback (2 opposite ticks)', pullbacks: 2, useRsi: false },
      { name: '3-Tick Pullback (3 opposite ticks)', pullbacks: 3, useRsi: false },
      { name: 'RSI(5) Extreme Dip (<25 / >75) in Trend', pullbacks: 1, useRsi: true },
    ];

    for (const strat of strategies) {
      let wins = 0;
      let losses = 0;
      let consecutiveLosses = 0;
      let maxConsecLosses = 0;
      let netProfit = 0;
      const stake = 10;
      const payout = 9.50;

      let i = 120;
      while (i < prices.length - 6) {
        const isUpTrend = emaFast[i] > emaSlow[i] && emaSlow[i] > emaTrend[i];
        const isDnTrend = emaFast[i] < emaSlow[i] && emaSlow[i] < emaTrend[i];

        let signal = null;

        if (strat.useRsi) {
          // RSI extreme dip in direction of macro trend
          if (isUpTrend && tickRsi[i] <= 25 && prices[i] > prices[i - 1]) {
            signal = 'rise';
          } else if (isDnTrend && tickRsi[i] >= 75 && prices[i] < prices[i - 1]) {
            signal = 'fall';
          }
        } else {
          // Consecutive counter-trend ticks in direction of macro trend
          if (isUpTrend) {
            let counterTicks = 0;
            for (let k = 0; k < strat.pullbacks; k++) {
              if (prices[i - k] < prices[i - k - 1]) counterTicks++;
            }
            if (counterTicks === strat.pullbacks) {
              signal = 'rise';
            }
          } else if (isDnTrend) {
            let counterTicks = 0;
            for (let k = 0; k < strat.pullbacks; k++) {
              if (prices[i - k] > prices[i - k - 1]) counterTicks++;
            }
            if (counterTicks === strat.pullbacks) {
              signal = 'fall';
            }
          }
        }

        if (!signal) {
          i++;
          continue;
        }

        // Evaluate trade over the next 5 ticks
        const outcome = evaluate5TickTrade(prices, i, signal);
        if (outcome === 'WIN') {
          wins++;
          netProfit += payout;
          consecutiveLosses = 0;
        } else if (outcome === 'LOSS') {
          losses++;
          netProfit -= stake;
          consecutiveLosses++;
          if (consecutiveLosses > maxConsecLosses) maxConsecLosses = consecutiveLosses;
        }

        // Advance 5 ticks so trades don't overlap arbitrarily
        i += 5;
      }

      const total = wins + losses;
      if (total < 20) continue;
      const wr = ((wins / total) * 100).toFixed(2);
      const edge = (Number(wr) - 51.28).toFixed(2);
      const sign = netProfit >= 0 ? '+' : '';
      const statusIcon = Number(wr) > 54 ? '🔥 WINNER' : Number(wr) > 51.28 ? '✅ PROFITABLE' : '❌ UNPROFITABLE';

      console.log(`    • ${strat.name}:`);
      console.log(`      Trades: ${total} | Win Rate: ${wr}% (Edge: ${edge > 0 ? '+' : ''}${edge}%) | P&L: ${sign}$${netProfit.toFixed(2)} | Max Cons. Losses: ${maxConsecLosses} | ${statusIcon}`);
    }
    console.log('');
  }

  client.close();
}

run().catch(console.error);
