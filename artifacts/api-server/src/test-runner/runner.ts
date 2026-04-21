import WebSocket from "ws";

// ─── Types ─────────────────────────────────────────────────────────────────

export type EmitFn = (event: Record<string, unknown>) => void;

export interface StageResult {
  stage: number;
  name: string;
  success: boolean;
  duration: number;
  details: Record<string, unknown>;
  errors: string[];
}

export interface BatchStep {
  n: number;
  strategy: "additive" | "unsub-resub";
  result: "ok" | "ack-no-trade" | "fail" | "skip";
  ackMs?: number;
  tradeMs?: number;
  note?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function log(emit: EmitFn, level: string, message: string): void {
  emit({ type: "log", level, message });
}

const PUMPPORTAL_WS = () =>
  process.env.PUMPPORTAL_WS_URL ?? "wss://pumpportal.fun/api/data";

function openWs(): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(PUMPPORTAL_WS());
    const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
    ws.once("open", () => { clearTimeout(t); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

function stageEnd(
  emit: EmitFn,
  results: StageResult[],
  stage: number,
  name: string,
  success: boolean,
  duration: number,
  details: Record<string, unknown>,
  errors: string[]
): void {
  const r: StageResult = { stage, name, success, duration, details, errors };
  results.push(r);
  emit({ type: "stage-end", stage, name, success, duration, details, errors });
}

// ─── Stage 1: Mint Collection ──────────────────────────────────────────────

async function stage1MintCollection(
  emit: EmitFn,
  results: StageResult[]
): Promise<string[]> {
  const stageName = "Stage 1: Mint Collection (subscribeNewToken)";
  emit({ type: "stage-start", stage: 1, name: stageName });
  log(emit, "header", "════ " + stageName);

  const COLLECT_TARGET = 30;
  const TIMEOUT_MS = 20_000;
  const stageStart = Date.now();
  const mints: string[] = [];
  const errors: string[] = [];
  let success = false;

  try {
    log(emit, "info", `Connecting to PumpPortal (${PUMPPORTAL_WS()})...`);
    const ws = await openWs();
    log(emit, "success", "✓ PumpPortal WebSocket connected");

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { ws.close(); }, TIMEOUT_MS);
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      log(emit, "info", "Subscribed to subscribeNewToken");

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof msg.mint === "string" && !mints.includes(msg.mint)) {
            mints.push(msg.mint);
            if (mints.length === 1)
              log(emit, "info", `First mint: ${msg.mint.slice(0, 20)}...`);
            if (mints.length >= COLLECT_TARGET) {
              clearTimeout(t);
              ws.close();
            }
          }
          if (msg.errors) log(emit, "warn", `PumpPortal: ${JSON.stringify(msg.errors)}`);
        } catch { /* skip */ }
      });
      ws.on("close", () => { clearTimeout(t); resolve(); });
      ws.on("error", () => { clearTimeout(t); resolve(); });
    });

    if (mints.length === 0) {
      errors.push(`PumpPortal returned 0 new token events within ${TIMEOUT_MS / 1000}s`);
      log(emit, "error", "✗ No mints received — Stage 1 failed");
    } else {
      log(emit, "success", `✓ Collected ${mints.length} mints`);
      success = true;
    }
  } catch (e) {
    errors.push((e as Error).message);
    log(emit, "error", `Stage 1 error: ${(e as Error).message}`);
  }

  const duration = Date.now() - stageStart;
  stageEnd(emit, results, 1, stageName, success, duration, { mintsCollected: mints.length }, errors);
  return mints;
}

// ─── Stage 2: Trade Wallet Collection ─────────────────────────────────────

async function stage2TradeWallets(
  emit: EmitFn,
  results: StageResult[],
  mints: string[]
): Promise<string[]> {
  const stageName = "Stage 2: Trade Wallet Collection (subscribeTokenTrade)";
  emit({ type: "stage-start", stage: 2, name: stageName });
  log(emit, "header", "════ " + stageName);

  const TIMEOUT_MS = 20_000;
  const stageStart = Date.now();
  const wallets: string[] = [];
  const errors: string[] = [];
  let success = false;

  // ── PumpPortal trade subscription ──
  try {
    log(emit, "info", `Subscribing to trades for ${mints.length} mints...`);
    const ws = await openWs();
    log(emit, "success", "✓ PumpPortal WebSocket connected");

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => ws.close(), TIMEOUT_MS);
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg.message) log(emit, "info", `PumpPortal: ${msg.message}`);
          if (typeof msg.traderPublicKey === "string" && !wallets.includes(msg.traderPublicKey)) {
            wallets.push(msg.traderPublicKey);
            if (wallets.length === 1)
              log(emit, "info", `First trader wallet: ${msg.traderPublicKey.slice(0, 20)}...`);
          }
          if (msg.errors) log(emit, "warn", `PumpPortal: ${JSON.stringify(msg.errors)}`);
        } catch { /* skip */ }
      });
      ws.on("close", () => { clearTimeout(t); resolve(); });
      ws.on("error", () => { clearTimeout(t); resolve(); });
    });

    if (wallets.length === 0) {
      errors.push(`No trade events in ${TIMEOUT_MS / 1000}s — no trader wallets collected`);
      log(emit, "error", "✗ No trade events received — Stage 2 failed");
    } else {
      log(emit, "success", `✓ Collected ${wallets.length} real trader wallets`);
    }
  } catch (e) {
    errors.push((e as Error).message);
    log(emit, "error", `Stage 2 PumpPortal error: ${(e as Error).message}`);
  }

  // ── DexScreener health check ──
  log(emit, "info", "DexScreener boosts health check...");
  try {
    const t0 = Date.now();
    const resp = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    const ms = Date.now() - t0;
    if (resp.ok) {
      const boosts = (await resp.json()) as Array<{ chainId?: string }>;
      const n = boosts.filter((b) => b.chainId === "solana").length;
      n > 0
        ? log(emit, "success", `✓ DexScreener: ${n} Solana boosted tokens (${ms}ms)`)
        : log(emit, "warn", "DexScreener: no Solana boosts returned");
    } else {
      log(emit, "warn", `DexScreener HTTP ${resp.status}`);
    }
  } catch (e) {
    log(emit, "warn", `DexScreener unreachable: ${(e as Error).message}`);
  }

  // ── DexPaprika SSE health check (warn-only, may be IP-banned in dev) ──
  log(emit, "info", "DexPaprika SSE health check...");
  try {
    const t0 = Date.now();
    const resp = await fetch(
      `https://api.dexpaprika.com/v1/sse/trades?tokens=${mints.slice(0, 3).join(",")}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    const ms = Date.now() - t0;
    resp.ok || resp.status === 200
      ? log(emit, "success", `✓ DexPaprika SSE reachable (${ms}ms)`)
      : log(emit, "warn", `DexPaprika SSE: HTTP ${resp.status} — may be IP-banned in dev; verify in production`);
  } catch (e) {
    log(emit, "warn", `DexPaprika SSE: ${(e as Error).message} — may be IP-banned in dev; verify in production`);
  }

  success = wallets.length > 0 && errors.length === 0;
  const duration = Date.now() - stageStart;
  stageEnd(emit, results, 2, stageName, success, duration, { walletsCollected: wallets.length, mintsSubscribed: mints.length }, errors);
  return wallets;
}

// ─── Stage 3: Chainstack + Shyft Wallet History ────────────────────────────

async function stage3WalletHistory(
  emit: EmitFn,
  results: StageResult[],
  wallets: string[]
): Promise<void> {
  const stageName = "Stage 3: Wallet History (Chainstack + Shyft)";
  emit({ type: "stage-start", stage: 3, name: stageName });
  log(emit, "header", "════ " + stageName);

  const stageStart = Date.now();
  const errors: string[] = [];

  const chainstackRpc = process.env.CHAINSTACK_RPC_URL;
  const chainstackKey = process.env.CHAINSTACK_API_KEY;
  const shyftKey = process.env.SHYFT_API_KEY;

  // Chainstack requires at minimum one of: full RPC URL or just the API key
  if (!chainstackRpc && !chainstackKey) {
    errors.push("Neither CHAINSTACK_RPC_URL nor CHAINSTACK_API_KEY is configured — Stage 3 cannot run");
    log(emit, "error", "✗ No Chainstack credentials configured");
  }
  if (!shyftKey) {
    errors.push("SHYFT_API_KEY not configured — Stage 3 cannot run");
    log(emit, "error", "✗ SHYFT_API_KEY not configured");
  }

  if (errors.length === 0) {
    const rpcUrl =
      chainstackRpc ??
      `https://solana-mainnet.core.chainstack.com/${chainstackKey}`;
    const testWallets = wallets.slice(0, 3);
    log(emit, "info", `Querying ${testWallets.length} wallets via Chainstack...`);

    for (const wallet of testWallets) {
      try {
        const t0 = Date.now();
        const resp = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "getSignaturesForAddress",
            params: [wallet, { limit: 10 }],
            id: 1,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const ms = Date.now() - t0;
        if (!resp.ok) {
          errors.push(`Chainstack HTTP ${resp.status} for ${wallet.slice(0, 12)}`);
          log(emit, "error", `✗ Chainstack HTTP ${resp.status}`);
          continue;
        }
        const data = (await resp.json()) as {
          result?: unknown[];
          error?: { message: string };
        };
        if (data.error) {
          errors.push(`Chainstack RPC error: ${data.error.message}`);
          log(emit, "error", `✗ Chainstack RPC: ${data.error.message}`);
        } else {
          const n = Array.isArray(data.result) ? data.result.length : 0;
          log(emit, "success", `✓ ${wallet.slice(0, 16)}... — ${n} sigs (${ms}ms)`);
        }
      } catch (e) {
        errors.push(`Chainstack: ${(e as Error).message}`);
        log(emit, "error", `✗ Chainstack: ${(e as Error).message}`);
      }
    }

    // Shyft
    log(emit, "info", "Querying Shyft transaction history...");
    try {
      const wallet = wallets[0];
      const t0 = Date.now();
      const resp = await fetch(
        `https://api.shyft.to/sol/v1/transaction/history?network=mainnet-beta&account=${wallet}&tx_num=10`,
        { headers: { "x-api-key": shyftKey! }, signal: AbortSignal.timeout(10_000) }
      );
      const ms = Date.now() - t0;
      if (resp.ok) {
        const data = (await resp.json()) as { result?: unknown[] };
        const n = data.result?.length ?? 0;
        log(emit, "success", `✓ Shyft: ${n} txs for ${wallet.slice(0, 16)}... (${ms}ms)`);
      } else {
        errors.push(`Shyft HTTP ${resp.status}`);
        log(emit, "error", `✗ Shyft HTTP ${resp.status}`);
      }
    } catch (e) {
      errors.push(`Shyft: ${(e as Error).message}`);
      log(emit, "error", `✗ Shyft: ${(e as Error).message}`);
    }
  }

  const success = errors.length === 0;
  const duration = Date.now() - stageStart;
  stageEnd(emit, results, 3, stageName, success, duration, { walletsQueried: Math.min(wallets.length, 3) }, errors);
}

// ─── Stage 4: Batch Subscription Capacity Test ────────────────────────────

async function stage4BatchCapacity(
  emit: EmitFn,
  results: StageResult[],
  seedMints: string[],
  seedWallets: string[]
): Promise<void> {
  const stageName = "Stage 4: Batch Subscription Capacity Test";
  emit({ type: "stage-start", stage: 4, name: stageName });
  log(emit, "header", "════ " + stageName);

  const stageStart = Date.now();
  const errors: string[] = [];

  // ── Build address pools with sentinel detection ──
  log(emit, "info", "Building address pool (30s collection + DexScreener)...");
  const mintPool = [...new Set(seedMints)];
  const walletPool = [...new Set(seedWallets)];
  const sentinelMints = new Set<string>();

  // Supplement from DexScreener boosts
  try {
    const resp = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    if (resp.ok) {
      const boosts = (await resp.json()) as Array<{ chainId?: string; tokenAddress?: string }>;
      boosts
        .filter((b) => b.chainId === "solana" && b.tokenAddress)
        .forEach((b) => { if (!mintPool.includes(b.tokenAddress!)) mintPool.push(b.tokenAddress!); });
      log(emit, "info", `+ DexScreener mints → pool: ${mintPool.length}`);
    }
  } catch { /* best-effort */ }

  // 30s collection: subscribeNewToken + subscribeTokenTrade on same connection
  // to detect actively trading tokens (sentinel mints)
  await new Promise<void>((resolve) => {
    let ws: WebSocket;
    try { ws = new WebSocket(PUMPPORTAL_WS()); } catch { resolve(); return; }

    const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 30_000);
    let tradeSubSent = false;

    ws.once("open", () => {
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;

        // New token creation
        if (typeof msg.mint === "string" && !mintPool.includes(msg.mint)) {
          mintPool.push(msg.mint);
          // Subscribe to trades for this mint (additive subscription)
          if (!tradeSubSent && mintPool.length >= 3) {
            ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mintPool.slice(0, 15) }));
            tradeSubSent = true;
          }
        }

        // Trade event — mark this mint as a confirmed sentinel
        if (typeof msg.mint === "string" && typeof msg.traderPublicKey === "string") {
          sentinelMints.add(msg.mint);
          if (!walletPool.includes(msg.traderPublicKey))
            walletPool.push(msg.traderPublicKey);
        }

        // Also collect wallets from subscribeAccountTrade-style events
        if (typeof msg.traderPublicKey === "string" && !walletPool.includes(msg.traderPublicKey)) {
          walletPool.push(msg.traderPublicKey);
        }
      } catch { /* skip */ }
    });

    ws.on("close", () => { clearTimeout(t); resolve(); });
    ws.on("error", () => { clearTimeout(t); resolve(); });
  });

  // Sentinels first in the pool (they're confirmed to generate trade events)
  const sentinelArray = [...sentinelMints].slice(0, 5);
  const nonSentinels = mintPool.filter((m) => !sentinelMints.has(m));
  const orderedMintPool = [...sentinelArray, ...nonSentinels];
  const orderedWalletPool = [...new Set([...seedWallets, ...walletPool])];

  log(emit, "success", [
    `✓ Pool ready: ${orderedMintPool.length} mints (${sentinelArray.length} sentinels),`,
    `${orderedWalletPool.length} wallets`,
  ].join(" "));

  if (sentinelArray.length === 0) {
    log(emit, "warn", "No sentinel mints found — trade-event confirmation will be skipped; ack-only used");
  }

  // ── Ramp helper ──
  const RAMP_STEPS = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    20, 30, 40, 50, 60, 70, 80, 90, 100,
    200, 300, 400, 500, 600, 700, 800, 900, 1000,
  ];

  const runRamp = async (
    subMethod: string,
    unsubMethod: string,
    pool: string[],
    sentinels: Set<string>,
    label: string
  ): Promise<BatchStep[]> => {
    log(emit, "section", `── ${label} (${pool.length} addresses, ${sentinels.size} sentinels)`);
    const steps: BatchStep[] = [];
    let prevN = 0;
    let connectionLost = false;

    let ws: WebSocket;
    try { ws = await openWs(); } catch (e) {
      log(emit, "error", `  Cannot connect: ${(e as Error).message}`);
      errors.push(`${label}: WS connect failed`);
      return steps;
    }

    ws.on("close", () => { connectionLost = true; });
    ws.on("error", () => { connectionLost = true; });

    // Callbacks for pending operations
    let ackCb: ((msg: Record<string, unknown>) => void) | null = null;
    let tradeCb: ((msg: Record<string, unknown>) => void) | null = null;
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (ackCb) ackCb(msg);
        if (tradeCb) tradeCb(msg);
      } catch { /* skip */ }
    });

    // Wait for a subscription acknowledgment (fast, ~100ms)
    const waitAck = (ms = 3_000): Promise<{ ok: boolean; ms: number; note?: string }> =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setTimeout(() => {
          ackCb = null;
          resolve({ ok: false, ms: Date.now() - t0, note: "no ack" });
        }, ms);
        ackCb = (msg) => {
          const text = typeof msg.message === "string" ? msg.message : "";
          if (text.toLowerCase().includes("subscribed")) {
            clearTimeout(timer); ackCb = null;
            resolve({ ok: true, ms: Date.now() - t0 });
          } else if (msg.errors) {
            clearTimeout(timer); ackCb = null;
            resolve({ ok: false, ms: Date.now() - t0, note: JSON.stringify(msg.errors) });
          }
        };
      });

    // Wait for a trade event from one of the sentinel addresses (5s)
    const waitTrade = (keys: string[], ms = 5_000): Promise<{ ok: boolean; ms: number; note?: string }> => {
      const keySet = new Set(keys);
      return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setTimeout(() => {
          tradeCb = null;
          resolve({ ok: false, ms: Date.now() - t0, note: "timeout — no trade event in 5s" });
        }, ms);
        tradeCb = (msg) => {
          const tradeKey = (msg.mint ?? msg.account ?? msg.wallet) as string | undefined;
          if (tradeKey && keySet.has(tradeKey)) {
            clearTimeout(timer); tradeCb = null;
            resolve({ ok: true, ms: Date.now() - t0 });
          }
          if (msg.errors) {
            clearTimeout(timer); tradeCb = null;
            resolve({ ok: false, ms: Date.now() - t0, note: JSON.stringify(msg.errors) });
          }
        };
      });
    };

    for (const n of RAMP_STEPS) {
      if (connectionLost) {
        steps.push({ n, strategy: "unsub-resub", result: "fail", note: "connection closed by server" });
        log(emit, "error", `  N=${n}: connection closed by server`);
        errors.push(`${label}: connection closed at N=${n}`);
        break;
      }
      if (pool.length < n) {
        steps.push({ n, strategy: "unsub-resub", result: "skip", note: `pool has only ${pool.length} addresses` });
        log(emit, "warn", `  N=${n}: SKIP (pool exhausted at ${pool.length})`);
        break;
      }

      const keys = pool.slice(0, n);
      const activeSentinels = keys.filter((k) => sentinels.has(k));

      // For steps 1-10: also test additive (no unsub before sending)
      if (n <= 10 && prevN > 0) {
        ws.send(JSON.stringify({ method: subMethod, keys }));
        const ack = await waitAck(3_000);
        steps.push({ n, strategy: "additive", result: ack.ok ? "ack-no-trade" : "fail", ackMs: ack.ms, note: ack.note ?? "ack only (no trade wait for additive)" });
        log(emit, ack.ok ? "success" : "warn",
          `  N=${n} additive: ${ack.ok ? `✓ ack ${ack.ms}ms` : `⚠ ${ack.note ?? "no ack"}`}`
        );
      }

      // Unsub+Resub strategy
      if (prevN > 0) {
        ws.send(JSON.stringify({ method: unsubMethod, keys: pool.slice(0, prevN) }));
        await new Promise((r) => setTimeout(r, 200));
      }
      ws.send(JSON.stringify({ method: subMethod, keys }));

      // Get ack first
      const ack = await waitAck(3_000);
      if (!ack.ok) {
        // Subscription was rejected
        steps.push({ n, strategy: "unsub-resub", result: "fail", ackMs: ack.ms, note: ack.note });
        log(emit, "error", `  N=${n} unsub+resub: ✗ ack failed — ${ack.note ?? "no ack"}`);
        errors.push(`${label}: subscription rejected at N=${n} (${ack.note ?? "no ack"})`);
        break;
      }

      // If we have active sentinels in this batch, wait for a trade event (true confirmation)
      let tradeResult: { ok: boolean; ms: number; note?: string } | null = null;
      if (activeSentinels.length > 0) {
        tradeResult = await waitTrade(activeSentinels, 5_000);
      }

      if (tradeResult && tradeResult.ok) {
        steps.push({ n, strategy: "unsub-resub", result: "ok", ackMs: ack.ms, tradeMs: tradeResult.ms });
        log(emit, "success", `  N=${n} unsub+resub: ✓ ack ${ack.ms}ms, trade ${tradeResult.ms}ms`);
      } else if (tradeResult && !tradeResult.ok) {
        // Ack received but no trade event — subscription was acknowledged but delivery unconfirmed
        steps.push({ n, strategy: "unsub-resub", result: "ack-no-trade", ackMs: ack.ms, note: tradeResult.note });
        log(emit, "warn", `  N=${n} unsub+resub: ⚠ ack ${ack.ms}ms, ${tradeResult.note}`);
      } else {
        // No sentinels in batch — can only confirm via ack
        steps.push({ n, strategy: "unsub-resub", result: "ack-no-trade", ackMs: ack.ms, note: "no sentinel in batch" });
        log(emit, "success", `  N=${n} unsub+resub: ✓ ack ${ack.ms}ms (no sentinel in batch)`);
      }

      prevN = n;
    }

    try { ws.close(); } catch { /* ignore */ }

    const maxTradeConfirmed = steps.filter((s) => s.strategy === "unsub-resub" && s.result === "ok").map((s) => s.n);
    const maxAckConfirmed = steps.filter((s) => s.strategy === "unsub-resub" && (s.result === "ok" || s.result === "ack-no-trade")).map((s) => s.n);
    const max = maxTradeConfirmed.length ? Math.max(...maxTradeConfirmed) : 0;
    const maxAck = maxAckConfirmed.length ? Math.max(...maxAckConfirmed) : 0;
    const failPoints = steps.filter((s) => s.result === "fail").map((s) => s.n);

    log(emit, "success", `  ▶ Max trade-confirmed: ${max} keys | Max ack-confirmed: ${maxAck} keys${failPoints.length ? ` | First fail: N=${failPoints[0]}` : ""}`);

    return steps;
  };

  let tokenSteps: BatchStep[] = [];
  let walletSteps: BatchStep[] = [];
  let runError: string | null = null;

  try {
    tokenSteps = await runRamp(
      "subscribeTokenTrade", "unsubscribeTokenTrade",
      orderedMintPool, sentinelMints,
      "subscribeTokenTrade"
    );

    // For wallet ramp, use seedWallets as sentinels (known active from Stage 2)
    const walletSentinels = new Set(seedWallets.slice(0, 5));
    walletSteps = await runRamp(
      "subscribeAccountTrade", "unsubscribeAccountTrade",
      orderedWalletPool, walletSentinels,
      "subscribeAccountTrade"
    );
  } catch (e) {
    runError = (e as Error).message;
    errors.push(runError);
    log(emit, "error", `Stage 4 error: ${runError}`);
  }

  const maxToken = Math.max(0, ...tokenSteps.filter((s) => s.strategy === "unsub-resub" && s.result === "ok").map((s) => s.n));
  const maxWallet = Math.max(0, ...walletSteps.filter((s) => s.strategy === "unsub-resub" && s.result === "ok").map((s) => s.n));

  const success = errors.length === 0;
  const duration = Date.now() - stageStart;
  stageEnd(emit, results, 4, stageName, success, duration, {
    mintPoolSize: orderedMintPool.length,
    walletPoolSize: orderedWalletPool.length,
    sentinelMints: sentinelArray.length,
    maxTokenBatchConfirmed: maxToken,
    maxWalletBatchConfirmed: maxWallet,
    tokenSteps,
    walletSteps,
  }, errors);
}

// ─── Main Exports ──────────────────────────────────────────────────────────

export async function runAllStages(emit: EmitFn): Promise<void> {
  const startTime = Date.now();
  const results: StageResult[] = [];

  log(emit, "header", "════════════ PENNY-PINCHER API TEST SUITE ════════════");

  const mints = await stage1MintCollection(emit, results);
  if (mints.length === 0) {
    emitComplete(emit, results, Date.now() - startTime);
    return;
  }

  const wallets = await stage2TradeWallets(emit, results, mints);
  if (wallets.length === 0) {
    log(emit, "error", "Stage 2 returned 0 wallets — aborting stages 3 and 4");
    emitComplete(emit, results, Date.now() - startTime);
    return;
  }

  await stage3WalletHistory(emit, results, wallets);
  await stage4BatchCapacity(emit, results, mints, wallets);

  emitComplete(emit, results, Date.now() - startTime);
}

export async function runSyntaxTests(emit: EmitFn): Promise<void> {
  const startTime = Date.now();
  let passed = 0;
  let failed = 0;

  const check = async (
    provider: string,
    method: string,
    fn: () => Promise<{ ok: boolean; note?: string }>
  ) => {
    try {
      const r = await fn();
      r.ok ? passed++ : failed++;
      emit({ type: "syntax-result", provider, method, passed: r.ok, error: r.note });
    } catch (e) {
      failed++;
      emit({ type: "syntax-result", provider, method, passed: false, error: (e as Error).message });
    }
  };

  await check("DexScreener", "token-boosts/latest/v1", async () => {
    const resp = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    return { ok: resp.ok, note: resp.ok ? undefined : `HTTP ${resp.status}` };
  });

  await check("DexPaprika", "sse/trades", async () => {
    const resp = await fetch(
      "https://api.dexpaprika.com/v1/sse/trades?tokens=So11111111111111111111111111111111111111112",
      { signal: AbortSignal.timeout(5_000) }
    );
    const ok = resp.ok || resp.status === 200;
    return { ok, note: ok ? undefined : `HTTP ${resp.status} (may be IP-banned in dev)` };
  });

  await check("PumpPortal", "wss-connect", async () => {
    const ws = await openWs();
    ws.close();
    return { ok: true };
  });

  emit({ type: "complete", passed, failed, totalDuration: Date.now() - startTime, results: [] });
}

function emitComplete(emit: EmitFn, results: StageResult[], totalDuration: number): void {
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  log(emit, "header", "════════════ TEST SUMMARY ════════════");
  log(emit, "info", `Stages completed: ${results.length}`);
  if (failed > 0) log(emit, "warn", `Failed: ${failed}`);

  emit({ type: "complete", passed, failed, totalDuration, results });
}
