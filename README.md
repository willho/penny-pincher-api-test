# Penny-Pincher API Test Suite

**⚠️ PRE-PRODUCTION TESTING ONLY** - This repo validates API syntax, format correctness, and rate limits before integration into Penny-Pincher2.

## Purpose

Small-scale test environment for:
1. **API Format Validation** - Ensure request/response schemas match provider specs
2. **Rate Limit Testing** - Validate per-second limits calculated from monthly quotas
3. **Provider Coverage** - Determine which APIs cover pump.fun vs full Solana chain
4. **Pipeline Flow** - Validate data flows correctly through the pipeline

## Test Scope

- ~20-30 sample tokens from pump.fun
- 5 sequential stages (mints → enrichment → wallet discovery → coverage → rate limits)
- Total runtime: ~3 minutes per test run
- No real trading, no circuit breakers (per-second limiting only)

## APIs Under Test

| API | Type | Status |
|-----|------|--------|
| PumpPortal | WebSocket | Testing |
| DexPaprika | SSE batch | Testing |
| DexScreener | HTTP | Testing |
| Chainstack | JSON-RPC | Testing |
| Shyft | HTTP/gRPC | Testing |

## Setup

```bash
npm install
cp .env.example .env.local
# Edit .env.local with API keys
npm run test:all
```

## Test Stages

1. **Stage 1** - Mint collection from PumpPortal newtoken stream
2. **Stage 2** - Token enrichment (price, volume, trends)
3. **Stage 3** - Wallet discovery (history, holder ranking)
4. **Stage 4** - Coverage verification (pump.fun vs full Solana)
5. **Stage 5** - Rate limit validation

## Output

- Syntax validation report (per API)
- Coverage matrix (pump.fun vs full chain coverage)
- Rate limit verification (no overage despite burst)
- Error logs (if any syntax issues found)

---

**Repository**: Separate from Penny-Pincher2, used only for validation before production integration.
