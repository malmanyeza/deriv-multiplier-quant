import type { ConnectionStatus, DerivWsError } from '../types/deriv';

export const PUBLIC_OPTIONS_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const MAX_REQUESTS_PER_SECOND = 85; // Below Deriv's 100 req/s gateway limit
const MAX_CONCURRENT_SUBSCRIPTIONS = 90; // Below Deriv's 100 concurrent stream ceiling
const HEARTBEAT_INTERVAL_MS = 25_000;

const FORBIDDEN_LEGACY_KEYS = new Set([
  'authorize',
  'loginid',
  'landing_company',
  'landing_company_short',
  'product_type',
  'barrier_category',
  'barrier_range',
  'trade_risk_profile',
  'trading_period_start',
]);

export class DerivProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DerivProtocolError';
    this.code = code;
  }
}

export function assertNewApiSocketUrl(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'wss:' ||
    parsed.hostname !== 'api.derivws.com' ||
    parsed.pathname.includes('/websockets/v3') ||
    parsed.pathname.includes('/legacy/')
  ) {
    throw new DerivProtocolError(
      'ForbiddenEndpoint',
      'Refusing connection to non-New-API WebSocket endpoint.',
    );
  }
}

export function assertNewApiPayload(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_LEGACY_KEYS.has(key)) {
      throw new DerivProtocolError(
        'ForbiddenLegacyField',
        `Payload contains forbidden Legacy API field "${key}".`,
      );
    }
  }
  if ('proposal' in payload && 'symbol' in payload) {
    throw new DerivProtocolError(
      'ForbiddenLegacyField',
      'Proposal payload must use "underlying_symbol", never Legacy "symbol".',
    );
  }
}

export interface SubscriptionHandle {
  unsubscribe: () => void;
  readonly generation: number;
}

export interface SocketStateSnapshot {
  status: ConnectionStatus;
  generation: number;
  authenticatedAccountId: string | null;
  lastError: string | null;
}

export type OtpUrlFetcher = (accountId: string) => Promise<string>;
export type WebSocketFactory = (url: string) => WebSocket;

interface PendingRequest {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  generation: number;
}

interface ActiveStream {
  reqId: number;
  subscriptionId: string | null;
  generation: number;
  disposed: boolean;
  onMessage: (msg: Record<string, unknown>) => void;
  onError?: (err: DerivProtocolError) => void;
}

export class DerivSocketOwner {
  private ws: WebSocket | null = null;
  private generation = 0;
  private nextReqId = 1;
  private status: ConnectionStatus = 'connecting';
  private targetAccountId: string | null = null;
  private lastError: string | null = null;
  private disposed = false;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private openWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly streamsByReqId = new Map<number, ActiveStream>();
  private readonly streamsBySubId = new Map<string, ActiveStream>();
  private readonly stateListeners = new Set<(snap: SocketStateSnapshot) => void>();
  private sentTimestamps: number[] = [];

  private readonly fetchOtpUrl?: OtpUrlFetcher;
  private readonly createWs: WebSocketFactory;

  constructor(opts?: { fetchOtpUrl?: OtpUrlFetcher; createWs?: WebSocketFactory }) {
    this.fetchOtpUrl = opts?.fetchOtpUrl;
    this.createWs = opts?.createWs ?? ((url: string) => new WebSocket(url));
  }

  getSnapshot(): SocketStateSnapshot {
    return {
      status: this.status,
      generation: this.generation,
      authenticatedAccountId:
        this.status === 'ready_authenticated' ? this.targetAccountId : null,
      lastError: this.lastError,
    };
  }

  onStateChange(listener: (snap: SocketStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async connectPublic(): Promise<number> {
    this.targetAccountId = null;
    this.reconnectAttempt = 0;
    return this.openGeneration(false);
  }

  async connectAuthenticated(accountId: string): Promise<number> {
    if (!this.fetchOtpUrl) {
      throw new DerivProtocolError('MissingOtpFetcher', 'OTP fetcher is not configured.');
    }
    this.targetAccountId = accountId;
    this.reconnectAttempt = 0;
    return this.openGeneration(false);
  }

  /**
   * Immediately triggers a fresh connection attempt if the socket is disconnected/reconnecting
   * (e.g. when a browser tab wakes from sleep or network comes back online).
   */
  reconnectNow(): void {
    if (this.disposed || this.isSocketOpen()) return;
    if (this.status === 'connecting' || this.status === 'authenticating') return;

    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    void this.openGeneration(true).catch(() => {
      // Handled inside openGeneration & scheduleReconnect
    });
  }

  private async openGeneration(isReconnect: boolean): Promise<number> {
    if (this.disposed) {
      throw new DerivProtocolError('Disposed', 'Socket owner has been disposed.');
    }

    this.clearTimers();
    this.teardownActiveSocket('Connection generation superseded.');
    const gen = ++this.generation;
    const accountId = this.targetAccountId;

    this.setStatus(
      isReconnect
        ? 'reconnecting'
        : accountId
          ? 'authenticating'
          : 'connecting',
      null,
    );

    let socketUrl = PUBLIC_OPTIONS_WS_URL;
    if (accountId) {
      try {
        // Fresh one-time OTP URL per connection generation — never reuse a consumed OTP URL
        socketUrl = await this.fetchOtpUrl!(accountId);
      } catch (err) {
        if (gen !== this.generation || this.disposed) {
          throw new DerivProtocolError('Superseded', 'Connection attempt superseded.');
        }
        const message =
          err instanceof Error ? err.message : 'Unable to obtain authenticated socket URL.';
        this.setStatus('error', message);
        this.scheduleReconnect();
        throw err instanceof Error ? err : new Error(message);
      }
    }

    if (gen !== this.generation || this.disposed) {
      throw new DerivProtocolError('Superseded', 'Connection attempt superseded.');
    }

    assertNewApiSocketUrl(socketUrl);

    return new Promise<number>((resolve, reject) => {
      const socket = this.createWs(socketUrl);
      this.ws = socket;

      const waiter = {
        generation: gen,
        resolve: () => resolve(gen),
        reject,
      };
      this.openWaiters.push(waiter);

      socket.addEventListener('open', () => {
        if (gen !== this.generation || this.ws !== socket) return;
        this.reconnectAttempt = 0;
        this.setStatus(accountId ? 'ready_authenticated' : 'ready_public', null);
        this.startHeartbeat(gen);

        const readyWaiters = this.openWaiters.splice(0);
        for (const w of readyWaiters) {
          if (w.generation === gen) w.resolve();
        }
      });

      socket.addEventListener('message', (event) => {
        if (gen !== this.generation || this.ws !== socket) return;
        this.handleRawMessage(String(event.data), gen);
      });

      socket.addEventListener('error', () => {
        if (gen !== this.generation || this.ws !== socket) return;
        this.lastError = 'WebSocket transport error.';
      });

      socket.addEventListener('close', () => {
        if (gen !== this.generation || this.ws !== socket) return;
        this.ws = null;
        this.stopHeartbeat();
        this.rejectPendingForGeneration(gen, 'WebSocket closed before response.');

        if (!this.disposed) {
          this.setStatus('reconnecting', 'Connection interrupted. Reconnecting…');
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    if (this.reconnectAttempt >= 6) {
      this.setStatus(
        'reconnecting',
        'Connection interrupted (network or server waking up). Retrying automatically…',
      );
    }
    const exp = Math.min(this.reconnectAttempt, 6);
    const baseMs = Math.min(30_000, 800 * 2 ** exp);
    const jitterMs = Math.floor(Math.random() * 400);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        void this.openGeneration(true).catch(() => {
          // Handled inside openGeneration & next scheduleReconnect
        });
      }
    }, baseMs + jitterMs);
  }

  private startHeartbeat(gen: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.generation !== gen || !this.isSocketOpen()) return;
      void this.request({ ping: 1 }, { timeoutMs: 8_000 }).catch(() => {
        // Closed socket handler will manage reconnect
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private isSocketOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private checkRateLimit(): void {
    const now = Date.now();
    this.sentTimestamps = this.sentTimestamps.filter((t) => now - t < 1000);
    if (this.sentTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
      throw new DerivProtocolError(
        'ClientRateLimit',
        'Outgoing WebSocket request rate limit reached. Backing off.',
      );
    }
    this.sentTimestamps.push(now);
  }

  private async waitUntilOpen(expectedGeneration?: number): Promise<number> {
    if (this.isSocketOpen()) {
      if (expectedGeneration !== undefined && this.generation !== expectedGeneration) {
        throw new DerivProtocolError('GenerationMismatch', 'Socket generation changed.');
      }
      return this.generation;
    }
    const targetGen = expectedGeneration ?? this.generation;
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DerivProtocolError('ConnectTimeout', 'Timed out waiting for WebSocket open.'));
      }, 10_000);

      this.openWaiters.push({
        generation: targetGen,
        resolve: () => {
          clearTimeout(timer);
          resolve(this.generation);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    payload: Record<string, unknown>,
    options?: { timeoutMs?: number; expectedGeneration?: number },
  ): Promise<T> {
    assertNewApiPayload(payload);
    const gen = await this.waitUntilOpen(options?.expectedGeneration);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new DerivProtocolError('SocketNotOpen', 'WebSocket is not open.');
    }

    this.checkRateLimit();
    const reqId = this.nextReqId++;
    const wirePayload = { ...payload, req_id: reqId };
    const timeoutMs = options?.timeoutMs ?? 12_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new DerivProtocolError('RequestTimeout', 'WebSocket request timed out.'));
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        generation: gen,
        timer,
        resolve: (msg) => resolve(msg as T),
        reject,
      });

      this.ws!.send(JSON.stringify(wirePayload));
    });
  }

  subscribe(
    payload: Record<string, unknown>,
    handlers: {
      onMessage: (msg: Record<string, unknown>) => void;
      onError?: (err: DerivProtocolError) => void;
    },
    options?: { expectedGeneration?: number },
  ): SubscriptionHandle {
    assertNewApiPayload(payload);

    if (this.streamsByReqId.size >= MAX_CONCURRENT_SUBSCRIPTIONS) {
      throw new DerivProtocolError(
        'SubscriptionCeiling',
        'Maximum concurrent WebSocket subscriptions reached.',
      );
    }

    const reqId = this.nextReqId++;
    const capturedGen = options?.expectedGeneration ?? this.generation;

    const stream: ActiveStream = {
      reqId,
      subscriptionId: null,
      generation: capturedGen,
      disposed: false,
      onMessage: handlers.onMessage,
      onError: handlers.onError,
    };

    this.streamsByReqId.set(reqId, stream);

    void this.waitUntilOpen(capturedGen)
      .then((openGen) => {
        if (stream.disposed || openGen !== capturedGen || !this.isSocketOpen()) return;
        this.checkRateLimit();
        this.ws!.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId }));
      })
      .catch((err) => {
        if (stream.disposed) return;
        this.streamsByReqId.delete(reqId);
        stream.onError?.(
          err instanceof DerivProtocolError
            ? err
            : new DerivProtocolError('SubscribeFailed', err instanceof Error ? err.message : 'Subscription failed'),
        );
      });

    return {
      generation: capturedGen,
      unsubscribe: () => {
        if (stream.disposed) return;
        stream.disposed = true;
        this.streamsByReqId.delete(reqId);
        const subId = stream.subscriptionId;
        if (subId) {
          this.streamsBySubId.delete(subId);
          if (this.generation === capturedGen && this.isSocketOpen()) {
            try {
              this.checkRateLimit();
              this.ws!.send(JSON.stringify({ forget: subId, req_id: this.nextReqId++ }));
            } catch {
              // Ignore forget failures during teardown
            }
          }
        }
      },
    };
  }

  private handleRawMessage(raw: string, gen: number): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const reqId = typeof msg.req_id === 'number' ? msg.req_id : undefined;
    const subObj = msg.subscription as { id?: unknown } | undefined;
    const subId = typeof subObj?.id === 'string' ? subObj.id : undefined;
    const wsErr = msg.error as DerivWsError | undefined;

    // Route stream responses first if matching an active stream
    const stream =
      (reqId !== undefined ? this.streamsByReqId.get(reqId) : undefined) ??
      (subId !== undefined ? this.streamsBySubId.get(subId) : undefined);

    if (stream) {
      if (stream.disposed || stream.generation !== gen) {
        // Late response from a disposed subscription: forget immediately if server created a stream
        if (subId && this.isSocketOpen()) {
          try {
            this.ws!.send(JSON.stringify({ forget: subId, req_id: this.nextReqId++ }));
          } catch {
            // Ignore
          }
        }
        return;
      }

      if (subId && !stream.subscriptionId) {
        stream.subscriptionId = subId;
        this.streamsBySubId.set(subId, stream);
      }

      if (wsErr && typeof wsErr.code === 'string') {
        this.streamsByReqId.delete(stream.reqId);
        if (stream.subscriptionId) {
          this.streamsBySubId.delete(stream.subscriptionId);
        }
        stream.disposed = true;
        stream.onError?.(
          new DerivProtocolError(wsErr.code, wsErr.message || 'Stream request failed.'),
        );
        return;
      }

      stream.onMessage(msg);
      return;
    }

    // Route one-shot request/response
    if (reqId !== undefined) {
      const pending = this.pendingRequests.get(reqId);
      if (!pending || pending.generation !== gen) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(reqId);

      if (wsErr && typeof wsErr.code === 'string') {
        pending.reject(
          new DerivProtocolError(wsErr.code, wsErr.message || 'Deriv WebSocket error.'),
        );
        return;
      }
      pending.resolve(msg);
    }
  }

  private teardownActiveSocket(reason: string): void {
    this.rejectPendingForGeneration(this.generation, reason);
    this.streamsByReqId.clear();
    this.streamsBySubId.clear();

    const waiters = this.openWaiters.splice(0);
    for (const w of waiters) {
      w.reject(new DerivProtocolError('Superseded', reason));
    }

    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        // Ignore
      }
    }
  }

  private rejectPendingForGeneration(gen: number, reason: string): void {
    for (const [reqId, pending] of this.pendingRequests.entries()) {
      if (pending.generation === gen) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(reqId);
        pending.reject(new DerivProtocolError('ConnectionClosed', reason));
      }
    }
  }

  private setStatus(status: ConnectionStatus, errorMessage: string | null): void {
    this.status = status;
    this.lastError = errorMessage;
    const snap = this.getSnapshot();
    for (const listener of this.stateListeners) {
      listener(snap);
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  revive(): void {
    if (!this.disposed) return;
    this.disposed = false;
    this.status = 'connecting';
    this.lastError = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.teardownActiveSocket('Socket owner disposed.');
    this.stateListeners.clear();
  }
}
