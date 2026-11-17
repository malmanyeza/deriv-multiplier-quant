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

async function probeSymbol(client, symbol, targetBars = 36000) {
  let end = 'latest';
  let total = 0;
  let oldestDate = '';
  let newestDate = '';

  for (let p = 0; p < Math.ceil(targetBars / 1000); p++) {
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
      if (list.length === 0) {
        console.log(`[${symbol}] Page ${p}: empty candles list.`);
        break;
      }

      total += list.length;
      if (!newestDate) newestDate = new Date(Number(list[list.length - 1].epoch) * 1000).toISOString();
      oldestDate = new Date(Number(list[0].epoch) * 1000).toISOString();
      end = Number(list[0].epoch) - 1;

      if (list.length < 20) {
        console.log(`[${symbol}] Reached end of historical data: only ${list.length} bars returned.`);
        break;
      }
    } catch (err) {
      console.log(`[${symbol}] Page ${p} error: ${err.message}`);
      break;
    }
  }

  return { symbol, total, newestDate, oldestDate };
}

async function run() {
  const client = await createClient();
  const symbols = ['1HZ100V', 'R_75', '1HZ50V', 'R_100', '1HZ25V'];
  for (const s of symbols) {
    const res = await probeSymbol(client, s, 36000);
    console.log(`Symbol: ${res.symbol.padEnd(8)} | Bars: ${String(res.total).padStart(5)} (~${(res.total / 96).toFixed(1)} days) | From: ${res.oldestDate.split('T')[0]} to ${res.newestDate.split('T')[0]}`);
  }
  client.close();
}

run().catch(console.error);
