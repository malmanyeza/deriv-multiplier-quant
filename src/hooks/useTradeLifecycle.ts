import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AmountBasis,
  BuyWire,
  ConnectionStatus,
  ContractFamily,
  DurationUnit,
  LifecyclePhase,
  NormalizedPosition,
  ProposalOpenContractWire,
  ProposalWire,
  TradeDirection,
} from '../types/deriv';
import { DerivProtocolError, type DerivSocketOwner } from '../services/derivSocket';
import type { RiseFallSymbolRules } from '../services/marketData';
import {
  buildRiseFallProposal,
  buildSelectionKey,
  resolveRiseFallContractType,
} from '../adapters/riseFallAdapter';
import {
  buildMultipliersProposal,
  resolveMultiplierContractType,
} from '../adapters/multipliersAdapter';
import {
  normalizeOpenContract,
  normalizePortfolioContract,
  type PortfolioContractWire,
} from '../services/positionNormalizer';

const MAX_PROPOSAL_AGE_MS = 2_000;
const CONFIRM_PREREFRESH_AGE_MS = 2_000;
const IDLE_QUOTE_REFRESH_INTERVAL_MS = 25_000;

function isUnknownProposalError(err: unknown): err is DerivProtocolError {
  if (!(err instanceof DerivProtocolError)) return false;
  return (
    err.code === 'InvalidContractProposal' ||
    /unknown contract proposal/i.test(err.message)
  );
}

export interface DirectionQuote {
  proposal: ProposalWire | null;
  receivedAtMs: number;
  selectionKey: string;
  connectionGeneration: number;
  authenticatedSocket: boolean;
  error: string | null;
}

export interface PendingConfirmation {
  direction: TradeDirection;
  contractFamily: ContractFamily;
  contractType: string;
  underlyingSymbol: string;
  proposalId: string;
  askPrice: number;
  payout: number;
  spot: number;
  longcode: string;
  currency: string;
  duration: number;
  durationUnit: DurationUnit;
  multiplier?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
  selectionKey: string;
  connectionGeneration: number;
  pricedAtMs: number;
}

export interface UseTradeLifecycleArgs {
  socket: DerivSocketOwner;
  connectionStatus: ConnectionStatus;
  connectionGeneration: number;
  authenticated: boolean;
  accountId: string | null;
  currency: string;
  contractFamily?: ContractFamily;
  underlyingSymbol: string;
  rules: RiseFallSymbolRules | null;
  allowEquals: boolean;
  basis: AmountBasis;
  amount: number;
  duration: number;
  durationUnit: DurationUnit;
  multiplier?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

export function useTradeLifecycle(args: UseTradeLifecycleArgs) {
  const {
    socket,
    connectionStatus,
    connectionGeneration,
    authenticated,
    accountId,
    currency,
    contractFamily = 'rise_fall',
    underlyingSymbol,
    rules,
    allowEquals,
    basis,
    amount,
    duration,
    durationUnit,
    multiplier = 100,
    takeProfit = null,
    stopLoss = null,
  } = args;

  const [riseQuote, setRiseQuote] = useState<DirectionQuote | null>(null);
  const [fallQuote, setFallQuote] = useState<DirectionQuote | null>(null);
  const [stakeLimits, setStakeLimits] = useState<{ min?: number; max?: number }>({});
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [buyingInFlight, setBuyingInFlight] = useState(false);
  const [sellingContractIds, setSellingContractIds] = useState<Set<number>>(new Set());
  const [positions, setPositions] = useState<NormalizedPosition[]>([]);
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<BuyWire | null>(null);

  const buyLockRef = useRef(false);
  const confirmationActiveRef = useRef(false);
  confirmationActiveRef.current = confirmation !== null;

  const selectionKey = useMemo(
    () =>
      buildSelectionKey({
        accountId,
        connectionGeneration,
        contractFamily,
        underlyingSymbol,
        allowEquals,
        basis,
        amount,
        currency,
        duration,
        durationUnit,
        multiplier,
        takeProfit,
        stopLoss,
      }),
    [
      accountId,
      connectionGeneration,
      contractFamily,
      underlyingSymbol,
      allowEquals,
      basis,
      amount,
      currency,
      duration,
      durationUnit,
      multiplier,
      takeProfit,
      stopLoss,
    ],
  );

  // Reset symbol-specific stake limits when symbol, contractFamily, or currency changes
  useEffect(() => {
    setStakeLimits({});
  }, [underlyingSymbol, contractFamily, currency]);

  // Immediately invalidate any open confirmation modal if selection or socket generation changes
  useEffect(() => {
    setConfirmation((prev) =>
      prev &&
      (prev.selectionKey !== selectionKey ||
        prev.connectionGeneration !== connectionGeneration)
        ? null
        : prev,
    );
  }, [selectionKey, connectionGeneration]);

  const riseBuild = useMemo(
    () =>
      contractFamily === 'multipliers'
        ? buildMultipliersProposal(
            {
              underlyingSymbol,
              direction: 'rise',
              amount,
              currency,
              multiplier,
              takeProfit,
              stopLoss,
            },
            rules,
            stakeLimits,
          )
        : buildRiseFallProposal(
            {
              underlyingSymbol,
              direction: 'rise',
              allowEquals,
              basis,
              amount,
              currency,
              duration,
              durationUnit,
            },
            rules,
            stakeLimits,
          ),
    [
      contractFamily,
      underlyingSymbol,
      allowEquals,
      basis,
      amount,
      currency,
      duration,
      durationUnit,
      multiplier,
      takeProfit,
      stopLoss,
      rules,
      stakeLimits,
    ],
  );

  const fallBuild = useMemo(
    () =>
      contractFamily === 'multipliers'
        ? buildMultipliersProposal(
            {
              underlyingSymbol,
              direction: 'fall',
              amount,
              currency,
              multiplier,
              takeProfit,
              stopLoss,
            },
            rules,
            stakeLimits,
          )
        : buildRiseFallProposal(
            {
              underlyingSymbol,
              direction: 'fall',
              allowEquals,
              basis,
              amount,
              currency,
              duration,
              durationUnit,
            },
            rules,
            stakeLimits,
          ),
    [
      contractFamily,
      underlyingSymbol,
      allowEquals,
      basis,
      amount,
      currency,
      duration,
      durationUnit,
      multiplier,
      takeProfit,
      stopLoss,
      rules,
      stakeLimits,
    ],
  );

  const proposalsValid = riseBuild.ok && fallBuild.ok;
  const payloadsRef = useRef<{
    rise: Record<string, unknown> | null;
    fall: Record<string, unknown> | null;
  }>({ rise: null, fall: null });
  payloadsRef.current = {
    rise: riseBuild.ok ? (riseBuild.payload as unknown as Record<string, unknown>) : null,
    fall: fallBuild.ok ? (fallBuild.payload as unknown as Record<string, unknown>) : null,
  };

  const updateLimitsFromProposal = useCallback((prop: ProposalWire) => {
    const minStr =
      prop.validation_params?.stake?.min ?? prop.contract_details?.minimum_stake;
    const maxStr =
      prop.validation_params?.stake?.max ?? prop.contract_details?.maximum_stake;
    const min = minStr !== undefined ? Number(minStr) : undefined;
    const max = maxStr !== undefined ? Number(maxStr) : undefined;
    if (
      (min !== undefined && Number.isFinite(min)) ||
      (max !== undefined && Number.isFinite(max))
    ) {
      setStakeLimits((prev) => {
        const nextMin = min !== undefined && Number.isFinite(min) ? min : prev.min;
        const nextMax = max !== undefined && Number.isFinite(max) ? max : prev.max;
        if (prev.min === nextMin && prev.max === nextMax) return prev;
        return { min: nextMin, max: nextMax };
      });
    }
  }, []);

  // Stream Rise and Fall proposals concurrently for the current selectionKey + connectionGeneration.
  // Keyed on `proposalsValid` rather than `riseBuild`/`fallBuild` object identities so arrival of
  // `stakeLimits` on the first proposal response never `forget`s valid active proposals.
  useEffect(() => {
    const isSocketReady =
      connectionStatus === 'ready_public' || connectionStatus === 'ready_authenticated';
    if (!isSocketReady || !proposalsValid) {
      setRiseQuote(null);
      setFallQuote(null);
      return;
    }

    const risePayload = payloadsRef.current.rise;
    const fallPayload = payloadsRef.current.fall;
    if (!risePayload || !fallPayload) {
      setRiseQuote(null);
      setFallQuote(null);
      return;
    }

    const isAuthSocket = connectionStatus === 'ready_authenticated';
    const capturedKey = selectionKey;
    const capturedGen = connectionGeneration;
    let cancelled = false;
    let lastRiseAt = 0;
    let lastFallAt = 0;

    setRiseQuote({
      proposal: null,
      receivedAtMs: 0,
      selectionKey: capturedKey,
      connectionGeneration: capturedGen,
      authenticatedSocket: isAuthSocket,
      error: null,
    });
    setFallQuote({
      proposal: null,
      receivedAtMs: 0,
      selectionKey: capturedKey,
      connectionGeneration: capturedGen,
      authenticatedSocket: isAuthSocket,
      error: null,
    });

    // Debounce rapid amount/duration keystrokes so we respect rate limits
    let riseSub: { unsubscribe: () => void } | null = null;
    let fallSub: { unsubscribe: () => void } | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const debounceTimer = setTimeout(() => {
      if (cancelled) return;

      riseSub = socket.subscribe(
        risePayload,
        {
          onMessage: (msg) => {
            if (cancelled) return;
            const prop = msg.proposal as ProposalWire | undefined;
            if (!prop || typeof prop.id !== 'string') return;
            const now = Date.now();
            lastRiseAt = now;
            updateLimitsFromProposal(prop);
            setRiseQuote({
              proposal: prop,
              receivedAtMs: now,
              selectionKey: capturedKey,
              connectionGeneration: capturedGen,
              authenticatedSocket: isAuthSocket,
              error: null,
            });
          },
          onError: (err) => {
            if (cancelled) return;
            setRiseQuote({
              proposal: null,
              receivedAtMs: 0,
              selectionKey: capturedKey,
              connectionGeneration: capturedGen,
              authenticatedSocket: isAuthSocket,
              error: err.message,
            });
          },
        },
        { expectedGeneration: capturedGen },
      );

      fallSub = socket.subscribe(
        fallPayload,
        {
          onMessage: (msg) => {
            if (cancelled) return;
            const prop = msg.proposal as ProposalWire | undefined;
            if (!prop || typeof prop.id !== 'string') return;
            const now = Date.now();
            lastFallAt = now;
            updateLimitsFromProposal(prop);
            setFallQuote({
              proposal: prop,
              receivedAtMs: now,
              selectionKey: capturedKey,
              connectionGeneration: capturedGen,
              authenticatedSocket: isAuthSocket,
              error: null,
            });
          },
          onError: (err) => {
            if (cancelled) return;
            setFallQuote({
              proposal: null,
              receivedAtMs: 0,
              selectionKey: capturedKey,
              connectionGeneration: capturedGen,
              authenticatedSocket: isAuthSocket,
              error: err.message,
            });
          },
        },
        { expectedGeneration: capturedGen },
      );

      // Constant-price tick/ATM Synthetic Index contracts only emit one initial `proposal` message
      // even with `subscribe: 1`, and Deriv evicts idle proposal IDs after a short TTL.
      // Refresh idle non-streaming quotes periodically while no confirmation/purchase is active.
      refreshTimer = setInterval(() => {
        if (cancelled || buyLockRef.current || confirmationActiveRef.current) return;
        const now = Date.now();

        if (lastRiseAt > 0 && now - lastRiseAt >= IDLE_QUOTE_REFRESH_INTERVAL_MS - 3_000) {
          void socket
            .request<{ proposal?: ProposalWire }>(risePayload, {
              expectedGeneration: capturedGen,
              timeoutMs: 8_000,
            })
            .then((res) => {
              if (cancelled || !res.proposal?.id) return;
              const ts = Date.now();
              lastRiseAt = ts;
              setRiseQuote({
                proposal: res.proposal,
                receivedAtMs: ts,
                selectionKey: capturedKey,
                connectionGeneration: capturedGen,
                authenticatedSocket: isAuthSocket,
                error: null,
              });
            })
            .catch(() => {});
        }

        if (lastFallAt > 0 && now - lastFallAt >= IDLE_QUOTE_REFRESH_INTERVAL_MS - 3_000) {
          void socket
            .request<{ proposal?: ProposalWire }>(fallPayload, {
              expectedGeneration: capturedGen,
              timeoutMs: 8_000,
            })
            .then((res) => {
              if (cancelled || !res.proposal?.id) return;
              const ts = Date.now();
              lastFallAt = ts;
              setFallQuote({
                proposal: res.proposal,
                receivedAtMs: ts,
                selectionKey: capturedKey,
                connectionGeneration: capturedGen,
                authenticatedSocket: isAuthSocket,
                error: null,
              });
            })
            .catch(() => {});
        }
      }, IDLE_QUOTE_REFRESH_INTERVAL_MS);
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      if (refreshTimer) clearInterval(refreshTimer);
      riseSub?.unsubscribe();
      fallSub?.unsubscribe();
    };
  }, [
    socket,
    connectionStatus,
    connectionGeneration,
    selectionKey,
    proposalsValid,
    updateLimitsFromProposal,
  ]);

  // Portfolio snapshot + all-contract `proposal_open_contract` subscription on authenticated socket
  useEffect(() => {
    if (connectionStatus !== 'ready_authenticated' || !authenticated || !accountId) {
      setPositions([]);
      return;
    }

    let cancelled = false;
    const capturedGen = connectionGeneration;

    const upsertPosition = (incoming: NormalizedPosition) => {
      setPositions((prev) => {
        const idx = prev.findIndex((p) => p.contractId === incoming.contractId);
        if (idx === -1) {
          return [incoming, ...prev].sort((a, b) => b.purchaseTime - a.purchaseTime);
        }
        const next = [...prev];
        next[idx] = incoming;
        return next;
      });
    };

    // 1. Initial one-shot portfolio snapshot
    void socket
      .request<{ portfolio?: { contracts?: PortfolioContractWire[] } }>(
        { portfolio: 1 },
        { expectedGeneration: capturedGen },
      )
      .then((res) => {
        if (cancelled) return;
        const contracts = Array.isArray(res.portfolio?.contracts)
          ? res.portfolio!.contracts
          : [];
        for (const raw of contracts) {
          const norm = normalizePortfolioContract(raw);
          if (norm) upsertPosition(norm);
        }
      })
      .catch(() => {
        // Non-fatal if portfolio snapshot fails transiently
      });

    // 2. Live all-open-contracts stream (`proposal_open_contract: 1, subscribe: 1`)
    const pocSub = socket.subscribe(
      { proposal_open_contract: 1 },
      {
        onMessage: (msg) => {
          if (cancelled) return;
          const wire = msg.proposal_open_contract as ProposalOpenContractWire | undefined;
          if (!wire || typeof wire.contract_id !== 'number') return;
          const norm = normalizeOpenContract(wire);
          if (norm) upsertPosition(norm);
        },
      },
      { expectedGeneration: capturedGen },
    );

    return () => {
      cancelled = true;
      pocSub.unsubscribe();
    };
  }, [socket, connectionStatus, connectionGeneration, authenticated, accountId]);

  const requestFreshProposalForDirection = useCallback(
    async (
      direction: TradeDirection,
      expectedSelectionKey: string,
      expectedGen: number,
    ): Promise<{ proposal: ProposalWire; receivedAtMs: number }> => {
      const payload =
        direction === 'rise' ? payloadsRef.current.rise : payloadsRef.current.fall;
      if (!payload) {
        throw new DerivProtocolError(
          'InvalidSelection',
          'Current order parameters are incomplete.',
        );
      }

      const res = await socket.request<{ proposal?: ProposalWire }>(payload, {
        expectedGeneration: expectedGen,
        timeoutMs: 8_000,
      });

      const prop = res.proposal;
      if (!prop || typeof prop.id !== 'string') {
        throw new DerivProtocolError(
          'MissingProposal',
          'Unable to obtain a fresh contract quote.',
        );
      }

      const ts = Date.now();
      updateLimitsFromProposal(prop);

      const nextQuote: DirectionQuote = {
        proposal: prop,
        receivedAtMs: ts,
        selectionKey: expectedSelectionKey,
        connectionGeneration: expectedGen,
        authenticatedSocket: true,
        error: null,
      };
      if (direction === 'rise') {
        setRiseQuote(nextQuote);
      } else {
        setFallQuote(nextQuote);
      }

      return { proposal: prop, receivedAtMs: ts };
    },
    [socket, updateLimitsFromProposal],
  );

  const requestConfirmation = useCallback(
    (direction: TradeDirection) => {
      setTradeError(null);
      if (!authenticated || connectionStatus !== 'ready_authenticated') {
        setTradeError('Sign in with your Deriv account to place executable trades.');
        return;
      }

      const quote = direction === 'rise' ? riseQuote : fallQuote;
      if (
        !quote?.proposal ||
        !quote.authenticatedSocket ||
        quote.selectionKey !== selectionKey ||
        quote.connectionGeneration !== connectionGeneration
      ) {
        setTradeError('Waiting for a fresh executable quote on your authenticated account.');
        return;
      }

      const pricedAtMs = quote.receivedAtMs || Date.now();
      const resolvedType =
        contractFamily === 'multipliers'
          ? resolveMultiplierContractType(direction)
          : resolveRiseFallContractType(direction, allowEquals);

      setConfirmation({
        direction,
        contractFamily,
        contractType: resolvedType,
        underlyingSymbol,
        proposalId: quote.proposal.id,
        askPrice: Number(quote.proposal.ask_price),
        payout: Number(quote.proposal.payout),
        spot: Number(quote.proposal.spot),
        longcode: quote.proposal.longcode,
        currency,
        duration,
        durationUnit,
        multiplier: contractFamily === 'multipliers' ? multiplier : undefined,
        takeProfit: contractFamily === 'multipliers' ? takeProfit : null,
        stopLoss: contractFamily === 'multipliers' ? stopLoss : null,
        selectionKey,
        connectionGeneration,
        pricedAtMs,
      });

      // Pre-refresh single-direction proposal if the cached quote has aged while watching the chart
      if (Date.now() - pricedAtMs >= CONFIRM_PREREFRESH_AGE_MS) {
        const capturedKey = selectionKey;
        const capturedGen = connectionGeneration;
        void requestFreshProposalForDirection(direction, capturedKey, capturedGen)
          .then(({ proposal: freshProp, receivedAtMs }) => {
            if (buyLockRef.current) return;
            setConfirmation((prev) => {
              if (
                !prev ||
                prev.direction !== direction ||
                prev.selectionKey !== capturedKey ||
                prev.connectionGeneration !== capturedGen
              ) {
                return prev;
              }
              return {
                ...prev,
                proposalId: freshProp.id,
                askPrice: Number(freshProp.ask_price),
                payout: Number(freshProp.payout),
                spot: Number(freshProp.spot),
                longcode: freshProp.longcode,
                pricedAtMs: receivedAtMs,
              };
            });
          })
          .catch(() => {});
      }
    },
    [
      authenticated,
      connectionStatus,
      riseQuote,
      fallQuote,
      selectionKey,
      connectionGeneration,
      contractFamily,
      allowEquals,
      underlyingSymbol,
      currency,
      duration,
      durationUnit,
      multiplier,
      takeProfit,
      stopLoss,
      requestFreshProposalForDirection,
    ],
  );

  const cancelConfirmation = useCallback(() => {
    if (!buyLockRef.current) {
      setConfirmation(null);
    }
  }, []);

  /**
   * Executes `buy` using a verified fresh authenticated `proposal.id` for the confirmed direction.
   * - Refreshing stale (`>= 10s`) proposals before `buy` prevents `Unknown contract proposal` on
   *   constant-price Synthetic Index tick/ATM contracts that do not stream updates after initial load.
   * - If Deriv explicitly rejects a `buy` with `InvalidContractProposal` ("Unknown contract proposal")
   *   — an explicit WebSocket `error` envelope that guarantees no contract was created — mints one
   *   fresh proposal for the same selection, enforces `ask_price <= confirmedMaxPrice`, and buys once.
   * - Never blindly retries on ambiguous timeout or disconnect; reconciles via `statement` first!
   */
  const confirmAndBuy = useCallback(async () => {
    if (!confirmation || buyLockRef.current) return;

    if (
      connectionStatus !== 'ready_authenticated' ||
      confirmation.connectionGeneration !== connectionGeneration ||
      confirmation.selectionKey !== selectionKey
    ) {
      setConfirmation(null);
      setTradeError('Quote changed or connection reset before purchase. Please review a fresh quote.');
      return;
    }

    const confirmedMaxPrice = Number(confirmation.askPrice);
    if (!Number.isFinite(confirmedMaxPrice) || confirmedMaxPrice < 0) {
      setTradeError('Invalid proposal price.');
      return;
    }

    // Pick whichever matching quote (`liveQuote` vs `confirmation`) has the fresher proposal ID
    const liveQuote = confirmation.direction === 'rise' ? riseQuote : fallQuote;
    const canUseLiveQuote =
      Boolean(liveQuote?.proposal) &&
      Boolean(liveQuote?.authenticatedSocket) &&
      liveQuote?.selectionKey === confirmation.selectionKey &&
      liveQuote?.connectionGeneration === confirmation.connectionGeneration &&
      (liveQuote?.receivedAtMs ?? 0) >= confirmation.pricedAtMs &&
      Number(liveQuote?.proposal?.ask_price) <= confirmedMaxPrice + 1e-6;

    let proposalId = canUseLiveQuote ? liveQuote!.proposal!.id : confirmation.proposalId;
    let numericPrice = Number(
      canUseLiveQuote ? liveQuote!.proposal!.ask_price : confirmedMaxPrice,
    );
    const effectivePricedAtMs = canUseLiveQuote
      ? liveQuote!.receivedAtMs
      : confirmation.pricedAtMs;

    buyLockRef.current = true;
    setBuyingInFlight(true);
    setTradeError(null);
    const sentAtEpoch = Math.floor(Date.now() / 1000) - 5;

    const applyPriceMovedGuard = (freshProp: ProposalWire, freshTs: number): boolean => {
      const freshAsk = Number(freshProp.ask_price);
      if (!Number.isFinite(freshAsk) || freshAsk > confirmedMaxPrice + 1e-6) {
        setConfirmation((prev) =>
          prev &&
          prev.selectionKey === confirmation.selectionKey &&
          prev.connectionGeneration === confirmation.connectionGeneration
            ? {
                ...prev,
                proposalId: freshProp.id,
                askPrice: freshAsk,
                payout: Number(freshProp.payout),
                spot: Number(freshProp.spot),
                longcode: freshProp.longcode,
                pricedAtMs: freshTs,
              }
            : prev,
        );
        setTradeError(
          'Contract ask price increased since confirmation. Review the updated price and confirm again.',
        );
        return false;
      }
      return true;
    };

    try {
      // 1. Proactively refresh if the cached proposal ID has aged past MAX_PROPOSAL_AGE_MS
      if (Date.now() - effectivePricedAtMs >= MAX_PROPOSAL_AGE_MS) {
        const { proposal: freshProp, receivedAtMs: freshTs } =
          await requestFreshProposalForDirection(
            confirmation.direction,
            confirmation.selectionKey,
            confirmation.connectionGeneration,
          );
        if (!applyPriceMovedGuard(freshProp, freshTs)) {
          return;
        }
        proposalId = freshProp.id;
        numericPrice = Number(freshProp.ask_price);
      }

      // 2. Execute `buy` by proposal ID; recover once if Deriv evicted the cached proposal ID
      let res: { buy?: BuyWire };
      try {
        res = await socket.request<{ buy?: BuyWire }>(
          {
            buy: proposalId,
            price: numericPrice,
          },
          { expectedGeneration: confirmation.connectionGeneration, timeoutMs: 12_000 },
        );
      } catch (firstBuyErr) {
        if (!isUnknownProposalError(firstBuyErr)) {
          throw firstBuyErr;
        }
        // Deriv explicitly rejected the stale proposal ID (`error` envelope => no contract created).
        // Mint a brand-new single-direction proposal on the same socket and buy within the confirmed price ceiling.
        const { proposal: freshProp, receivedAtMs: freshTs } =
          await requestFreshProposalForDirection(
            confirmation.direction,
            confirmation.selectionKey,
            confirmation.connectionGeneration,
          );
        if (!applyPriceMovedGuard(freshProp, freshTs)) {
          return;
        }
        res = await socket.request<{ buy?: BuyWire }>(
          {
            buy: freshProp.id,
            price: Number(freshProp.ask_price),
          },
          { expectedGeneration: confirmation.connectionGeneration, timeoutMs: 12_000 },
        );
      }

      if (res.buy) {
        setLastReceipt(res.buy);
        // Ensure individual contract state is fetched immediately alongside stream updates
        void socket
          .request(
            { proposal_open_contract: 1, contract_id: res.buy.contract_id },
            { expectedGeneration: confirmation.connectionGeneration },
          )
          .then((pocRes) => {
            const wire = (pocRes as { proposal_open_contract?: ProposalOpenContractWire })
              .proposal_open_contract;
            if (wire) {
              const norm = normalizeOpenContract(wire);
              if (norm) {
                setPositions((prev) => {
                  const exists = prev.some((p) => p.contractId === norm.contractId);
                  return exists
                    ? prev.map((p) => (p.contractId === norm.contractId ? norm : p))
                    : [norm, ...prev];
                });
              }
            }
          })
          .catch(() => {});
      }
      setConfirmation(null);
    } catch (err) {
      // Ambiguous timeout or disconnect: NEVER blindly resend `buy`! Reconcile with `statement` first.
      if (
        err instanceof DerivProtocolError &&
        (err.code === 'RequestTimeout' || err.code === 'ConnectionClosed')
      ) {
        try {
          const stmtRes = await socket.request<{
            statement?: {
              transactions?: Array<{
                action_type?: string;
                contract_id?: number | null;
                transaction_time?: number;
                shortcode?: string | null;
              }>;
            };
          }>({
            statement: 1,
            action_type: 'buy',
            date_from: sentAtEpoch,
            description: 1,
            limit: 10,
          });

          const matched = stmtRes.statement?.transactions?.find(
            (tx) =>
              tx.action_type === 'buy' &&
              typeof tx.contract_id === 'number' &&
              (tx.transaction_time ?? 0) >= sentAtEpoch &&
              (tx.shortcode ?? '').includes(confirmation.underlyingSymbol),
          );

          if (matched?.contract_id) {
            setConfirmation(null);
            setTradeError(
              `Purchase reply timed out, but reconciliation confirmed Contract #${matched.contract_id} was opened.`,
            );
            return;
          }
        } catch {
          // Statement check also unavailable
        }
        setConfirmation(null);
        setTradeError(
          'Purchase response was interrupted. Check Open Positions before placing another order.',
        );
      } else {
        setConfirmation(null);
        setTradeError(err instanceof Error ? err.message : 'Order could not be placed.');
      }
    } finally {
      buyLockRef.current = false;
      setBuyingInFlight(false);
    }
  }, [
    confirmation,
    connectionStatus,
    connectionGeneration,
    selectionKey,
    riseQuote,
    fallQuote,
    socket,
    requestFreshProposalForDirection,
  ]);

  /**
   * Sells an open contract at market (`price: 0` finite number).
   * Reconciles `is_sold` via `proposal_open_contract` on ambiguous failure rather than blindly retrying.
   */
  const sellAtMarket = useCallback(
    async (contractId: number) => {
      if (sellingContractIds.has(contractId)) return;
      setTradeError(null);
      setSellingContractIds((prev) => new Set(prev).add(contractId));

      try {
        await socket.request(
          {
            sell: contractId,
            price: 0,
          },
          { expectedGeneration: connectionGeneration, timeoutMs: 10_000 },
        );
      } catch (err) {
        // Reconcile `is_sold` with `proposal_open_contract` before reporting
        try {
          const check = await socket.request<{
            proposal_open_contract?: ProposalOpenContractWire;
          }>({
            proposal_open_contract: 1,
            contract_id: contractId,
          });
          if (check.proposal_open_contract) {
            const norm = normalizeOpenContract(check.proposal_open_contract);
            if (norm) {
              setPositions((prev) =>
                prev.map((p) => (p.contractId === norm.contractId ? norm : p)),
              );
              if (norm.isSold) return;
            }
          }
        } catch {
          // Ignore reconciliation error
        }
        setTradeError(err instanceof Error ? err.message : 'Unable to sell contract.');
      } finally {
        setSellingContractIds((prev) => {
          const next = new Set(prev);
          next.delete(contractId);
          return next;
        });
      }
    },
    [socket, connectionGeneration, sellingContractIds],
  );

  /**
   * Direct programmatic purchase for the Demo Quant Strategy Runner:
   * Always requests a fresh proposal on the authenticated socket, verifies `ask_price`,
   * and executes `buy` with 1x `InvalidContractProposal` recovery.
   */
  const executeDirectBuy = useCallback(
    async (direction: TradeDirection): Promise<BuyWire | null> => {
      if (buyLockRef.current || connectionStatus !== 'ready_authenticated' || !authenticated) {
        return null;
      }

      buyLockRef.current = true;
      setBuyingInFlight(true);
      setTradeError(null);

      try {
        const { proposal: freshProp } = await requestFreshProposalForDirection(
          direction,
          selectionKey,
          connectionGeneration,
        );
        const ask = Number(freshProp.ask_price);
        if (!Number.isFinite(ask) || ask <= 0) {
          throw new DerivProtocolError('InvalidAskPrice', 'Invalid proposal ask price.');
        }

        let res: { buy?: BuyWire };
        try {
          res = await socket.request<{ buy?: BuyWire }>(
            { buy: freshProp.id, price: ask },
            { expectedGeneration: connectionGeneration, timeoutMs: 12_000 },
          );
        } catch (firstErr) {
          if (!isUnknownProposalError(firstErr)) throw firstErr;
          const { proposal: retryProp } = await requestFreshProposalForDirection(
            direction,
            selectionKey,
            connectionGeneration,
          );
          res = await socket.request<{ buy?: BuyWire }>(
            { buy: retryProp.id, price: Number(retryProp.ask_price) },
            { expectedGeneration: connectionGeneration, timeoutMs: 12_000 },
          );
        }

        if (res.buy) {
          setLastReceipt(res.buy);
          void socket
            .request(
              { proposal_open_contract: 1, contract_id: res.buy.contract_id },
              { expectedGeneration: connectionGeneration },
            )
            .then((pocRes) => {
              const wire = (pocRes as { proposal_open_contract?: ProposalOpenContractWire })
                .proposal_open_contract;
              if (wire) {
                const norm = normalizeOpenContract(wire);
                if (norm) {
                  setPositions((prev) => {
                    const exists = prev.some((p) => p.contractId === norm.contractId);
                    return exists
                      ? prev.map((p) => (p.contractId === norm.contractId ? norm : p))
                      : [norm, ...prev];
                  });
                }
              }
            })
            .catch(() => {});
          return res.buy;
        }
        return null;
      } catch (err) {
        setTradeError(err instanceof Error ? err.message : 'Automated order could not be placed.');
        return null;
      } finally {
        buyLockRef.current = false;
        setBuyingInFlight(false);
      }
    },
    [
      connectionStatus,
      authenticated,
      requestFreshProposalForDirection,
      selectionKey,
      connectionGeneration,
      socket,
    ],
  );

  // Compute observable lifecycle phase
  const phase: LifecyclePhase = useMemo(() => {
    if (connectionStatus === 'reconnecting') return 'reconnecting';
    if (buyingInFlight) return 'buying';
    if (confirmation) return 'confirming';
    if (tradeError) return 'failed';

    const openForSymbol = positions.filter(
      (p) => p.underlyingSymbol === underlyingSymbol && !p.isSold,
    );
    if (openForSymbol.some((p) => p.isValidToSell)) return 'sellable';
    if (openForSymbol.some((p) => p.isExpired && !p.isSold)) return 'settling';
    if (openForSymbol.length > 0) return 'open';

    if (!riseBuild.ok || !fallBuild.ok) return 'idle';
    if (riseQuote?.proposal && fallQuote?.proposal) return 'quoted';
    if (riseQuote || fallQuote) return 'pricing';
    if (positions.some((p) => p.isSold)) return 'closed';
    return 'idle';
  }, [
    connectionStatus,
    buyingInFlight,
    confirmation,
    tradeError,
    positions,
    underlyingSymbol,
    riseBuild.ok,
    fallBuild.ok,
    riseQuote,
    fallQuote,
  ]);

  const validationError = !riseBuild.ok
    ? riseBuild.message
    : !fallBuild.ok
      ? fallBuild.message
      : null;

  return {
    phase,
    selectionKey,
    validationError,
    stakeLimits,
    riseQuote,
    fallQuote,
    confirmation,
    buyingInFlight,
    sellingContractIds,
    positions,
    tradeError,
    clearTradeError: () => setTradeError(null),
    lastReceipt,
    requestConfirmation,
    cancelConfirmation,
    confirmAndBuy,
    executeDirectBuy,
    sellAtMarket,
  };
}
