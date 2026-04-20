/**
 * Per-second rate limiters calculated from monthly quotas
 * No circuit breaker - requests wait, don't fail
 */

export class TokenBucketLimiter {
  private tokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly maxTokens: number;
  private lastRefill: number;

  constructor(requestsPerSecond: number, burstSize = 1) {
    this.refillRate = requestsPerSecond;
    this.maxTokens = Math.max(burstSize, Math.ceil(requestsPerSecond));
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async waitUntilAllowed(): Promise<void> {
    this.refill();

    // If tokens available, use immediately
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait until token available
    const timeToWait = (1 - this.tokens) / this.refillRate;
    await new Promise((resolve) => setTimeout(resolve, timeToWait * 1000));
    this.tokens -= 1;
  }

  canMakeRequest(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  getStatus(): { available: number; max: number; refillRate: number } {
    this.refill();
    return {
      available: Math.floor(this.tokens * 100) / 100,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

export class CreditBasedLimiter {
  private credits: number;
  private readonly creditsPerSecond: number;
  private lastRefill: number;
  private monthlyUsed: number = 0;

  constructor(monthlyQuota: number, creditCostPerRequest: number = 5) {
    // Monthly quota converted to per-second limit
    // 1 month ≈ 2.6 million seconds
    const secondsPerMonth = 30 * 24 * 60 * 60;
    const creditsPerSecond = monthlyQuota / secondsPerMonth;

    this.creditsPerSecond = creditsPerSecond;
    this.credits = creditsPerSecond;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.credits = Math.min(
      this.creditsPerSecond * 2,
      this.credits + elapsed * this.creditsPerSecond
    );
    this.lastRefill = now;
  }

  async waitUntilAllowed(creditCost: number): Promise<void> {
    this.refill();

    // If credits available, use immediately
    if (this.credits >= creditCost) {
      this.credits -= creditCost;
      this.monthlyUsed += creditCost;
      return;
    }

    // Wait until enough credits available
    const timeToWait = (creditCost - this.credits) / this.creditsPerSecond;
    await new Promise((resolve) => setTimeout(resolve, timeToWait * 1000));
    this.refill();
    this.credits -= creditCost;
    this.monthlyUsed += creditCost;
  }

  getStatus(): { available: number; perSecond: number; monthlyUsed: number } {
    this.refill();
    return {
      available: Math.floor(this.credits * 100) / 100,
      perSecond: Math.floor(this.creditsPerSecond * 100) / 100,
      monthlyUsed: this.monthlyUsed,
    };
  }
}

/**
 * Pre-configured rate limiters for each API
 */
export const RateLimiters = {
  // DexPaprika: 200 req/min = 3.33 req/sec
  dexPaprika: new TokenBucketLimiter(200 / 60, 2),

  // DexScreener: 300 req/min = 5 req/sec
  dexScreener: new TokenBucketLimiter(300 / 60, 2),

  // Chainstack: 1M credits/month, avg 5 credits/request = ~385 credits/sec
  chainstack: new CreditBasedLimiter(1_000_000, 5),

  // Shyft HTTP: Unlimited
  shyftHttp: new TokenBucketLimiter(10000, 1000), // Effectively unlimited

  // Shyft gRPC: 1 concurrent connection only
  shyftGrpc: { maxConnections: 1, activeConnections: 0 },
};
