import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  canApplySeriesUpdate,
  deriveRiseFallChartOverlays,
  normalizeLiveOhlc,
  normalizeTickHistory,
} from '../services/chartFeed';
import { normalizeOpenContract } from '../services/positionNormalizer';
import { DerivSocketOwner } from '../services/derivSocket';
import { extractRiseFallRules } from '../services/marketData';
import { useTradeLifecycle } from '../hooks/useTradeLifecycle';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { createApp } from '../../server/index';
import { InMemorySessionStore } from '../../server/sessionStore';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  url: string;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Set<(ev: { data?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.emit('open', {});
    });
  }

  addEventListener(type: string, cb: (ev: { data?: string }) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  emit(type: string, ev: { data?: string }) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(ev);
    }
  }

  serverPush(payload: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(payload) });
  }
}

describe('Chart feed & overlay derivation', () => {
  it('sorts and deduplicates tick history, parses OHLC strings, and guards monotonic updates', () => {
    const ticks = normalizeTickHistory({
      times: [1700000003, 1700000001, 1700000003, 1700000002],
      prices: ['101.25', '100.50', '101.30', '100.75'],
    });

    expect(ticks.map((t) => Number(t.time))).toEqual([
      1700000001,
      1700000002,
      1700000003,
    ]);
    expect(ticks[2].value).toBe(101.3);

    const ohlc = normalizeLiveOhlc({
      ohlc: {
        open_time: 1700000060,
        epoch: 1700000075,
        open: '150.10',
        high: '152.00',
        low: '149.90',
        close: '151.45',
        pip_size: 2,
        symbol: '1HZ100V',
      },
    });
    expect(ohlc?.candle).toEqual({
      time: 1700000060,
      open: 150.1,
      high: 152,
      low: 149.9,
      close: 151.45,
    });

    expect(canApplySeriesUpdate(1700000060, 1700000059)).toBe(false);
    expect(canApplySeriesUpdate(1700000060, 1700000060)).toBe(true);
    expect(canApplySeriesUpdate(1700000060, 1700000061)).toBe(true);
  });

  it('normalizes proposal_open_contract string amounts and clears overlays on symbol switch', () => {
    const pos = normalizeOpenContract({
      contract_id: 9001,
      contract_type: 'CALL',
      underlying_symbol: '1HZ100V',
      currency: 'USD',
      buy_price: '10.00',
      bid_price: '14.20',
      payout: '19.50',
      profit: '4.20',
      profit_percentage: 42,
      purchase_time: 1700000010,
      date_start: 1700000010,
      date_expiry: 1700000025,
      entry_spot: '1234.56',
      entry_spot_time: 1700000011,
      current_spot: '1235.10',
      is_sold: 0,
      is_valid_to_sell: 1,
      tick_count: 5,
      tick_stream: [{ epoch: 1700000011, tick: 1234.56 }],
    });

    expect(pos).not.toBeNull();
    expect(pos!.buyPrice).toBe(10);
    expect(pos!.bidPrice).toBe(14.2);
    expect(pos!.isValidToSell).toBe(true);

    const activeOverlays = deriveRiseFallChartOverlays([pos!], '1HZ100V', 0, 1700000015);
    expect(activeOverlays.entryPriceLine?.price).toBe(1234.56);
    expect(activeOverlays.markers.length).toBe(1);
    expect(activeOverlays.whitespaceFuturePoints.length).toBe(10);

    // Switching symbol clears all overlays immediately
    const switchedOverlays = deriveRiseFallChartOverlays([pos!], 'R_50', 0, 1700000015);
    expect(switchedOverlays.entryPriceLine).toBeNull();
    expect(switchedOverlays.markers).toEqual([]);
    expect(switchedOverlays.whitespaceFuturePoints).toEqual([]);
  });

  it('derives SL, TP, KO, and Entry price lines and focuses clicked selectedContractId', () => {
    const multA = normalizeOpenContract({
      contract_id: 201,
      underlying_symbol: 'R_100',
      contract_type: 'MULTUP',
      multiplier: 40,
      currency: 'USD',
      buy_price: '10.00',
      bid_price: '10.80',
      profit: '0.80',
      profit_percentage: 8,
      purchase_time: 1700000000,
      date_start: 1700000000,
      entry_spot: '500.00',
      entry_spot_time: 1700000000,
      current_spot: '501.00',
      is_sold: 0,
      is_valid_to_sell: 1,
      limit_order: {
        take_profit: { value: '510.00' },
        stop_loss: { value: '495.00' },
        stop_out: { value: '487.50' },
      },
    })!;

    const multB = normalizeOpenContract({
      contract_id: 202,
      underlying_symbol: 'R_100',
      contract_type: 'MULTDOWN',
      multiplier: 40,
      currency: 'USD',
      buy_price: '10.00',
      bid_price: '9.50',
      profit: '-0.50',
      profit_percentage: -5,
      purchase_time: 1700000100,
      date_start: 1700000100,
      entry_spot: '505.00',
      entry_spot_time: 1700000100,
      current_spot: '506.00',
      is_sold: 0,
      is_valid_to_sell: 1,
      limit_order: {
        take_profit: { value: '490.00' },
        stop_loss: { value: '512.00' },
        stop_out: { value: '517.50' },
      },
    })!;

    const defaultOverlays = deriveRiseFallChartOverlays([multA, multB], 'R_100', 60, 1700000120);
    expect(defaultOverlays.focusPosition?.contractId).toBe(201);
    expect(defaultOverlays.entryPriceLine?.price).toBe(500);
    expect(defaultOverlays.takeProfitPriceLine?.price).toBe(510);
    expect(defaultOverlays.stopLossPriceLine?.price).toBe(495);
    expect(defaultOverlays.stopOutPriceLine?.price).toBe(487.5);

    const clickedOverlays = deriveRiseFallChartOverlays(
      [multA, multB],
      'R_100',
      60,
      1700000120,
      202,
    );
    expect(clickedOverlays.focusPosition?.contractId).toBe(202);
    expect(clickedOverlays.entryPriceLine?.price).toBe(505);
    expect(clickedOverlays.takeProfitPriceLine?.price).toBe(490);
    expect(clickedOverlays.stopLossPriceLine?.price).toBe(512);
    expect(clickedOverlays.stopOutPriceLine?.price).toBe(517.5);
  });
});

describe('DerivSocketOwner OTP minting, subscription forget & late message drop', () => {
  it('mints a fresh OTP URL on every authenticated connection and forgets disposed streams', async () => {
    const sockets: FakeWebSocket[] = [];
    let otpCounter = 0;
    const fetchOtpUrl = vi.fn(async (accountId: string) => {
      otpCounter += 1;
      return `wss://api.derivws.com/trading/v1/options/ws/demo?acct=${accountId}&otp=tok_${otpCounter}`;
    });

    const owner = new DerivSocketOwner({
      fetchOtpUrl,
      createWs: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });

    const gen1 = await owner.connectAuthenticated('VRTC100');
    expect(fetchOtpUrl).toHaveBeenCalledTimes(1);
    expect(sockets[0].url).toContain('otp=tok_1');

    const received: Array<Record<string, unknown>> = [];
    const sub = owner.subscribe(
      { ticks_history: '1HZ100V', style: 'ticks' },
      { onMessage: (m) => received.push(m) },
      { expectedGeneration: gen1 },
    );

    await vi.waitFor(() => expect(sockets[0].sent.length).toBe(1));
    const subReqId = sockets[0].sent[0].req_id as number;

    sockets[0].serverPush({
      req_id: subReqId,
      subscription: { id: 'sub_ticks_1' },
      history: { prices: [100], times: [1700000001] },
    });
    expect(received).toHaveLength(1);

    // Unsubscribe must send `forget` and drop subsequent messages
    sub.unsubscribe();
    expect(sockets[0].sent.some((m) => m.forget === 'sub_ticks_1')).toBe(true);

    sockets[0].serverPush({
      req_id: subReqId,
      subscription: { id: 'sub_ticks_1' },
      tick: { epoch: 1700000002, quote: 101 },
    });
    expect(received).toHaveLength(1);

    // Switching account mints a brand-new single-use OTP URL
    await owner.connectAuthenticated('CR200');
    expect(fetchOtpUrl).toHaveBeenCalledTimes(2);
    expect(sockets[1].url).toContain('otp=tok_2');

    owner.dispose();
  });
});

describe('useTradeLifecycle confirmation, double-buy lock & timeout reconciliation', () => {
  const rules = extractRiseFallRules('1HZ100V', [
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'CALL',
      default_stake: 10,
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      sentiment: 'up',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
    {
      barriers: 1,
      contract_category: 'callput',
      contract_type: 'PUT',
      default_stake: 10,
      expiry_type: 'tick',
      market: 'synthetic_index',
      min_contract_duration: '1t',
      max_contract_duration: '10t',
      sentiment: 'down',
      submarket: 'random_index',
      underlying_symbol: '1HZ100V',
    },
  ]);

  it('prevents double-buy and reconciles via statement instead of resending buy on timeout', async () => {
    const sockets: FakeWebSocket[] = [];
    const owner = new DerivSocketOwner({
      fetchOtpUrl: async () =>
        'wss://api.derivws.com/trading/v1/options/ws/demo?otp=single_use',
      createWs: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });

    const gen = await owner.connectAuthenticated('VRTC1');
    const ws = sockets[0];

    const { result, rerender } = renderHook(
      (props: { amount: number }) =>
        useTradeLifecycle({
          socket: owner,
          connectionStatus: 'ready_authenticated',
          connectionGeneration: gen,
          authenticated: true,
          accountId: 'VRTC1',
          currency: 'USD',
          underlyingSymbol: '1HZ100V',
          rules,
          allowEquals: false,
          basis: 'stake',
          amount: props.amount,
          duration: 5,
          durationUnit: 't',
        }),
      { initialProps: { amount: 10 } },
    );

    // Wait for portfolio + proposal_open_contract + debounced Rise & Fall proposals
    await waitFor(() => {
      const proposals = ws.sent.filter((m) => m.proposal === 1);
      expect(proposals.length).toBe(2);
    });

    const riseReq = ws.sent.find(
      (m) => m.proposal === 1 && m.contract_type === 'CALL',
    )!;
    const fallReq = ws.sent.find(
      (m) => m.proposal === 1 && m.contract_type === 'PUT',
    )!;

    act(() => {
      ws.serverPush({
        req_id: riseReq.req_id,
        subscription: { id: 'sub_rise' },
        proposal: {
          id: 'prop_rise_1',
          ask_price: 10,
          payout: 19.5,
          spot: 1200.5,
          spot_time: 1700000001,
          date_start: 1700000001,
          longcode: 'Win payout if Volatility 100 (1s) Index is strictly higher',
        },
      });
      ws.serverPush({
        req_id: fallReq.req_id,
        subscription: { id: 'sub_fall' },
        proposal: {
          id: 'prop_fall_1',
          ask_price: 10,
          payout: 19.5,
          spot: 1200.5,
          spot_time: 1700000001,
          date_start: 1700000001,
          longcode: 'Win payout if Volatility 100 (1s) Index is strictly lower',
        },
      });
    });

    expect(result.current.phase).toBe('quoted');

    // Open confirmation, then mutate amount -> confirmation MUST auto-invalidate
    act(() => {
      result.current.requestConfirmation('rise');
    });
    expect(result.current.confirmation?.proposalId).toBe('prop_rise_1');

    rerender({ amount: 20 });
    expect(result.current.confirmation).toBeNull();

    // Feed fresh quote for amount=20 and test single-flight buy lock
    await waitFor(() => {
      const nextCalls = ws.sent.filter(
        (m) => m.proposal === 1 && m.amount === 20 && m.contract_type === 'CALL',
      );
      expect(nextCalls.length).toBe(1);
    });
    const rise20 = ws.sent.find(
      (m) => m.proposal === 1 && m.amount === 20 && m.contract_type === 'CALL',
    )!;

    act(() => {
      ws.serverPush({
        req_id: rise20.req_id,
        subscription: { id: 'sub_rise_20' },
        proposal: {
          id: 'prop_rise_20',
          ask_price: 20,
          payout: 39.1,
          spot: 1201.0,
          spot_time: 1700000005,
          date_start: 1700000005,
          longcode: 'Rise 20 USD',
        },
      });
    });

    act(() => {
      result.current.requestConfirmation('rise');
    });

    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.confirmAndBuy();
      p2 = result.current.confirmAndBuy(); // Duplicate click while in flight
    });

    await waitFor(() => {
      const buys = ws.sent.filter((m) => 'buy' in m);
      expect(buys.length).toBe(1);
      expect(buys[0]).toMatchObject({ buy: 'prop_rise_20', price: 20 });
      expect(typeof buys[0].price).toBe('number');
    });

    const buyReqId = ws.sent.find((m) => 'buy' in m)!.req_id;
    act(() => {
      ws.serverPush({
        req_id: buyReqId,
        buy: {
          contract_id: 77701,
          buy_price: 20,
          payout: 39.1,
          balance_after: 9980,
          longcode: 'Rise 20 USD',
          purchase_time: 1700000006,
          start_time: 1700000006,
          shortcode: 'CALL_1HZ100V_39.1_1700000006_5T',
          transaction_id: 50001,
        },
      });
    });

    await act(async () => {
      await Promise.all([p1, p2]);
    });
    expect(result.current.lastReceipt?.contract_id).toBe(77701);

    owner.dispose();
  });

  it('refreshes a fresh one-shot proposal and completes buy when Deriv returns Unknown contract proposal', async () => {
    const sockets: FakeWebSocket[] = [];
    const owner = new DerivSocketOwner({
      fetchOtpUrl: async () =>
        'wss://api.derivws.com/trading/v1/options/ws/demo?otp=reprice_ok',
      createWs: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
    });

    const gen = await owner.connectAuthenticated('VRTC1');
    const ws = sockets[0];

    const { result } = renderHook(() =>
      useTradeLifecycle({
        socket: owner,
        connectionStatus: 'ready_authenticated',
        connectionGeneration: gen,
        authenticated: true,
        accountId: 'VRTC1',
        currency: 'USD',
        underlyingSymbol: '1HZ100V',
        rules,
        allowEquals: false,
        basis: 'stake',
        amount: 10,
        duration: 5,
        durationUnit: 't',
      }),
    );

    await waitFor(() => {
      expect(ws.sent.filter((m) => m.proposal === 1).length).toBe(2);
    });

    const riseSubReq = ws.sent.find(
      (m) => m.proposal === 1 && m.contract_type === 'CALL',
    )!;

    act(() => {
      ws.serverPush({
        req_id: riseSubReq.req_id,
        subscription: { id: 'stale_prop_uuid_11111111_2222_3333' },
        proposal: {
          id: 'stale_prop_uuid_11111111_2222_3333',
          ask_price: 10,
          payout: 17.99,
          spot: 1365.85,
          spot_time: 1700000001,
          date_start: 1700000001,
          date_expiry: 1700000006,
          longcode: 'Win payout if Volatility 100 (1s) Index is strictly higher',
        },
      });
    });

    act(() => {
      result.current.requestConfirmation('rise');
    });

    let buyPromise!: Promise<void>;
    act(() => {
      buyPromise = result.current.confirmAndBuy();
    });

    // 1. First `buy` sends the cached proposal ID; simulate Deriv's `Unknown contract proposal` error
    await waitFor(() => {
      expect(ws.sent.filter((m) => 'buy' in m).length).toBe(1);
    });
    const firstBuy = ws.sent.find((m) => 'buy' in m)!;
    expect(firstBuy.buy).toBe('stale_prop_uuid_11111111_2222_3333');

    act(() => {
      ws.serverPush({
        req_id: firstBuy.req_id,
        msg_type: 'buy',
        error: {
          code: 'InvalidContractProposal',
          message: 'Unknown contract proposal',
        },
      });
    });

    // 2. Hook must request a fresh one-shot `proposal` (without `subscribe: 1`) for CALL
    await waitFor(() => {
      const oneShotProposals = ws.sent.filter(
        (m) => m.proposal === 1 && !('subscribe' in m) && m.contract_type === 'CALL',
      );
      expect(oneShotProposals.length).toBe(1);
    });
    const freshPropReq = ws.sent.find(
      (m) => m.proposal === 1 && !('subscribe' in m) && m.contract_type === 'CALL',
    )!;

    act(() => {
      ws.serverPush({
        req_id: freshPropReq.req_id,
        msg_type: 'proposal',
        proposal: {
          id: 'fresh_prop_uuid_44444444_5555_6666',
          ask_price: 10,
          payout: 17.99,
          spot: 1366.1,
          spot_time: 1700000010,
          date_start: 1700000010,
          date_expiry: 1700000015,
          longcode: 'Win payout if Volatility 100 (1s) Index is strictly higher',
        },
      });
    });

    // 3. Hook immediately buys using the newly minted proposal ID within confirmed price ceiling
    await waitFor(() => {
      expect(ws.sent.filter((m) => 'buy' in m).length).toBe(2);
    });
    const secondBuy = ws.sent.filter((m) => 'buy' in m)[1];
    expect(secondBuy).toMatchObject({
      buy: 'fresh_prop_uuid_44444444_5555_6666',
      price: 10,
    });

    act(() => {
      ws.serverPush({
        req_id: secondBuy.req_id,
        buy: {
          contract_id: 88802,
          buy_price: 10,
          payout: 17.99,
          balance_after: 10018.03,
          longcode: 'Rise 10 USD',
          purchase_time: 1700000010,
          start_time: 1700000010,
          shortcode: 'CALL_1HZ100V_17.99_1700000010_5T',
          transaction_id: 60002,
        },
      });
    });

    await act(async () => {
      await buyPromise;
    });

    expect(result.current.tradeError).toBeNull();
    expect(result.current.lastReceipt?.contract_id).toBe(88802);

    owner.dispose();
  });
});

describe('Express BFF PKCE, single-use OAuth state, PAT Deriv-App-ID & CSRF boundary', () => {
  it('generates S256 PKCE redirect, enforces single-use state, and rejects missing CSRF on OTP', async () => {
    const store = new InMemorySessionStore();
    const app = createApp(
      {
        port: 0,
        frontendOrigin: 'http://localhost:5173',
        derivAppId: 'test_app_placeholder',
        derivClientId: 'test_app_placeholder',
        derivRedirectUri: 'http://localhost:3001/api/auth/callback',
        derivScopes: ['trade'],
      },
      store,
    );

    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Start OAuth login -> redirects to auth.deriv.com with S256 PKCE
      const loginRes = await fetch(`${baseUrl}/api/auth/login?returnTo=/`, {
        redirect: 'manual',
      });
      expect(loginRes.status).toBe(302);
      const location = loginRes.headers.get('location') ?? '';
      const authUrl = new URL(location);
      expect(authUrl.origin).toBe('https://auth.deriv.com');
      expect(authUrl.pathname).toBe('/oauth2/auth');
      expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authUrl.searchParams.get('scope')).toBe('trade');
      const state = authUrl.searchParams.get('state')!;
      expect(state.length).toBeGreaterThan(20);

      // 2. Callback consumes state once (with provider error=access_denied)
      const cb1 = await fetch(
        `${baseUrl}/api/auth/callback?state=${encodeURIComponent(state)}&error=access_denied`,
        { redirect: 'manual' },
      );
      expect(cb1.headers.get('location')).toBe(
        'http://localhost:5173/?auth_error=access_denied',
      );

      // 3. Replaying the same state is rejected as state_mismatch
      const cbReplay = await fetch(
        `${baseUrl}/api/auth/callback?state=${encodeURIComponent(state)}&code=abc`,
        { redirect: 'manual' },
      );
      expect(cbReplay.headers.get('location')).toBe(
        'http://localhost:5173/?auth_error=state_mismatch',
      );

      // 4. POST /api/auth/otp without X-CSRF-Token returns 403 CsrfRejected
      const otpNoCsrf = await fetch(`${baseUrl}/api/auth/otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'VRTC1' }),
      });
      expect(otpNoCsrf.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('flags missingAppIdForPat when DERIV_PAT is present without DERIV_APP_ID and never leaks the PAT', async () => {
    const fakeSecretPat = 'pat_unit_test_redacted_token_0001';
    const app = createApp(
      {
        port: 0,
        frontendOrigin: 'http://localhost:5173',
        derivAppId: '',
        derivClientId: '',
        derivRedirectUri: 'http://localhost:3001/api/auth/callback',
        derivScopes: ['trade'],
        derivPat: fakeSecretPat,
      },
      new InMemorySessionStore(),
    );

    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const statusRes = await fetch(`${baseUrl}/api/auth/status`);
      const rawBody = await statusRes.text();
      expect(rawBody).not.toContain(fakeSecretPat);

      const parsed = JSON.parse(rawBody) as {
        patConfigured: boolean;
        patReady: boolean;
        missingAppIdForPat: boolean;
        authenticated: boolean;
        csrfToken: string;
      };
      expect(parsed.patConfigured).toBe(true);
      expect(parsed.patReady).toBe(false);
      expect(parsed.missingAppIdForPat).toBe(true);
      expect(parsed.authenticated).toBe(false);

      const cookieHeader = statusRes.headers.get('set-cookie')?.split(';')[0] ?? '';
      const patLoginRes = await fetch(`${baseUrl}/api/auth/pat-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
          'X-CSRF-Token': parsed.csrfToken,
        },
      });
      expect(patLoginRes.status).toBe(400);
      const errText = await patLoginRes.text();
      expect(errText).toContain('DERIV_APP_ID');
      expect(errText).not.toContain(fakeSecretPat);
    } finally {
      server.close();
    }
  });

  it('survives React.StrictMode double-effect unmount/remount and reaches ready_authenticated', async () => {
    const sockets: FakeWebSocket[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/status')) {
        return new Response(
          JSON.stringify({
            configured: true,
            patConfigured: true,
            patReady: true,
            authenticated: true,
            csrfToken: 'csrf_test_1',
            accounts: [
              {
                account_id: 'VRTC_STRICT_1',
                account_type: 'demo',
                currency: 'USD',
                balance: 10000,
              },
            ],
            selectedAccountId: 'VRTC_STRICT_1',
            expiresAtMs: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/auth/otp')) {
        return new Response(
          JSON.stringify({
            url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=strict_ok',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    try {
      const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(AuthProvider, {
            children,
            createWs: (wsUrl: string) => {
              const ws = new FakeWebSocket(wsUrl);
              sockets.push(ws);
              return ws as unknown as WebSocket;
            },
          }),
        );

      const { result, unmount } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.connectionStatus).toBe('ready_authenticated');
      });
      expect(result.current.socket.isDisposed()).toBe(false);
      expect(result.current.selectedAccount?.account_id).toBe('VRTC_STRICT_1');

      unmount();
      expect(result.current.socket.isDisposed()).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
