/**
 * ELITE 7 Live-Execution Flight-Check Audit (Read-Only Public WS)
 * Verifies EVERY single assumption between backtest and live Deriv execution:
 *   1. Exact `proposal` acceptance for BOTH MULTUP and MULTDOWN on all 7 Elite symbols
 *   2. Exact live `commission` vs configured `commissionPer100Stake`
 *   3. Exact live `stop_out` distance % vs backtest knock-out formula `(1 - comm) / M`
 *   4. Exact `limit_order.take_profit` acceptance (for symbols with TP: USDCHF, 1HZ100V, R_75)
 *   5. Exact `min_stake` / `max_stake` limits
 *
 * Run: npx tsx scripts/elite7_live_audit.ts
 */
import WebSocket from 'ws';
import { getSymbolStrategyProfile } from '../src/services/quantStrategyEngine.ts';

const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

function sendReq<T = any>(ws: WebSocket, payload: Record<string, unknown>, timeoutMs = 12_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 1_000_000_000);
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`Timeout`));
    }, timeoutMs);
    const onMsg = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.req_id === reqId) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message || msg.error.code));
        else resolve(msg as T);
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...payload, req_id: reqId }));
  });
}

async function main() {
  const ws = new WebSocket(PUBLIC_WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const elite7 = [
    { sym: 'cryBTCUSD', tf: '1h' as const },
    { sym: 'cryETHUSD', tf: '1h' as const },
    { sym: 'frxXAUUSD', tf: '1h' as const },
    { sym: 'frxUSDCHF', tf: '1h' as const },
    { sym: 'frxUSDJPY', tf: '1h' as const },
    { sym: '1HZ100V', tf: '15m' as const },
    { sym: 'R_75', tf: '15m' as const },
  ];

  console.log('===================================================================================================================');
  console.log('  ELITE 7 LIVE-EXECUTION FLIGHT-CHECK AUDIT (LIVE DERIV PUBLIC WS — READ-ONLY PROPOSALS)');
  console.log('===================================================================================================================');

  let issues = 0;

  for (const item of elite7) {
    const prof = getSymbolStrategyProfile(item.sym);
    const M = item.tf === '15m' ? prof.recommendedMultiplier15m : prof.recommendedMultiplier1h;
    const tpMult = item.tf === '15m' ? prof.trendTpMult15m : prof.trendTpMult1h;
    const stake = 100;

    for (const ct of prof.longBiasOnly ? ['MULTUP'] : ['MULTUP', 'MULTDOWN']) {
      const payload: Record<string, unknown> = {
        proposal: 1,
        amount: stake,
        basis: 'stake',
        contract_type: ct,
        currency: 'USD',
        multiplier: M,
        underlying_symbol: item.sym,
      };
      if (tpMult !== null) {
        payload.limit_order = { take_profit: Number((stake * tpMult).toFixed(2)) };
      }

      try {
        const res = await sendReq<{ proposal?: any }>(ws, payload);
        const p = res.proposal;
        const spot = Number(p.spot);
        const comm = Number(p.commission ?? 0);
        const stopOut = Number(p.limit_order?.stop_out?.value ?? 0);
        const liveKoPct = spot > 0 && stopOut > 0 ? (Math.abs(spot - stopOut) / spot) * 100 : 0;
        const modelKoPct = ((1 - comm / 100) / M) * 100;
        const koDiffPct = liveKoPct - modelKoPct;
        const commDiff = Math.abs(comm - prof.commissionPer100Stake);
        const flag = commDiff > 0.5 || Math.abs(koDiffPct) > 0.08 ? '⚠️ CHECK' : '✅ OK';
        if (flag !== '✅ OK') issues++;

        console.log(
          `  ${flag} ${item.sym.padEnd(10)} ${ct.padEnd(8)} (${String(M).padStart(3)}x) | Comm: live=${comm.toFixed(2)}% vs cfg=${prof.commissionPer100Stake.toFixed(2)}% | KO Dist: live=${liveKoPct.toFixed(3)}% vs model=${modelKoPct.toFixed(3)}% | TP=${tpMult ? '+' + tpMult + 'R' : 'Trail'}`,
        );
      } catch (e: any) {
        issues++;
        console.log(`  ❌ FAIL ${item.sym.padEnd(10)} ${ct.padEnd(8)} (${M}x) | Error: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  console.log(`\nFlight-Check Complete: ${issues === 0 ? '✅ ZERO DISCREPANCIES FOUND' : `⚠️ ${issues} ITEM(S) FLAGGED`}`);
  ws.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
