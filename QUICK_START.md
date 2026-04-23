# Quick Start: PreGrad vs PostGrad Test

## What This Tests

Does DexPaprika's SSE endpoint work with:
- ✅ Bonding-curve tokens (pump.fun, pre-graduation)?
- ✅ Graduated tokens (Raydium/Orca, post-graduation)?

## Run It Now

1. **Open in browser**:
   ```
   file:///tmp/penny-pincher-api-test/test-pregrad-vs-postgrad.html
   ```

2. **Click buttons**:
   - Left panel: "Fetch 10 PreGrad + Test DexPaprika"
   - Right panel: "Fetch 10 PostGrad + Test DexPaprika"

3. **Watch results**:
   - ✅ HTTP 200 = DexPaprika supports that token type
   - ❌ HTTP 400 = Token not supported ("asset not found")
   - Network error = API down or blocked

## Expected Outcomes

### Scenario A: Both Work ✅
- PreGrad: HTTP 200 + SSE stream
- PostGrad: HTTP 200 + SSE stream
- **Conclusion**: DexPaprika covers both pump.fun and graduated tokens

### Scenario B: Only PostGrad Works
- PreGrad: HTTP 400 "asset not found"
- PostGrad: HTTP 200 + SSE stream
- **Conclusion**: DexPaprika only supports graduated tokens, not bonding curves

### Scenario C: Only PreGrad Works
- PreGrad: HTTP 200 + SSE stream
- PostGrad: HTTP 400 "asset not found"
- **Conclusion**: DexPaprika only supports bonding curves

### Scenario D: Neither Works
- Both: HTTP 400 or network error
- **Conclusion**: DexPaprika endpoint issue or tokens not recognized

## Tokens Used

| Source | Method | Count |
|--------|--------|-------|
| **PreGrad** | DexScreener (pump.fun filter) | 10 |
| **PostGrad** | DexScreener (Raydium/Orca filter) | 10 |

If API calls fail, uses hardcoded examples to validate endpoint format.

## CORS Proxy

Uses `cors-anywhere.herokuapp.com` - if down, replace in script with:
- `https://api.allorigins.win/raw?url=`
- `https://thingproxy.freeboard.io/fetch/`

Or run locally:
```bash
npm install -g cors-anywhere
cors-anywhere  # http://localhost:8080/
```

## Next Steps

Based on results, feed findings back into:
- `Stage 2: Token Enrichment` decision logic
- DexPaprika polling strategy (which token types to monitor)
- Fallback API strategy if DexPaprika has gaps
