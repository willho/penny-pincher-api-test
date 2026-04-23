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

function log(emit: EmitFn, level: string, message: string, stage?: string): void {
  const prefix = stage ? `[${stage}] ` : "";
  emit({ type: "log", level, message: prefix + message, stage });
}

const PUMPPORTAL_WS = () =>
  process.env.PUMPPORTAL_WS_URL ?? "wss://pumpportal.fun/api/data";

const PUMPDEV_WS = () =>
  process.env.PUMPDEV_WS_URL ?? "wss://pumpdev.io/ws";

function openWs(): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(PUMPPORTAL_WS());
    const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
    ws.once("open", () => { clearTimeout(t); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

function openWsDev(): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(PUMPDEV_WS());
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
  const stageName = "Stage 1: Mint Collection (subscribeNewToken from PumpPortal + PumpDev)";
  const stagePrefix = "STAGE-1";
  emit({ type: "stage-start", stage: 1, name: stageName });
  log(emit, "header", "════ " + stageName, stagePrefix);

  const COLLECT_TARGET = 2000;
  const TIMEOUT_MS = 300_000;
  const PROGRESS_LOG_INTERVAL = 200;
  const stageStart = Date.now();
  const mintSet = new Set<string>();
  const errors: string[] = [];
  let success = false;
  let ppConnected = false;
  let pdConnected = false;

  try {
    log(emit, "info", `Attempting dual-source collection (target: ${COLLECT_TARGET} mints, no time limit)...`, stagePrefix);

    // Open both connections in parallel
    const ppPromise = openWs()
      .then((ws) => { ppConnected = true; log(emit, "success", "✓ PumpPortal WebSocket connected", stagePrefix); return ws; })
      .catch((e) => { log(emit, "warn", `PumpPortal connection failed: ${(e as Error).message}`, stagePrefix); return null; });

    const pdPromise = openWsDev()
      .then((ws) => { pdConnected = true; log(emit, "success", "✓ PumpDev WebSocket connected", stagePrefix); return ws; })
      .catch((e) => { log(emit, "warn", `PumpDev connection failed: ${(e as Error).message}`, stagePrefix); return null; });

    const [ppWs, pdWs] = await Promise.all([ppPromise, pdPromise]);

    if (!ppWs && !pdWs) {
      errors.push("Neither PumpPortal nor PumpDev could connect");
      log(emit, "error", "✗ All connection attempts failed");
    } else {
      const timeout = setTimeout(() => {
        if (ppWs) ppWs.close();
        if (pdWs) pdWs.close();
      }, TIMEOUT_MS);

      // Subscribe to both
      if (ppWs) {
        ppWs.send(JSON.stringify({ method: "subscribeNewToken" }));
      }
      if (pdWs) {
        pdWs.send(JSON.stringify({ method: "subscribeNewToken" }));
      }

      // Set up message handlers for both
      const messageHandler = (source: string) => (data: unknown) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof msg.mint === "string" && !mintSet.has(msg.mint)) {
            mintSet.add(msg.mint);
            if (mintSet.size === 1) {
              log(emit, "info", `First mint (${source}): ${msg.mint.slice(0, 20)}...`);
            }
            if (mintSet.size % PROGRESS_LOG_INTERVAL === 0) {
              log(emit, "info", `Progress: ${mintSet.size}/${COLLECT_TARGET} mints collected (${source})...`, stagePrefix);
            }
            if (mintSet.size >= COLLECT_TARGET) {
              clearTimeout(timeout);
              if (ppWs) ppWs.close();
              if (pdWs) pdWs.close();
            }
          }
          if (msg.errors) log(emit, "warn", `${source}: ${JSON.stringify(msg.errors)}`);
        } catch { /* skip */ }
      };

      if (ppWs) {
        ppWs.on("message", messageHandler("PumpPortal"));
        ppWs.on("close", () => { clearTimeout(timeout); });
        ppWs.on("error", () => { clearTimeout(timeout); });
      }

      if (pdWs) {
        pdWs.on("message", messageHandler("PumpDev"));
        pdWs.on("close", () => { clearTimeout(timeout); });
        pdWs.on("error", () => { clearTimeout(timeout); });
      }

      // Wait for completion
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!ppWs || ppWs.readyState === 3) { // CLOSED = 3
            if (!pdWs || pdWs.readyState === 3) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve();
            }
          }
        }, 100);
      });
    }

    if (mintSet.size === 0) {
      errors.push(`No mints collected within ${TIMEOUT_MS / 1000}s from either source`);
      log(emit, "error", "✗ No mints received — Stage 1 failed");
    } else {
      log(emit, "success", `✓ Collected ${mintSet.size} mints from ${ppConnected ? "PumpPortal" : ""}${ppConnected && pdConnected ? " + " : ""}${pdConnected ? "PumpDev" : ""}`);
      success = true;
    }
  } catch (e) {
    errors.push((e as Error).message);
    log(emit, "error", `Stage 1 error: ${(e as Error).message}`);
  }

  const duration = Date.now() - stageStart;
  stageEnd(emit, results, 1, stageName, success, duration, { mintsCollected: mintSet.size, pumpportalConnected: ppConnected, pumpdevConnected: pdConnected }, errors);
  return Array.from(mintSet);
}

// ─── Stage 2: Trade Wallet Collection ─────────────────────────────────────

async function stage2TradeWallets(
  emit: EmitFn,
  results: StageResult[],
  mints: string[]
): Promise<string[]> {
  const stageName = "Stage 2: Trade Wallet Collection (subscribeTokenTrade from PumpPortal + PumpDev)";
  emit({ type: "stage-start", stage: 2, name: stageName });
  log(emit, "header", "════ " + stageName);

  const COLLECT_TARGET = 2000;
  const TIMEOUT_MS = 300_000;
  const PROGRESS_LOG_INTERVAL = 200;
  const stageStart = Date.now();
  const walletSet = new Set<string>();
  const errors: string[] = [];
  let success = false;
  let ppConnected = false;
  let pdConnected = false;

  // ── Dual-source trade wallet subscription ──
  try {
    log(emit, "info", `Subscribing to trades for ${mints.length} mints from dual sources (target: ${COLLECT_TARGET} wallets)...`);

    // Open both connections in parallel
    const ppPromise = openWs()
      .then((ws) => { ppConnected = true; log(emit, "success", "✓ PumpPortal WebSocket connected"); return ws; })
      .catch((e) => { log(emit, "warn", `PumpPortal connection failed: ${(e as Error).message}`); return null; });

    const pdPromise = openWsDev()
      .then((ws) => { pdConnected = true; log(emit, "success", "✓ PumpDev WebSocket connected"); return ws; })
      .catch((e) => { log(emit, "warn", `PumpDev connection failed: ${(e as Error).message}`); return null; });

    const [ppWs, pdWs] = await Promise.all([ppPromise, pdPromise]);

    if (!ppWs && !pdWs) {
      errors.push("Neither PumpPortal nor PumpDev could connect");
      log(emit, "error", "✗ All connection attempts failed");
    } else {
      const timeout = setTimeout(() => {
        if (ppWs) ppWs.close();
        if (pdWs) pdWs.close();
      }, TIMEOUT_MS);

      // Subscribe to both
      if (ppWs) {
        ppWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
      }
      if (pdWs) {
        pdWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
      }

      // Set up message handlers for both
      const messageHandler = (source: string) => (data: unknown) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg.message) log(emit, "info", `${source}: ${msg.message}`);
          if (typeof msg.traderPublicKey === "string" && !walletSet.has(msg.traderPublicKey)) {
            walletSet.add(msg.traderPublicKey);
            if (walletSet.size === 1) {
              log(emit, "info", `First trader wallet (${source}): ${msg.traderPublicKey.slice(0, 20)}...`);
            }
            if (walletSet.size % PROGRESS_LOG_INTERVAL === 0) {
              log(emit, "info", `Progress: ${walletSet.size}/${COLLECT_TARGET} wallets collected...`);
            }
            if (walletSet.size >= COLLECT_TARGET) {
              clearTimeout(timeout);
              if (ppWs) ppWs.close();
              if (pdWs) pdWs.close();
            }
          }
          if (msg.errors) log(emit, "warn", `${source}: ${JSON.stringify(msg.errors)}`);
        } catch { /* skip */ }
      };

      if (ppWs) {
        ppWs.on("message", messageHandler("PumpPortal"));
        ppWs.on("close", () => { clearTimeout(timeout); });
        ppWs.on("error", () => { clearTimeout(timeout); });
      }

      if (pdWs) {
        pdWs.on("message", messageHandler("PumpDev"));
        pdWs.on("close", () => { clearTimeout(timeout); });
        pdWs.on("error", () => { clearTimeout(timeout); });
      }

      // Wait for completion
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!ppWs || ppWs.readyState === 3) { // CLOSED = 3
            if (!pdWs || pdWs.readyState === 3) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve();
            }
          }
        }, 100);
      });
    }

    if (walletSet.size === 0) {
      errors.push(`No trade events in ${TIMEOUT_MS / 1000}s — no trader wallets collected`);
      log(emit, "error", "✗ No trade events received — Stage 2 failed");
    } else {
      log(emit, "success", `✓ Collected ${walletSet.size} real trader wallets from ${ppConnected ? "PumpPortal" : ""}${ppConnected && pdConnected ? " + " : ""}${pdConnected ? "PumpDev" : ""}`);
    }
  } catch (e) {
    errors.push((e as Error).message);
    log(emit, "error", `Stage 2 error: ${(e as Error).message}`);
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

  // ── DexPaprika streaming health check ──
  log(emit, "info", "DexPaprika streaming health check...");
  try {
    const t0 = Date.now();
    const resp = await fetch("https://streaming.dexpaprika.com/stream", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify([{ chain: "solana", address: "So11111111111111111111111111111111111111112", method: "t_p" }]),
      signal: AbortSignal.timeout(5_000),
    });
    const ms = Date.now() - t0;
    resp.ok
      ? log(emit, "success", `✓ DexPaprika streaming reachable (HTTP 200, ${ms}ms)`)
      : log(emit, "warn", `DexPaprika streaming: HTTP ${resp.status}`);
  } catch (e) {
    log(emit, "warn", `DexPaprika streaming unreachable: ${(e as Error).message}`);
  }

  success = walletSet.size > 0 && errors.length === 0;
  const duration = Date.now() - stageStart;
  stageEnd(emit, results, 2, stageName, success, duration, { walletsCollected: walletSet.size, mintsSubscribed: mints.length, pumpportalConnected: ppConnected, pumpdevConnected: pdConnected }, errors);
  return Array.from(walletSet);
}

// ─── Stage 3: Shyft 7-Day Wallet History Stress Test ─────────────────────────

async function stage3WalletHistory(
  emit: EmitFn,
  results: StageResult[],
  wallets: string[]
): Promise<void> {
  const stageName = "Stage 3: Shyft 7-Day Wallet History Stress Test (200 mints × 20 wallets = 4K queries)";
  const stagePrefix = "STAGE-3";
  emit({ type: "stage-start", stage: 3, name: stageName });
  log(emit, "header", "════ " + stageName, stagePrefix);

  const stageStart = Date.now();
  const errors: string[] = [];
  let success = false;

  const shyftKey = process.env.SHYFT_API_KEY;

  if (!shyftKey) {
    errors.push("SHYFT_API_KEY not configured");
    log(emit, "error", "✗ SHYFT_API_KEY not configured", stagePrefix);
  } else {
    // Stress test: 200 mints × 20 wallets per mint = 4,000 wallet queries
    const MINTS_TO_TEST = 200;
    const WALLETS_PER_MINT = 20;
    const TOTAL_WALLET_QUERIES = MINTS_TO_TEST * WALLETS_PER_MINT;

    log(emit, "info", `Stress testing Shyft with ${TOTAL_WALLET_QUERIES} wallet queries (${MINTS_TO_TEST} mints × ${WALLETS_PER_MINT} wallets)...`, stagePrefix);
    log(emit, "info", `Note: Reusing ${wallets.length} unique traders across synthetic distribution...`, stagePrefix);

    let successCount = 0;
    let failureCount = 0;
    let totalLatency = 0;
    let totalTxs = 0;
    let minLatency = Infinity;
    let maxLatency = 0;
    const latencies: number[] = [];

    const logInterval = 500; // Log progress every 500 queries
    const startTime = Date.now();

    for (let mintIdx = 0; mintIdx < MINTS_TO_TEST; mintIdx++) {
      // Distribute wallets across mints (cycle through available wallets)
      for (let walletIdx = 0; walletIdx < WALLETS_PER_MINT; walletIdx++) {
        const walletAddress = wallets[(mintIdx * WALLETS_PER_MINT + walletIdx) % wallets.length];
        const queryNum = mintIdx * WALLETS_PER_MINT + walletIdx + 1;

        try {
          const t0 = Date.now();
          const resp = await fetch(
            `https://api.shyft.to/sol/v1/transaction/history?network=mainnet-beta&account=${walletAddress}&tx_num=50`,
            {
              headers: { "x-api-key": shyftKey },
              signal: AbortSignal.timeout(10_000),
            }
          );
          const latency = Date.now() - t0;

          if (!resp.ok) {
            failureCount++;
            errors.push(`Query ${queryNum}: HTTP ${resp.status}`);
            if (queryNum % logInterval === 0) {
              log(emit, "warn", `Progress: ${queryNum}/${TOTAL_WALLET_QUERIES} (${failureCount} failures)`, stagePrefix);
            }
            continue;
          }

          const data = (await resp.json()) as { result?: Array<unknown> };
          const txCount = Array.isArray(data.result) ? data.result.length : 0;

          successCount++;
          totalLatency += latency;
          totalTxs += txCount;
          latencies.push(latency);
          minLatency = Math.min(minLatency, latency);
          maxLatency = Math.max(maxLatency, latency);

          if (queryNum % logInterval === 0) {
            const elapsed = Date.now() - startTime;
            const qps = (queryNum / elapsed * 1000).toFixed(1);
            log(emit, "info", `Progress: ${queryNum}/${TOTAL_WALLET_QUERIES} | Success: ${successCount} | QPS: ${qps} | Avg latency: ${(totalLatency / successCount).toFixed(0)}ms`, stagePrefix);
          }
        } catch (e) {
          failureCount++;
          const errMsg = (e as Error).message;
          errors.push(`Query ${queryNum}: ${errMsg}`);
        }
      }
    }

    // Calculate statistics
    const avgLatency = successCount > 0 ? (totalLatency / successCount).toFixed(0) : "N/A";
    const successRate = ((successCount / TOTAL_WALLET_QUERIES) * 100).toFixed(1);
    const avgTxs = successCount > 0 ? (totalTxs / successCount).toFixed(1) : "0";
    const totalElapsed = Date.now() - stageStart;
    const qps = (TOTAL_WALLET_QUERIES / totalElapsed * 1000).toFixed(2);

    // Calculate percentiles
    latencies.sort((a, b) => a - b);
    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : 0;
    const p99 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : 0;

    log(emit, "divider", "═" .repeat(80), stagePrefix);
    log(emit, "header", "SHYFT STRESS TEST RESULTS", stagePrefix);
    log(emit, "divider", "═" .repeat(80), stagePrefix);
    log(emit, "info", `Total Queries: ${TOTAL_WALLET_QUERIES}`, stagePrefix);
    log(emit, successCount === TOTAL_WALLET_QUERIES ? "success" : "warn", `Success Rate: ${successCount}/${TOTAL_WALLET_QUERIES} (${successRate}%)`, stagePrefix);
    log(emit, "info", `Failed: ${failureCount}`, stagePrefix);
    log(emit, "info", `Throughput: ${qps} queries/sec`, stagePrefix);
    log(emit, "info", `Total Time: ${(totalElapsed / 1000).toFixed(1)}s`, stagePrefix);
    log(emit, "divider", "─" .repeat(80), stagePrefix);
    log(emit, "info", `Latency - Min: ${minLatency}ms, Max: ${maxLatency}ms, Avg: ${avgLatency}ms`, stagePrefix);
    log(emit, "info", `Latency - P50: ${p50}ms, P95: ${p95}ms, P99: ${p99}ms`, stagePrefix);
    log(emit, "info", `Transactions - Total: ${totalTxs}, Avg per wallet: ${avgTxs}`, stagePrefix);
    log(emit, "divider", "═" .repeat(80), stagePrefix);

    success = failureCount === 0 && errors.length === 0;
  }

  const duration = Date.now() - stageStart;
  stageEnd(
    emit,
    results,
    3,
    stageName,
    success,
    duration,
    {
      totalQueries: 4000,
      mintsUsed: 200,
      walletsPerMint: 20,
      note: "Stress test: 4,000 Shyft wallet history queries to validate throughput for backend automation",
    },
    errors
  );
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

    // Single message callback used by waitConfirmation
    let msgCb: ((msg: Record<string, unknown>) => void) | null = null;
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msgCb) msgCb(msg);
      } catch { /* skip */ }
    });

    /**
     * Send a subscription and wait up to timeoutMs for confirmation.
     * Confirmation tiers (best to worst):
     *   "ok"          — a trade event from a sentinel address arrived
     *   "ack-no-trade" — subscription ack received but no trade event in window
     *   "fail"        — explicit errors from PumpPortal, connection closed, or no ack at all
     */
    const waitConfirmation = (
      sentinelKeys: string[],
      timeoutMs = 5_000
    ): Promise<{ result: "ok" | "ack-no-trade" | "fail"; ackMs?: number; tradeMs?: number; note?: string }> => {
      // Build set covering all fields PumpPortal may use to identify the subscribed key:
      //   - subscribeTokenTrade events carry the token as msg.mint
      //   - subscribeAccountTrade events carry the wallet as msg.traderPublicKey
      const sentinelSet = new Set(sentinelKeys);
      return new Promise((resolve) => {
        const t0 = Date.now();
        let ackMs: number | undefined;

        const timer = setTimeout(() => {
          msgCb = null;
          if (ackMs !== undefined) {
            resolve({ result: "ack-no-trade", ackMs, note: "timeout — no trade event in 5s" });
          } else {
            resolve({ result: "fail", note: "timeout — no ack within 5s" });
          }
        }, timeoutMs);

        msgCb = (msg) => {
          // Explicit error from PumpPortal
          if (msg.errors) {
            clearTimeout(timer); msgCb = null;
            resolve({ result: "fail", ackMs, note: JSON.stringify(msg.errors) });
            return;
          }

          // Trade-event confirmation: check all fields PumpPortal uses for the subscribed key
          if (sentinelSet.size > 0) {
            const candidates = [
              msg.mint,
              msg.traderPublicKey,  // wallet key used by subscribeAccountTrade
              msg.account,
              msg.wallet,
            ].filter((v): v is string => typeof v === "string");
            if (candidates.some((k) => sentinelSet.has(k))) {
              clearTimeout(timer); msgCb = null;
              resolve({ result: "ok", ackMs, tradeMs: Date.now() - t0 });
              return;
            }
          }

          // Subscription acknowledgment
          const text = typeof msg.message === "string" ? msg.message : "";
          if (ackMs === undefined && text.toLowerCase().includes("subscribed")) {
            ackMs = Date.now() - t0;
            // Keep waiting for a trade event until the timeout
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

      // For steps 1-10: also test additive strategy (send new sub without unsubscribing first)
      if (n <= 10 && prevN > 0) {
        ws.send(JSON.stringify({ method: subMethod, keys }));
        const c = await waitConfirmation(activeSentinels, 5_000);
        steps.push({ n, strategy: "additive", result: c.result, ackMs: c.ackMs, tradeMs: c.tradeMs, note: c.note });
        const icon = c.result === "ok" ? "✓" : c.result === "ack-no-trade" ? "⚠" : "✗";
        log(emit, c.result === "ok" ? "success" : c.result === "ack-no-trade" ? "warn" : "warn",
          `  N=${n} additive: ${icon} ${c.result}${c.ackMs !== undefined ? ` ack=${c.ackMs}ms` : ""}${c.tradeMs !== undefined ? ` trade=${c.tradeMs}ms` : ""}${c.note ? ` (${c.note})` : ""}`
        );
        // Additive failures are informational — do NOT break the ramp
      }

      // Unsub+Resub strategy (primary — always tested)
      if (prevN > 0) {
        ws.send(JSON.stringify({ method: unsubMethod, keys: pool.slice(0, prevN) }));
        await new Promise((r) => setTimeout(r, 200)); // brief settle
      }
      ws.send(JSON.stringify({ method: subMethod, keys }));
      const c = await waitConfirmation(activeSentinels, 5_000);

      steps.push({ n, strategy: "unsub-resub", result: c.result, ackMs: c.ackMs, tradeMs: c.tradeMs, note: c.note });
      const icon = c.result === "ok" ? "✓" : c.result === "ack-no-trade" ? "⚠" : "✗";
      log(emit, c.result === "ok" ? "success" : c.result === "ack-no-trade" ? "warn" : "error",
        `  N=${n} unsub+resub: ${icon} ${c.result}${c.ackMs !== undefined ? ` ack=${c.ackMs}ms` : ""}${c.tradeMs !== undefined ? ` trade=${c.tradeMs}ms` : ""}${c.note ? ` (${c.note})` : ""}`
      );

      if (c.result === "fail") {
        // Explicit PumpPortal rejection or no ack — stop the ramp
        errors.push(`${label}: subscription failed at N=${n} (${c.note ?? "unknown"})`);
        break;
      }

      prevN = n;
    }

    try { ws.close(); } catch { /* ignore */ }

    const maxTradeConfirmed = steps
      .filter((s) => s.strategy === "unsub-resub" && s.result === "ok")
      .map((s) => s.n);
    const maxAckConfirmed = steps
      .filter((s) => s.strategy === "unsub-resub" && (s.result === "ok" || s.result === "ack-no-trade"))
      .map((s) => s.n);
    const maxTrade = maxTradeConfirmed.length ? Math.max(...maxTradeConfirmed) : 0;
    const maxAck = maxAckConfirmed.length ? Math.max(...maxAckConfirmed) : 0;
    const failPoints = steps.filter((s) => s.result === "fail").map((s) => s.n);

    log(
      emit,
      maxTrade > 0 || maxAck > 0 ? "success" : "warn",
      `  ▶ Max trade-confirmed: ${maxTrade} keys | Max ack-confirmed: ${maxAck} keys` +
        (failPoints.length ? ` | First fail: N=${failPoints[0]}` : " | No failure detected")
    );

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

// ─── Stage 5: DexPaprika Bonding-Curve Price Stream ────────────────────────
// Uses POST https://streaming.dexpaprika.com/stream with bonding-curve mints
// from Stage 1. Tests whether DexPaprika indexes freshly launched PumpFun tokens.

async function stage5DexPaprika(
  emit: EmitFn,
  results: StageResult[],
  bondingMints: string[]
): Promise<void> {
  const stageName = "Stage 5: DexPaprika Bonding-Curve Price Stream";
  emit({ type: "stage-start", stage: 5, name: stageName });
  log(emit, "header", "════ " + stageName);

  const stageStart = Date.now();
  const errors: string[] = [];

  const testMints = bondingMints.slice(0, 20);
  if (testMints.length === 0) {
    errors.push("No bonding-curve mints available from Stage 1 — cannot test DexPaprika");
    log(emit, "error", "✗ No mints to test with");
    stageEnd(emit, results, 5, stageName, false, Date.now() - stageStart, { mintsProvided: 0 }, errors);
    return;
  }

  log(emit, "info", `Testing DexPaprika price stream with ${testMints.length} bonding-curve mint(s)`);
  log(emit, "info", `Mints: ${testMints.slice(0, 3).map((m) => m.slice(0, 16) + "...").join(", ")}${testMints.length > 3 ? ` +${testMints.length - 3} more` : ""}`);

  const assets = testMints.map((a) => ({ chain: "solana", address: a, method: "t_p" }));

  let eventsReceived = 0;
  let connectOk = false;
  let firstEventMs: number | undefined;
  let httpStatus: number | undefined;
  const uniqueMintsWithPrices = new Set<string>();
  const samplePrices: { mint: string; price: string }[] = [];
  const latencies: number[] = [];

  try {
    // Phase 1: connect (8s timeout)
    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), 8_000);
    const t0 = Date.now();
    const resp = await fetch("https://streaming.dexpaprika.com/stream", {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(assets),
      signal: connectController.signal,
    }).finally(() => clearTimeout(connectTimer));

    httpStatus = resp.status;

    if (!resp.ok) {
      let errBody = "";
      try { errBody = await resp.text(); } catch { /* ignore */ }
      errors.push(`DexPaprika HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
      log(emit, "error", `✗ DexPaprika HTTP ${resp.status}: ${errBody.slice(0, 100)}`);
      stageEnd(emit, results, 5, stageName, false, Date.now() - stageStart, {
        httpStatus,
        mintsProvided: testMints.length,
        eventsReceived: 0,
      }, errors);
      return;
    }

    connectOk = true;
    log(emit, "success", `✓ DexPaprika streaming connected (HTTP 200, ${Date.now() - t0}ms)`);
    log(emit, "info", "Reading price stream for 15s...");

    // Phase 2: read for exactly 15s
    const readController = new AbortController();
    const readTimer = setTimeout(() => readController.abort(), 15_000);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        if (readController.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as { a?: string; c?: string; p?: string; t?: number; t_p?: number };
            if (evt.a && evt.p) {
              eventsReceived++;
              uniqueMintsWithPrices.add(evt.a);
              if (evt.t_p) latencies.push(Date.now() / 1000 - evt.t_p);

              if (eventsReceived === 1) {
                firstEventMs = Date.now() - t0;
                log(emit, "success", `✓ First price event in ${firstEventMs}ms — ${evt.a.slice(0, 20)}... $${Number(evt.p).toFixed(8)}`);
              }
              if (samplePrices.length < 5 && !samplePrices.find((s) => s.mint === evt.a)) {
                samplePrices.push({ mint: evt.a, price: evt.p });
                log(emit, "info", `  price: ${evt.a.slice(0, 20)}... = $${Number(evt.p).toFixed(8)}`);
              }
            }
          } catch { /* malformed */ }
        }
      }
    } finally {
      clearTimeout(readTimer);
      reader.cancel().catch(() => { /* ignore */ });
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("abort") && !msg.includes("timeout") && !msg.includes("terminated") && !msg.includes("cancel")) {
      errors.push(`DexPaprika stream error: ${msg}`);
      log(emit, "error", `✗ ${msg}`);
    }
  }

  const avgLatencyMs = latencies.length > 0
    ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 1000)
    : undefined;

  if (eventsReceived > 0) {
    log(emit, "success", `✓ DexPaprika: ${eventsReceived} price event(s) for ${uniqueMintsWithPrices.size}/${testMints.length} bonding-curve mints${avgLatencyMs !== undefined ? ` (avg latency ${avgLatencyMs}ms)` : ""}`);
  } else if (connectOk) {
    log(emit, "warn", "⚠ DexPaprika connected but no price events in 15s — bonding-curve tokens may not yet be indexed");
  }

  // Warn-not-fail for 0 events: bonding-curve tokens are brand-new and may not be indexed
  const success = connectOk && errors.length === 0;
  stageEnd(emit, results, 5, stageName, success, Date.now() - stageStart, {
    httpStatus,
    mintsProvided: testMints.length,
    eventsReceived,
    uniqueMintsWithPrices: uniqueMintsWithPrices.size,
    firstEventMs,
    avgLatencyMs,
    samplePrices,
    note: connectOk && eventsReceived === 0 ? "Connected but no prices — bonding-curve tokens may not be indexed yet" : undefined,
  }, errors);
}

// ─── Stage 6: Graduated Token Cross-Provider Test ──────────────────────────
// Tests PumpPortal + PumpDev (pumpdev.io/ws) with mints that have GRADUATED
// from PumpFun bonding curve onto Raydium/Orca (sourced from DexScreener boosts).

async function stage6GraduatedTokens(
  emit: EmitFn,
  results: StageResult[]
): Promise<void> {
  const stageName = "Stage 6: Graduated Token Trade Streams (PumpPortal + PumpDev)";
  emit({ type: "stage-start", stage: 6, name: stageName });
  log(emit, "header", "════ " + stageName);

  const stageStart = Date.now();
  const errors: string[] = [];

  // ── Step 1: Fetch graduated mints from DexScreener boosts (Solana) ──
  log(emit, "info", "Fetching graduated mints from DexScreener boosts...");
  const graduatedMints: string[] = [];

  try {
    const resp = await fetch("https://api.dexscreener.com/token-boosts/latest/v1");
    if (resp.ok) {
      const boosts = (await resp.json()) as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
        url?: string;
      }>;
      const solanaMints = boosts
        .filter((b) => b.chainId === "solana" && typeof b.tokenAddress === "string")
        .map((b) => b.tokenAddress!);
      graduatedMints.push(...solanaMints.slice(0, 20)); // cap at 20
      log(emit, "success", `✓ ${graduatedMints.length} Solana mints from DexScreener boosts`);
      log(emit, "info", `  Sample: ${graduatedMints.slice(0, 3).map((m) => m.slice(0, 16) + "...").join(", ")}`);
    } else {
      errors.push(`DexScreener boosts HTTP ${resp.status}`);
      log(emit, "error", `✗ DexScreener HTTP ${resp.status}`);
    }
  } catch (e) {
    errors.push(`DexScreener: ${(e as Error).message}`);
    log(emit, "error", `✗ DexScreener: ${(e as Error).message}`);
  }

  if (graduatedMints.length === 0) {
    errors.push("No graduated mints available — cannot test providers");
    stageEnd(emit, results, 6, stageName, false, Date.now() - stageStart, {
      graduatedMintCount: 0,
    }, errors);
    return;
  }

  // ── Step 2: Test each provider with graduated mints ──
  const testProvider = async (
    name: string,
    wsUrl: string,
    mints: string[]
  ): Promise<{ connected: boolean; ackReceived: boolean; tradeReceived: boolean; firstTradeMs?: number; note?: string }> => {
    log(emit, "section", `── Testing ${name} (${wsUrl}) with ${mints.length} graduated mints`);
    const result = { connected: false, ackReceived: false, tradeReceived: false, firstTradeMs: undefined as number | undefined, note: undefined as string | undefined };

    try {
      const ws = new WebSocket(wsUrl);
      const t0 = Date.now();

      await new Promise<void>((resolve, reject) => {
        const connectTimer = setTimeout(() => reject(new Error("WS connect timeout (10s)")), 10_000);
        ws.once("open", () => { clearTimeout(connectTimer); resolve(); });
        ws.once("error", (e) => { clearTimeout(connectTimer); reject(e); });
      });

      result.connected = true;
      log(emit, "success", `  ✓ Connected to ${name} (${Date.now() - t0}ms)`);
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));

      await new Promise<void>((resolve) => {
        const streamTimer = setTimeout(() => resolve(), 15_000);

        ws.on("message", (data) => {
          try {
            const msg = JSON.parse(data.toString()) as Record<string, unknown>;

            // Ack detection (PumpPortal style)
            const text = typeof msg.message === "string" ? msg.message : "";
            if (!result.ackReceived && (text.toLowerCase().includes("subscribed") || msg.type === "subscribed")) {
              result.ackReceived = true;
              log(emit, "info", `  ✓ ${name}: subscription acknowledged (${Date.now() - t0}ms)`);
            }

            // Trade event detection — graduated tokens should have mint + txType/price
            if (!result.tradeReceived && typeof msg.mint === "string" && mints.includes(msg.mint)) {
              result.tradeReceived = true;
              result.firstTradeMs = Date.now() - t0;
              const txType = (msg.txType ?? msg.type ?? "trade") as string;
              log(emit, "success", `  ✓ ${name}: trade event for graduated mint ${msg.mint.slice(0, 16)}... (${txType}, ${result.firstTradeMs}ms)`);
              clearTimeout(streamTimer);
              resolve();
            }

            if (msg.errors) {
              result.note = JSON.stringify(msg.errors);
              log(emit, "warn", `  ⚠ ${name} error msg: ${result.note}`);
            }
          } catch { /* skip */ }
        });

        ws.on("close", () => { clearTimeout(streamTimer); resolve(); });
        ws.on("error", () => { clearTimeout(streamTimer); resolve(); });
      });

      try { ws.close(); } catch { /* ignore */ }

      if (!result.tradeReceived) {
        if (result.ackReceived) {
          result.note = "Subscribed but no trade event in 15s — graduated tokens may be low-volume";
          log(emit, "warn", `  ⚠ ${name}: ack received, no trade event in 15s`);
        } else {
          result.note = "No ack and no trade event in 15s";
          log(emit, "warn", `  ⚠ ${name}: no ack and no trade event`);
        }
      }
    } catch (e) {
      result.note = (e as Error).message;
      log(emit, "error", `  ✗ ${name}: ${result.note}`);
    }

    return result;
  };

  const pumpportalResult = await testProvider(
    "PumpPortal",
    process.env.PUMPPORTAL_WS_URL ?? "wss://pumpportal.fun/api/data",
    graduatedMints
  );

  const pumpdevResult = await testProvider(
    "PumpDev",
    process.env.PUMPDEV_WS_URL ?? "wss://pumpdev.io/ws",
    graduatedMints
  );

  // Stage success = both providers connected and at least subscribed
  const bothConnected = pumpportalResult.connected && pumpdevResult.connected;
  if (!pumpportalResult.connected) errors.push(`PumpPortal WS connect failed: ${pumpportalResult.note ?? "unknown"}`);
  if (!pumpdevResult.connected) errors.push(`PumpDev WS connect failed: ${pumpdevResult.note ?? "unknown"}`);

  log(emit, "section", "── Cross-Provider Summary");
  log(emit, pumpportalResult.tradeReceived ? "success" : "warn",
    `PumpPortal: connected=${pumpportalResult.connected} ack=${pumpportalResult.ackReceived} trade=${pumpportalResult.tradeReceived}${pumpportalResult.firstTradeMs !== undefined ? ` (${pumpportalResult.firstTradeMs}ms)` : ""}`
  );
  log(emit, pumpdevResult.tradeReceived ? "success" : "warn",
    `PumpDev:    connected=${pumpdevResult.connected} ack=${pumpdevResult.ackReceived} trade=${pumpdevResult.tradeReceived}${pumpdevResult.firstTradeMs !== undefined ? ` (${pumpdevResult.firstTradeMs}ms)` : ""}`
  );

  const success = bothConnected && errors.length === 0;
  stageEnd(emit, results, 6, stageName, success, Date.now() - stageStart, {
    graduatedMintCount: graduatedMints.length,
    pumpportal: pumpportalResult,
    pumpdev: pumpdevResult,
  }, errors);
}

// ─── Stage 7: DexPaprika 2,000-Token Bulk Subscription Stress Test ─────────
// Collects tokens from PumpPortal subscribeNewToken (bonding-curve) and
// DexScreener token-profiles/boosts (graduated), then subscribes up to 2000
// to DexPaprika streaming to stress-test the bulk subscription limit.

async function stage7DexPaprikaStress(
  emit: EmitFn,
  results: StageResult[]
): Promise<void> {
  const stageName = "Stage 7: DexPaprika 2,000-Token Bulk Subscription Stress Test";
  emit({ type: "stage-start", stage: 7, name: stageName });
  log(emit, "header", "════ " + stageName);

  const stageStart = Date.now();
  const errors: string[] = [];

  // ── Step 1: Collect tokens from two sources over 60s ──
  log(emit, "info", "Collecting tokens from PumpPortal new token stream + DexScreener (60s)...");

  const bondingMints: string[] = [];
  const graduatedMints: string[] = [];

  await Promise.all([
    // Source A: PumpPortal subscribeNewToken WS (bonding-curve mints)
    (async () => {
      try {
        const ws = await openWs();
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        log(emit, "info", "  PumpPortal subscribeNewToken started...");

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { ws.close(); resolve(); }, 60_000);
          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString()) as Record<string, unknown>;
              if (msg.mint && typeof msg.mint === "string") {
                bondingMints.push(msg.mint);
                if (bondingMints.length % 100 === 0) {
                  log(emit, "info", `  PumpPortal: ${bondingMints.length} bonding-curve mints...`);
                }
              }
            } catch { /* malformed */ }
          });
          ws.on("error", () => { clearTimeout(timeout); resolve(); });
          ws.on("close", () => { clearTimeout(timeout); resolve(); });
        });

        log(emit, "success", `✓ PumpPortal: ${bondingMints.length} bonding-curve mints collected`);
      } catch (e) {
        log(emit, "warn", `⚠ PumpPortal stream error: ${(e as Error).message}`);
      }
    })(),

    // Source B: DexScreener token-profiles + token-boosts (graduated/Raydium mints)
    (async () => {
      try {
        const [profilesResp, boostsResp] = await Promise.all([
          fetch("https://api.dexscreener.com/token-profiles/latest/v1"),
          fetch("https://api.dexscreener.com/token-boosts/latest/v1"),
        ]);

        if (profilesResp.ok) {
          const profiles = await profilesResp.json() as Array<{ chainId?: string; tokenAddress?: string }>;
          const addrs = profiles
            .filter((p) => p.chainId === "solana" && p.tokenAddress)
            .map((p) => p.tokenAddress as string);
          graduatedMints.push(...addrs);
          log(emit, "info", `  DexScreener profiles: ${addrs.length} Solana tokens`);
        }

        if (boostsResp.ok) {
          const boosts = await boostsResp.json() as Array<{ chainId?: string; tokenAddress?: string }>;
          const addrs = boosts
            .filter((b) => b.chainId === "solana" && b.tokenAddress)
            .map((b) => b.tokenAddress as string)
            .filter((a) => !graduatedMints.includes(a));
          graduatedMints.push(...addrs);
          log(emit, "info", `  DexScreener boosts: ${addrs.length} additional Solana tokens`);
        }

        log(emit, "success", `✓ DexScreener: ${graduatedMints.length} graduated tokens collected`);
      } catch (e) {
        log(emit, "warn", `⚠ DexScreener fetch error: ${(e as Error).message}`);
      }
    })(),
  ]);

  // ── Combine, dedup, cap at 2000 ──
  const seen = new Set<string>();
  const allTokens: string[] = [];
  for (const mint of [...bondingMints, ...graduatedMints]) {
    if (!seen.has(mint) && allTokens.length < 2000) {
      seen.add(mint);
      allTokens.push(mint);
    }
  }

  log(emit, "info", `Collected: ${bondingMints.length} bonding-curve + ${graduatedMints.length} graduated = ${allTokens.length} unique (cap 2000)`);

  if (allTokens.length === 0) {
    errors.push("No tokens collected from any source");
    stageEnd(emit, results, 7, stageName, false, Date.now() - stageStart, {
      bondingCurveTokens: 0, graduatedTokens: 0, tokensSubscribed: 0, totalEvents: 0,
    }, errors);
    return;
  }

  // ── Step 2: POST to DexPaprika streaming ──
  // Note: DexPaprika only supports graduated tokens (Raydium/Orca), not pump.fun bonding-curve
  log(emit, "info", `DexPaprika supports graduated tokens only. Using ${graduatedMints.length} graduated tokens (excluding ${bondingMints.length} bonding-curve)...`);

  // Validate tokens before sending (filter out invalid addresses) - use only graduated tokens
  const validTokens = graduatedMints.filter(a => {
    // Basic validation: Solana addresses are 43-44 chars, alphanumeric
    return a && a.length >= 40 && a.length <= 50 && /^[A-Za-z0-9]+$/.test(a);
  });

  if (validTokens.length < allTokens.length) {
    log(emit, "warn", `Filtered out ${allTokens.length - validTokens.length} invalid token addresses`);
  }

  const assets = validTokens.map((a) => ({ chain: "solana", address: a, method: "t_p" }));

  let totalEvents = 0;
  const tokenUpdateCounts = new Map<string, number>();
  let httpStatus: number | undefined;
  let connectOk = false;
  const t0 = Date.now();

  try {
    // Phase 1: connect (10s timeout)
    const connectController = new AbortController();
    const connectTimer = setTimeout(() => connectController.abort(), 10_000);

    const resp = await fetch("https://streaming.dexpaprika.com/stream", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(assets),
      signal: connectController.signal,
    }).finally(() => clearTimeout(connectTimer));

    httpStatus = resp.status;

    if (!resp.ok) {
      let errBody = "";
      try { errBody = await resp.text(); } catch { /* ignore */ }
      errors.push(`DexPaprika HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
      log(emit, "error", `✗ DexPaprika HTTP ${resp.status}: ${errBody.slice(0, 100)}`);
      log(emit, "warn", `Retrying with smaller batch (${Math.min(50, validTokens.length)} tokens)...`);

      // Retry with smaller batch if 400 error
      if (resp.status === 400 && validTokens.length > 50) {
        const smallBatch = validTokens.slice(0, 50).map((a) => ({ chain: "solana", address: a, method: "t_p" }));
        try {
          const retryResp = await fetch("https://streaming.dexpaprika.com/stream", {
            method: "POST",
            headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
            body: JSON.stringify(smallBatch),
            signal: AbortSignal.timeout(10_000),
          });

          if (retryResp.ok) {
            log(emit, "success", `✓ Retry succeeded with smaller batch`);
            // Continue with small batch response handling
          } else {
            throw new Error(`Retry also failed: HTTP ${retryResp.status}`);
          }
        } catch (e) {
          log(emit, "error", `✗ Retry failed: ${(e as Error).message}`);
        }
      }

      stageEnd(emit, results, 7, stageName, false, Date.now() - stageStart, {
        httpStatus, tokensSubscribed: validTokens.length,
        bondingCurveTokens: bondingMints.length, graduatedTokens: graduatedMints.length, totalEvents: 0,
        note: "DexPaprika only supports graduated tokens, bonding-curve tokens excluded",
      }, errors);
      return;
    }

    connectOk = true;
    log(emit, "success", `✓ DexPaprika accepted ${validTokens.length} graduated token subscriptions (HTTP 200, ${Date.now() - t0}ms)`);
    log(emit, "info", "Reading stream for 30s...");

    // Phase 2: read for exactly 30s
    const readController = new AbortController();
    const readTimer = setTimeout(() => readController.abort(), 30_000);
    const readStart = Date.now();
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastLogAt = Date.now();

    try {
      while (true) {
        if (readController.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            const evt = JSON.parse(raw) as { a?: string; p?: string; t_p?: number };
            if (evt.a && evt.p) {
              totalEvents++;
              tokenUpdateCounts.set(evt.a, (tokenUpdateCounts.get(evt.a) ?? 0) + 1);
              if (totalEvents === 1) {
                const latMs = evt.t_p ? Math.round((Date.now() / 1000 - evt.t_p) * 1000) : undefined;
                log(emit, "success", `✓ First price event: ${evt.a.slice(0, 20)}... $${Number(evt.p).toFixed(6)}${latMs !== undefined ? ` (latency ${latMs}ms)` : ""}`);
              }
            }
          } catch { /* malformed */ }
        }

        if (Date.now() - lastLogAt >= 5_000) {
          const elapsed = (Date.now() - readStart) / 1000;
          const evps = elapsed > 0 ? (totalEvents / elapsed).toFixed(1) : "0";
          log(emit, "info", `  ${totalEvents} events, ${tokenUpdateCounts.size} tokens priced, ${evps} ev/s`);
          lastLogAt = Date.now();
        }
      }
    } finally {
      clearTimeout(readTimer);
      reader.cancel().catch(() => { /* ignore */ });
    }
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("abort") && !msg.includes("timeout") && !msg.includes("terminated") && !msg.includes("cancel")) {
      errors.push(`DexPaprika stream error: ${msg}`);
      log(emit, "error", `✗ Stream error: ${msg}`);
    }
  }

  const actualReadSecs = Math.min(30, (Date.now() - t0) / 1000);
  const eventsPerSec = actualReadSecs > 0 ? (totalEvents / actualReadSecs).toFixed(1) : "0";
  const coveragePct = allTokens.length > 0
    ? ((tokenUpdateCounts.size / allTokens.length) * 100).toFixed(1)
    : "0";

  log(emit, totalEvents > 0 ? "success" : "warn",
    `DexPaprika 30s summary: ${totalEvents} events, ${tokenUpdateCounts.size}/${allTokens.length} tokens priced (${coveragePct}%), ${eventsPerSec} ev/s`
  );

  const success = connectOk && totalEvents > 0 && errors.length === 0;
  stageEnd(emit, results, 7, stageName, success, Date.now() - stageStart, {
    httpStatus,
    bondingCurveTokens: bondingMints.length,
    graduatedTokens: graduatedMints.length,
    tokensSubscribed: allTokens.length,
    totalEvents,
    eventsPerSec: Number(eventsPerSec),
    uniqueTokensWithUpdates: tokenUpdateCounts.size,
    coveragePct: Number(coveragePct),
  }, errors);
}

// ─── Main Exports ──────────────────────────────────────────────────────────

export async function runAllStages(emit: EmitFn): Promise<void> {
  const startTime = Date.now();
  const results: StageResult[] = [];

  log(emit, "header", "════════════ PENNY-PINCHER API TEST SUITE ════════════");
  log(emit, "info", "PARALLEL EXECUTION PLAN:", "ORCHESTRATOR");
  log(emit, "info", "  • Stage 1 (background): Collect 2000+ mints, NO time limit", "ORCHESTRATOR");
  log(emit, "info", "  • Stages 3-7 (independent): Start immediately, no Stage 1 dependency", "ORCHESTRATOR");
  log(emit, "info", "  • Stage 2 (dependent): Start after Stage 1 completes", "ORCHESTRATOR");
  log(emit, "divider", "═══════════════════════════════════════════════════════", "ORCHESTRATOR");

  // ── Start Stage 1 in background (runs until 2000+ mints collected, no timeout) ──
  log(emit, "info", ">>> Starting STAGE-1 (mint collection in background, no timeout)...", "ORCHESTRATOR");
  const stage1Promise = stage1MintCollection(emit, results);

  // ── Stages 4-7 start immediately (all independent) ──
  log(emit, "info", ">>> Starting Stages 4-7 immediately (independent tests)...", "ORCHESTRATOR");
  const stage4Promise = stage4BatchCapacity(emit, results, [], []);
  const stage5Promise = stage5DexPaprika(emit, results, []);
  const stage6Promise = stage6GraduatedTokens(emit, results);
  const stage7Promise = stage7DexPaprikaStress(emit, results);

  // ── Wait for Stage 1 to complete mint collection ──
  log(emit, "info", "[waiting...] STAGE-1 collecting mints, Stages 4-7 running in parallel", "ORCHESTRATOR");
  const mints = await stage1Promise;

  if (mints.length === 0) {
    log(emit, "error", "STAGE-1 FAILED: collected 0 mints — skipping Stages 2-3", "ORCHESTRATOR");
    await Promise.all([stage4Promise, stage5Promise, stage6Promise, stage7Promise]);
    emitComplete(emit, results, Date.now() - startTime);
    return;
  }

  log(emit, "divider", "═══════════════════════════════════════════════════════", "ORCHESTRATOR");
  // ── Run Stage 2 (needs Stage 1 mints) ──
  log(emit, "info", `STAGE-1 COMPLETE: Collected ${mints.length} mints. Starting STAGE-2...`, "ORCHESTRATOR");
  const wallets = await stage2TradeWallets(emit, results, mints);

  if (wallets.length === 0) {
    log(emit, "error", "STAGE-2 FAILED: collected 0 wallets — skipping Stage 3", "ORCHESTRATOR");
  } else {
    // ── Run Stage 3 (needs Stage 2 wallets) ──
    log(emit, "info", `STAGE-2 COMPLETE: Collected ${wallets.length} wallets. Starting STAGE-3 (Shyft 7-day history test)...`, "ORCHESTRATOR");
    await stage3WalletHistory(emit, results, wallets);
  }

  log(emit, "divider", "═══════════════════════════════════════════════════════", "ORCHESTRATOR");
  // ── Wait for remaining stages to complete ──
  log(emit, "info", "[waiting...] Waiting for Stages 4-7 to complete...", "ORCHESTRATOR");
  await Promise.all([stage4Promise, stage5Promise, stage6Promise, stage7Promise]);

  log(emit, "divider", "═══════════════════════════════════════════════════════", "ORCHESTRATOR");
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

  await check("DexPaprika", "streaming.dexpaprika.com/stream", async () => {
    const resp = await fetch("https://streaming.dexpaprika.com/stream", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify([{ chain: "solana", address: "So11111111111111111111111111111111111111112", method: "t_p" }]),
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: resp.ok, note: resp.ok ? undefined : `HTTP ${resp.status}` };
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
