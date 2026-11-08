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
        if (msg.error) p.rej(new Error(msg.error.message || msg.error.code));
        else p.res(msg);
      }
    });

    ws.addEventListener('error', (err) => reject(err));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(client, payload, maxRetries = 5) {
  let delay = 1200;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sleep(delay);
      return await client.request(payload);
    } catch (err) {
      console.warn(`[Attempt ${attempt}] Request error: ${err.message}. Backing off...`);
      if (attempt === maxRetries) throw err;
      await sleep(delay * 2);
      delay *= 1.5;
    }
  }
}

async function probeSymbol(client, symbol, targetPages = 36) {
  let end = 'latest';
  let totalCandles = 0;
  let earliest = null;
  let latest = null;

  console.log(`\nProbing ${symbol} for up to ${targetPages} pages (up to ~4 years)...`);

  for (let p = 1; p <= targetPages; p++) {
    const res = await fetchWithRetry(client, {
      ticks_history: symbol,
      style: 'candles',
      granularity: 3600,
      count: 1000,
      end,
    });

    const candles = res.candles || [];
    if (candles.length === 0) {
      console.log(`Page ${p}: 0 candles returned. Reached beginning of archive.`);
      break;
    }

    if (!latest) latest = new Date(Number(candles[candles.length - 1].epoch) * 1000).toISOString();
    earliest = new Date(Number(candles[0].epoch) * 1000).toISOString();
    totalCandles += candles.length;

    console.log(
      `  Page ${p.toString().padStart(2)}: got ${candles.length} bars | earliest bar: ${earliest.slice(0, 10)} | total: ${totalCandles}`,
    );

    end = Number(candles[0].epoch) - 1;
    if (candles.length < 50) {
      console.log(`Page returned only ${candles.length} bars. Reached start of archive.`);
      break;
    }
  }

  console.log(`=> ${symbol} Summary: ${totalCandles} 1h bars from ${earliest?.slice(0, 10)} to ${latest?.slice(0, 10)}`);
  return { symbol, totalCandles, earliest, latest };
}

async function main() {
  const client = await createClient();
  const symbols = ['cryBTCUSD', 'cryETHUSD', 'frxXAUUSD', 'OTC_NDX'];
  for (const s of symbols) {
    await probeSymbol(client, s, 36);
  }
  client.close();
}

main().catch(console.error);
