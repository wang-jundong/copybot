import BN from 'bn.js';
import bs58 from 'bs58';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, unpackAccount, unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from '@pump-fun/pump-sdk';
import { GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_AMM_SDK, sellBaseInput } from '@pump-fun/pump-swap-sdk';
import { tokenBalance } from './events.js';
import { setTimeout as delay } from 'node:timers/promises';
import { FirstBuyIndex, entryBoundsStatus, entryFilterReason, eventMarketCapLamports, formatSol } from './curve_filter.js';
import { log } from './logger.js';
import { chooseHeliusTipAccount, sendHeliusSenderTransaction } from './helius_sender.js';
import { liveTestAttempts, liveTestSellAmount } from './live_test_limit.js';
import { RecentBlockhash } from './recent_blockhash.js';
import { reconcilePendingUntilSettled } from './reconcile_pending.js';

export function positionKey(watch, mint) { return `${watch}:${mint}`; }

export function positionsFromJournal(journal) {
  const positions = new Map();
  for (const row of journal.rows.values()) {
    if (!['confirmed', 'dry-run'].includes(row.status)) continue;
    if (!row.watch || !row.mint || row.delta === undefined) {
      throw new Error('Journal has trades without per-wallet position data; reconcile or archive it before running multi-wallet mode');
    }
    const key = positionKey(row.watch, row.mint);
    const next = (positions.get(key) || 0n) + BigInt(row.delta);
    if (next < 0n) throw new Error(`Negative journal position for ${key}`);
    positions.set(key, next);
  }
  return positions;
}

export class Trader {
  constructor(connection, config, journal) {
    this.rpc = connection; this.config = config; this.journal = journal;
    this.sdk = new OnlinePumpSdk(connection);
    this.positions = positionsFromJournal(journal);
    if (!config.dryRun && config.liveTestMode) {
      liveTestAttempts(journal, 'buy');
      liveTestAttempts(journal, 'sell');
    }
    this.firstBuys = new FirstBuyIndex(connection, journal);
    this.sendSenderTransaction = sendHeliusSenderTransaction;
    this.blockhashCache = new RecentBlockhash(connection);
    this.recoveryRpc = null;
    this.quoteAmmSell = sellBaseInput;
    this.buildAmmSell = (state, amount, minQuote) => PUMP_AMM_SDK.sellInstructions(state, amount, minQuote);
    this.decodeAmmPool = info => PUMP_AMM_SDK.decodePool(info);
    this.decodeAmmGlobal = info => PUMP_AMM_SDK.decodeGlobalConfig(info);
    this.decodeAmmFee = info => PUMP_AMM_SDK.decodeFeeConfig(info);
    this.mints = new Map();
    this.mintLoads = new Map();
    this.global = null;
    this.feeConfig = null;
    this.staticLoad = null;
    this.staticLoadedAt = 0;
  }
  warmStatic() {
    if (this.global && this.feeConfig && Date.now() - this.staticLoadedAt < 60000) return Promise.resolve();
    if (!this.staticLoad) this.staticLoad = Promise.all([this.sdk.fetchGlobal(), this.sdk.fetchFeeConfig()])
      .then(([global, feeConfig]) => { this.global = global; this.feeConfig = feeConfig; this.staticLoadedAt = Date.now(); })
      .finally(() => { this.staticLoad = null; });
    return this.staticLoad;
  }
  hasLiveTestSlot(kind) {
    return this.config.dryRun || !this.config.liveTestMode || liveTestAttempts(this.journal, kind) < 1;
  }
  heldMints() {
    const mints = new Set();
    for (const [key, amount] of this.positions) {
      if (amount > 0n && this.config.watches.includes(key.slice(0, key.indexOf(':'))))
        mints.add(key.slice(key.indexOf(':') + 1));
    }
    return mints;
  }
  pruneMintCache(nowSeconds = Date.now() / 1000, activeMints = new Set()) {
    const protectedMints = new Set(activeMints);
    // Preserve holdings even if their source wallet is no longer watched.
    for (const [key, amount] of this.positions) {
      if (amount > 0n) protectedMints.add(key.slice(key.indexOf(':') + 1));
    }
    for (const row of this.journal.rows.values()) {
      if (row.status === 'pending') protectedMints.add(row.mint);
    }
    const expired = new Set();
    for (const [mint, timestamp] of this.firstBuys.times) {
      if (Number.isSafeInteger(timestamp) && nowSeconds - timestamp > 600
        && !protectedMints.has(mint) && !this.firstBuys.pending.has(mint) && !this.mintLoads.has(mint))
        expired.add(mint);
    }
    this.journal.removeClosedMints(expired);
    if (!expired.size) return 0;
    for (const mint of expired) {
      this.firstBuys.times.delete(mint);
      this.firstBuys.eventIds.delete(mint);
      this.firstBuys.legacyTried.delete(mint);
      this.mints.delete(mint);
    }
    for (const [key, amount] of this.positions) {
      if (amount === 0n && expired.has(key.slice(key.indexOf(':') + 1))) this.positions.delete(key);
    }
    return expired.size;
  }
  warmMint(mint) {
    if (this.mints.has(mint)) return Promise.resolve();
    if (this.mintLoads.has(mint)) return this.mintLoads.get(mint);
    const task = this.rpc.getAccountInfo(new PublicKey(mint), 'confirmed').then(info => {
      if (!info || ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => program.equals(info.owner))) return;
      const tokenProgram = info.owner;
      const rawMint = unpackMint(new PublicKey(mint), info, tokenProgram);
      const mintSupply = new BN(rawMint.supply.toString());
      this.mints.set(mint, { tokenProgram, mintSupply, rawMint });
    }).finally(() => this.mintLoads.delete(mint));
    this.mintLoads.set(mint, task);
    return task;
  }
  async prepareForStream() {
    const mints = [...this.heldMints()];
    if (!mints.length) return;
    // Do not subscribe until every open position has the state needed for its next sell.
    // Bound concurrent RPC reads so a large recovered journal does not flood the provider.
    await Promise.all([this.warmStatic(), (async () => {
      for (let index = 0; index < mints.length; index += 4) {
        await Promise.all(mints.slice(index, index + 4).map(async mint => {
          await this.warmMint(mint);
          if (!this.mints.has(mint)) throw new Error(`Mint state unavailable for open position ${mint}`);
        }));
      }
    })()]);
  }
  observe(trade) {
    if (!this.config.watches.includes(trade.watch)) return Promise.resolve();
    // Cache work is separate from the trade decision. The current uncached buy is skipped.
    return Promise.allSettled([Promise.resolve().then(() => this.firstBuys.get(trade.mint)),
      Promise.resolve().then(() => this.warmMint(trade.mint)), Promise.resolve().then(() => this.warmStatic())])
      .then(results => {
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
      });
  }

  async inspect(trade) {
    if (!trade.isBuy || !this.config.watches.includes(trade.watch)) return null;
    const firstBuyTime = this.firstBuys.cached(trade.mint);
    const cachedMint = this.mints.get(trade.mint);
    let marketCapLamports = null;
    if (cachedMint) {
      try { marketCapLamports = eventMarketCapLamports(trade, cachedMint.mintSupply); }
      catch { /* Missing reserves fail closed. */ }
    }
    const reason = !this.hasLiveTestSlot('buy') ? 'live test buy limit reached'
      : firstBuyTime === null ? 'first bonding-curve buy not cached'
      : !cachedMint ? 'mint supply not cached'
      : entryFilterReason(trade, firstBuyTime, marketCapLamports, this.config, this.firstBuys.eventId(trade.mint));
    const age = Number.isSafeInteger(firstBuyTime) ? String(trade.timestamp - firstBuyTime) : 'unknown';
    log('FILTER', trade.watch, trade.mint, 'ageSec', age,
      'marketCapSol', formatSol(marketCapLamports), 'bounds', entryBoundsStatus(this.config),
      reason ? 'REJECT' : 'PASS', ...(reason ? [reason] : []));
    return { ...cachedMint, reason };
  }

  async execute(trade, inspection) {
    const c = this.config;
    if (!c.watches.includes(trade.watch)) return;
    if (this.journal.has(trade.id)) return;
    const skip = (reason, quiet = false) => {
      if (!quiet) log('SKIP', trade.watch, trade.mint, reason);
    };
    if (Date.now() / 1000 - trade.timestamp > c.maxAge || trade.timestamp > Date.now() / 1000 + 5) return skip('stale event');
    const mint = new PublicKey(trade.mint);
    const key = positionKey(trade.watch, trade.mint);
    if (!trade.isBuy && (this.positions.get(key) || 0n) === 0n) return skip('no tracked position');
    if (!this.hasLiveTestSlot(trade.isBuy ? 'buy' : 'sell'))
      return skip(`live test ${trade.isBuy ? 'buy' : 'sell'} limit reached`);
    let tokenProgram, mintSupply;
    if (trade.isBuy) {
      const check = await (inspection || this.inspect(trade));
      if (check.reason) return skip(check.reason, true);
      ({ tokenProgram, mintSupply } = check);
    } else {
      const cached = this.mints.get(trade.mint);
      if (!cached) return skip('mint supply not cached');
      ({ tokenProgram, mintSupply } = cached);
    }
    if (!this.global || !this.feeConfig) return skip('global fee state not cached');
    if (!trade.virtualSolReserves || !trade.virtualTokenReserves || !trade.realTokenReserves || !trade.creator)
      return skip('trade event missing curve state');
    if (trade.quoteMint && trade.quoteMint !== NATIVE_MINT.toBase58() && trade.quoteMint !== PublicKey.default.toBase58())
      return skip('only SOL curves supported');
    const bondingCurve = {
      virtualSolReserves: new BN(trade.virtualSolReserves),
      virtualQuoteReserves: new BN(trade.virtualSolReserves),
      virtualTokenReserves: new BN(trade.virtualTokenReserves),
      realTokenReserves: new BN(trade.realTokenReserves),
      creator: new PublicKey(trade.creator),
      creatorFeeBps: new BN(trade.creatorFeeBasisPoints || '0'),
      isMayhemMode: trade.mayhemMode,
      quoteMint: NATIVE_MINT,
    };
    if (bondingCurve.realTokenReserves.isZero()) return skip('curve graduated');
    const quoteParams = { global: this.global, feeConfig: this.feeConfig, mintSupply, bondingCurve, quoteMint: NATIVE_MINT };
    let amount, quoteAmount;
    if (trade.isBuy) {
      const quoteBudget = c.buyLamports * 1000n / BigInt(1000 + Math.floor(c.buySlippage * 10));
      quoteAmount = new BN(quoteBudget.toString());
      amount = getBuyTokenAmountFromSolAmount({ ...quoteParams, amount: quoteAmount });
    } else {
      const held = this.positions.get(key) || 0n;
      amount = new BN(liveTestSellAmount(held, trade, !c.dryRun && c.liveTestMode).toString());
      if (amount.isZero()) return skip('no position or ambiguous source sell');
      quoteAmount = getSellSolAmountFromTokenAmount({ ...quoteParams, amount });
    }
    if (amount.isZero() || quoteAmount.isZero()) return skip('zero quote');
    const params = { global: this.global, bondingCurve, mint, user: c.user,
      amount, quoteAmount, slippage: trade.isBuy ? c.buySlippage : c.sellSlippage, tokenProgram };
    const instructions = trade.isBuy
      ? [createAssociatedTokenAccountIdempotentInstruction(c.user,
          getAssociatedTokenAddressSync(mint, c.user, false, tokenProgram), c.user, mint, tokenProgram),
        await PUMP_SDK.buyV2Instruction({ ...params, creator: bondingCurve.creator,
          associatedUser: getAssociatedTokenAddressSync(mint, c.user, false, tokenProgram),
          quoteMint: NATIVE_MINT, mayhemMode: bondingCurve.isMayhemMode })]
      : await PUMP_SDK.sellV2Instructions(params);
    if (Date.now() / 1000 - trade.timestamp > c.maxAge) return skip('event expired during quote');
    if (c.dryRun) {
      const delta = BigInt(amount.toString()) * (trade.isBuy ? 1n : -1n);
      this.positions.set(key, (this.positions.get(key) || 0n) + delta);
      this.journal.put({ id: trade.id, status: 'dry-run', watch: trade.watch, mint: trade.mint, delta: delta.toString() });
      log('DRY_RUN', trade.isBuy ? 'BUY' : 'SELL', trade.watch, trade.mint, 'tokens', amount.toString(), 'quoteLamports', quoteAmount.toString());
      return;
    }
    return this.submitLiveTrade(trade, instructions);
  }
  async migrationSwapState(mint, poolKey) {
    const cached = this.mints.get(mint);
    if (!cached?.rawMint) throw new Error(`Mint state unavailable for migration exit ${mint}`);
    const baseMint = new PublicKey(mint);
    const baseVault = getAssociatedTokenAddressSync(baseMint, poolKey, true, cached.tokenProgram);
    const quoteVault = getAssociatedTokenAddressSync(NATIVE_MINT, poolKey, true, TOKEN_PROGRAM_ID);
    // One batched Helius RPC read supplies fresh pool, vault balances, and fee state.
    const [poolInfo, baseInfo, quoteInfo, globalInfo, feeInfo] = await this.rpc.getMultipleAccountsInfo(
      [poolKey, baseVault, quoteVault, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA], 'processed');
    if (!poolInfo || !baseInfo || !quoteInfo || !globalInfo
      || !poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)
      || !globalInfo.owner.equals(PUMP_AMM_PROGRAM_ID)
      || (feeInfo && !feeInfo.owner.equals(PUMP_FEE_PROGRAM_ID)))
      throw new Error(`PumpSwap pool state unavailable for ${mint}`);
    const pool = this.decodeAmmPool(poolInfo);
    if (!pool.baseMint.equals(baseMint) || !pool.quoteMint.equals(NATIVE_MINT)
      || !pool.poolBaseTokenAccount.equals(baseVault) || !pool.poolQuoteTokenAccount.equals(quoteVault))
      throw new Error(`PumpSwap pool accounts do not match canonical SOL pool for ${mint}`);
    const baseAccount = unpackAccount(baseVault, baseInfo, cached.tokenProgram);
    const quoteAccount = unpackAccount(quoteVault, quoteInfo, TOKEN_PROGRAM_ID);
    if (!baseAccount.owner.equals(poolKey) || !baseAccount.mint.equals(baseMint)
      || !quoteAccount.owner.equals(poolKey) || !quoteAccount.mint.equals(NATIVE_MINT))
      throw new Error(`PumpSwap vaults do not belong to canonical SOL pool for ${mint}`);
    const globalConfig = this.decodeAmmGlobal(globalInfo);
    const feeConfig = feeInfo ? this.decodeAmmFee(feeInfo) : null;
    const user = this.config.user;
    return { globalConfig, feeConfig, poolKey, poolAccountInfo: poolInfo, pool,
      poolBaseAmount: new BN(baseAccount.amount.toString()),
      poolQuoteAmount: new BN(quoteAccount.amount.toString()),
      baseTokenProgram: cached.tokenProgram, quoteTokenProgram: TOKEN_PROGRAM_ID,
      baseMint, baseMintAccount: cached.rawMint, user,
      userBaseTokenAccount: getAssociatedTokenAddressSync(baseMint, user, false, cached.tokenProgram),
      userQuoteTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, user),
      userBaseAccountInfo: { owner: cached.tokenProgram }, userQuoteAccountInfo: null };
  }
  async executeMigration(migration) {
    const { mint, event } = migration;
    const allocations = [...this.positions.entries()].filter(([key, amount]) =>
      amount > 0n && key.endsWith(`:${mint}`)
      && this.config.watches.includes(key.slice(0, key.indexOf(':'))))
      .map(([key, held]) => ({ watch: key.slice(0, key.indexOf(':')), held,
        id: `${migration.id}:${key.slice(0, key.indexOf(':'))}` }));
    if (!allocations.length) return;
    if (allocations.every(({ id }) => this.journal.has(id))) return;
    if (allocations.some(({ id }) => this.journal.has(id)))
      throw new Error(`Partial migration exit journal for ${mint}; reconcile before continuing`);
    if (!this.hasLiveTestSlot('sell'))
      throw new Error(`Live test sell limit reached for migrated mint ${mint}; manual exit required`);
    if (Date.now() / 1000 - migration.timestamp > this.config.maxAge)
      throw new Error(`Migration event for held mint ${mint} is stale; manual exit required`);
    const amount = new BN(allocations.reduce((sum, row) => sum + row.held, 0n).toString());
    const state = await this.migrationSwapState(mint, event.pool);
    const { pool } = state;
    const quote = this.quoteAmmSell({ base: amount, slippage: this.config.sellSlippage,
      baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: pool.virtualQuoteReserves, globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount, baseMint: state.baseMint,
      coinCreator: pool.coinCreator, creator: pool.creator, feeConfig: state.feeConfig,
      quoteMint: NATIVE_MINT, isMayhemMode: pool.isMayhemMode,
      creatorFeeBps: pool.creatorFeeBps });
    if (quote.minQuote.isZero() || quote.minQuote.isNeg())
      throw new Error(`Migration exit has zero minimum SOL for ${mint}`);
    const instructions = await this.buildAmmSell(state, amount, quote.minQuote);
    if (Date.now() / 1000 - migration.timestamp > this.config.maxAge)
      throw new Error(`Migration exit for held mint ${mint} expired during build; manual exit required`);
    if (this.config.dryRun) {
      for (const { watch, held, id } of allocations) {
        this.journal.put({ id, watch, mint, status: 'dry-run', delta: (-held).toString(), venue: 'pumpswap' });
        this.positions.set(positionKey(watch, mint), 0n);
      }
      log('DRY_RUN MIGRATION SELL', mint, 'tokens', amount.toString(), 'minQuoteLamports', quote.minQuote.toString());
      return;
    }
    const confirmed = await this.submitLiveTrade(
      { ...migration, watch: allocations[0].watch, isBuy: false }, instructions, allocations);
    if (confirmed === false)
      throw new Error(`Migration sell failed on chain for ${mint}; tracked position remains open`);
    if (confirmed === null)
      throw new Error(`Live test sell limit reached for migrated mint ${mint}; manual exit required`);
  }
  async submitLiveTrade(trade, instructions, allocations = null) {
    const c = this.config;
    if (!c.keypair) throw new Error('Live trading requires PRIVATE_KEY');
    const key = positionKey(trade.watch, trade.mint);
    const entries = allocations || [{ id: trade.id, watch: trade.watch }];
    const tradeKind = trade.isBuy ? 'buy' : 'sell';
    // This check and the pending journal writes run synchronously before any await.
    if (!this.hasLiveTestSlot(tradeKind)) {
      log('SKIP', trade.watch, trade.mint, `live test ${tradeKind} limit reached`);
      return null;
    }
    const latest = this.blockhashCache.current();
    if (!latest) throw new Error('No fresh Helius blockhash cached; live trade was not submitted');
    const tipAccount = chooseHeliusTipAccount(c);
    const tipInstruction = SystemProgram.transfer({ fromPubkey: c.user, toPubkey: tipAccount,
      lamports: c.tipLamports });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: c.user, recentBlockhash: latest.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: c.priorityFee }), ...instructions,
        tipInstruction],
    }).compileToV0Message());
    tx.sign([c.keypair]);
    const signature = bs58.encode(tx.signatures[0]);
    // Persist before broadcasting. On uncertain outcomes, stop instead of buying twice.
    for (const entry of entries) this.journal.put({ id: entry.id, watch: entry.watch, mint: trade.mint,
      status: 'pending', tradeKind, signature, ...latest, submittedAt: Date.now(),
      ...(allocations ? { expectedDelta: (-entry.held).toString() } : {}),
      venue: allocations ? 'pumpswap' : 'curve',
      tipAccount: tipAccount.toBase58(), tipLamports: c.tipLamports.toString() });
    try {
      await this.sendSenderTransaction('swqos', tx.serialize(), signature);
      const result = await this.rpc.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (result.value.err) {
        for (const entry of entries) this.journal.put({ id: entry.id, watch: entry.watch, mint: trade.mint,
          tradeKind, signature, status: 'failed' });
        log(allocations ? 'FAILED MIGRATION SELL' : 'FAILED', trade.watch, trade.mint, signature);
        return false;
      }
      // Confirmed RPC results can lag confirmation. Keep pending until actual fill is known.
      let filled;
      for (let attempt = 0; attempt < 10; attempt++) {
        filled = await this.rpc.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (filled?.meta) break;
        await delay(1000);
      }
      if (!filled?.meta || filled.meta.err) throw new Error('Could not read confirmed trade metadata');
      const owner = c.user.toBase58();
      const delta = tokenBalance(filled.meta.postTokenBalances, owner, trade.mint)
        - tokenBalance(filled.meta.preTokenBalances, owner, trade.mint);
      if (trade.isBuy ? delta <= 0n : delta >= 0n) throw new Error('Confirmed trade has unexpected token balance change');
      if (allocations) {
        const expected = allocations.reduce((sum, row) => sum + row.held, 0n);
        if (delta !== -expected) throw new Error('Migration exit fill differs from tracked position');
        for (const { id, watch, held } of allocations) {
          this.journal.put({ id, watch, mint: trade.mint, tradeKind, signature, status: 'confirmed',
            delta: (-held).toString(), venue: 'pumpswap',
            tipAccount: tipAccount.toBase58(), tipLamports: c.tipLamports.toString() });
          this.positions.set(positionKey(watch, trade.mint), 0n);
        }
        log('CONFIRMED MIGRATION SELL', trade.mint, signature, 'tokens', delta.toString());
      } else {
        this.journal.put({ id: trade.id, watch: trade.watch, mint: trade.mint, tradeKind, signature, status: 'confirmed', delta: delta.toString(),
          tipAccount: tipAccount.toBase58(), tipLamports: c.tipLamports.toString() });
        this.positions.set(key, (this.positions.get(key) || 0n) + delta);
        log('CONFIRMED', trade.watch, trade.mint, signature, 'tokens', delta.toString(),
          'tipAccount', tipAccount.toBase58(), 'tipLamports', c.tipLamports.toString());
      }
      return true;
    } catch (e) {
      const fallback = this.recoveryRpc || new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
      const outcomes = await reconcilePendingUntilSettled(this.journal, this.rpc, fallback, c.user, new Set([signature]));
      const outcome = outcomes.get(signature);
      if (outcome === 'confirmed') {
        this.positions = positionsFromJournal(this.journal);
        log('RECOVERED CONFIRMED', trade.watch, trade.mint, signature);
        return true;
      }
      if (outcome === 'failed') {
        log('RECOVERED FAILED', trade.watch, trade.mint, signature);
        return false;
      }
      throw new Error(`Submission outcome uncertain for ${signature}. Reconcile data/live.jsonl before restarting.`, { cause: e });
    }
  }

}
