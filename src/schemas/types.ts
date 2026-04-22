/**
 * API Response Type Definitions
 * Used for strict syntax validation across all providers
 */

// ============================================================================
// PumpPortal WebSocket Types
// ============================================================================

export interface PumpPortalSubscriptionMessage {
  method: "subscribeNewToken" | "subscribeTokenTrade" | "unsubscribe";
  keys?: string[];
}

export interface PumpPortalTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  decimals: number;
  initialBuy?: {
    solAmount: number;
    tokenAmount: number;
    isBurned: boolean;
  };
}

export interface PumpPortalTradeEvent {
  signature: string;
  mint: string;
  txType: "buy" | "sell";
  initialBuy?: boolean;
  initialSell?: boolean;
  tokenAmount: number;
  solAmount: number;
  isMigrated?: boolean;
  user: string;
  timestamp: number;
  txIndex: number;
}

// ============================================================================
// DexPaprika SSE Types
// ============================================================================

export interface DexPaprikaSSERequest {
  tokens: string; // comma-separated mint addresses
}

export interface DexPaprikaSSEEvent {
  data: {
    tokenAddress: string;
    dexProgram?: string;
    signature: string;
    maker: string;
    mint: string;
    solAmount: number;
    tokenAmount: number;
    tokenDecimals: number;
    priceInSol: number;
    tradeTime: number;
  };
}

// ============================================================================
// DexScreener Types
// ============================================================================

export interface DexScreenerToken {
  address: string;
  chainId: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    m5: number;
    h1: number;
    h24: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h24: number;
  };
}

export interface DexScreenerResponse {
  tokens?: DexScreenerToken[];
  pairs?: DexScreenerPair[];
  schemaVersion?: string;
}

// ============================================================================
// Chainstack JSON-RPC Types
// ============================================================================

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id: number | string;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: number | string;
}

export interface ChainstackSignature {
  signature: string;
  slot: number;
  err: null | object;
  memo: string | null;
  blockTime: number;
}

// ============================================================================
// Shyft Types
// ============================================================================

export interface ShyftTokenResponse {
  success: boolean;
  data?: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoURI?: string;
  };
  error?: string;
}

export interface ShyftAccountResponse {
  success: boolean;
  data?: {
    address: string;
    lamports: number;
    data: {
      [key: string]: unknown;
    };
  };
  error?: string;
}

// ============================================================================
// Test Summary Types
// ============================================================================

export interface ApiTestResult {
  api: string;
  endpoint: string;
  success: boolean;
  statusCode?: number;
  responseTime: number;
  syntaxValid: boolean;
  errorMessage?: string;
  requestSample?: unknown;
  responseSample?: unknown;
}

export interface CoverageInfo {
  api: string;
  pumpFunOnly: boolean | null;
  fullSolanaChain: boolean | null;
  latencyMs: number;
  confirmed: boolean;
}

export interface RateLimitTestResult {
  api: string;
  requestsPerSecond: number;
  monthlyQuota?: number;
  calculatedRateLimit: number;
  testsPassed: number;
  testsFailed: number;
  overageDetected: boolean;
}
