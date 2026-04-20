/**
 * Syntax validators for each API
 * Validates request/response formats match provider specifications exactly
 */

export class SyntaxValidator {
  static validateDexPaprikaSSERequest(tokens: string[]): {
    valid: boolean;
    error?: string;
    formatted?: string;
  } {
    // DexPaprika requires comma-separated token addresses in query string
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { valid: false, error: "Tokens must be non-empty array" };
    }

    const tokensCsv = tokens.join(",");

    // Validate each token is a valid Solana address (44 chars, base58)
    const base58Regex = /^[1-9A-HJ-NP-Z]{44}$/;
    for (const token of tokens) {
      if (!base58Regex.test(token)) {
        return {
          valid: false,
          error: `Invalid Solana address format: ${token}`,
        };
      }
    }

    return {
      valid: true,
      formatted: `POST /v1/sse/trades?tokens=${tokensCsv}`,
    };
  }

  static validateDexPaprikaSSEResponse(data: string): {
    valid: boolean;
    error?: string;
    parsed?: object;
  } {
    // DexPaprika SSE responses are Server-Sent Events format
    // Each line should be "data: {json}"
    if (!data.includes("data:")) {
      return {
        valid: false,
        error: "SSE format missing 'data:' prefix",
      };
    }

    try {
      const jsonPart = data.split("data:")[1]?.trim();
      if (!jsonPart) {
        return {
          valid: false,
          error: "No JSON data after 'data:' prefix",
        };
      }

      const parsed = JSON.parse(jsonPart);

      // Validate required fields for trade events
      const required = [
        "tokenAddress",
        "signature",
        "maker",
        "tokenAmount",
        "solAmount",
        "priceInSol",
      ];
      for (const field of required) {
        if (!(field in parsed)) {
          return {
            valid: false,
            error: `Missing required field: ${field}`,
          };
        }
      }

      return { valid: true, parsed };
    } catch (e) {
      return {
        valid: false,
        error: `Failed to parse JSON: ${(e as Error).message}`,
      };
    }
  }

  static validateDexScreenerResponse(data: unknown): {
    valid: boolean;
    error?: string;
  } {
    if (typeof data !== "object" || data === null) {
      return { valid: false, error: "Response must be JSON object" };
    }

    const obj = data as Record<string, unknown>;

    // DexScreener returns either tokens or pairs array
    const hasTokens = Array.isArray(obj.tokens);
    const hasPairs = Array.isArray(obj.pairs);

    if (!hasTokens && !hasPairs) {
      return {
        valid: false,
        error: "Response must contain 'tokens' or 'pairs' array",
      };
    }

    // If tokens, validate structure
    if (hasTokens && obj.tokens) {
      const tokens = obj.tokens as unknown[];
      if (tokens.length > 0) {
        const token = tokens[0] as Record<string, unknown>;
        const tokenRequired = ["address", "chainId", "symbol"];
        for (const field of tokenRequired) {
          if (!(field in token)) {
            return {
              valid: false,
              error: `Token missing required field: ${field}`,
            };
          }
        }
      }
    }

    return { valid: true };
  }

  static validateChainStackJsonRpc(request: unknown): {
    valid: boolean;
    error?: string;
  } {
    if (typeof request !== "object" || request === null) {
      return { valid: false, error: "Request must be JSON object" };
    }

    const req = request as Record<string, unknown>;

    // JSON-RPC 2.0 spec requires these fields
    if (req.jsonrpc !== "2.0") {
      return { valid: false, error: 'jsonrpc field must be "2.0"' };
    }

    if (typeof req.method !== "string" || req.method.length === 0) {
      return { valid: false, error: "method must be non-empty string" };
    }

    if (!Array.isArray(req.params)) {
      return { valid: false, error: "params must be array" };
    }

    if (typeof req.id !== "string" && typeof req.id !== "number") {
      return { valid: false, error: "id must be string or number" };
    }

    return { valid: true };
  }

  static validateChainStackJsonRpcResponse(response: unknown): {
    valid: boolean;
    error?: string;
  } {
    if (typeof response !== "object" || response === null) {
      return { valid: false, error: "Response must be JSON object" };
    }

    const resp = response as Record<string, unknown>;

    // JSON-RPC 2.0 response must have jsonrpc, id, and either result or error
    if (resp.jsonrpc !== "2.0") {
      return { valid: false, error: 'jsonrpc field must be "2.0"' };
    }

    if (typeof resp.id !== "string" && typeof resp.id !== "number") {
      return { valid: false, error: "id must be present in response" };
    }

    const hasResult = "result" in resp;
    const hasError = "error" in resp;

    if (!hasResult && !hasError) {
      return {
        valid: false,
        error: "Response must contain either 'result' or 'error'",
      };
    }

    // If error, validate error structure
    if (hasError && resp.error) {
      const err = resp.error as Record<string, unknown>;
      if (typeof err.code !== "number" || typeof err.message !== "string") {
        return {
          valid: false,
          error: "Error must have code (number) and message (string)",
        };
      }
    }

    return { valid: true };
  }

  static validateShyftResponse(response: unknown): {
    valid: boolean;
    error?: string;
  } {
    if (typeof response !== "object" || response === null) {
      return { valid: false, error: "Response must be JSON object" };
    }

    const resp = response as Record<string, unknown>;

    // Shyft responses have success boolean
    if (typeof resp.success !== "boolean") {
      return { valid: false, error: "success field must be boolean" };
    }

    // If success false, should have error
    if (resp.success === false && typeof resp.error !== "string") {
      return { valid: false, error: "Failed response must have error message" };
    }

    // If success true, should have data
    if (resp.success === true && !("data" in resp)) {
      return {
        valid: false,
        error: "Successful response must have data field",
      };
    }

    return { valid: true };
  }

  static validatePumpPortalMessage(message: unknown): {
    valid: boolean;
    error?: string;
  } {
    if (typeof message !== "object" || message === null) {
      return { valid: false, error: "Message must be JSON object" };
    }

    const msg = message as Record<string, unknown>;

    // PumpPortal messages must have method field
    if (typeof msg.method !== "string") {
      return { valid: false, error: "method field must be string" };
    }

    const validMethods = [
      "subscribeNewToken",
      "subscribeTokenTrade",
      "unsubscribe",
    ];
    if (!validMethods.includes(msg.method)) {
      return {
        valid: false,
        error: `method must be one of: ${validMethods.join(", ")}`,
      };
    }

    return { valid: true };
  }
}
