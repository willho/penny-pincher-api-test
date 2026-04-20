/**
 * Per-API syntax validation tests
 * Tests request/response format correctness for each provider
 */

import { logger } from "../utils/logger";
import { SyntaxValidator } from "../utils/validator";

logger.header("API SYNTAX VALIDATION");

const testResults: {
  api: string;
  test: string;
  passed: boolean;
  error?: string;
}[] = [];

function testDexPaprika() {
  logger.section("DexPaprika SSE");

  // Test 1: Valid request
  const req1 = SyntaxValidator.validateDexPaprikaSSERequest([
    "EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc",
  ]);
  testResults.push({
    api: "DexPaprika",
    test: "Valid request format",
    passed: req1.valid,
    error: req1.error,
  });
  logger.info(`✓ Valid request: ${req1.valid}`);

  // Test 2: Invalid token address
  const req2 = SyntaxValidator.validateDexPaprikaSSERequest([
    "InvalidAddress",
  ]);
  testResults.push({
    api: "DexPaprika",
    test: "Invalid token rejection",
    passed: !req2.valid,
    error: req2.error,
  });
  logger.info(`✓ Invalid token rejected: ${!req2.valid}`);

  // Test 3: SSE event parsing
  const sseEvent =
    'data: {"tokenAddress":"EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc","signature":"sig123","maker":"maker123","tokenAmount":1000,"solAmount":0.5,"priceInSol":0.0005,"tradeTime":1234567890}';
  const event1 = SyntaxValidator.validateDexPaprikaSSEResponse(sseEvent);
  testResults.push({
    api: "DexPaprika",
    test: "SSE event parsing",
    passed: event1.valid,
    error: event1.error,
  });
  logger.info(`✓ SSE event valid: ${event1.valid}`);

  // Test 4: Missing required field
  const malformedEvent =
    'data: {"tokenAddress":"EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc"}';
  const event2 = SyntaxValidator.validateDexPaprikaSSEResponse(malformedEvent);
  testResults.push({
    api: "DexPaprika",
    test: "Missing field rejection",
    passed: !event2.valid,
    error: event2.error,
  });
  logger.info(`✓ Missing fields rejected: ${!event2.valid}`);
}

function testDexScreener() {
  logger.section("DexScreener");

  // Test 1: Valid response with tokens
  const resp1 = {
    tokens: [
      {
        address: "EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc",
        chainId: "solana",
        symbol: "USDC",
        name: "USDC",
        decimals: 6,
      },
    ],
  };
  const test1 = SyntaxValidator.validateDexScreenerResponse(resp1);
  testResults.push({
    api: "DexScreener",
    test: "Valid response with tokens",
    passed: test1.valid,
    error: test1.error,
  });
  logger.info(`✓ Valid response: ${test1.valid}`);

  // Test 2: Missing required token fields
  const resp2 = {
    tokens: [{ address: "EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc" }],
  };
  const test2 = SyntaxValidator.validateDexScreenerResponse(resp2);
  testResults.push({
    api: "DexScreener",
    test: "Missing token fields rejection",
    passed: !test2.valid,
    error: test2.error,
  });
  logger.info(`✓ Missing fields rejected: ${!test2.valid}`);

  // Test 3: Empty response
  const test3 = SyntaxValidator.validateDexScreenerResponse({});
  testResults.push({
    api: "DexScreener",
    test: "Empty response rejection",
    passed: !test3.valid,
    error: test3.error,
  });
  logger.info(`✓ Empty response rejected: ${!test3.valid}`);
}

function testChainstack() {
  logger.section("Chainstack JSON-RPC");

  // Test 1: Valid JSON-RPC request
  const req1 = {
    jsonrpc: "2.0",
    method: "getSignaturesForAddress",
    params: ["EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc"],
    id: 1,
  };
  const test1 = SyntaxValidator.validateChainStackJsonRpc(req1);
  testResults.push({
    api: "Chainstack",
    test: "Valid JSON-RPC request",
    passed: test1.valid,
    error: test1.error,
  });
  logger.info(`✓ Valid request: ${test1.valid}`);

  // Test 2: Missing jsonrpc field
  const req2 = {
    method: "getSignaturesForAddress",
    params: [],
    id: 1,
  };
  const test2 = SyntaxValidator.validateChainStackJsonRpc(req2);
  testResults.push({
    api: "Chainstack",
    test: "Missing jsonrpc rejection",
    passed: !test2.valid,
    error: test2.error,
  });
  logger.info(`✓ Missing jsonrpc rejected: ${!test2.valid}`);

  // Test 3: Valid response with result
  const resp1 = {
    jsonrpc: "2.0",
    result: [{ signature: "sig1", slot: 100 }],
    id: 1,
  };
  const test3 = SyntaxValidator.validateChainStackJsonRpcResponse(resp1);
  testResults.push({
    api: "Chainstack",
    test: "Valid response with result",
    passed: test3.valid,
    error: test3.error,
  });
  logger.info(`✓ Valid response: ${test3.valid}`);

  // Test 4: Valid error response
  const resp2 = {
    jsonrpc: "2.0",
    error: { code: -32600, message: "Invalid request" },
    id: 1,
  };
  const test4 = SyntaxValidator.validateChainStackJsonRpcResponse(resp2);
  testResults.push({
    api: "Chainstack",
    test: "Valid error response",
    passed: test4.valid,
    error: test4.error,
  });
  logger.info(`✓ Valid error response: ${test4.valid}`);

  // Test 5: Missing result and error
  const resp3 = { jsonrpc: "2.0", id: 1 };
  const test5 = SyntaxValidator.validateChainStackJsonRpcResponse(resp3);
  testResults.push({
    api: "Chainstack",
    test: "Missing result/error rejection",
    passed: !test5.valid,
    error: test5.error,
  });
  logger.info(`✓ Missing result/error rejected: ${!test5.valid}`);
}

function testShyft() {
  logger.section("Shyft");

  // Test 1: Valid success response
  const resp1 = {
    success: true,
    data: { address: "EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc" },
  };
  const test1 = SyntaxValidator.validateShyftResponse(resp1);
  testResults.push({
    api: "Shyft",
    test: "Valid success response",
    passed: test1.valid,
    error: test1.error,
  });
  logger.info(`✓ Valid success response: ${test1.valid}`);

  // Test 2: Valid error response
  const resp2 = {
    success: false,
    error: "Token not found",
  };
  const test2 = SyntaxValidator.validateShyftResponse(resp2);
  testResults.push({
    api: "Shyft",
    test: "Valid error response",
    passed: test2.valid,
    error: test2.error,
  });
  logger.info(`✓ Valid error response: ${test2.valid}`);

  // Test 3: Missing data in success
  const resp3 = { success: true };
  const test3 = SyntaxValidator.validateShyftResponse(resp3);
  testResults.push({
    api: "Shyft",
    test: "Missing data rejection",
    passed: !test3.valid,
    error: test3.error,
  });
  logger.info(`✓ Missing data rejected: ${!test3.valid}`);

  // Test 4: Missing error in failure
  const resp4 = { success: false };
  const test4 = SyntaxValidator.validateShyftResponse(resp4);
  testResults.push({
    api: "Shyft",
    test: "Missing error rejection",
    passed: !test4.valid,
    error: test4.error,
  });
  logger.info(`✓ Missing error rejected: ${!test4.valid}`);
}

function testPumpPortal() {
  logger.section("PumpPortal WebSocket");

  // Test 1: Valid subscribe message
  const msg1 = { method: "subscribeNewToken" };
  const test1 = SyntaxValidator.validatePumpPortalMessage(msg1);
  testResults.push({
    api: "PumpPortal",
    test: "Valid subscribe message",
    passed: test1.valid,
    error: test1.error,
  });
  logger.info(`✓ Valid message: ${test1.valid}`);

  // Test 2: Invalid method
  const msg2 = { method: "invalidMethod" };
  const test2 = SyntaxValidator.validatePumpPortalMessage(msg2);
  testResults.push({
    api: "PumpPortal",
    test: "Invalid method rejection",
    passed: !test2.valid,
    error: test2.error,
  });
  logger.info(`✓ Invalid method rejected: ${!test2.valid}`);

  // Test 3: Missing method
  const msg3 = {};
  const test3 = SyntaxValidator.validatePumpPortalMessage(msg3);
  testResults.push({
    api: "PumpPortal",
    test: "Missing method rejection",
    passed: !test3.valid,
    error: test3.error,
  });
  logger.info(`✓ Missing method rejected: ${!test3.valid}`);
}

// Run all tests
testDexPaprika();
testDexScreener();
testChainstack();
testShyft();
testPumpPortal();

// Summary
logger.header("SYNTAX TEST SUMMARY");
const passed = testResults.filter((r) => r.passed).length;
const failed = testResults.filter((r) => !r.passed).length;

logger.info(`Total tests: ${testResults.length}`);
logger.success(`Passed: ${passed}`);
if (failed > 0) logger.warn(`Failed: ${failed}`);

if (failed > 0) {
  logger.divider();
  logger.section("FAILED TESTS");
  for (const result of testResults.filter((r) => !r.passed)) {
    logger.error(`${result.api} - ${result.test}`);
    if (result.error) logger.error(`  Error: ${result.error}`);
  }
}
