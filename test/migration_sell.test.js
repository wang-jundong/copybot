import { test } from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { canonicalPumpPoolPda, PUMP_AMM_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { PUMP_FEE_PROGRAM_ID } from '@pump-fun/pump-swap-sdk';
import { Trader, positionKey } from '../src/trader.js';
import { HELIUS_TIP_ACCOUNTS } from '../src/helius_sender.js';

const tokenRow = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });

test('migration sells every watched allocation in one locally built PumpSwap exit', async () => {
  const watches = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  const mint = Keypair.generate().publicKey.toBase58();
  const pool = canonicalPumpPoolPda(new PublicKey(mint));
  const rows = new Map(watches.map((watch, i) => [`buy-${i}`, {
    id: `buy-${i}`, status: 'dry-run', watch, mint, delta: String((i + 1) * 100),
  }]));
  const journal = { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) };
  const config = { watches, user: Keypair.generate().publicKey, dryRun: true,
    maxAge: 30, sellSlippage: 50 };
  const trader = new Trader({}, config, journal);
  trader.mints.set(mint, { tokenProgram: TOKEN_PROGRAM_ID, rawMint: { supply: 1000n } });
  let quoted, built;
  trader.quoteAmmSell = args => { quoted = args; return { minQuote: new BN(1000) }; };
  const realBuild = trader.buildAmmSell;
  trader.buildAmmSell = async (state, amount, minQuote) => {
    const instructions = await realBuild(state, amount, minQuote);
    built = { state, amount, minQuote, instructions };
    return instructions;
  };
  const event = { baseMint: new PublicKey(mint), pool,
    quoteMint: NATIVE_MINT, poolBump: 1, index: 0,
    creator: Keypair.generate().publicKey, coinCreator: Keypair.generate().publicKey,
    lpMint: Keypair.generate().publicKey, initialLiquidity: new BN(10000),
    poolBaseAmount: new BN(1000000), poolQuoteAmount: new BN(1000000),
    creatorFeeBps: new BN(0), isMayhemMode: false };
  trader.migrationSwapState = async () => ({
    globalConfig: { protocolFeeRecipients: [Keypair.generate().publicKey],
      buybackFeeRecipients: [Keypair.generate().publicKey] }, feeConfig: null,
    poolKey: pool, poolAccountInfo: { data: Buffer.alloc(270) },
    pool: { baseMint: event.baseMint, quoteMint: NATIVE_MINT, creator: event.creator,
      coinCreator: event.coinCreator, poolBaseTokenAccount: Keypair.generate().publicKey,
      poolQuoteTokenAccount: Keypair.generate().publicKey, isMayhemMode: false,
      isCashbackCoin: true, virtualQuoteReserves: new BN(0), creatorFeeBps: new BN(0) },
    poolBaseAmount: event.poolBaseAmount, poolQuoteAmount: event.poolQuoteAmount,
    baseTokenProgram: TOKEN_PROGRAM_ID, quoteTokenProgram: TOKEN_PROGRAM_ID,
    baseMint: event.baseMint, baseMintAccount: { supply: 1000n }, user: config.user,
    userBaseTokenAccount: Keypair.generate().publicKey,
    userQuoteTokenAccount: Keypair.generate().publicKey,
    userBaseAccountInfo: { owner: TOKEN_PROGRAM_ID }, userQuoteAccountInfo: null,
  });
  const migration = { id: 'source:1', mint, timestamp: Math.floor(Date.now() / 1000), event };
  await trader.executeMigration(migration);
  assert.equal(quoted.base.toString(), '300');
  assert.equal(quoted.slippage, 50);
  assert.equal(built.amount.toString(), '300');
  assert.equal(built.state.pool.isCashbackCoin, true);
  assert.equal(built.minQuote.toString(), '1000');
  assert.ok(built.instructions.filter(ix => ix.programId.equals(PUMP_AMM_PROGRAM_ID)).length >= 2);
  const message = new TransactionMessage({ payerKey: config.user,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
      ...built.instructions,
      SystemProgram.transfer({ fromPubkey: config.user,
        toPubkey: Keypair.generate().publicKey, lamports: 5000 })],
  }).compileToV0Message();
  assert.ok(new VersionedTransaction(message).serialize().length <= 1232);
  for (const [i, watch] of watches.entries()) {
    assert.equal(trader.positions.get(positionKey(watch, mint)), 0n);
    assert.equal(rows.get(`${migration.id}:${watch}`).delta, String(-(i + 1) * 100));
  }
  await trader.executeMigration(migration);
  assert.equal(rows.size, 4);
});

test('one migration transaction journals confirmed fills for all watched allocations', async () => {
  const keypair = Keypair.generate();
  const watches = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map(watches.map((watch, i) => [`buy-${i}`, {
    id: `buy-${i}`, status: 'confirmed', watch, mint, delta: String((i + 1) * 100),
  }]));
  const journal = { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) };
  const owner = keypair.publicKey.toBase58();
  const rpc = { async confirmTransaction() { return { value: { err: null } }; },
    async getTransaction() { return { meta: { preTokenBalances: [tokenRow(owner, mint, 300)],
      postTokenBalances: [] } }; } };
  const trader = new Trader(rpc, { keypair, user: keypair.publicKey, watches,
    dryRun: false, priorityFee: 1000, tipLamports: 5000n,
    tipAccount: HELIUS_TIP_ACCOUNTS[0] }, journal);
  trader.sendSenderTransaction = async (_mode, _raw, signature) => signature;
  const allocations = watches.map((watch, i) => ({ watch, held: BigInt((i + 1) * 100), id: `migration:1:${watch}` }));
  const ix = SystemProgram.transfer({ fromPubkey: keypair.publicKey,
    toPubkey: Keypair.generate().publicKey, lamports: 1 });
  await trader.submitLiveTrade({ id: 'migration:1', watch: watches[0], mint,
    isBuy: false, blockhash: Keypair.generate().publicKey.toBase58() }, [ix], allocations);
  for (const [i, watch] of watches.entries()) {
    assert.equal(rows.get(`migration:1:${watch}`).status, 'confirmed');
    assert.equal(rows.get(`migration:1:${watch}`).delta, String(-(i + 1) * 100));
    assert.equal(trader.positions.get(positionKey(watch, mint)), 0n);
  }
});

test('migration state uses one batched RPC read and validates canonical vaults', async () => {
  const mint = Keypair.generate().publicKey;
  const poolKey = canonicalPumpPoolPda(mint);
  const user = Keypair.generate().publicKey;
  let calls = 0;
  const tokenInfo = (tokenMint, owner, amount) => {
    const data = Buffer.alloc(165);
    tokenMint.toBuffer().copy(data, 0);
    owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(BigInt(amount), 64);
    data[108] = 1;
    return { owner: TOKEN_PROGRAM_ID, data };
  };
  const poolInfo = { owner: PUMP_AMM_PROGRAM_ID, data: Buffer.alloc(300) };
  const rpc = { async getMultipleAccountsInfo(keys, commitment) {
    calls++;
    assert.equal(keys.length, 5);
    assert.equal(keys[0].toBase58(), poolKey.toBase58());
    assert.equal(commitment, 'processed');
    return [poolInfo, tokenInfo(mint, poolKey, 900), tokenInfo(NATIVE_MINT, poolKey, 500),
      { owner: PUMP_AMM_PROGRAM_ID, data: Buffer.alloc(1) },
      { owner: PUMP_FEE_PROGRAM_ID, data: Buffer.alloc(1) }];
  } };
  const trader = new Trader(rpc, { user, watches: [] }, { rows: new Map() });
  trader.mints.set(mint.toBase58(), { tokenProgram: TOKEN_PROGRAM_ID, rawMint: { supply: 1000n } });
  trader.decodeAmmPool = () => ({ baseMint: mint, quoteMint: NATIVE_MINT,
    poolBaseTokenAccount: getAssociatedTokenAddressSync(mint, poolKey, true, TOKEN_PROGRAM_ID),
    poolQuoteTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, poolKey, true, TOKEN_PROGRAM_ID) });
  trader.decodeAmmGlobal = () => ({ protocolFeeRecipients: [user] });
  trader.decodeAmmFee = () => ({ feeTiers: [] });
  const state = await trader.migrationSwapState(mint.toBase58(), poolKey);
  assert.equal(calls, 1);
  assert.equal(state.poolBaseAmount.toString(), '900');
  assert.equal(state.poolQuoteAmount.toString(), '500');
  assert.equal(state.poolAccountInfo, poolInfo);
  assert.equal(state.feeConfig.feeTiers.length, 0);
});

test('confirmed failed migration sell keeps all tracked positions open', async () => {
  const keypair = Keypair.generate();
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map([['buy', { id: 'buy', status: 'confirmed', watch, mint, delta: '100' }]]);
  const journal = { rows, put: row => rows.set(row.id, row) };
  const rpc = { async confirmTransaction() { return { value: { err: { InstructionError: [2, 6000] } } }; } };
  const trader = new Trader(rpc, { keypair, user: keypair.publicKey, watches: [watch],
    dryRun: false, priorityFee: 1000, tipLamports: 5000n,
    tipAccount: HELIUS_TIP_ACCOUNTS[0] }, journal);
  trader.sendSenderTransaction = async (_mode, _raw, signature) => signature;
  const ix = SystemProgram.transfer({ fromPubkey: keypair.publicKey,
    toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const result = await trader.submitLiveTrade({ id: 'migration:failed', watch, mint,
    isBuy: false, blockhash: Keypair.generate().publicKey.toBase58() }, [ix],
    [{ id: `migration:failed:${watch}`, watch, held: 100n }]);
  assert.equal(result, false);
  assert.equal(rows.get(`migration:failed:${watch}`).status, 'failed');
  assert.equal(trader.positions.get(positionKey(watch, mint)), 100n);
});
