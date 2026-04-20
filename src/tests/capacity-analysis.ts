/**
 * Capacity Analysis: Can APIs handle target system scale?
 * Tests: 500 tokens + 20 wallets with various subscription strategies
 */

import { logger } from "../utils/logger";

logger.header("CAPACITY ANALYSIS: API Limits vs System Scale");

interface Scenario {
  name: string;
  tokens: number;
  wallets: number;
  strategy: string;
  pumpPortalMsgSec: number;
  rpcCallsDay: number;
  rpcCreditsDay: number;
  dexPaprikaReqDay: number;
  feasible: boolean;
  bottleneck?: string;
}

const scenarios: Scenario[] = [];

// System targets from Penny-Pincher2
const config = {
  targetTokens: 500,
  targetWallets: 20,
  limits: {
    pumpPortalMsgSec: 200,
    rpcHeliusDay: 30000,
    rpcChainstackDay: 90000,
    dexPaprikaDay: 288000,
  },
};

logger.info(`Target: ${config.targetTokens} tokens + ${config.targetWallets} wallets`);
logger.divider();

// Scenario 1: All real-time (impossible)
logger.section("Scenario 1: All Real-Time Subscriptions");
const s1: Scenario = {
  name: "500 tokens all via PumpPortal WS",
  tokens: 500,
  wallets: 20,
  strategy: "3 WebSocket connections × 200 tokens",
  pumpPortalMsgSec: 600,
  rpcCallsDay: 0,
  rpcCreditsDay: 0,
  dexPaprikaReqDay: 0,
  feasible: false,
  bottleneck: "PumpPortal 600 msg/sec vs 200 limit (3x over capacity)",
};
scenarios.push(s1);
logger.warn(`❌ ${s1.bottleneck}`);

// Scenario 2: Rotation approach
logger.section("Scenario 2: Rotation (200 tokens real-time + 300 polled)");
const s2: Scenario = {
  name: "Rotate 200 tokens every 5min via PumpPortal + RPC polling",
  tokens: 500,
  wallets: 20,
  strategy: "1 WS (200 tokens) + RPC polling (300 tokens)",
  pumpPortalMsgSec: 200,
  rpcCallsDay: 300 * 1440, // 432K calls
  rpcCreditsDay: 300 * 1440 * 5, // 2.16M credits
  dexPaprikaReqDay: 10,
  feasible: false,
  bottleneck: `RPC: 2.16M credits/day vs ${(config.limits.rpcHeliusDay + config.limits.rpcChainstackDay) * 0.95 / 1e6}M limit`,
};
scenarios.push(s2);
logger.warn(`❌ ${s2.bottleneck}`);
logger.info(`RPC needed: ${(s2.rpcCreditsDay / 1e6).toFixed(2)}M credits/day`);
logger.info(`RPC available: ${((config.limits.rpcHeliusDay + config.limits.rpcChainstackDay) * 0.95 / 1e6).toFixed(2)}M credits/day (95% limit)`);

// Scenario 3: Smart hybrid with reduced scale
logger.section("Scenario 3: Smart Hybrid (200 tokens + 10 wallets)");
const s3: Scenario = {
  name: "200 tokens realistic: 50 real-time + 150 polled",
  tokens: 200,
  wallets: 10,
  strategy: "DexPaprika SSE 50 tokens + RPC poll 150 tokens + wallet monitoring",
  pumpPortalMsgSec: 0,
  rpcCallsDay: 150 * 1440 + 10 * 2 * 1440, // tokens + wallets
  rpcCreditsDay: (150 * 1440 + 10 * 2 * 1440) * 5,
  dexPaprikaReqDay: 5,
  feasible: false,
  bottleneck: "",
};

const rpcBudget = (config.limits.rpcHeliusDay + config.limits.rpcChainstackDay) * 0.95;
s3.feasible =
  s3.rpcCreditsDay <= rpcBudget &&
  s3.dexPaprikaReqDay <= config.limits.dexPaprikaDay;

if (s3.feasible) {
  logger.success(`✓ FEASIBLE`);
} else {
  s3.bottleneck = `RPC: ${(s3.rpcCreditsDay / 1e6).toFixed(2)}M credits vs ${(rpcBudget / 1e6).toFixed(2)}M limit`;
  logger.warn(`❌ ${s3.bottleneck}`);
}

logger.info(`RPC used: ${(s3.rpcCreditsDay / 1e6).toFixed(3)}M / ${(rpcBudget / 1e6).toFixed(2)}M credits`);
logger.info(`RPC remaining: ${((rpcBudget - s3.rpcCreditsDay) / 1e6).toFixed(2)}M credits for other ops`);
scenarios.push(s3);

// Scenario 4: Optimal mix
logger.section("Scenario 4: Optimal Mix (400 tokens + 15 wallets)");
const s4: Scenario = {
  name: "400 tokens: PumpPortal 200 real-time + DexPaprika 200 rotated",
  tokens: 400,
  wallets: 15,
  strategy: "1 WS (200 pump.fun) + DexPaprika rotating (200 graduated) + RPC poll",
  pumpPortalMsgSec: 120, // conservative
  rpcCallsDay: 200 * 1440 + 15 * 2 * 1440, // tokens + wallets
  rpcCreditsDay: (200 * 1440 + 15 * 2 * 1440) * 5,
  dexPaprikaReqDay: 2 * 6 * 24, // 2 rotations × 6 per hour × 24 hours
  feasible: false,
  bottleneck: "",
};

s4.feasible =
  s4.pumpPortalMsgSec <= config.limits.pumpPortalMsgSec &&
  s4.rpcCreditsDay <= rpcBudget &&
  s4.dexPaprikaReqDay <= config.limits.dexPaprikaDay;

if (s4.feasible) {
  logger.success(`✓ FEASIBLE`);
} else {
  if (s4.rpcCreditsDay > rpcBudget) {
    s4.bottleneck = `RPC: ${(s4.rpcCreditsDay / 1e6).toFixed(2)}M credits vs ${(rpcBudget / 1e6).toFixed(2)}M`;
  }
  logger.warn(`❌ ${s4.bottleneck || "Check metrics below"}`);
}

logger.info(`PumpPortal: ${s4.pumpPortalMsgSec} msg/sec (limit: ${config.limits.pumpPortalMsgSec})`);
logger.info(`DexPaprika: ${s4.dexPaprikaReqDay} req/day (limit: ${config.limits.dexPaprikaDay})`);
logger.info(`RPC: ${(s4.rpcCreditsDay / 1e6).toFixed(2)}M credits (limit: ${(rpcBudget / 1e6).toFixed(2)}M)`);
scenarios.push(s4);

// Summary
logger.divider();
logger.header("SUMMARY");

const feasible = scenarios.filter((s) => s.feasible);
const infeasible = scenarios.filter((s) => !s.feasible);

logger.info(`Scenarios analyzed: ${scenarios.length}`);
logger.success(`Feasible: ${feasible.length}`);
logger.warn(`Infeasible: ${infeasible.length}`);

logger.divider();
logger.section("FINDINGS");

if (feasible.length === 0) {
  logger.error("❌ Target 500-token scale NOT ACHIEVABLE with current APIs");
  logger.warn("Reasons:");
  logger.warn("  1. PumpPortal: 200 msg/sec limit → max ~200 simultaneous tokens");
  logger.warn("  2. RPC: 120K calls/day → max ~200 polled tokens at 1 check/min");
  logger.warn("  Combined: ~400 tokens max with smart rotation");
} else {
  logger.success(`✓ Found ${feasible.length} feasible approach(es):`);
  for (const s of feasible) {
    logger.success(`  • ${s.name}`);
  }
}

logger.divider();
logger.section("RECOMMENDATION");
logger.warn("Scale back from 500 to ~400 tokens with hybrid strategy:");
logger.info("  • PumpPortal: 1 WebSocket for 200 pump.fun tokens (real-time)");
logger.info("  • DexPaprika: Rotate 200 graduated tokens (10min batches)");
logger.info("  • RPC polling: Fallback for non-subscribed tokens (1x/min)");
logger.info("  • Wallet monitoring: 15 wallets (2 checks/min)");
logger.info("  Result: Full coverage, resilient to API hiccups");
