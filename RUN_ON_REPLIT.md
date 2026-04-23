# Running on Replit

This test suite is configured to run directly on Replit with no external proxies needed.

## Quick Start

1. **Clone/Fork this repo to Replit**
   ```
   https://github.com/willho/penny-pincher-api-test
   ```

2. **Dependencies are pre-configured**
   - Replit detects `package.json` with `"type": "module"` workspace
   - Runs `npm install` automatically

3. **Start the server**
   ```bash
   npm start
   ```
   OR in Replit, just click the **Run** button

4. **Open in browser**
   - Replit will show a preview URL
   - Click to open the test dashboard
   - Test buttons appear immediately

## What It Tests

Tests DexPaprika SSE endpoint with PreGrad and PostGrad tokens:
- **PreGrad**: Bonding-curve tokens (pump.fun, <10s old may fail)
- **PostGrad**: Graduated tokens (Raydium/Orca, always accessible)

## API Endpoints

```
GET  /api/test       → Test DexPaprika SSE with 3 PreGrad + 3 PostGrad tokens
GET  /health         → Server health
```

## DexPaprika SSE Endpoint (Corrected)

**Correct endpoint**: `GET https://streaming.dexpaprika.com/stream`

Query parameters:
- `chain=solana`
- `address={mint}`
- `method=t_p`

Example:
```
GET https://streaming.dexpaprika.com/stream?chain=solana&address=EPjFWaLb3odcjGVY9wn9Qo0iRjb3FSPmN9h2yeP7qdc&method=t_p
```

**Note**: Returns SSE stream (text/event-stream), not JSON

## Build & Run

```bash
npm run build    # Compile TypeScript → dist/
npm start        # Run server on :3000
npm run dev      # Run with auto-reload (ts-node)
```

## Expected Results

**Scenario A: Both Supported ✅**
```
PreGrad: HTTP 200 ✅
PostGrad: HTTP 200 ✅
→ DexPaprika supports both bonding-curve and graduated tokens
```

**Scenario B: Only PostGrad Supported**
```
PreGrad: HTTP 400 ❌ (asset not found)
PostGrad: HTTP 200 ✅
→ DexPaprika only supports graduated tokens, not pump.fun
```

**Scenario C: Only PreGrad Supported**
```
PreGrad: HTTP 200 ✅
PostGrad: HTTP 400 ❌ (asset not found)
→ DexPaprika only supports bonding curves, not graduated tokens
```

**Scenario D: Neither Supported ❌**
```
PreGrad: HTTP 400 or error ❌
PostGrad: HTTP 400 or error ❌
→ DexPaprika endpoint issue or unrecognized token format
```

## Notes

- **No proxies needed** - All API calls from server-side (Node.js)
- **Fallback tokens included** - If DexScreener fails, uses hardcoded examples
- **Live token fetching** - Pulls current trending/pump.fun tokens from DexScreener
- **Real-time results** - Full logging of each API call and response

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Port 3000 in use | Replit assigns random port automatically |
| Network timeouts | Check API keys in `.env.local` (if needed) |
| "Module not found" | Run `npm install` manually |
| TypeScript errors | Run `npm run build` to check compilation |

---

**No CORS issues. No proxies. Just Node.js ↔ Public APIs.**
