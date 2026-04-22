/**
 * Shared API client for all providers
 * Handles HTTP, WebSocket, and JSON-RPC with rate limiting
 */

import { logger } from "./logger";
import { SyntaxValidator } from "./validator";
import { RateLimiters, TokenBucketLimiter } from "./rate-limiters";

export class ApiClient {
  /**
   * Make HTTP GET request with rate limiting
   */
  static async getWithRateLimit(
    url: string,
    api: "dexPaprika" | "dexScreener" | "chainstack" | "shyftHttp",
    headers: Record<string, string> = {}
  ): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    statusCode?: number;
    responseTime: number;
  }> {
    const limiter =
      RateLimiters[api as keyof typeof RateLimiters] as TokenBucketLimiter;

    // Wait for rate limit
    await limiter.waitUntilAllowed();

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...headers,
        },
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          success: false,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
        };
      }

      const data = await response.json();

      // Validate syntax based on API type
      let syntaxValid = true;
      let syntaxError: string | undefined;

      if (api === "dexScreener") {
        const validation = SyntaxValidator.validateDexScreenerResponse(data);
        syntaxValid = validation.valid;
        syntaxError = validation.error;
      } else if (api === "shyftHttp") {
        const validation = SyntaxValidator.validateShyftResponse(data);
        syntaxValid = validation.valid;
        syntaxError = validation.error;
      }

      if (!syntaxValid) {
        logger.warn(
          `Syntax validation failed for ${api}: ${syntaxError}`
        );
      }

      return {
        success: true,
        data,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        error: (error as Error).message,
        responseTime,
      };
    }
  }

  /**
   * Make HTTP POST request (for DexPaprika SSE)
   */
  static async postWithRateLimit(
    url: string,
    api: "dexPaprika" | "dexScreener" = "dexPaprika",
    headers: Record<string, string> = {}
  ): Promise<{
    success: boolean;
    eventStream?: Response;
    error?: string;
    statusCode?: number;
    responseTime: number;
  }> {
    const limiter =
      RateLimiters[api as keyof typeof RateLimiters] as TokenBucketLimiter;

    // Wait for rate limit
    await limiter.waitUntilAllowed();

    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          ...headers,
        },
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          success: false,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${response.statusText}`,
          responseTime,
        };
      }

      return {
        success: true,
        eventStream: response,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        error: (error as Error).message,
        responseTime,
      };
    }
  }

  /**
   * Make JSON-RPC call with rate limiting
   */
  static async jsonRpcCall(
    rpcUrl: string,
    method: string,
    params: unknown[],
    id: number | string = 1
  ): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    responseTime: number;
  }> {
    const limiter = RateLimiters.chainstack;

    // Wait for rate limit (5 credits per request)
    await limiter.waitUntilAllowed(5);

    const startTime = Date.now();

    const request = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    // Validate request format
    const reqValidation = SyntaxValidator.validateChainStackJsonRpc(request);
    if (!reqValidation.valid) {
      return {
        success: false,
        error: `Invalid JSON-RPC request: ${reqValidation.error}`,
        responseTime: Date.now() - startTime,
      };
    }

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      const responseTime = Date.now() - startTime;
      const data = await response.json();

      // Validate response format
      const respValidation =
        SyntaxValidator.validateChainStackJsonRpcResponse(data);
      if (!respValidation.valid) {
        return {
          success: false,
          error: `Invalid JSON-RPC response: ${respValidation.error}`,
          responseTime,
        };
      }

      // Check for RPC error
      if (data.error) {
        return {
          success: false,
          error: `RPC Error (${data.error.code}): ${data.error.message}`,
          responseTime,
        };
      }

      return {
        success: true,
        data: data.result,
        responseTime,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        error: (error as Error).message,
        responseTime,
      };
    }
  }

  /**
   * Parse SSE stream events
   */
  static async parseSSEStream(
    response: Response,
    maxEvents = 10,
    timeoutMs = 5000
  ): Promise<{
    events: object[];
    parseErrors: string[];
    completedNormally: boolean;
  }> {
    const events: object[] = [];
    const parseErrors: string[] = [];

    if (!response.body) {
      return {
        events,
        parseErrors: ["Response has no body"],
        completedNormally: false,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const timeout = new Promise((resolve) =>
      setTimeout(resolve, timeoutMs)
    );

    let buffer = "";

    try {
      while (events.length < maxEvents) {
        const { done, value } = await Promise.race([
          reader.read(),
          timeout,
        ]) as { done?: boolean; value?: Uint8Array };

        if (done) {
          return {
            events,
            parseErrors,
            completedNormally: true,
          };
        }

        if (!value) {
          // Timeout reached
          return {
            events,
            parseErrors,
            completedNormally: false,
          };
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("data:")) {
            try {
              const jsonStr = line.substring(5).trim();
              const event = JSON.parse(jsonStr);

              // Validate event syntax
              const validation =
                SyntaxValidator.validateDexPaprikaSSEResponse(
                  `data: ${jsonStr}`
                );
              if (validation.valid && validation.parsed) {
                events.push(validation.parsed);
              } else {
                parseErrors.push(
                  `Event ${events.length}: ${validation.error}`
                );
              }
            } catch (e) {
              parseErrors.push(
                `Failed to parse event ${events.length}: ${(e as Error).message}`
              );
            }
          }
        }
      }

      return {
        events,
        parseErrors,
        completedNormally: events.length === maxEvents,
      };
    } catch (error) {
      parseErrors.push((error as Error).message);
      return {
        events,
        parseErrors,
        completedNormally: false,
      };
    }
  }
}
