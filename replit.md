# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Penny Pincher API Test Suite

Lives at `artifacts/api-server/src/test-runner/` and is served via the Express API at `/api/tests/`.

**Dashboard URL:** `<host>/api/tests/`

### Test Stages
1. **Stage 1** — PumpPortal `subscribeNewToken` → collects real mint addresses (20s window, target 30)
2. **Stage 2** — PumpPortal `subscribeTokenTrade` → collects real `traderPublicKey` wallets from live trades (20s). DexScreener + DexPaprika health checks (DexPaprika warns-not-fails; may be IP-banned in dev).
3. **Stage 3** — Real Chainstack RPC `getSignaturesForAddress` + Shyft transaction history calls. **Fails if `CHAINSTACK_RPC_URL` or `SHYFT_API_KEY` are missing** (these are not yet configured).
4. **Stage 4** — PumpPortal batch subscription capacity ramp: builds address pool (DexScreener + 30s collection), then ramps `subscribeTokenTrade` and `subscribeAccountTrade` from 1→1000 keys (steps: 1-10 fine, 10-100 coarse, 100-1000 ultra). Tests additive (no-unsub) strategy for N≤10, unsub+resub for all N. Stops on failure or pool exhaustion.

### Key Files
- `artifacts/api-server/src/test-runner/runner.ts` — all stage logic (Stages 1-4)
- `artifacts/api-server/src/test-runner/report-generator.ts` — markdown report generator
- `artifacts/api-server/src/routes/tests.ts` — SSE streaming route + HTML dashboard
- `artifacts/api-server/reports/` — saved markdown reports (auto-created)

### Dependencies
- `ws` + `@types/ws` — WebSocket client for PumpPortal
- `CHAINSTACK_RPC_URL` (or `CHAINSTACK_API_KEY`) — required for Stage 3
- `SHYFT_API_KEY` — required for Stage 3
