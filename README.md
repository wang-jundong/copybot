# Pump.fun copy bot (JavaScript)

Node.js 22+ bot for multiple watched wallets through **one shared Yellowstone gRPC connection**, copying buys and sells on SOL-denominated Pump.fun bonding curves and selling tracked holdings when their token migrates to PumpSwap. Uses the official Pump and PumpSwap SDKs for quotes and instructions and Yellowstone gRPC for transaction events.

## Setup

```sh
npm ci
cp .env.example .env
```

Fill in your VibeStation **Yellowstone-compatible gRPC** URL, optional x-token, Solana HTTP RPC URL, `WATCH_WALLETS` (comma or space separated). The old `WATCH_WALLET` setting still works for one wallet. Obtain the endpoint/auth requirements from your provider; VibeStation connectivity has not been tested here. Set `HELIUS_RPC_URL` to your Helius mainnet HTTP RPC URL for live trade confirmation and background history/state reads. It takes precedence over `RPC_URL`, which is a dry-run fallback. VibeStation gRPC continues to deliver watched-wallet events. The Helius HTTP RPC must support confirmations and historical/account reads. All live buys and sells submit through Helius Sender SWQoS only. `HELIUS_SENDER_MODE` must be `swqos` if present, and `HELIUS_TIP_LAMPORTS` defaults to 5000 lamports (0.000005 SOL). Live mode requires `HELIUS_RPC_URL` for confirmation and history. The bot selects a published Helius tip account, or uses a valid `HELIUS_TIP_ACCOUNT` from that list. The tip transfer is inside the buy/sell transaction and costs extra to `BUY_SOL`; it is only paid if the transaction succeeds. Sender uses skip-preflight and zero RPC retries, while the existing journal still stops on uncertain outcomes. There is no standard RPC broadcast fallback.

```sh
npm test
npm start
```

## Run with PM2

After `npm ci` and configuring `.env`, start one managed process from the project directory:

```sh
npm run pm2:start
npm run pm2:status
npm run pm2:logs
```

Use `npm run pm2:restart` after changing `.env` or code, and `npm run pm2:stop` to stop it. PM2 runs one forked instance, restarts it after crashes, and allows up to three minutes for the bot to finish in-flight work on shutdown. `.env` is loaded from this project directory by the bot. Do not run `npm start` at the same time: only one process can own the journal lock and gRPC stream. PM2 process restarts do not backfill missed gRPC events; check the journal and open positions after a crash.

Default `DRY_RUN=true` needs no bot key or public key. It generates a temporary simulation public key, reads events, warms required account data in the background, builds instructions, and logs hypothetical trades without submitting transactions. Paper holdings are tracked per watched wallet and restored from the dry-run journal across restarts. This validates quoting/building, not actual transaction simulation or fills.

For automatic live copy buys and sells, set `HELIUS_RPC_URL`, explicitly set `DRY_RUN=false`, and set `PRIVATE_KEY` in `.env`. It accepts a base58 Solana secret key or a 64-byte JSON array. Configure at least one curve-age bound and one SOL market-cap bound before starting; buys are rejected otherwise. Keep `.env` private. Fund the wallet for buys, fees, and token account rent. Use a dedicated bot wallet. For a capped funded check, set `LIVE_TEST_MODE=true`. It allows at most one submitted buy and one submitted sell across restarts, using `data/live.jsonl` as the counter; pending, failed, and confirmed submissions all consume a slot. The single sell exits the entire tracked allocation after a valid watched sell, even if that wallet sells only part of its tokens. A PumpSwap migration exit also consumes the sell slot. The cap does not apply to dry-run. If a slot has been used, subsequent matching trades are skipped; an already used sell slot leaves any later holdings requiring manual exit. Keep `LIVE_TEST_MODE=true` until you intentionally remove this cap. If an older live journal contains submitted trades without a `tradeKind` field, startup stops until those rows are reconciled; the bot will not guess whether a slot was already used. Each source wallet has a separate token allocation recorded from confirmed fills; sells use only that allocation. The bot records actual fills after confirmation. A PumpSwap migration exit sells the combined tracked amount for that mint in one transaction and records the sell against each watched wallet allocation. Keep the dedicated wallet free of manual token transfers: without a pre-sell balance read, a changed balance may make a sell fail on chain.

## Bonding-curve entry filters

Configure at least one age bound and one SOL market-cap bound in `.env` (limits are inclusive):

```dotenv
MIN_CURVE_AGE_SECONDS=
MAX_CURVE_AGE_SECONDS=
MIN_MARKETCAP_SOL=
MAX_MARKETCAP_SOL=
```

An empty individual bound is unrestricted. If either category has no bound, the bot logs `REJECT` and skips the buy. It logs `FILTER` from data already cached when the watched buy arrives and skips a buy when either measurement is unavailable. Trade submission stays in event order for each mint; an earlier trade for that mint or the four-trade concurrency limit can delay submission after the checks finish. Age is **the watched wallet trade event's on-chain timestamp minus the mint's first Pump bonding-curve buy event timestamp**, in seconds. It is not time since creation, time since the bot connected, or time since the watched wallet's first buy. For a mint first seen after startup, the bot skips the current buy and starts a background scan of confirmed Solana RPC signature history for the mint, oldest first, to decode the first Pump buy event. The first watched buy **or sell** for a mint starts this historical lookup. The timestamp and exact first-buy event ID are cached in the journal and loaded again on restart. Mint supply, token program, and Pump global/fee state are warmed with background RPC reads and kept only in memory; the global/fee state refreshes on a watched event after 60 seconds; after restart, the bot warms the state for every open tracked position before subscribing, so its first sell can use fresh data. If that startup warmup fails, the bot stops before subscribing. Mints with no open position still warm on their first watched event. The exact first buy is never copied, even if an age bound includes zero. Older timestamp-only cache entries are upgraded when RPC history is available; until then, buys in that same first second are skipped. A sell does not wait for the lookup before closing a tracked position. If the history is unavailable, pruned, or longer than 10,000 signatures, the bot skips that entry rather than guessing its age. Historical lookups require an RPC with transaction history; buys received before the lookup finishes are skipped.

Market cap is measured at the **watched wallet's buy event**, using its virtual SOL and token reserves and the mint's token supply: `supply × virtual SOL reserves ÷ virtual token reserves`. The resulting lamports are compared with SOL limits using exact integer arithmetic. The bounds apply to copied **buys**; copied sells remain eligible to close existing positions after the curve ages or its market cap changes.

## Copy rules

- Each eligible source buy triggers a fixed-size buy. `BUY_SOL` includes maximum slippage allowance but excludes fees and account rent. `BUY_SLIPPAGE_PERCENT=12` sets the buy tolerance and `SELL_SLIPPAGE_PERCENT=50` sets the sell tolerance. Repeated buys accumulate; there is no total exposure cap.
- Selling 25% of one source wallet's pre-transaction holdings sells 25% of that wallet's bot allocation. A full exit sells that allocation. Token arithmetic uses integers.
- Only successful confirmed transactions and Pump TradeEvents are accepted. Foreign program/user events and spoofed nested logs are ignored.
- Graduated curve trades and non-SOL quotes are skipped. For a held SOL token, a confirmed canonical PumpSwap pool-creation event triggers a sell of the tracked balance, using `SELL_SLIPPAGE_PERCENT`. The bot reads the new pool, two vaults, and fee accounts in one batched Helius RPC call, builds the sell locally, and sends through Helius Sender SWQoS. There is no Raydium exit.
- Multiple same-mint trades within one source transaction are ignored. Sells with missing ownership or balance changes inconsistent with the trade are skipped.
- All watched wallets and held tokens’ canonical PumpSwap pools share one dynamically updated gRPC subscription. Trades for the same mint run in order; up to four different mints can progress concurrently. Curve quotes and instructions use the received gRPC event reserves and cached account data without waiting for pre-trade RPC reads. A migration exit makes one batched RPC read of the current PumpSwap pool and fee accounts before it builds the sell. Live transactions use a Helius blockhash refreshed in the background, submit only through Helius Sender SWQoS, then use block-height-aware Helius RPC confirmation and read fills. If the cached blockhash becomes stale, submission stops before signing or journaling; there is no per-trade blockhash RPC read. Old events are skipped; queue overflow stops the process. A migration that happens while the bot is offline or during a gRPC gap cannot trigger an automatic exit after restart; inspect and close that position manually. If the new pool state is unavailable or the migration sell cannot be built, the bot stops for manual reconciliation. Confirmed delivery and per-mint confirmation before the next trade favor consistency over minimum latency.
- Disconnects reconnect with a heartbeat. **No replay/backfill**: events during gaps or in truncated logs can be missed.

## Recovery

`data/live.jsonl` records source event IDs, submitted signatures, and each signed blockhash's last valid block height. Completed events are deduplicated. Skipped events are not saved; a redelivered skipped event can be checked again while it is still fresh. A pending entry is flushed before broadcast. On confirmation errors and at live startup, the bot checks the signature through Helius and a second Solana RPC for up to about two minutes. Confirmed fills restore positions; on-chain failures or signatures absent after proven blockhash expiry are resolved as failed. Unverifiable outcomes remain pending and stop the bot to prevent duplicate trades. Inspect the signature using your RPC/explorer and confirm whether it landed or expired, then append a new JSON line for the same `id` with `status` `confirmed` or `failed`. For a confirmed trade, include `watch`, `mint`, `tradeKind` (`buy` or `sell`), and the signed raw-token `delta` from transaction metadata; a buy has positive delta and a sell negative delta. The bot also leaves a transaction pending if confirmation succeeds but its fill cannot be read. A migration exit writes one journal row per watched-wallet allocation, all with the same bot transaction signature; reconcile every pending row for that signature. Never delete the journal to retry an uncertain trade.

Skipped events are not cached or appended to either journal. To delete skipped rows already in the JSONL files, stop the bot and run `npm run journal:prune-skipped`. The command validates and atomically replaces each file, retaining first-buy, pending, confirmed, failed, and dry-run rows. It creates no archive of the deleted skipped rows.

A lock prevents two processes using the same journal. After a hard crash, verify no bot is running before removing its stale `.lock` file. Journals contain positions for each watched wallet and are tied to the bot wallet. Do not delete trade or first-buy rows without first preserving their position and cache state. Journals from the previous single-wallet version lack position data and require migration/reconciliation before reuse. Dry-run uses a separate journal. The remaining trade and first-buy rows can still grow; pruning skipped rows does not remove state needed for recovery.

Signed live curve buys, sells, and PumpSwap migration exits are covered by mocked RPC tests. A live migration and funded trade have not been tested; verify the route in dry-run first.

References: [Pump official docs](https://github.com/pump-fun/pump-public-docs), [Yellowstone examples](https://github.com/rpcpool/yellowstone-grpc).
