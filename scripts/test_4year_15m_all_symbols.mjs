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
        if (msg.error) p.rej(new Error(msg.error.message || msg.error.code));
        else p.res(msg);
      }
    });

    ws.on('error', (err) => reject(err));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeSymbolOldest(client, symbol) {
  // Try querying 15m candle from 4 years ago (November 2022 = epoch 1667952000)
  const targetEpoch4YearsAgo = Math.floor(Date.now() / 1000) - (4 * 365 * 86400);

  try {
    await sleep(350);
    const res = await client.request({
      ticks_history: symbol,
      style: 'candles',
      granularity: 900,
      count: 10,
      end: targetEpoch4YearsAgo + 86400, // Query around Nov 2022
    });

    const candles = res.candles || [];
    if (candles.length > 0) {
      const d = new Date(Number(candles[0].epoch) * 1000).toISOString().split('T')[0];
      return { symbol, has4Years: true, date: d, count: candles.length };
    }
  } catch (err) {
    return { symbol, has4Years: false, error: err.message };
  }

  // Also query without end parameter to find the oldest reachable epoch by jumping back
  return { symbol, has4Years: false, error: 'Empty candles returned for 2022' };
}

async function run() {
  const client = await createClient();
  const testList = [
    'cryBTCUSD',
    'cryETHUSD',
    'frxXAUUSD',
    'frxEURUSD',
    '1HZ100V',
    'R_100',
    'R_50',
    'R_25',
    'R_10',
  ];

  console.log(`Testing Deriv 15M candles for 4-year historical reach (Nov 2022)...`);

  for (const sym of testList) {
    const res = await probeSymbolOldest(client, sym);
    console.log(`• ${sym.padEnd(10)}: has4Years=${res.has4Years} | detail: ${res.date || res.error}`);
  }

  client.close();
}

run().catch(console.error);
