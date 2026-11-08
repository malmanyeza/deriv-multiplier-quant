const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

function createClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let reqId = 1;
    const pending = new Map();

    ws.addEventListener('open', () => {
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

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      const p = pending.get(msg.req_id);
      if (p) {
        pending.delete(msg.req_id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg);
      }
    });

    ws.addEventListener('error', (err) => reject(err));
  });
}

async function fetchYearCandles(client, symbol) {
  let end = 'latest';
  const byTime = new Map();
  for (let p = 0; p < 9; p++) {
    const res = await client.request({
      ticks_history: symbol,
      style: 'candles',
      granularity: 3600,
      count: 1000,
      end,
    });
    const candles = res.candles || [];
    if (candles.length === 0) break;
    for (const c of candles) {
      byTime.set(Number(c.epoch), {
        time: Number(c.epoch),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      });
    }
    end = Number(candles[0].epoch) - 1;
    if (candles.length < 20) break;
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
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
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
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
      Math.abs(bars[i].low - bars[i - 1].close),
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

function getProfile(symbol) {
  if (symbol === 'cryBTCUSD') {
    return { comm: 2.99, longBiasOnly: false, pureTrendOnly: false, lookback: 48 };
  }
  if (symbol === 'cryETHUSD') {
    return { comm: 7.99, longBiasOnly: false, pureTrendOnly: false, lookback: 48 };
  }
  if (symbol === 'frxXAUUSD') {
    return { comm: 2.5, longBiasOnly: true, pureTrendOnly: true, lookback: 72 };
  }
  return { comm: 2.5, longBiasOnly: true, pureTrendOnly: false, lookback: 48 };
}

function extractTrades(bars, symbol) {
  const profile = getProfile(symbol);
  const multiplier = 100;
  const commDollars = profile.comm;
  const koMovePct = (100 - commDollars) / (100 * multiplier);

  const closes = bars.map((b) => b.close);
  const ema100 = computeEMA(closes, 100);
  const ema30 = computeEMA(closes, 30);
  const rsi = computeRSI(closes, 14);
  const { atr, adx } = computeADXandATR(bars, 14);
  const lookback = profile.lookback;

  const trades = [];
  let i = 120;
  const endIdx = bars.length;

  while (i < endIdx - 2) {
    const atrPct = bars[i].close > 0 ? atr[i] / bars[i].close : 1;
    if (atrPct > 0.0065) {
      i++;
      continue;
    }

    let mode = null;
    let dir = 0;
    const trendAdxMin = profile.pureTrendOnly ? 20 : 24;

    if (adx[i] >= trendAdxMin) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = Math.max(0, i - lookback); k < i; k++) {
        if (bars[k].high > hi) hi = bars[k].high;
        if (bars[k].low < lo) lo = bars[k].low;
      }
      if (bars[i].close > hi && bars[i].close > ema100[i] && ema30[i] > ema100[i]) {
        dir = 1;
        mode = 'trend';
      } else if (
        !profile.longBiasOnly &&
        bars[i].close < lo &&
        bars[i].close < ema100[i] &&
        ema30[i] < ema100[i]
      ) {
        dir = -1;
        mode = 'trend';
      }
    } else if (!profile.pureTrendOnly && adx[i] <= 20) {
      if (
        rsi[i - 1] < 27 &&
        rsi[i] >= 27 &&
        bars[i].close > bars[i].open &&
        (!profile.longBiasOnly || bars[i].close > ema100[i] * 0.97)
      ) {
        dir = 1;
        mode = 'mr';
      } else if (
        !profile.longBiasOnly &&
        rsi[i - 1] > 73 &&
        rsi[i] <= 73 &&
        bars[i].close < bars[i].open
      ) {
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
    let pnl = 0;
    let exitIdx = lastBar;
    let done = false;

    for (let j = i + 1; j <= lastBar; j++) {
      if (
        (dir === 1 && bars[j].low <= koPrice) ||
        (dir === -1 && bars[j].high >= koPrice)
      ) {
        pnl = -100;
        exitIdx = j;
        done = true;
        break;
      }

      if (mode === 'mr') {
        const tpMove = (160 + commDollars) / (100 * multiplier);
        const tpPrice = dir === 1 ? entry * (1 + tpMove) : entry * (1 - tpMove);
        if (
          (dir === 1 && bars[j].high >= tpPrice) ||
          (dir === -1 && bars[j].low <= tpPrice)
        ) {
          pnl = 160;
          exitIdx = j;
          done = true;
          break;
        }
        if (j < lastBar && ((dir === 1 && rsi[j] > 58) || (dir === -1 && rsi[j] < 42))) {
          const ex = bars[j + 1].open;
          pnl = Math.max(
            -100,
            100 * multiplier * dir * ((ex - entry) / entry) - commDollars,
          );
          exitIdx = j + 1;
          done = true;
          break;
        }
      } else if (j < lastBar) {
        if (
          (dir === 1 && bars[j].close < ema30[j]) ||
          (dir === -1 && bars[j].close > ema30[j])
        ) {
          const ex = bars[j + 1].open;
          pnl = Math.max(
            -100,
            100 * multiplier * dir * ((ex - entry) / entry) - commDollars,
          );
          exitIdx = j + 1;
          done = true;
          break;
        }
      }
    }

    if (!done) {
      const ex = bars[lastBar].close;
      pnl = Math.max(-100, 100 * multiplier * dir * ((ex - entry) / entry) - commDollars);
    }

    trades.push({
      symbol,
      entryTime,
      exitTime: bars[exitIdx].time,
      r: pnl / 100, // e.g. -1.00 for Stop-Out, +3.50 for +350% winner
    });
    i = exitIdx + 1;
  }

  return trades;
}

function analyzeStreaks(trades) {
  let curConsecLosses = 0;
  let curStreakLossR = 0;
  let maxConsecLosses = 0;
  let maxConsecStreakLossR = 0;

  let cumR = 0;
  let peakR = 0;
  let maxDdR = 0;

  for (const t of trades) {
    cumR += t.r;
    if (cumR > peakR) peakR = cumR;
    if (peakR - cumR > maxDdR) maxDdR = peakR - cumR;

    if (t.r <= 0) {
      curConsecLosses += 1;
      curStreakLossR += Math.abs(t.r);
      if (
        curConsecLosses > maxConsecLosses ||
        (curConsecLosses === maxConsecLosses && curStreakLossR > maxConsecStreakLossR)
      ) {
        maxConsecLosses = curConsecLosses;
        maxConsecStreakLossR = curStreakLossR;
      }
    } else {
      curConsecLosses = 0;
      curStreakLossR = 0;
    }
  }

  return {
    n: trades.length,
    netR: cumR,
    maxDdR,
    maxConsecLosses,
    maxConsecStreakLossR,
  };
}

function simulateSizingRule(trades, startBalance, mode, param) {
  let bal = startBalance;
  let peakBal = startBalance;
  let maxDdPct = 0;
  let maxDdDollar = 0;

  let streakStartBal = startBalance;
  let maxConsecLossPct = 0;
  let inLossStreak = false;
  let recentSymbolR = new Map();

  for (const t of trades) {
    let stake = 0;
    if (mode === 'fixed') {
      stake = Math.min(bal, param); // e.g. $10 flat stake
    } else if (mode === 'pct') {
      stake = Math.max(1, bal * param);
    } else if (mode === 'quarter_kelly_throttled') {
      const symHistory = recentSymbolR.get(t.symbol) || [];
      const rolling15 = symHistory.slice(-15).reduce((a, b) => a + b, 0);
      const throttled = symHistory.length >= 5 && rolling15 <= -5.0;
      const pct = throttled ? param * 0.5 : param;
      stake = Math.max(1, bal * pct);
      symHistory.push(t.r);
      recentSymbolR.set(t.symbol, symHistory);
    }

    if (bal < 1) {
      bal = 0;
      maxDdPct = 100;
      break;
    }

    if (t.r <= 0 && !inLossStreak) {
      inLossStreak = true;
      streakStartBal = bal;
    } else if (t.r > 0) {
      inLossStreak = false;
    }

    const dollarPnl = stake * t.r;
    bal = Math.max(0, bal + dollarPnl);

    if (t.r <= 0 && inLossStreak && streakStartBal > 0) {
      const streakDropPct = ((streakStartBal - bal) / streakStartBal) * 100;
      if (streakDropPct > maxConsecLossPct) {
        maxConsecLossPct = streakDropPct;
      }
    }

    if (bal > peakBal) peakBal = bal;
    const ddDollar = peakBal - bal;
    const ddPct = peakBal > 0 ? (ddDollar / peakBal) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
    if (ddDollar > maxDdDollar) maxDdDollar = ddDollar;
  }

  return {
    finalBalance: bal,
    netProfitDollar: bal - startBalance,
    netReturnPct: ((bal - startBalance) / startBalance) * 100,
    maxConsecLossPct,
    maxDdPct,
    maxDdDollar,
  };
}

function runMonteCarloRuin(trades, trials, startBalance, mode, param) {
  const n = trades.length;
  let dd25Count = 0;
  let dd50Count = 0;
  let ruin80Count = 0;
  let worstStreakSeen = 0;
  const endingBalances = [];

  // Deterministic LCG PRNG for reproducible Monte Carlo
  let seed = 133742;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  for (let sim = 0; sim < trials; sim++) {
    let bal = startBalance;
    let peak = startBalance;
    let maxDdPct = 0;
    let consecLosses = 0;
    let recentR = [];

    for (let k = 0; k < n; k++) {
      const pick = trades[Math.floor(rand() * n)];
      let stake = 0;
      if (mode === 'fixed') {
        stake = Math.min(bal, param);
      } else if (mode === 'pct') {
        stake = Math.max(1, bal * param);
      } else if (mode === 'quarter_kelly_throttled') {
        const rolling15 = recentR.slice(-15).reduce((a, b) => a + b, 0);
        const throttled = recentR.length >= 5 && rolling15 <= -5.0;
        const pct = throttled ? param * 0.5 : param;
        stake = Math.max(1, bal * pct);
        recentR.push(pick.r);
      }

      bal = Math.max(0, bal + stake * pick.r);
      if (pick.r <= 0) {
        consecLosses += 1;
        if (consecLosses > worstStreakSeen) worstStreakSeen = consecLosses;
      } else {
        consecLosses = 0;
      }

      if (bal > peak) peak = bal;
      const ddPct = peak > 0 ? ((peak - bal) / peak) * 100 : 100;
      if (ddPct > maxDdPct) maxDdPct = ddPct;
      if (bal < 100 || ddPct >= 80) {
        maxDdPct = Math.max(maxDdPct, 80);
        if (bal < 10) break;
      }
    }

    if (maxDdPct >= 25) dd25Count += 1;
    if (maxDdPct >= 50) dd50Count += 1;
    if (maxDdPct >= 80 || bal <= startBalance * 0.2) ruin80Count += 1;
    endingBalances.push(bal);
  }

  endingBalances.sort((a, b) => a - b);
  const medianBal = endingBalances[Math.floor(trials * 0.5)];
  const p5Bal = endingBalances[Math.floor(trials * 0.05)];

  return {
    probDd25Pct: (dd25Count / trials) * 100,
    probDd50Pct: (dd50Count / trials) * 100,
    probRuin80Pct: (ruin80Count / trials) * 100,
    medianEndingBal: medianBal,
    worst5thPctBal: p5Bal,
    worstStreakSeen,
  };
}


