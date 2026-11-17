import WebSocket from 'ws';

/**
 * OPTION A: 1-MINUTE RISE/FALL QUANT BACKTEST
 * Period: Past 30 Days (43,200 one-minute candles)
 * Starting Balance: $100.00
 * Payout: 95.4% (Profit = +95.4% of stake on win, -100% on loss)
 * Assets: R_75, 1HZ100V, 1HZ50V
 * 
 * Strategy: Trend Pullback Continuation
 * - Trend Filter: EMA(9) > EMA(21) (for Rise) or EMA(9) < EMA(21) (for Fall)
 * - Momentum Filter: ADX(14) >= 20 (avoiding flat chop)
 * - Pullback: Candle [i-1] was counter-trend (Red candle in uptrend, Green candle in downtrend)
 * - Entry: At open of candle [i], trade Rise if Trend is UP, or Fall if Trend is DOWN
 * - Expiry: 1 minute (close of candle [i] vs open of candle [i])
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

function computeADX(candles, period = 14) {
  const n = candles.length;
  const adx = new Float64Array(n);
  if (n < period * 2) return adx;

  const tr = new Float64Array(n);
  const plusDM = new Float64Array(n);
  const minusDM = new Float64Array(n);

  for (let i = 1; i < n; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const prevH = candles[i - 1].high;
    const prevL = candles[i - 1].low;
    const prevC = candles[i - 1].close;

    tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    const upMove = h - prevH;
    const downMove = prevL - l;

    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let trSmooth = 0;
  let plusDMSmooth = 0;
  let minusDMSmooth = 0;

  for (let i = 1; i <= period; i++) {
    trSmooth += tr[i];
    plusDMSmooth += plusDM[i];
    minusDMSmooth += minusDM[i];
  }

  const dx = new Float64Array(n);

  for (let i = period + 1; i < n; i++) {
    trSmooth = trSmooth - trSmooth / period + tr[i];
    plusDMSmooth = plusDMSmooth - plusDMSmooth / period + plusDM[i];
    minusDMSmooth = minusDMSmooth - minusDMSmooth / period + minusDM[i];

    const plusDI = trSmooth > 0 ? (plusDMSmooth / trSmooth) * 100 : 0;
    const minusDI = trSmooth > 0 ? (minusDMSmooth / trSmooth) * 100 : 0;
    const diSum = plusDI + minusDI;
    dx[i] = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
  }

  let adxSum = 0;
  for (let i = period + 1; i <= period * 2; i++) {
    adxSum += dx[i];
  }
  let currentADX = adxSum / period;
  adx[period * 2] = currentADX;

  for (let i = period * 2 + 1; i < n; i++) {
    currentADX = (currentADX * (period - 1) + dx[i]) / period;
    adx[i] = currentADX;
  }

  return adx;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetch1MinCandles(client, symbol, totalCandles = 10000) {
  let fetched = [];
  let end = 'latest';

  while (fetched.length < totalCandles) {
    await sleep(200);
    const res = await client.request({
      ticks_history: symbol,
      style: 'candles',
      granularity: 60, // 1 minute
      count: 1000,
      end,
    });

    const list = res.candles || [];
    if (list.length === 0) break;

    fetched = [...list, ...fetched];
    end = list[0].epoch - 1;
    if (list.length < 500) break;
  }

  // Deduplicate and sort by epoch ascending
  const map = new Map();
  for (const c of fetched) {
    map.set(c.epoch, {
      epoch: c.epoch,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    });
  }

  const sorted = Array.from(map.values()).sort((a, b) => a.epoch - b.epoch);
  return sorted;
}

async function runBacktestForSymbol(client, symbol, totalCandles = 10000) {
  console.log(`\nFetching 1-Minute historical candles for ${symbol}...`);
  const candles = await fetch1MinCandles(client, symbol, totalCandles);
  console.log(`Loaded ${candles.length} continuous 1-minute candles for ${symbol}.`);

  const closes = candles.map((c) => c.close);
  const emaFast = computeEMA(closes, 9);
  const emaSlow = computeEMA(closes, 21);
  const adx = computeADX(candles, 14);

  const PAYOUT_RATE = 0.954; // 95.4% Deriv 1-min payout
  const BREAKEVEN_WINRATE = 1 / (1 + PAYOUT_RATE); // 51.18%

  // Test across multiple ADX thresholds and pullback variants
  const experiments = [
    { name: 'ADX >= 20 (Mild Trend + 1 Red Pullback)', adxMin: 20, pullbackBars: 1 },
    { name: 'ADX >= 25 (Strong Trend + 1 Red Pullback)', adxMin: 25, pullbackBars: 1 },
    { name: 'ADX >= 28 (Aggressive Momentum + 1 Red Pullback)', adxMin: 28, pullbackBars: 1 },
    { name: 'ADX >= 25 (Strong Trend + 2 Red Pullbacks)', adxMin: 25, pullbackBars: 2 },
  ];

  for (const exp of experiments) {
    let wins = 0;
    let losses = 0;
    let balance = 100.0;
    const RISK_PCT = 0.02; // 2% fixed-fractional
    let maxDD = 0;
    let peakBalance = balance;
    let maxConsecLosses = 0;
    let currentConsecLosses = 0;

    for (let i = 35; i < candles.length - 1; i++) {
      const isUpTrend = emaFast[i - 1] > emaSlow[i - 1] && adx[i - 1] >= exp.adxMin;
      const isDnTrend = emaFast[i - 1] < emaSlow[i - 1] && adx[i - 1] >= exp.adxMin;

      let signal = null;

      if (isUpTrend) {
        // Pullback: previous candle(s) were red
        let isPullback = true;
        for (let k = 1; k <= exp.pullbackBars; k++) {
          if (candles[i - k].close >= candles[i - k].open) isPullback = false;
        }
        if (isPullback) signal = 'rise';
      } else if (isDnTrend) {
        // Pullback: previous candle(s) were green
        let isPullback = true;
        for (let k = 1; k <= exp.pullbackBars; k++) {
          if (candles[i - k].close <= candles[i - k].open) isPullback = false;
        }
        if (isPullback) signal = 'fall';
      }

      if (!signal) continue;

      // Evaluate 1-minute candle: Entry at open of candle [i], Exit at close of candle [i]
      const entrySpot = candles[i].open;
      const exitSpot = candles[i].close;

      const stake = balance * RISK_PCT;
      if (stake < 0.35) {
        // Account depleted below minimum Deriv stake ($0.35)
        break;
      }

      const isWin =
        signal === 'rise' ? exitSpot > entrySpot : exitSpot < entrySpot;

      if (isWin) {
        wins++;
        currentConsecLosses = 0;
        balance += stake * PAYOUT_RATE;
      } else {
        losses++;
        currentConsecLosses++;
        if (currentConsecLosses > maxConsecLosses) {
          maxConsecLosses = currentConsecLosses;
        }
        balance -= stake;
      }

      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const netEdge = winRate - BREAKEVEN_WINRATE * 100;
    const netReturn = ((balance - 100) / 100) * 100;

    console.log(`\n  --- Experiment: ${exp.name} ---`);
    console.log(`  • Trades Executed:   ${totalTrades}`);
    console.log(`  • Win Rate:          ${winRate.toFixed(2)}% (${wins}W / ${losses}L)`);
    console.log(`  • Break-Even Hurdle: ${(BREAKEVEN_WINRATE * 100).toFixed(2)}% | Net Edge: ${netEdge >= 0 ? '+' : ''}${netEdge.toFixed(2)}%`);
    console.log(`  • Ending Balance:    $${balance.toFixed(2)} (${netReturn >= 0 ? '+' : ''}${netReturn.toFixed(2)}%)`);
    console.log(`  • Max Drawdown:      -${maxDD.toFixed(2)}% | Max Consec Losses: ${maxConsecLosses}`);
  }
}

async function main() {
  const client = await createClient();
  console.log('========================================================================');
  console.log('  OPTION A: 1-MINUTE RISE/FALL QUANT BACKTEST (DERIV SYNTHETICS)');
  console.log('  Testing Trend Pullback Continuation on 1-Minute Candles');
  console.log('  Starting Capital: $100.00 | Payout: 95.4% | Risk: 2.0% per trade');
  console.log('========================================================================');

  try {
    await runBacktestForSymbol(client, 'R_75', 10000); // 10,000 continuous 1-min candles = ~7 full days
    await runBacktestForSymbol(client, '1HZ100V', 10000);
  } finally {
    client.close();
  }
}

main().catch(console.error);
