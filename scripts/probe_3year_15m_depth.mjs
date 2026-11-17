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

async function probeDepth(client, symbol) {
  let end = 'latest';
  let totalBars = 0;
  let oldestDate = '';
  let newestDate = '';

  console.log(`Checking 3-year history depth for ${symbol} on 15m (granularity: 900)...`);

  // Target 110,000 bars = ~1,145 days = ~3.1 years
  for (let p = 0; p < 115; p++) {
    let retries = 3;
    let list = null;

    while (retries > 0) {
      try {
        await sleep(400);
        const res = await client.request({
          ticks_history: symbol,
          style: 'candles',
          granularity: 900,
          count: 1000,
          end,
        });
        list = res.candles || [];
        break;
      } catch (err) {
        if (err.message.includes('rate limit') || err.message.includes('ticks_history_expensive')) {
          await sleep(2000);
          retries--;
        } else {
          console.log(`[${symbol}] Stopped at page ${p}: ${err.message}`);
          return { symbol, totalBars, oldestDate, newestDate };
        }
      }
    }

    if (!list || list.length === 0) {
      console.log(`[${symbol}] Reached end of history at page ${p} (empty list).`);
      break;
    }

    totalBars += list.length;
    if (!newestDate) newestDate = new Date(Number(list[list.length - 1].epoch) * 1000).toISOString();
    oldestDate = new Date(Number(list[0].epoch) * 1000).toISOString();
    end = Number(list[0].epoch) - 1;

    if (p % 10 === 0 && p > 0) {
      console.log(`  -> Page ${p}: ${totalBars} bars fetched so far (Back to ${oldestDate.split('T')[0]})...`);
    }

    if (list.length < 20) {
      console.log(`[${symbol}] Reached end of historical records: only ${list.length} bars on page ${p}.`);
      break;
    }
  }

  return { symbol, totalBars, oldestDate, newestDate };
}

async function run() {
  const client = await createClient();
  const res = await probeDepth(client, '1HZ100V');
  console.log(`\n========================================================================`);
  console.log(`Result for ${res.symbol}:`);
  console.log(`• Total 15M Bars: ${res.totalBars}`);
  console.log(`• Days Covered:   ${(res.totalBars / 96).toFixed(1)} days (~${(res.totalBars / 96 / 365).toFixed(2)} years)`);
  console.log(`• Date Range:     ${res.oldestDate.split('T')[0]} to ${res.newestDate.split('T')[0]}`);
  console.log(`========================================================================\n`);
  client.close();
}

run().catch(console.error);
