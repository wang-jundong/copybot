import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { Trader } from '../src/trader.js';

test('a sell without a tracked position skips before any RPC call', async () => {
  const rows = new Map();
  const written = [];
  const journal = { rows, has: id => rows.has(id), put: row => { rows.set(row.id, row); written.push(row); } };
  const rpc = { getAccountInfo: async () => { throw new Error('RPC should not be called'); } };
  const config = { dryRun: true, maxAge: 30, user: Keypair.generate().publicKey, watches: [] };
  const trader = new Trader(rpc, config, journal);
  const trade = { id: 'sell-1', watch: Keypair.generate().publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58(),
    isBuy: false, timestamp: Math.floor(Date.now() / 1000), preBalance: 10n, postBalance: 0n, tokens: 10n };
  config.watches.push(trade.watch);
  await trader.execute(trade);
  assert.equal(written[0].reason, 'no tracked position');
});

test('unwatched trade is ignored before logging, journaling, or RPC', async () => {
  let called = false;
  const journal = { rows: new Map(), has: () => { called = true; return false; }, put: () => { called = true; } };
  const trader = new Trader({ getAccountInfo: async () => { called = true; } },
    { dryRun: true, maxAge: 30, user: Keypair.generate().publicKey, watches: [] }, journal);
  await trader.execute({ id: 'other', watch: Keypair.generate().publicKey.toBase58(), isBuy: true });
  assert.equal(called, false);
});

test('uncached first-buy time rejects this buy without RPC while warming in background', async () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const calls = [];
  const rows = new Map();
  const trader = new Trader({ getAccountInfo: async () => { calls.push('mint'); return null; } },
    { dryRun: true, watches: [watch], maxAge: 30, minCurveAge: 0, minMarketCapLamports: 0n },
    { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) });
  trader.firstBuys.get = async () => { calls.push('first-buy'); return 100; };
  trader.warmStatic = async () => { calls.push('global'); };
  const trade = { id: 'uncached-buy', isBuy: true, watch, mint, timestamp: Math.floor(Date.now() / 1000) };
  const result = await trader.inspect(trade);
  assert.equal(result.reason, 'first bonding-curve buy not cached');
  assert.deepEqual(calls, []);
  await trader.observe(trade);
  assert.deepEqual(calls.sort(), ['first-buy', 'global', 'mint']);
  trader.firstBuys.times.set(mint, trade.timestamp - 100);
  await trader.execute(trade, Promise.resolve(result));
  assert.equal(rows.get(trade.id).reason, 'first bonding-curve buy not cached');
});

test('rejected entry cannot reach a buy quote or transaction', async () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map();
  const trader = new Trader({ getAccountInfo: async () => { throw new Error('unexpected RPC'); } },
    { dryRun: true, watches: [watch], maxAge: 30, user: Keypair.generate().publicKey },
    { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) });
  const trade = { id: 'no-bounds-buy', watch, mint, isBuy: true, timestamp: Math.floor(Date.now() / 1000) };
  await trader.execute(trade, Promise.resolve({ reason: 'age and market-cap limits must both be configured' }));
  assert.equal(rows.get(trade.id).status, 'skipped');
});

test('a watched sell can skip without waiting for first-buy cache history', async () => {
  const watch = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const rows = new Map();
  const trader = new Trader({}, { dryRun: true, watches: [watch], maxAge: 30 },
    { rows, has: id => rows.has(id), put: row => rows.set(row.id, row) });
  let finishHistory;
  trader.firstBuys.get = () => new Promise(resolve => { finishHistory = resolve; });
  trader.warmMint = async () => {};
  trader.warmStatic = async () => {};
  const trade = { id: 'sell-while-cache-pending', watch, mint, isBuy: false,
    timestamp: Math.floor(Date.now() / 1000) };
  const cache = trader.observe(trade);
  await trader.execute(trade);
  assert.equal(rows.get(trade.id).reason, 'no tracked position');
  await Promise.resolve();
  finishHistory(123);
  await cache;
});
